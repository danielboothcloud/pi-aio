package aio

// Queue wiring (port of queue/index.ts and queue/queue-editor.ts). The
// mirror, the interrupt controller, the widget rows, and the key decisions
// are in go/internal/queue. The queue editor extends the user-bash editor
// and consults the editor intercepts (session-nav) before the host handles
// a key. The frame shows the queue as panel rows; the below-editor widget
// is used only without the frame.
//
// Differences from TypeScript:
//   - pi's onSubmit cannot be wrapped from Go, so the submitted text is
//     predicted on the submit key and offered to the intercepts first
//     (queue.HandleInput).
//   - The interrupt sends the host's interrupt key through the base editor
//     (Pi's ctx.abort() in the TUI: the queued messages go back to the
//     editor, then the run aborts). PiG's ctx.Abort keeps the queued
//     messages and waits until the session is idle (see PIG-LIMITS.md).
//   - sendUserMessage goes out on a worker: a host call made from an
//     agent_start handler would wait for the run that handler holds.

import (
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	"github.com/danielboothcloud/pi-aio/go/internal/frame"
	"github.com/danielboothcloud/pi-aio/go/internal/queue"
)

func init() { addRegistrar(OrderQueue, "queue", registerQueue) }

const queueWidgetKey = "aio-queue"

// queueState is registerQueue's state. Host calls that the controller asks
// for run after the lock is released (see run).
type queueState struct {
	mu      sync.Mutex
	feature *queue.Feature
	loaded  *sdk.Context
	current *sdk.Context // the handler context during run, else nil
	pending []func()
	sends   chan func()
}

// run runs fn under the lock with the handler context ctx (nil outside a
// handler), then the host calls it queued.
func (q *queueState) run(ctx *sdk.Context, fn func()) {
	q.mu.Lock()
	q.current = ctx
	fn()
	q.current = nil
	calls := q.pending
	q.pending = nil
	q.mu.Unlock()
	for _, call := range calls {
		call()
	}
}

// later queues a host call; the caller holds q.mu.
func (q *queueState) later(fn func()) { q.pending = append(q.pending, fn) }

// host is the context for host calls: the handler's while one runs (the
// long-lived context's calls wait behind each other), else the long-lived
// one. The caller holds q.mu.
func (q *queueState) host() *sdk.Context {
	if q.current != nil {
		return q.current
	}
	return q.loaded
}

// updateWidgetLocked is updateWidget. The caller holds q.mu.
func (q *queueState) updateWidgetLocked() {
	ctx := q.host()
	if ctx == nil || !ctx.HasUI() {
		return
	}
	entries, show := q.feature.WidgetUpdate(frame.Probe().Active)
	if !show {
		q.later(func() { _ = ctx.SetWidget(queueWidgetKey, nil) })
		return
	}
	theme := q.loaded
	q.later(func() {
		_ = ctx.SetWidgetRenderer(queueWidgetKey, func(width int) []string {
			return queue.BuildLines(entries, width, theme.UITheme(), 0)
		}, sdk.WidgetOptions{"placement": "belowEditor"})
	})
}

// interruptKey is the terminal data of the host's interrupt key
// (app.interrupt), for the key ids that have a plain encoding.
func interruptKey() (string, bool) {
	kb := sdktui.GetKeybindings()
	for _, id := range kb.GetKeys("app.interrupt") {
		var data string
		switch {
		case id == "escape" || id == "esc":
			data = "\x1b"
		case strings.HasPrefix(id, "ctrl+") && len(id) == 6 && id[5] >= 'a' && id[5] <= 'z':
			data = string(rune(id[5] - 'a' + 1))
		default:
			continue
		}
		if kb.Matches(data, "app.interrupt") {
			return data, true
		}
	}
	return "", false
}

// queueEditor is QueueEditor: the user-bash editor plus the empty-submit
// interrupt and the editor intercepts.
type queueEditor struct {
	*bashHintEditor
	state *queueState
}

// queueHost adapts the queue editor to queue.EditorHost.
type queueHost struct{ e *queueEditor }

func (h queueHost) Matches(data, binding string) bool {
	return sdktui.GetKeybindings().Matches(data, binding)
}

func (h queueHost) Text() string {
	text, _ := h.e.Editor.GetText()
	return text
}

func (h queueHost) ExpandedText() string {
	text, _ := h.e.Editor.GetExpandedText()
	return text
}

func (h queueHost) ShowingAutocomplete() bool {
	showing, _ := h.e.Editor.IsShowingAutocomplete()
	return showing
}

func (h queueHost) SubmitDisabled() bool {
	disabled, _ := h.e.Editor.DisableSubmit()
	return disabled
}

func (h queueHost) BackslashBeforeCursor() bool {
	cursor, err := h.e.Editor.GetCursor()
	if err != nil || cursor.Col <= 0 {
		return false
	}
	lines, err := h.e.Editor.GetLines()
	if err != nil || cursor.Line >= len(lines) {
		return false
	}
	units := utf16Units(lines[cursor.Line])
	return cursor.Col <= len(units) && units[cursor.Col-1] == '\\'
}

func (h queueHost) ClearText()        { _ = h.e.bashHintEditor.SetText("") }
func (h queueHost) Super(data string) { _ = h.e.bashHintEditor.HandleInput(data) }

func utf16Units(s string) []uint16 {
	var out []uint16
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
			continue
		}
		out = append(out, uint16(r))
	}
	return out
}

// HandleInput is QueueEditor.handleInput.
func (e *queueEditor) HandleInput(data string) error {
	queue.HandleInput(queueHost{e}, data, e.onEmptySubmit)
	return nil
}

