package aio

// ask-user-question wiring (port of ask-user-question/index.ts,
// ask-user-question.ts, and reconcile.ts). The logic is in
// go/internal/askuserquestion; this file connects it to the PiG host.
//
// Differences from TypeScript:
//   - @juicesharp/rpiv-i18n cannot load in Go: every string is the built-in
//     English text (TypeScript falls back to it when the package is absent).
//   - There is no lazily loaded session module, so the session-load and
//     stale-module-cache errors and the startup pre-warm do not exist.
//   - The overlay's setHidden and the collapse notice run on their own
//     goroutine: the terminal-input listener must answer at once, and a host
//     call from the overlay's input queue must not wait on the host.
//   - A shown overlay that the host closes without a result (a teardown)
//     returns the decline result. TypeScript's custom() never resolves then.
//   - PiG sends a key to the focused overlay before the terminal-input
//     listeners, so the first collapse key goes through routeKey. The
//     one-time "hidden" notice is also sent from that path (see
//     askuserquestion.Execute).

import (
	"os"
	"sync"
	"sync/atomic"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	aq "github.com/danielboothcloud/pi-aio/go/internal/askuserquestion"
	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
)

func init() {
	addRegistrar(OrderAskUserQuestion, "ask-user-question", registerAskUserQuestion)
}

// agentPromptSeq is withAgentPrompt's nextPromptId (notifications/protocol.ts).
var agentPromptSeq atomic.Int64

func configWarn(message string) { _, _ = os.Stderr.WriteString(message + "\n") }

// hostKeys is aq.Keys over pi-tui's helpers.
type hostKeys struct{}

func (hostKeys) Matches(data, binding string) bool {
	return sdktui.GetKeybindings().Matches(data, binding)
}
func (hostKeys) MatchesKey(data, keyID string) bool {
	return sdktui.MatchesKey(data, sdktui.KeyID(keyID))
}
func (hostKeys) DecodeKittyPrintable(data string) (string, bool) {
	return sdktui.DecodeKittyPrintable(data)
}

// questionnaireComponent shows aq.Overlay as an SDK overlay.
type questionnaireComponent struct{ o *aq.Overlay }

func (c *questionnaireComponent) Render(width int) []string { return c.o.Render(width) }

func (c *questionnaireComponent) HandleInput(data string) (sdk.RemoteComponentResult, error) {
	if c.o.HandleInput(data) {
		result, _, _ := c.o.Result()
		return sdk.RemoteComponentResult{Done: true, Value: result}, nil
	}
	return sdk.RemoteComponentResult{}, nil
}

func (c *questionnaireComponent) SetInvalidate(fn func()) { c.o.SetInvalidate(fn) }

// overlayHandle adapts sdk.OverlayHandle. SetHidden records the value at
// once (TypeScript's setHidden is synchronous) and applies it on a worker
// goroutine in call order.
type overlayHandle struct {
	h      *sdk.OverlayHandle
	mu     sync.Mutex
	hidden bool
	closed bool
	queue  chan bool
}

func newOverlayHandle(h *sdk.OverlayHandle) *overlayHandle {
	oh := &overlayHandle{h: h, hidden: h.IsHidden(), queue: make(chan bool, 16)}
	go func() {
		for v := range oh.queue {
			_ = oh.h.SetHidden(v)
		}
	}()
	return oh
}

func (o *overlayHandle) IsHidden() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.hidden
}

func (o *overlayHandle) IsFocused() bool { return o.h.IsFocused() }

func (o *overlayHandle) SetHidden(hidden bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	o.hidden = hidden
	select {
	case o.queue <- hidden:
	default:
		go func() { _ = o.h.SetHidden(hidden) }()
	}
}

func (o *overlayHandle) close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.closed {
		o.closed = true
		close(o.queue)
	}
}

// questionHost is aq.Host over one tool call's context.
type questionHost struct {
	ctx sdk.Context
	md  copywidget.MarkdownTheme
}

func (h questionHost) Select(title string, options []string) (any, bool) {
	value, ok, err := h.ctx.Select(title, options)
	if err != nil {
		return nil, false
	}
	return value, ok
}

