package aio

// user-bash wiring (port of user-bash/): an editor that labels `!`/`!!`
// input and adds the space after the prefix. Explicit user shell commands
// keep Pi's native execution path.
//
// The editor needs a PiG whose host does not crash on a Go editor that
// overrides methods (the PiG fork, commit f46b9ab2c; see PIG-LIMITS.md). As
// in TypeScript, the queue editor extends this editor and the frame wraps
// it; the frame owns the mode label while it is installed.

import (
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/userbash"
)

func init() { addRegistrar(OrderUserBash, "user-bash", registerUserBash) }

// sdkBase adapts the host's default editor to userbash.Base. It keeps the
// first error of a call so the component can return it.
type sdkBase struct {
	editor *sdk.Editor
	err    error
}

func (b *sdkBase) keep(err error) {
	if err != nil && b.err == nil {
		b.err = err
	}
}

func (b *sdkBase) take() error {
	err := b.err
	b.err = nil
	return err
}

func (b *sdkBase) Text() string {
	text, err := b.editor.GetText()
	b.keep(err)
	return text
}

func (b *sdkBase) SetText(text string)     { b.keep(b.editor.SetText(text)) }
func (b *sdkBase) HandleInput(data string) { b.keep(b.editor.HandleInput(data)) }

// bashStatus publishes the user-bash status through the long-lived
// context, skipping repeats (TypeScript sets it after every key in-process;
// here each set is a host call).
type bashStatus struct {
	mu   sync.Mutex
	ctx  *sdk.Context
	last *string
}

func (s *bashStatus) set(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx == nil || !s.ctx.HasUI() || s.ctx.Mode() != "tui" {
		return
	}
	if s.last != nil && *s.last == text {
		return
	}
	s.last = &text
	if text == "" {
		s.ctx.ClearStatus("user-bash")
		return
	}
	s.ctx.SetStatus("user-bash", text)
}

// bashHintEditor is BashHintEditor: the host's editor with the shell hint.
type bashHintEditor struct {
	*sdk.Editor
	mu   sync.Mutex
	base *sdkBase
	hint *userbash.Editor
	ctx  *sdk.Context // long-lived context: the editor outlives any handler
}

func newBashHintEditor(base *sdk.Editor, ctx *sdk.Context, status *bashStatus) *bashHintEditor {
	b := &bashHintEditor{Editor: base, base: &sdkBase{editor: base}, ctx: ctx}
	b.hint = &userbash.Editor{
		Base:   b.base,
		Status: status.set,
		Theme:  func() userbash.Theme { return ctx.UITheme() },
	}
	// Pi copies padding 0 onto custom editors; keep one column.
	_ = base.SetPaddingX(1)
	b.hint.SyncHint(b.base.Text())
	b.base.take()
	return b
}

// SetFrameChrome is setFrameChrome: the frame owns the mode label.
func (b *bashHintEditor) SetFrameChrome(active bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.hint.SetFrameChrome(active)
	b.base.take()
}

// HandleInput is BashHintEditor.handleInput.
func (b *bashHintEditor) HandleInput(data string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.hint.HandleInput(data)
	return b.base.take()
}

// SetText is BashHintEditor.setText.
func (b *bashHintEditor) SetText(text string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.hint.SetText(text)
	return b.base.take()
}

func (b *bashHintEditor) border(text string) string {
	if colored, err := b.Editor.BorderColor(text); err == nil {
		return colored
	}
	return text
}

func (b *bashHintEditor) renderWithChrome(width int, frameChrome bool) ([]string, error) {
	lines, err := b.Editor.Render(width)
	if err != nil {
		return lines, err
	}
	text, err := b.Editor.GetText()
	if err != nil || b.ctx == nil {
		return lines, nil
	}
	return userbash.RenderWithChrome(lines, text, width, frameChrome, b.ctx.UITheme(), b.border), nil
}

// Render is BashHintEditor.render.
func (b *bashHintEditor) Render(width int) ([]string, error) {
	b.mu.Lock()
	frameChrome := b.hint.FrameChrome
	b.mu.Unlock()
	return b.renderWithChrome(width, frameChrome)
}

// RenderUnframed is renderUnframed: the native chrome without touching the
// status.
func (b *bashHintEditor) RenderUnframed(width int) ([]string, error) {
	return b.renderWithChrome(width, false)
}

// userBashStatus is the user-bash status shared by the user-bash and
// queue editors.
var userBashStatus = &bashStatus{}

func registerUserBash(e *sdk.Extension) {
	var loaded *sdk.Context
	status := userBashStatus
	e.OnLoaded(func(ctx sdk.Context) {
		loaded = &ctx
		status.mu.Lock()
		status.ctx = &ctx
		status.mu.Unlock()
	})
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		status.mu.Lock()
		status.last = nil
		status.mu.Unlock()
		if !ctx.HasUI() || ctx.Mode() != "tui" || ctx.GetEditorComponent() != nil {
			return nil, nil
		}
		err := ctx.SetEditorComponent(func(base *sdk.Editor) sdk.EditorComponent {
			return newBashHintEditor(base, loaded, status)
		})
		if err == nil {
			editorOwner.set("user-bash")
		}
		return nil, err
	})
	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if ctx.HasUI() {
			status.set("")
			ctx.ClearStatus("user-bash")
			_ = ctx.SetEditorComponent(nil)
			editorOwner.set("")
		}
		return nil, nil
	})
}