func (e *queueEditor) onEmptySubmit() bool {
	consumed := false
	e.state.run(nil, func() { consumed = e.state.feature.OnEmptySubmit() })
	return consumed
}

// editorSubmitter is the base editor of the AIO editor, whose host
// onSubmit runs a slash command as if the user submitted it (session-nav).
var editorSubmitter struct {
	mu     sync.Mutex
	editor *sdk.Editor
}

func setEditorSubmitter(editor *sdk.Editor) {
	editorSubmitter.mu.Lock()
	editorSubmitter.editor = editor
	editorSubmitter.mu.Unlock()
}

func currentEditorBase() *sdk.Editor {
	editorSubmitter.mu.Lock()
	defer editorSubmitter.mu.Unlock()
	return editorSubmitter.editor
}

// submitThroughEditor submits text through the AIO editor's host onSubmit.
// It reports false when no AIO editor is installed.
func submitThroughEditor(text string) bool {
	editor := currentEditorBase()
	return editor != nil && editor.OnSubmit(text) == nil
}

func registerQueue(e *sdk.Extension) {
	q := &queueState{feature: queue.NewFeature(), sends: make(chan func(), 64)}
	go func() {
		for send := range q.sends {
			send()
		}
	}()
	e.OnLoaded(func(ctx sdk.Context) { q.loaded = &ctx })
	frame.SetQueuePanelLinesProvider(func() []string {
		q.mu.Lock()
		defer q.mu.Unlock()
		return q.feature.Panel()
	})
	newController := func() *queue.Controller {
		return queue.NewController(queue.Deps{
			IsIdle: func() bool {
				idle, err := q.host().IsIdle()
				return err == nil && idle
			},
			HasPendingMessages: func() bool {
				pending, err := q.host().HasPendingMessages()
				return err == nil && pending
			},
			Abort: func() {
				loaded := q.loaded
				q.later(func() {
					if key, ok := interruptKey(); ok {
						if base := currentEditorBase(); base != nil {
							_ = base.HandleInput(key)
							return
						}
					}
					go loaded.Abort()
				})
			},
			ClearEditor: func() {
				ctx := q.host()
				q.later(func() { ctx.SetEditorText("") })
			},
			RestoreTextsToEditor: func(texts []string) {
				ctx := q.host()
				q.later(func() {
					if !ctx.HasUI() || len(texts) == 0 {
						return
					}
					current, _ := ctx.GetEditorText()
					ctx.SetEditorText(queue.MergeRestore(current, texts))
				})
			},
			SendUserMessage: func(text, mode string) {
				loaded := q.loaded
				q.later(func() { q.sends <- func() { _ = loaded.SendUserMessage(text, mode) } })
			},
			Notify: func(message, level string) {
				ctx := q.host()
				q.later(func() { ctx.Notify(message, level) })
			},
			UpdateWidget: q.updateWidgetLocked,
		})
	}
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if ctx.Mode() != "tui" {
			q.run(&ctx, func() { q.feature.Controller = nil })
			return nil, nil
		}
		q.run(&ctx, func() { q.feature.Controller = newController() })
		loaded, status := q.loaded, userBashStatus
		if err := ctx.SetEditorComponent(func(base *sdk.Editor) sdk.EditorComponent {
			setEditorSubmitter(base)
			return &queueEditor{bashHintEditor: newBashHintEditor(base, loaded, status), state: q}
		}); err != nil {
			return nil, err
		}
		editorOwner.set("queue")
		q.run(&ctx, q.updateWidgetLocked)
		return nil, nil
	})
	e.OnEvent("input", func(ctx sdk.Context, data map[string]any) (any, error) {
		behavior, _ := data["streamingBehavior"].(string)
		text, _ := data["text"].(string)
		if behavior != "" {
			q.run(&ctx, func() {
				if c := q.feature.Controller; c != nil {
					c.HandleQueuedInput(text, behavior)
				}
			})
		}
		return nil, nil
	})
	e.OnEvent("message_start", func(ctx sdk.Context, data map[string]any) (any, error) {
		message, _ := data["message"].(map[string]any)
		if message["role"] != "user" {
			return nil, nil
		}
		text := queue.ExtractUserText(message)
		q.run(&ctx, func() {
			if c := q.feature.Controller; c != nil {
				c.HandleUserMessageText(text)
			}
		})
		return nil, nil
	})
	controllerEvent := func(name string, fn func(*queue.Controller)) {
		e.OnEvent(name, func(ctx sdk.Context, _ map[string]any) (any, error) {
			q.run(&ctx, func() {
				if c := q.feature.Controller; c != nil {
					fn(c)
				}
			})
			return nil, nil
		})
	}
	controllerEvent("agent_start", (*queue.Controller).OnAgentStart)
	controllerEvent("agent_end", (*queue.Controller).Resync)
	controllerEvent("agent_settled", (*queue.Controller).OnAgentSettled)
	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		q.run(&ctx, func() { q.feature.Controller = nil })
		setEditorSubmitter(nil)
		if ctx.HasUI() {
			_ = ctx.SetWidget(queueWidgetKey, nil)
		}
		return nil, nil
	})
	e.RegisterCommand("queue", sdk.CommandOptions{
		Description: "Toggle or inspect the aio queue UI (on|off|status). Enter on an empty input interrupts the agent and sends the next queued message.",
		Handler: func(ctx sdk.Context, args string) error {
			var message, level string
			q.run(&ctx, func() {
				var update bool
				message, level, update = q.feature.Command(args)
				if update {
					q.updateWidgetLocked()
				}
			})
			ctx.Notify(message, level)
			return nil
		},
	})
}
