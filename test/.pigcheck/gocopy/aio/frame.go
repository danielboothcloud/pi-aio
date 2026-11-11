package aio

// Frame wiring (port of frame/index.ts and frame/editor.ts). AIO wraps
// whatever editor this extension installed at session_start (normally the
// queue editor) in the minimalist frame. The renderer, the metadata, the
// git probe, the Codex quota poller, and the frame protocol are in
// go/internal/frame.
//
// Differences from TypeScript:
//   - The capability probe is package state shared by the Go features of
//     this extension. PiG's event bus carries JSON by value, so the
//     synchronous aio:minimal-frame-capability probe is not answered on the
//     bus. Another extension's editor (for example a standalone Zentui) is
//     invisible to GetEditorComponent, so it cannot be detected; the frame
//     wraps only this extension's editor.
//   - The Go SDK has no call to repaint an installed editor. Out-of-band
//     changes (git, timer, mode, quota) repaint through a no-op change of
//     the base editor's autocomplete size, which makes the host send its
//     editor state again (see PIG-LIMITS.md).
//   - The metadata (thinking level, context percent, session name, cost) is
//     read on lifecycle events, not on every render. The run timer
//     repaints once per second while the agent runs.
//   - Autocomplete rows are cut from the base editor's render (the rows
//     after its bottom rule); the SDK has no access to the list itself.
//   - menus.ts is not ported: the SDK exposes no host selector render or
//     mouse hook.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/frame"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// editorOwner names the feature whose factory this extension installed
// last ("user-bash", "queue", "frame"); the frame never wraps itself.
var editorOwner ownerName

type ownerName struct {
	mu   sync.Mutex
	name string
}

func (o *ownerName) set(name string) {
	o.mu.Lock()
	o.name = name
	o.mu.Unlock()
}

func (o *ownerName) get() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.name
}

func init() { addRegistrar(OrderFrame, "frame", registerFrame) }

const frameGitRefresh = 10 * time.Second

type frameState struct {
	mu       sync.Mutex
	loaded   *sdk.Context
	session  frame.Session
	snapshot frame.HostSnapshot
	base     *sdk.Editor
	route    bool
	codex    *frame.CodexCollector
	home     string

	stopGit   chan struct{}
	stopTimer chan struct{}
	repaints  chan struct{}
	epoch     int
}

// frameEditor is MinimalistFrameEditor around the inner component.
type frameEditor struct {
	inner sdk.EditorComponent
	base  *sdk.Editor
	state *frameState
}

type unframedRenderer interface {
	RenderUnframed(width int) ([]string, error)
}

type frameChromeSetter interface{ SetFrameChrome(active bool) }

func (e *frameEditor) HandleInput(data string) error             { return e.inner.HandleInput(data) }
func (e *frameEditor) HandleMouse(ev sdk.EditorMouseEvent) error { return e.inner.HandleMouse(ev) }
func (e *frameEditor) SetText(text string) error                 { return e.inner.SetText(text) }
func (e *frameEditor) InsertTextAtCursor(text string) error      { return e.inner.InsertTextAtCursor(text) }
func (e *frameEditor) AddToHistory(text string) error            { return e.inner.AddToHistory(text) }

// Invalidate forwards the theme change.
func (e *frameEditor) Invalidate() error {
	if inv, ok := e.inner.(interface{ Invalidate() error }); ok {
		return inv.Invalidate()
	}
	return nil
}

// SetWorkingStatusIndicator forwards the host's working status.
func (e *frameEditor) SetWorkingStatusIndicator(status *sdk.EditorStatus) error {
	if setter, ok := e.inner.(interface {
		SetWorkingStatusIndicator(*sdk.EditorStatus) error
	}); ok {
		return setter.SetWorkingStatusIndicator(status)
	}
	return nil
}

// frameBase adapts the inner component to frame.EditorBase for one render.
type frameBase struct {
	e    *frameEditor
	text *string
}

func (b *frameBase) Render(width int) []string {
	lines, err := b.e.inner.Render(width)
	if err != nil {
		return nil
	}
	return lines
}

func (b *frameBase) HasUnframed() bool {
	_, ok := b.e.inner.(unframedRenderer)
	return ok
}

func (b *frameBase) RenderUnframed(width int) []string {
	lines, err := b.e.inner.(unframedRenderer).RenderUnframed(width)
	if err != nil {
		return nil
	}
	return lines
}

func (b *frameBase) Text() string {
	if b.text == nil {
		text, _ := b.e.base.GetText()
		b.text = &text
	}
	return *b.text
}

func (b *frameBase) ShowingAutocomplete() bool {
	showing, _ := b.e.base.IsShowingAutocomplete()
	return showing
}

func (b *frameBase) PaddingX() int {
	padding, _ := b.e.base.GetPaddingX()
	return padding
}

