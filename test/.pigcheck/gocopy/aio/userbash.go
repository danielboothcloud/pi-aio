package aio

// user-bash wiring (port of user-bash/): an editor that labels `!`/`!!`
// input and adds the space after the prefix. Explicit user shell commands
// keep Pi's native execution path.
//
// OFF BY DEFAULT: PiG 0.7.0 panics ("autocomplete provider is no longer
// available") when a Go editor component overrides any method (HandleInput
// on every key; Render or SetText once bash mode is active). Set
// AIO_GO_USER_BASH_EDITOR=1 to install it on a PiG version that fixes this.
// Without it, PiG's native editor still runs `!`/`!!` commands.
//
// Other differences from TypeScript: no frame chrome mode (frame is not
// ported), and spacing and status run in Render, not HandleInput.

import (
	"os"
	"strings"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	"github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	"github.com/danielboothcloud/pi-aio/go/internal/userbash"
)

func init() { addRegistrar(OrderUserBash, "user-bash", registerUserBash) }

type bashHintEditor struct {
	*sdk.Editor
	ctx *sdk.Context // long-lived context: the editor outlives any handler
}

func (b *bashHintEditor) sync(text string) {
	if b.ctx == nil || !b.ctx.HasUI() || b.ctx.Mode() != "tui" {
		return
	}
	state := userbash.Parse(text)
	if !state.Active {
		b.ctx.ClearStatus("user-bash")
		return
	}
	label := "!bash"
	if state.Hidden {
		label = "!!bash"
	}
	b.ctx.SetStatus("user-bash", b.ctx.UITheme().Fg("bashMode", label))
}

func (b *bashHintEditor) SetText(text string) error {
	if err := b.Editor.SetText(text); err != nil {
		return err
	}
	b.sync(text)
	return nil
}

// fitBorder ports fitBorder: ─left──gap──right─ in exactly width columns.
func fitBorder(left, right string, width int, border func(string) string) string {
	if width <= 0 {
		return ""
	}
	if width == 1 {
		return border("─")
	}
	const fixed, gap = 2, 1
	for fixed+tui.VisibleWidth(left)+tui.VisibleWidth(right)+gap > width && tui.VisibleWidth(right) > 0 {
		right = tui.TruncateToWidth(right, max(0, tui.VisibleWidth(right)-1), "", false)
	}
	for fixed+tui.VisibleWidth(left)+tui.VisibleWidth(right)+gap > width && tui.VisibleWidth(left) > 0 {
		left = tui.TruncateToWidth(left, max(0, tui.VisibleWidth(left)-1), "", false)
	}
	fill := max(0, width-fixed-tui.VisibleWidth(left)-tui.VisibleWidth(right))
	return border("─") + left + border(strings.Repeat("─", fill)) + right + border("─")
}

// Render also does the work that TypeScript does in handleInput: it adds
// the space after `!`/`!!` and updates the status. PiG 0.7.0 crashes
// ("autocomplete provider is no longer available") as soon as a Go editor
// overrides HandleInput, and the SDK renders the component after every
// input event, so Render sees each change.
func (b *bashHintEditor) Render(width int) ([]string, error) {
	text, err := b.Editor.GetText()
	if err == nil {
		if spaced, ok := userbash.EnsureSpacing(text); ok && b.Editor.SetText(spaced) == nil {
			text = spaced
		}
		b.sync(text)
	}
	lines, err := b.Editor.Render(width)
	if err != nil || b.ctx == nil {
		return lines, err
	}
	state := userbash.Parse(text)
	if !state.Active || len(lines) < 2 {
		return lines, nil
	}
	theme := b.ctx.UITheme()
	mode := theme.Fg("bashMode", " ! bash ")
	if state.Hidden {
		mode = theme.Fg("muted", " !! hidden ")
	}
	border := func(s string) string {
		if colored, err := b.Editor.BorderColor(s); err == nil {
			return colored
		}
		return s
	}
	lines[0] = fitBorder(mode, theme.Fg("dim", " Enter to run "), width, border)
	return lines, nil
}

// UserBashEditorEnv opts in to the editor component.
const UserBashEditorEnv = "AIO_GO_USER_BASH_EDITOR"

func registerUserBash(e *sdk.Extension) {
	if os.Getenv(UserBashEditorEnv) != "1" {
		return
	}
	var loaded *sdk.Context
	e.OnLoaded(func(ctx sdk.Context) { loaded = &ctx })
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if !ctx.HasUI() || ctx.Mode() != "tui" || ctx.GetEditorComponent() != nil {
			return nil, nil
		}
		return nil, ctx.SetEditorComponent(func(base *sdk.Editor) sdk.EditorComponent {
			// Pi copies padding 0 onto custom editors; keep one column.
			_ = base.SetPaddingX(1)
			return &bashHintEditor{Editor: base, ctx: loaded}
		})
	})
	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if ctx.HasUI() {
			ctx.ClearStatus("user-bash")
			_ = ctx.SetEditorComponent(nil)
		}
		return nil, nil
	})
}
