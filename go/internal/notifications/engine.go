package notifications

// Engine is the decision logic of registerNotifications: which events turn
// into a delivery request. Delivery (focus check, backend, validity) runs
// outside, in go/aio, and asks Valid before it acts.

import (
	"strconv"
	"sync"
)

// Delivery is one request to show a notification.
type Delivery struct {
	Category string
	Title    string
	Body     string
	Preview  string
	// Prompt is the agent prompt ID, or 0.
	Prompt int
	// Force skips the enabled/category settings and the focus check.
	Force bool
	// Settlement marks a finished-run notice: it is void once a new run starts.
	Settlement bool
	epoch      int
	runVersion int
}

// Prompt is an agent-owned dialog signal.
type Prompt struct {
	ID        int    `json:"id"`
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	Preview   string `json:"preview"`
	Active    bool   `json:"active"`
}

// Signal is a notification from another feature.
type Signal struct {
	Category           string `json:"category"`
	ID                 string `json:"id"`
	SessionID          string `json:"sessionId"`
	Title              string `json:"title"`
	Body               string `json:"body"`
	Preview            string `json:"preview"`
	ReplacesCompletion bool   `json:"replacesCompletion"`
}

// Engine holds the session state.
type Engine struct {
	mu           sync.Mutex
	Settings     Settings
	SessionID    string
	tui          bool
	hasCtx       bool
	epoch        int
	running      bool
	runVersion   int
	startedAt    float64
	lastText     string
	lastStop     string
	suppress     bool
	goalSession  string
	goalActive   bool
	goalSet      bool
	ownedPrompts map[int]Prompt
	seen         []string
}

// NewEngine returns an engine with the given settings and no session.
func NewEngine(settings Settings) *Engine {
	return &Engine{Settings: settings, ownedPrompts: map[int]Prompt{}}
}

// SessionStart resets the session state. tui is ctx.mode == "tui" && hasUI.
func (e *Engine) SessionStart(sessionID string, tui bool, settings Settings) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.epoch++
	e.SessionID, e.tui, e.Settings = sessionID, tui, settings
	e.hasCtx = true
	e.running, e.suppress = false, false
	e.ownedPrompts = map[int]Prompt{}
	e.seen = nil
}

// SessionShutdown ends the session.
func (e *Engine) SessionShutdown() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.epoch++
	e.tui, e.running, e.goalSet, e.hasCtx = false, false, false, false
	e.SessionID = ""
	e.ownedPrompts = map[int]Prompt{}
	e.seen = nil
}

// AgentStart marks a run start; now is milliseconds.
func (e *Engine) AgentStart(now float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.running {
		e.startedAt = now
		e.runVersion++
	}
	e.running = true
	e.lastText, e.lastStop = "", ""
}

// MessageEnd records the last assistant text and stop reason.
func (e *Engine) MessageEnd(stopReason, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.lastStop, e.lastText = stopReason, text
}

// request builds a delivery, or ok=false when settings or mode skip it.
func (e *Engine) request(d Delivery) (Delivery, bool) {
	if !e.tui {
		return Delivery{}, false
	}
	if !d.Force && (!e.Settings.Enabled || !e.Settings.Categories[d.Category]) {
		return Delivery{}, false
	}
	d.Settlement = d.Category == "core" && d.Prompt == 0 && !d.Force
	d.epoch, d.runVersion = e.epoch, e.runVersion
	return d, true
}

// Settled is agent_settled; now is milliseconds.
func (e *Engine) Settled(aborted bool, now float64) (Delivery, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	wasRunning := e.running
	e.running = false
	e.ownedPrompts = map[int]Prompt{}
	suppressed := e.suppress
	e.suppress = false
	if !wasRunning || suppressed || aborted || e.lastStop == "aborted" {
		return Delivery{}, false
	}
	if e.goalSet && e.goalSession == e.SessionID && e.goalActive {
		return Delivery{}, false
	}
	if e.lastStop == "error" {
		return e.request(Delivery{Category: "core", Title: "Run failed", Body: "The agent stopped with an error and needs your attention.", Preview: e.lastText})
	}
	if now-e.startedAt >= e.Settings.MinSeconds*1000 {
		return e.request(Delivery{Category: "core", Title: "Finished", Body: "The agent has finished and is ready for input.", Preview: e.lastText})
	}
	return Delivery{}, false
}

// PromptSignal handles an agent prompt start or end. A start returns a
// delivery that the caller sends after the current event finishes, if
// PromptStillOwned still holds.
func (e *Engine) PromptSignal(p Prompt) (Delivery, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if p.SessionID != e.SessionID {
		return Delivery{}, false
	}
	if !p.Active {
		delete(e.ownedPrompts, p.ID)
		return Delivery{}, false
	}
	if _, owned := e.ownedPrompts[p.ID]; owned {
		return Delivery{}, false
	}
	e.ownedPrompts[p.ID] = p
	return e.request(Delivery{Category: "core", Title: p.Title, Body: p.Body, Preview: p.Preview, Prompt: p.ID})
}

// PromptStillOwned reports whether a prompt is still open.
func (e *Engine) PromptStillOwned(id int) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.ownedPrompts[id]
	return ok
}

// GoalActivity records the goal loop's activity.
func (e *Engine) GoalActivity(sessionID string, active, quietSettle bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.hasCtx && sessionID != e.SessionID {
		return
	}
	e.goalSession, e.goalActive, e.goalSet = sessionID, active, true
	if sessionID == e.SessionID && quietSettle && e.running {
		e.suppress = true
	}
}