// Render is MinimalistFrameEditor.render.
func (e *frameEditor) Render(width int) ([]string, error) {
	s := e.state
	s.mu.Lock()
	loaded, home := s.loaded, s.home
	s.mu.Unlock()
	var theme frame.Theme = plainFrameTheme{}
	if loaded != nil {
		theme = loaded.UITheme()
	}
	return frame.RenderEditor(&frameBase{e: e}, width, frame.EditorOptions{
		Theme:         theme,
		Style:         frame.DefaultStyle,
		Home:          home,
		GetMetadata:   s.metadata,
		GetPanelLines: frame.QueuePanelLines,
	}), nil
}

type plainFrameTheme struct{}

func (plainFrameTheme) Fg(_, text string) string { return text }

func (s *frameState) metadata() frame.Metadata {
	s.mu.Lock()
	snapshot, codex := s.snapshot, s.codex
	s.mu.Unlock()
	var quota *frame.CodexQuota
	if codex != nil {
		quota = codex.Get()
	}
	return s.session.Metadata(snapshot, nowMillis(), quota)
}

// refresh reads the host values getMetadata reads (TypeScript reads them on
// every render).
func (s *frameState) refresh(ctx sdk.Context, entries bool) {
	thinking, _ := ctx.GetThinkingLevel()
	var percent *float64
	if usage, err := ctx.GetContextUsage(); err == nil && usage != nil && usage.Percent != nil {
		p := *usage.Percent
		percent = &p
	}
	name := ""
	if n, err := ctx.GetSessionName(); err == nil && n != nil {
		name = *n
	}
	var list []map[string]any
	if entries {
		list = sessionEntries(ctx)
	}
	s.mu.Lock()
	s.snapshot.Cwd = ctx.Cwd()
	s.snapshot.ModelID = ctx.Model()
	s.snapshot.ThinkingLevel = thinking
	s.snapshot.ContextPercent = percent
	s.snapshot.SessionName = name
	if entries {
		s.snapshot.Entries = list
	}
	s.mu.Unlock()
}

func sessionEntries(ctx sdk.Context) []map[string]any {
	entries, err := ctx.SessionManager().GetEntries()
	if err != nil {
		return nil
	}
	return entries
}

// repaint asks the host to render the frame again (coalesced).
func (s *frameState) repaint() {
	select {
	case s.repaints <- struct{}{}:
	default:
	}
}

func (s *frameState) repaintLoop() {
	for range s.repaints {
		s.mu.Lock()
		base := s.base
		s.mu.Unlock()
		if base == nil {
			continue
		}
		n, err := base.GetAutocompleteMaxVisible()
		if err != nil {
			continue
		}
		other := n + 1
		if other > 20 {
			other = n - 1
		}
		_ = base.SetAutocompleteMaxVisible(other)
		_ = base.SetAutocompleteMaxVisible(n)
	}
}

func (s *frameState) refreshGit() {
	s.mu.Lock()
	cwd, epoch := s.snapshot.Cwd, s.epoch
	s.mu.Unlock()
	if cwd == "" {
		return
	}
	go func() {
		result := frame.ReadGitStatus(cwd, frame.ExecGit)
		s.mu.Lock()
		current := epoch == s.epoch
		s.mu.Unlock()
		if !current {
			return
		}
		status := frame.GitStatus{}
		if result.Kind == "ok" && result.Status != nil {
			status = *result.Status
		} else if result.Kind == "error" {
			return // keep the previous snapshot
		}
		s.session.SetGit(status)
		s.repaint()
	}()
}

func (s *frameState) startTicker(interval time.Duration, slot *chan struct{}, tick func()) {
	s.mu.Lock()
	if *slot != nil {
		close(*slot)
	}
	stop := make(chan struct{})
	*slot = stop
	s.mu.Unlock()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				tick()
			}
		}
	}()
}

func (s *frameState) stopTicker(slot *chan struct{}) {
	s.mu.Lock()
	if *slot != nil {
		close(*slot)
		*slot = nil
	}
	s.mu.Unlock()
}

// codexRoute reports whether the routed model is the native Codex route
// (hasNativeCodexRoute). The provider's base URL is a registered
// override's, else the model's own: PiG's registry has no public provider
// object for a builtin provider (D78).
func codexRoute(ctx sdk.Context) bool {
	provider, id := ctx.ModelProvider(), ctx.Model()
	if provider != "openai-codex" || id == "" {
		return false
	}
	model, err := ctx.ModelRegistry().Find(provider, id)
	if err != nil || model == nil {
		return false
	}
	api, _ := model["api"].(string)
	baseURL, _ := model["baseUrl"].(string)
	providerBase := baseURL
	if config, err := ctx.ModelRegistry().GetRegisteredProviderConfig(provider); err == nil && config != nil {
		providerBase, _ = config["baseUrl"].(string)
	}
	return frame.HasNativeCodexRoute(&frame.CodexModel{Provider: provider, API: api, BaseURL: baseURL}, &frame.CodexProvider{ID: provider, BaseURL: providerBase})
}

var codexHTTP = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
	return errors.New("redirect")
}}

