package yamlhooks

// Feature layer (port of yaml-hooks/index.ts, host-adapter.ts, registry.ts,
// session-lifecycle.ts, prompt-support.ts): the event handlers the PiG
// wiring calls with a Host for the current request.

import (
	"strings"
	"sync"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Host is the per-request host surface (one sdk.Context).
type Host interface {
	Cwd() string
	HasUI() bool
	// SessionID is "" when the session id cannot be read.
	SessionID() string
	// SessionHeader is nil when the header cannot be read.
	SessionHeader() *SessionHeader
	Notify(text, level string)
	// Confirm returns the answer, or an error for a UI failure.
	Confirm(title, message string) (bool, error)
	// SetStatus sets a status; nil text clears it.
	SetStatus(key string, text *string)
	SendUserMessage(text, deliverAs string) error
	SendDiagnostics(content string, details *Object) error
	EmitAgentPrompt(data *Object)
	Reload() error
}

// Options configures the feature (RegisterYamlHooksOptions).
type Options struct {
	Paths                   Paths
	SynchronousBashBudgetMs *float64
	ExecuteBash             ExecuteBashFunc
	Now                     func() float64
	// DeletedMarkerTTL is how long a session.deleted dedupe marker lives
	// (5 s in TypeScript).
	DeletedMarkerTTL time.Duration
}

// Feature is the registered yaml-hooks feature.
type Feature struct {
	opts     Options
	mu       sync.Mutex
	runtimes map[string]*Runtime
	last     Host
	warned   map[string]bool
	deleted  map[string]bool
	promptID int
}

// New is registerYamlHooks without the SDK wiring.
func New(o Options) *Feature {
	if o.DeletedMarkerTTL == 0 {
		o.DeletedMarkerTTL = 5 * time.Second
	}
	return &Feature{opts: o, runtimes: map[string]*Runtime{}, warned: map[string]bool{}, deleted: map[string]bool{}}
}

// Paths returns the configured paths.
func (f *Feature) Paths() Paths { return f.opts.Paths }

func (f *Feature) remember(h Host) {
	f.mu.Lock()
	f.last = h
	f.mu.Unlock()
}

func (f *Feature) current() Host {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.last
}

// RuntimeFor is registry.getRuntimeFor.
func (f *Feature) RuntimeFor(cwd string) *Runtime {
	f.mu.Lock()
	defer f.mu.Unlock()
	if rt := f.runtimes[cwd]; rt != nil {
		return rt
	}
	rt := NewRuntime(RuntimeOptions{
		Paths: f.opts.Paths, ProjectDir: cwd, Host: adapter{f},
		SynchronousBashBudgetMs: f.opts.SynchronousBashBudgetMs, Now: f.opts.Now, ExecuteBash: f.opts.ExecuteBash,
	})
	f.runtimes[cwd] = rt
	return rt
}

// WaitAsync waits for the async hooks of every runtime (tests).
func (f *Feature) WaitAsync() {
	f.mu.Lock()
	list := make([]*Runtime, 0, len(f.runtimes))
	for _, rt := range f.runtimes {
		list = append(list, rt)
	}
	f.mu.Unlock()
	for _, rt := range list {
		rt.WaitAsync()
	}
}

func (f *Feature) warnOnce(key, message string) {
	f.mu.Lock()
	seen := f.warned[key]
	f.warned[key] = true
	f.mu.Unlock()
	if !seen {
		console("warn", "[aio yaml hooks] "+message)
	}
}

// ---- host adapter (host-adapter.ts) ----

type adapter struct{ f *Feature }

func (a adapter) Abort(string) {}

func (a adapter) RootSessionID(sessionID string) string {
	h := a.f.current()
	if h == nil {
		return sessionID
	}
	return GetRootSessionID(sessionID, h.SessionHeader())
}

func (a adapter) SendPrompt(sessionID, text string) (Delivery, error) {
	h := a.f.current()
	current := ""
	if h != nil {
		current = h.SessionID()
	}
	if current == "" || current != sessionID {
		details := NewObject("requestedSessionId", sessionID)
		if current != "" {
			details.Set("currentSessionId", current)
		}
		return Delivery{Status: "degraded", Reason: "current_session_only", Details: details}, nil
	}
	if err := h.SendUserMessage(text, "followUp"); err != nil {
		return Delivery{}, nodeErr{"sendUserMessage failed: " + err.Error()}
	}
	return Delivery{Status: "accepted"}, nil
}

func (a adapter) Notify(text, level string) (Delivery, error) {
	h := a.f.current()
	if h == nil || !h.HasUI() {
		a.f.warnOnce("no_notify", "notify action skipped: Pi UI surface unavailable for this context.")
		if level == "" {
			level = "info"
		}
		return Delivery{Status: "degraded", Reason: "ui_unavailable", Details: NewObject("text", text, "level", level)}, nil
	}
	piLevel := "info"
	if level == "warning" || level == "error" {
		piLevel = level
	}
	h.Notify(text, piLevel)
	return Delivery{Status: "accepted"}, nil
}

func (a adapter) Confirm(title *string, message string, _ *float64) bool {
	h := a.f.current()
	if h == nil || !h.HasUI() {
		if envConfirmAutoApprove() {
			return true
		}
		a.f.warnOnce("no_confirm", "confirm action denied: Pi UI surface unavailable for this context. confirm hooks fail closed in headless mode. Set PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE=1 to override.")
		return false
	}
	t := "Confirm"
	if title != nil {
		t = *title
	}
	a.f.mu.Lock()
	a.f.promptID++
	id := a.f.promptID
	a.f.mu.Unlock()
	emit := func(active bool) {
		defer func() { _ = recover() }()
		h.EmitAgentPrompt(NewObject("kind", "confirm", "title", "Hook confirmation needed",
			"body", "An automation hook is waiting for your confirmation.", "preview", message,
			"id", float64(id), "sessionId", h.SessionID(), "active", active))
	}
	emit(true)
	defer emit(false)
	approved, err := h.Confirm(t, message)
	return err == nil && approved
}

func (a adapter) SetStatus(hookID, text string) (Delivery, error) {
	h := a.f.current()
	if h == nil || !h.HasUI() {
		a.f.warnOnce("no_set_status", "setStatus action skipped: Pi UI surface unavailable for this context.")
		return Delivery{Status: "degraded", Reason: "ui_unavailable", Details: NewObject("hookId", hookID, "text", text)}, nil
	}
	if text == "" {
		h.SetStatus(hookID, nil)
	} else {
		h.SetStatus(hookID, &text)
	}
	return Delivery{Status: "accepted"}, nil
}

// ---- session lifecycle (session-lifecycle.ts) ----

func (f *Feature) markDeleted(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleted[id] {
		return false
	}
	f.deleted[id] = true
	time.AfterFunc(f.opts.DeletedMarkerTTL, func() {
		f.mu.Lock()
		delete(f.deleted, id)
		f.mu.Unlock()
	})
	return true
}

// SessionStart handles session_start: only startup and new sessions fire
// session.created (fail-open).
func (f *Feature) SessionStart(h Host, reason string) {
	f.remember(h)
	if reason != "new" && reason != "startup" {
		return
	}
	id := h.SessionID()
	if id == "" {
		return
	}
	func() {
		defer func() { _ = recover() }()
		_ = f.RuntimeFor(h.Cwd()).SessionCreated(id)
	}()
}

// SessionEnd handles session_before_switch and session_shutdown: one
// best-effort session.deleted per session id.
func (f *Feature) SessionEnd(h Host, reason string) {
	f.remember(h)
	id := h.SessionID()
	if id == "" || !f.markDeleted(id) {
		return
	}
	func() {
		defer func() { _ = recover() }()
		_ = f.RuntimeFor(h.Cwd()).SessionDeleted(id)
	}()
}

// SessionIdle dispatches session.idle (the runtime event; Pi wires no
// SDK event to it).
func (f *Feature) SessionIdle(h Host, sessionID string) error {
	f.remember(h)
	return f.RuntimeFor(h.Cwd()).SessionIdle(sessionID)
}

// ToolCall handles tool_call; it returns the block reason when blocked.
func (f *Feature) ToolCall(h Host, tool, callID string, input *Object) (string, bool) {
	f.remember(h)
	id := h.SessionID()
	if id == "" {
		return "", false
	}
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = nodeErr{errorText(r)}
			}
		}()
		err = f.RuntimeFor(h.Cwd()).ToolExecuteBefore(tool, id, callID, input)
	}()
	if err != nil {
		return err.Error(), true
	}
	return "", false
}