// NotificationSignal handles a signal from another feature.
func (e *Engine) NotificationSignal(s Signal) (Delivery, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.hasCtx || s.SessionID != e.SessionID || !e.Settings.Enabled || !e.Settings.Categories[s.Category] {
		return Delivery{}, false
	}
	key := s.Category + ":" + s.ID
	for _, k := range e.seen {
		if k == key {
			return Delivery{}, false
		}
	}
	e.seen = append(e.seen, key)
	if len(e.seen) > 100 {
		e.seen = e.seen[1:]
	}
	if s.ReplacesCompletion {
		e.suppress = true
	}
	return e.request(Delivery{Category: s.Category, Title: s.Title, Body: s.Body, Preview: s.Preview})
}

// Test is the delivery for /notify test.
func (e *Engine) Test() (Delivery, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.request(Delivery{Category: "core", Title: "Test", Body: "AIO desktop notification test.", Force: true})
}

// Valid reports whether a delivery still applies: same session epoch, an
// open prompt, no newer run for a settlement, and the settings still allow it.
func (e *Engine) Valid(d Delivery) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if d.epoch != e.epoch || !e.tui {
		return false
	}
	if d.Prompt != 0 {
		if _, ok := e.ownedPrompts[d.Prompt]; !ok {
			return false
		}
	}
	if d.Settlement && (e.running || d.runVersion != e.runVersion) {
		return false
	}
	return d.Force || (e.Settings.Enabled && e.Settings.Categories[d.Category])
}

// Notification builds the display data, frozen at request time.
func (e *Engine) Notification(d Delivery, subtitle string) Notification {
	e.mu.Lock()
	defer e.mu.Unlock()
	body := d.Body
	if e.Settings.Preview && d.Preview != "" {
		body = d.Preview
	}
	kind := d.Category
	if d.Prompt != 0 {
		kind = "prompt"
	}
	return Notification{Title: "Pi · " + d.Title, Body: body, Subtitle: CleanText(subtitle, 80), Group: Group(e.SessionID, kind), Sound: e.Settings.Sound}
}

// FocusSkip reports whether a delivery skips a focused terminal.
func (e *Engine) FocusSkip(d Delivery) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return !d.Force && e.Settings.FocusSkip
}

// String is a debug form of a delivery.
func (d Delivery) String() string {
	return d.Category + "|" + d.Title + "|" + d.Body + "|" + d.Preview + "|" + strconv.Itoa(d.Prompt)
}

// Notice is one ctx.ui.notify call.
type Notice struct{ Text, Level string }

// CommandOutcome is what /notify does: notices now, and an optional test
// delivery after TestDelay seconds.
type CommandOutcome struct {
	Notices   []Notice
	Test      *Delivery
	TestDelay float64
}

// HandleCommand runs /notify. mode is ctx.mode; save persists new settings.
func (e *Engine) HandleCommand(args, mode, backendName string, save func(Settings) error) CommandOutcome {
	e.mu.Lock()
	current := e.Settings
	e.mu.Unlock()
	cmd := ParseCommand(args, current)
	switch cmd.Kind {
	case "status":
		return CommandOutcome{Notices: []Notice{{Status(current, backendName), "info"}}}
	case "test":
		if mode != "tui" {
			return CommandOutcome{Notices: []Notice{{"Desktop notification tests require TUI mode.", "warning"}}}
		}
		if !cmd.TestValid {
			return CommandOutcome{Notices: []Notice{{"Usage: /notify test [seconds] (0–60).", "warning"}}}
		}
		out := CommandOutcome{TestDelay: cmd.TestSeconds}
		if cmd.TestSeconds > 0 {
			out.Notices = append(out.Notices, Notice{"Notification test scheduled in " + jsNumber(cmd.TestSeconds) + "s — switch to another app now.", "info"})
		}
		if d, ok := e.Test(); ok {
			out.Test = &d
		}
		return out
	case "invalid":
		return CommandOutcome{Notices: []Notice{{Usage, "warning"}}}
	}
	if err := save(cmd.Settings); err != nil {
		return CommandOutcome{Notices: []Notice{{"Could not save notification settings; previous settings retained.", "warning"}}}
	}
	e.mu.Lock()
	e.Settings = cmd.Settings
	e.epoch++ // cancels pending deliveries, as cancelPending does
	e.mu.Unlock()
	return CommandOutcome{Notices: []Notice{{"Notification settings saved.", "info"}}}
}

// TestOutcomeNotice is the follow-up notice after a test delivery.
// result is "dispatched" or "failed"; "skipped" gives none.
func TestOutcomeNotice(result, backendName string) (Notice, bool) {
	switch result {
	case "failed":
		return Notice{"Notification test failed before dispatch. Check /notify status and the terminal notification settings.", "warning"}, true
	case "dispatched":
		if len(backendName) >= 3 && backendName[:3] == "OSC" {
			return Notice{"Test dispatched via " + backendName + " terminal fallback, not confirmed by the OS. Ghostty may suppress it while focused: try /notify test 5 and switch apps. Check macOS notification permissions for your terminal. Native delivery requires terminal-notifier on PATH.", "warning"}, true
		}
		return Notice{"Test dispatched via " + backendName + "; OS display is not confirmed. If nothing appears, check macOS notification permissions and Focus / Do Not Disturb.", "info"}, true
	}
	return Notice{}, false
}
