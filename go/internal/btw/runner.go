package btw

import (
	"encoding/json"
	"strconv"
	"sync"

	notify "github.com/danielboothcloud/pi-aio/go/internal/notifications"
)

// DefaultAnswerCardMs is how long the answered card stays above the editor.
const DefaultAnswerCardMs = 60_000

// Host is what the /btw runner needs from PiG. go/aio adapts sdk.Context.
type Host interface {
	HasUI() bool
	IsTUI() bool
	Notify(message, level string)
	// SetStatus sets the footer status; "" clears it.
	SetStatus(text string)
	// ShowCard installs the above-editor card; ClearCard removes it.
	ShowCard(card Card)
	ClearCard()
	// StartCardTimer clears the card after ms unless StopCardTimer runs first.
	StartCardTimer(ms float64)
	StopCardTimer()
	AppendEntry(data EntryData) error
	// Now is the wall clock in milliseconds.
	Now() float64
	// SessionID and Emit carry the notification signals (pi.events.emit).
	SessionID() string
	Emit(event string, payload map[string]any)
}

// signal is emitNotification for a /btw outcome (notifications/protocol.ts):
// a background signal, sent only in the TUI and never from a child.
func signal(h Host, run *Run, title, body, preview string) {
	mode := ""
	if h.IsTUI() {
		mode = "tui"
	}
	if !notify.SignalAllowed(mode) {
		return
	}
	h.Emit(notify.NotificationEvent, notify.SignalPayload("background", "btw:"+strconv.Itoa(run.Seq), h.SessionID(), title, body, &preview, nil))
}

// AskInput is the context of one side question.
type AskInput struct {
	Branch   func() []json.RawMessage
	Cwd      string
	Complete CompleteFunc
}

// Run is one side question in flight.
type Run struct {
	Seq       int
	Question  string
	Model     string // "provider/id"
	MidFlow   bool
	StartedAt float64
}

// Runner is the /btw state: the newest question wins.
type Runner struct {
	mu           sync.Mutex
	seq          int
	active       *Run
	answerCardMs float64
	layout       Layout
}

// NewRunner makes a runner. answerCardMs < 0 uses DefaultAnswerCardMs.
func NewRunner(layout Layout, answerCardMs float64) *Runner {
	if answerCardMs < 0 {
		answerCardMs = DefaultAnswerCardMs
	}
	return &Runner{layout: layout, answerCardMs: answerCardMs}
}

// Current reports whether run is still the active question.
func (r *Runner) Current(run *Run) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active == run
}

func (r *Runner) syncAsking(h Host, run *Run) {
	if !h.HasUI() {
		return
	}
	if run == nil {
		h.SetStatus("")
		return
	}
	h.SetStatus(StatusAskingLine(ModelID(run.Model)))
}

// Command runs /btw. model is "provider/id" ("" when no model is active)
// and midFlow reports a streaming run. It returns the run to ask in the
// background, or nil.
func (r *Runner) Command(h Host, args, model string, midFlow bool) *Run {
	question := Slice16(Trim(args), MaxQuestionChars)
	r.mu.Lock()
	defer r.mu.Unlock()
	if question == "" {
		modelID := ""
		if r.active != nil {
			modelID = ModelID(r.active.Model)
		}
		h.Notify(UsageLine(r.active != nil, modelID), "info")
		return nil
	}
	if model == "" {
		h.Notify("btw — no model is active; pick one with /model first.", "warning")
		return nil
	}
	// Last wins: a newer question replaces the older run.
	r.active = nil
	h.StopCardTimer()
	r.seq++
	run := &Run{Seq: r.seq, Question: question, Model: model, MidFlow: midFlow, StartedAt: h.Now()}
	r.active = run
	r.syncAsking(h, run)
	if h.HasUI() && h.IsTUI() {
		h.StopCardTimer()
		h.ShowCard(Card{Pending: true, Question: question, Model: model, StartedAt: run.StartedAt})
	}
	return run
}

// Ask builds the context, runs the side question, and shows the outcome.
// It blocks; call it from a goroutine. A replaced run shows nothing.
func (r *Runner) Ask(h Host, run *Run, in AskInput) {
	digest := BuildFlowDigest(in.Branch(), FlowDigestOptions{})
	snapshot := BuildProjectSnapshot(in.Cwd, SnapshotOptions{})
	if !r.Current(run) {
		return
	}
	prompt := BuildPrompt(PromptInput{Question: run.Question, FlowDigest: digest, ProjectSnapshot: snapshot})
	started := h.Now()
	outcome := RunSideQuestion(prompt, in.Complete, func() bool { return !r.Current(run) })
	latency := h.Now() - started
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active != run {
		return
	}
	r.finish(h, run, outcome, latency)
}

// finish surfaces the outcome of the active run. The caller holds r.mu.
func (r *Runner) finish(h Host, run *Run, outcome Outcome, latencyMs float64) {
	r.active = nil
	r.syncAsking(h, nil)
	tui := h.HasUI() && h.IsTUI()
	if outcome.Error != "" {
		signal(h, run, "Side question failed", "The background side question could not be answered.", outcome.Error)
		h.StopCardTimer()
		if tui {
			h.ClearCard()
		}
		if h.HasUI() {
			h.Notify("btw — "+outcome.Error, "warning")
		}
		return
	}
	now := h.Now()
	data := EntryData{
		Question: run.Question, Answer: outcome.Answer, Model: run.Model, AnsweredMidFlow: run.MidFlow,
		Usage: outcome.Usage, LatencyMs: latencyMs, Timestamp: now,
	}
	_ = h.AppendEntry(data)
	signal(h, run, "Side answer ready", "Your /btw answer is ready in Pi.", outcome.Answer)
	if h.HasUI() {
		h.Notify(ToastText(r.layout, data), "info")
	}
	if r.answerCardMs > 0 {
		if tui {
			h.StopCardTimer()
			h.ShowCard(Card{Question: run.Question, Answer: outcome.Answer, AnsweredAt: now, DismissAt: now + r.answerCardMs})
			h.StartCardTimer(r.answerCardMs)
		}
	} else if tui {
		h.ClearCard()
	}
}

// Shutdown drops the active run and clears the surfaces.
func (r *Runner) Shutdown(h Host) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active = nil
	if h == nil {
		return
	}
	h.StopCardTimer()
	if h.HasUI() && h.IsTUI() {
		h.ClearCard()
	}
	if h.HasUI() {
		h.SetStatus("")
	}
}