// ToolResult handles tool_result (fail-open).
func (f *Feature) ToolResult(h Host, tool, callID string, input *Object) {
	f.remember(h)
	id := h.SessionID()
	if id == "" {
		return
	}
	func() {
		defer func() { _ = recover() }()
		_ = f.RuntimeFor(h.Cwd()).ToolExecuteAfter(tool, id, callID, input)
	}()
}

// ---- prompt support (prompt-support.ts) ----

const promptContextPrefix = "Context from aio yaml hooks user.prompt.submit:"

// BeforeAgentStart handles before_agent_start. It returns the new system
// prompt and true when the handler returns a result.
func (f *Feature) BeforeAgentStart(h Host, messageType, prompt, systemPrompt string) (string, bool) {
	if messageType != "user" {
		return "", false
	}
	blocks, ok := f.buildPromptBlocks(h, prompt)
	if !ok {
		return systemPrompt, true
	}
	if len(blocks) == 0 {
		return "", false
	}
	return strings.Join(append([]string{jsstr.TrimEnd(systemPrompt)}, blocks...), "\n\n"), true
}

func (f *Feature) buildPromptBlocks(h Host, prompt string) (blocks []string, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			reportPromptDispatchFailure()
			blocks, ok = nil, false
		}
	}()
	awareness, hasAwareness := BuildAwareness(f.opts.Paths, h.Cwd(), h.HasUI())
	id := h.SessionID()
	if id == "" {
		reportPromptDispatchFailure()
		return nil, false
	}
	contexts, err := f.RuntimeFor(h.Cwd()).UserPromptSubmit(id, prompt)
	if err != nil {
		reportPromptDispatchFailure()
		return nil, false
	}
	if hasAwareness {
		blocks = append(blocks, awareness)
	}
	for _, c := range contexts {
		blocks = append(blocks, promptContextPrefix+"\n"+c)
	}
	return blocks, true
}