func (h questionHost) Input(title, placeholder string) (any, bool) {
	value, ok, err := h.ctx.Input(title, placeholder)
	if err != nil {
		return nil, false
	}
	return value, ok
}

func (h questionHost) HasUI() bool       { return h.ctx.HasUI() }
func (h questionHost) Mode() string      { return h.ctx.Mode() }
func (h questionHost) HasDialogUI() bool { return true }

func (h questionHost) EmitEvent(channel string, payload any) {
	defer func() { _ = recover() }()
	_ = h.ctx.Events().Emit(channel, payload)
}

func (h questionHost) SessionID() string {
	id, _ := h.ctx.SessionManager().GetSessionID()
	return id
}

func (h questionHost) NextPromptID() int { return int(agentPromptSeq.Add(1)) }

func (h questionHost) Notify(message, level string) {
	ctx := h.ctx
	go ctx.Notify(message, level)
}

func (h questionHost) Theme() aq.Theme                    { return h.ctx.UITheme() }
func (h questionHost) Markdown() copywidget.MarkdownTheme { return h.md }
func (h questionHost) Keys() aq.Keys                      { return hostKeys{} }
func (h questionHost) Columns() int                       { return max(h.ctx.Width(), 1) }
func (h questionHost) Rows() int                          { return max(h.ctx.Height(), 1) }

func (h questionHost) OnTerminalInput(handler func(string) bool) (func(), bool) {
	unsubscribe, err := h.ctx.OnTerminalInput(func(data string) sdk.TerminalInputResult {
		return sdk.TerminalInputResult{Consume: handler(data)}
	})
	if err != nil {
		return nil, false
	}
	return unsubscribe, true
}

func (h questionHost) ShowOverlay(o *aq.Overlay, onHandle func(aq.OverlayHandle)) error {
	var mu sync.Mutex
	var handle *overlayHandle
	defer func() {
		mu.Lock()
		defer mu.Unlock()
		if handle != nil {
			handle.close()
		}
	}()
	_, err := h.ctx.Custom(&questionnaireComponent{o: o}, sdk.RemoteOverlayOptions{
		Overlay: true,
		OverlayOptions: &sdk.OverlayOptions{
			Anchor:    aq.OverlayAnchor,
			Width:     sdk.OverlayPercent(aq.OverlayWidth),
			MaxHeight: sdk.OverlayPercent(aq.OverlayMaxHeight),
			Margin:    &sdk.OverlayMargin{},
		},
		OnHandle: func(sh *sdk.OverlayHandle) {
			mu.Lock()
			handle = newOverlayHandle(sh)
			current := handle
			mu.Unlock()
			onHandle(current)
		},
	})
	return err
}

func textToolResult(r aq.ToolResult) sdk.AgentToolResult {
	return sdk.AgentToolResult{Content: []sdk.ToolResultContent{{Type: "text", Text: r.Text}}, Details: r.Details}
}

func registerAskUserQuestion(e *sdk.Extension) {
	snippet, guidelines := aq.Guidance(aq.LoadToolConfig(configWarn))
	e.RegisterTool(sdk.ToolDefinition{
		Name:             aq.ToolName,
		Label:            aq.ToolLabel,
		Description:      aq.ToolDescription,
		PromptSnippet:    snippet,
		PromptGuidelines: guidelines,
		Parameters:       aq.Schema(),
		// User interaction must finish before sibling tool calls begin, and
		// two questionnaire overlays must never race.
		ExecutionMode: aq.ExecutionMode,
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			host := questionHost{ctx: ctx, md: markdownTheme()}
			result, err := aq.Execute(host, aq.DecodeParams(params), aq.LoadToolConfig(configWarn))
			if err != nil {
				return nil, err
			}
			return textToolResult(result), nil
		},
	})

	// reconcile.ts: strip the tool without UI, restore it with UI, before
	// each turn's tool snapshot.
	e.OnEvent("before_agent_start", func(ctx sdk.Context, _ map[string]any) (any, error) {
		active, err := ctx.GetActiveTools()
		if err != nil {
			return nil, nil
		}
		if next, changed := aq.ReconcileActiveTools(ctx.HasUI(), active); changed {
			ctx.SetActiveTools(next)
		}
		return nil, nil
	})
}