func codexFetch(ctx context.Context, url string, headers map[string]string) (frame.CodexResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return frame.CodexResponse{}, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := codexHTTP.Do(req)
	if err != nil {
		return frame.CodexResponse{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return frame.CodexResponse{}, err
	}
	return frame.CodexResponse{Status: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After"), Body: body}, nil
}

func (s *frameState) setRoute(ctx sdk.Context) {
	route := codexRoute(ctx)
	s.mu.Lock()
	s.route = route
	s.mu.Unlock()
}

func registerFrame(e *sdk.Extension) {
	s := &frameState{repaints: make(chan struct{}, 1)}
	s.home, _ = os.UserHomeDir()
	go s.repaintLoop()
	// `supported` is true from registration: earlier registrars probe at
	// their own session_start, before the frame's.
	frame.SetSupported(true)
	e.OnLoaded(func(ctx sdk.Context) {
		s.mu.Lock()
		s.loaded = &ctx
		loaded := s.loaded
		s.mu.Unlock()
		s.codex = frame.NewCodexCollector(frame.CodexDeps{
			Route: func() bool {
				s.mu.Lock()
				defer s.mu.Unlock()
				return s.route
			},
			Token: func(context.Context) (string, error) {
				auth, err := loaded.ModelRegistry().GetApiKeyAndHeaders(map[string]any{"provider": loaded.ModelProvider(), "id": loaded.Model()})
				if err != nil {
					return "", err
				}
				ok, _ := auth["ok"].(bool)
				key, _ := auth["apiKey"].(string)
				if !ok {
					return "", nil
				}
				return key, nil
			},
			Fetch:   codexFetch,
			Changed: s.repaint,
		})
	})

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if ctx.Mode() != "tui" || !ctx.HasUI() {
			return nil, nil
		}
		s.mu.Lock()
		s.epoch++
		s.mu.Unlock()
		s.session.Reset()
		s.refresh(ctx, true)
		existing, _ := ctx.GetEditorComponent().(sdk.EditorFactory)
		if existing == nil || editorOwner.get() == "frame" {
			return nil, nil
		}
		previous, _ := ctx.GetEditorText()
		err := ctx.SetEditorComponent(func(base *sdk.Editor) sdk.EditorComponent {
			inner := existing(base)
			if setter, ok := inner.(frameChromeSetter); ok {
				setter.SetFrameChrome(true)
			}
			s.mu.Lock()
			s.base = base
			s.mu.Unlock()
			return &frameEditor{inner: inner, base: base, state: s}
		})
		if err != nil {
			return nil, err
		}
		editorOwner.set("frame")
		if jsstr.Trim(previous) != "" {
			ctx.SetEditorText(previous)
		}
		frame.SetRepaintHook(s.repaint)
		frame.SetActive(true)
		s.refreshGit()
		s.startTicker(frameGitRefresh, &s.stopGit, s.refreshGit)
		s.setRoute(ctx)
		if s.codex != nil {
			s.codex.Reconcile()
		}
		return nil, nil
	})

	e.OnSessionShutdown(func(_ sdk.Context, _ map[string]any) (any, error) {
		s.stopTicker(&s.stopGit)
		s.stopTicker(&s.stopTimer)
		if s.codex != nil {
			s.codex.Stop()
		}
		s.mu.Lock()
		s.epoch++
		s.base = nil
		s.mu.Unlock()
		frame.SetActive(false)
		frame.SetRepaintHook(nil)
		s.session.Reset()
		return nil, nil
	})

	active := func() bool { return frame.Probe().Active }
	e.OnEvent("model_select", func(ctx sdk.Context, _ map[string]any) (any, error) {
		if !active() {
			return nil, nil
		}
		s.refresh(ctx, false)
		s.setRoute(ctx)
		if s.codex != nil {
			s.codex.Reconcile()
		}
		s.repaint()
		return nil, nil
	})
	e.OnEvent("agent_start", func(ctx sdk.Context, _ map[string]any) (any, error) {
		if !active() {
			return nil, nil
		}
		s.session.AgentStart(nowMillis())
		s.refreshGit()
		s.repaint()
		s.startTicker(time.Second, &s.stopTimer, s.repaint)
		return nil, nil
	})
	e.OnEvent("agent_end", func(ctx sdk.Context, _ map[string]any) (any, error) {
		if !active() {
			return nil, nil
		}
		s.session.AgentEnd()
		s.stopTicker(&s.stopTimer)
		s.refresh(ctx, true)
		s.refreshGit()
		s.repaint()
		return nil, nil
	})
	for _, name := range []string{"message_end", "turn_end", "thinking_level_select"} {
		e.OnEvent(name, func(ctx sdk.Context, _ map[string]any) (any, error) {
			if !active() {
				return nil, nil
			}
			s.refresh(ctx, name == "message_end")
			s.repaint()
			return nil, nil
		})
	}
	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		if !active() {
			return nil, nil
		}
		s.refresh(ctx, true)
		s.refreshGit()
		s.repaint()
		return nil, nil
	})
}