func reportPromptDispatchFailure() {
	console("error", "[aio yaml hooks] Prompt submission hooks failed; continuing without injected context.")
}

// BuildAwareness is prompt-support.ts buildHookAwarenessSystemPrompt.
func BuildAwareness(p Paths, cwd string, hasUI bool) (string, bool) {
	if isEnvDisabled("PI_YAML_HOOKS_PROMPT_AWARENESS") {
		return "", false
	}
	loaded := LoadDiscoveredHooks(LoadOptions{Paths: p, ProjectDir: cwd})
	summary := SummarizeSources(loaded.Sources)
	if summary.Total == 0 && len(loaded.Errors) == 0 {
		return "", false
	}
	// TypeScript resolves the config paths without a project directory, so
	// the project line always reports that no project hook file is present.
	paths := resolveHookConfigPaths(p, "")
	global := paths.Global
	if global == "" {
		global = "none"
	}
	lines := []string{
		"Hook-awareness for this session (aio yaml hooks):",
		"- active hook config (global): " + global,
	}
	if paths.Project != "" {
		lines = append(lines, "- project hook config: "+paths.Project+" (trusted and active when loaded)")
	} else {
		lines = append(lines, "- no project hook file is present for this repo/worktree scope")
	}
	if len(loaded.Errors) > 0 {
		lines = append(lines, "- current hook files have "+itoa(len(loaded.Errors))+" validation issue(s); use /hooks-validate for the exact errors")
	} else {
		lines = append(lines, "- loaded "+itoa(summary.Total)+" hooks ("+itoa(summary.Global)+" global, "+itoa(summary.Project)+" project)")
	}
	lines = append(lines,
		"- command actions are unsupported; prefer bash-backed hooks",
		"- tool actions inject a follow-up prompt into the current session only; they cannot target other sessions",
		"- synchronous bash hooks inherit a 60s per-turn budget via PI_YAML_HOOKS_* env (see docs)",
	)
	if !hasUI {
		lines = append(lines, "- UI is unavailable in this mode: notify/setStatus degrade and confirm denies by default")
	}
	return strings.Join(lines, "\n"), true
}

func itoa(n int) string { return jsstr.NumberJS(float64(n)) }
