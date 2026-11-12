package goals

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/btw"
	notify "github.com/danielboothcloud/pi-aio/go/internal/notifications"
)

// Host is what the state machine needs from PiG. go/aio adapts sdk.Context.
type Host interface {
	HasUI() bool
	Notify(message, level string)
	// SetStatus sets the footer status in a tone; "" clears it.
	SetStatus(text, tone string)
	// Persist appends an aio-goal entry with {goal} (nil clears).
	Persist(goal *Goal) error
	// Send sends an aio-goal-message custom message that triggers a turn
	// as a follow-up.
	Send(content string, display bool, details MessageDetails) error
	// Confirm asks a yes/no question; false when cancelled.
	Confirm(title, body string) bool
	IsIdle() bool
	Abort()
	// Review pieces: the session branch, the model, the call, and git.
	Branch() []json.RawMessage
	HasModel() bool
	Complete(systemPrompt, prompt string) (map[string]any, error)
	Exec(command string, args []string) (string, int, error)
	// Notification protocol: the run mode, the session id, an event on the
	// extension event bus, and withAgentPrompt's next prompt id.
	Mode() string
	SessionID() string
	Emit(event string, payload map[string]any)
	NextPromptID() int
}

// MessageDetails are the details of an aio-goal-message.
type MessageDetails struct {
	Kind string `json:"kind"` // "draft" or "continue"
	Text string `json:"text"`
}

// Machine is the /goal state: the goal, the pending draft, and the review
// flag. It is safe for concurrent use; host calls that wait for the user or
// the model run without the lock, as the TypeScript awaits do.
type Machine struct {
	mu        sync.Mutex
	goal      *Goal
	drafting  *string
	reviewing bool
	now       Clock
}

// NewMachine makes an empty machine. A nil clock uses time.Now.
func NewMachine(now Clock) *Machine {
	if now == nil {
		now = time.Now
	}
	return &Machine{now: now}
}

func (m *Machine) iso() string { return ISO(m.now()) }

// Snapshot returns a copy of the current goal and the draft flag.
func (m *Machine) Snapshot() (*Goal, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return copyGoal(m.goal), m.drafting != nil
}

func copyGoal(goal *Goal) *Goal {
	if goal == nil {
		return nil
	}
	c := *goal
	return &c
}

func (m *Machine) isActive() bool { return m.goal != nil && m.goal.Status == Active }

// refresh sets the footer status. The caller holds m.mu.
func (m *Machine) refresh(h Host) {
	if !h.HasUI() {
		return
	}
	text, tone := StatusText(m.goal, m.drafting != nil, m.reviewing)
	h.SetStatus(text, tone)
}

// publish refreshes the status and tells observers about the goal
// activity (goals/index.ts publish and emitGoalActivity). The caller holds m.mu.
func (m *Machine) publish(h Host, quietSettle bool) {
	m.refresh(h)
	status := "none"
	if m.goal != nil {
		status = string(m.goal.Status)
	}
	h.Emit(notify.GoalActivityEvent, notify.GoalActivityPayload(h.SessionID(), status, quietSettle))
}

// persist appends the goal state and publishes it (goals/index.ts persist).
// The caller holds m.mu.
func (m *Machine) persist(h Host, quietSettle bool) {
	_ = h.Persist(copyGoal(m.goal))
	m.publish(h, quietSettle)
}

// signal is emitNotification for a goal signal.
func signal(h Host, id, title, body string, preview string) {
	if !notify.SignalAllowed(h.Mode()) {
		return
	}
	replaces := true
	h.Emit(notify.NotificationEvent, notify.SignalPayload("goal", id, h.SessionID(), title, body, &preview, &replaces))
}

// attention is goals/index.ts attention: the paused goal needs the user.
// The caller holds m.mu.
func (m *Machine) attention(h Host, reason string) {
	if m.goal == nil {
		return
	}
	signal(h, m.goal.ID+":paused:"+m.goal.UpdatedAt, "Goal needs attention",
		"The goal is paused. Return to Pi to review the next action.", reason)
}

// agentConfirm is withAgentPrompt around h.Confirm.
func agentConfirm(h Host, kind, promptTitle, promptBody, preview, title, body string) bool {
	id := h.NextPromptID()
	emit := func(active bool) {
		h.Emit(notify.AgentPromptEvent, notify.AgentPromptPayload(kind, promptTitle, promptBody, &preview, id, h.SessionID(), active))
	}
	emit(true)
	defer emit(false)
	return h.Confirm(title, body)
}

func (m *Machine) markPaused(reason string) {
	if m.goal == nil {
		return
	}
	g := *m.goal
	g.Status, g.PauseReason, g.UpdatedAt = Paused, reason, m.iso()
	m.goal = &g
}

func (m *Machine) pause(h Host, reason string, notify bool) {
	if !m.isActive() {
		return
	}
	m.markPaused(reason)
	m.persist(h, true)
	if notify {
		m.attention(h, reason)
	}
	if h.HasUI() {
		level := "info"
		if notify {
			level = "warning"
		}
		h.Notify("Goal paused: "+reason+". Run /goal resume to continue.", level)
	}
}

// sendContinuation counts and sends one explicit continuation. The caller
// does not hold m.mu: Send can start a run that calls back.
func (m *Machine) sendContinuation(h Host) {
	m.mu.Lock()
	if !m.isActive() {
		m.mu.Unlock()
		return
	}
	g := *m.goal
	g.Continuations++
	g.UpdatedAt = m.iso()
	m.goal = &g
	m.persist(h, false)
	m.mu.Unlock()
	if err := h.Send(ContinuationPrompt(g), false, MessageDetails{Kind: "continue"}); err != nil {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.pause(h, "could not continue: "+err.Error(), true)
	}
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// ToolError is a thrown tool error (the model sees an error result).
type ToolError string

func (e ToolError) Error() string { return string(e) }

// Propose is goal_propose. It returns the result text or a ToolError.
func (m *Machine) Propose(h Host, objective, doneWhen string) (string, error) {
	m.mu.Lock()
	if m.drafting == nil {
		m.mu.Unlock()
		return "", ToolError("No goal draft is waiting. Call goal_propose only after the user runs /goal <text>.")
	}
	m.mu.Unlock()
	objective, doneWhen = btw.Trim(objective), btw.Trim(doneWhen)
	if objective == "" {
		return "", ToolError("The objective is empty.")
	}
	if h.HasUI() {
		if !agentConfirm(h, "confirm", "Confirm goal", "The agent is waiting for you to confirm the goal.", objective,
			"Start this goal?", objective+"\n\nDone when:\n"+orNotSpecified(doneWhen)) {
			return "The user did not start this goal. Ask the user what to change, then call goal_propose again. Stop if they no longer want the goal.", nil
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.drafting = nil
	g := NewGoal(objective, doneWhen, m.now())
	m.goal = &g
	m.persist(h, false)
	if h.HasUI() {
		h.Notify("Goal started: "+OneLine(objective, 70), "info")
	}
	return StartedText(g), nil
}

// Done is goal_done: one review call decides. aborted reports the tool
// call's cancellation. update streams the "Reviewing" progress text.
func (m *Machine) Done(h Host, summary string, aborted func() bool, update func(string)) (string, error) {
	m.mu.Lock()
	if !m.isActive() {
		m.mu.Unlock()
		return "", ToolError("No active goal. Call goal_done only while a /goal is active.")
	}
	target := *m.goal
	m.reviewing = true
	m.refresh(h)
	m.mu.Unlock()
	if update != nil {
		update("Reviewing the goal…")
	}
	outcome := ReviewGoal(ReviewInput{
		Goal: target, Summary: summary, Branch: h.Branch(), HasModel: h.HasModel(),
		Complete: h.Complete, Exec: h.Exec, Aborted: aborted,
	})
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reviewing = false
	m.refresh(h)
	if m.goal == nil || m.goal.ID != target.ID || m.goal.Status != Active {
		return "The goal changed during the review, so the review result was discarded.", nil
	}
	if outcome.Verdict == nil {
		if aborted != nil && aborted() {
			return "The review was aborted.", nil
		}
		m.pause(h, "review failed: "+outcome.Error, true)
		return "The review could not run: " + outcome.Error + "\nThe goal is paused. Tell the user and stop.", nil
	}
	verdict := outcome.Verdict
	g := *m.goal
	if verdict.Approved {
		g.Status, g.Summary, g.LastReview, g.Rejections, g.PauseReason, g.UpdatedAt = Done, &summary, verdict.Reason, 0, "", m.iso()
		m.goal = &g
		m.persist(h, false)
		signal(h, g.ID+":complete", "Goal complete", "The goal has been marked complete.", g.Objective)
		if h.HasUI() {
			h.Notify("Goal complete: "+OneLine(g.Objective, 70), "info")
		}
		return "Review approved: " + verdict.Reason + "\nThe goal is complete. Give the user a short final summary and stop.", nil
	}
	g.Rejections++
	g.LastReview, g.UpdatedAt = verdict.Reason, m.iso()
	m.goal = &g
	if g.Rejections >= MaxRejections {
		reason := fmt.Sprintf("the review rejected the completion %d times", MaxRejections)
		m.markPaused(reason)
		m.persist(h, true)
		m.attention(h, reason)
		if h.HasUI() {
			h.Notify("Goal paused: "+reason+". Run /goal resume to continue.", "warning")
		}
		return fmt.Sprintf("Review rejected: %s\nThe goal is paused after %d rejected reviews. Explain the open points to the user and stop.", verdict.Reason, MaxRejections), nil
	}
	m.persist(h, false)
	return "Review rejected: " + verdict.Reason + "\nContinue working on the open points, then call goal_done again.", nil
}

// Blocked is goal_blocked.
func (m *Machine) Blocked(h Host, reason string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.isActive() {
		return "", ToolError("No active goal. Call goal_blocked only while a /goal is active.")
	}
	text := OneLine(reason, 200)
	if text == "" {
		text = "blocked"
	}
	m.pause(h, text, true)
	return "The goal is paused. Ask the user for what you need, then stop. The user runs /goal resume to continue.", nil
}

// ---------------------------------------------------------------------------
// /goal command
// ---------------------------------------------------------------------------

// Command runs /goal with its raw arguments. Abort and Send run without the
// lock: they start or stop a run, which can call back into this machine.
func (m *Machine) Command(h Host, args string) error {
	command := ParseArgs(args)
	m.mu.Lock()
	switch command.Kind {
	case "status":
		switch {
		case m.goal != nil:
			h.Notify(DescribeGoal(*m.goal), "info")
		case m.drafting != nil:
			h.Notify("Goal draft waiting for the agent: "+OneLine(*m.drafting, 120), "info")
		default:
			h.Notify("No goal. Use /goal <what you want done> to start one.", "info")
		}
		m.mu.Unlock()
	case "pause":
		if !m.isActive() {
			m.mu.Unlock()
			h.Notify("No active goal to pause.", "info")
			return nil
		}
		m.markPaused("paused by the user")
		m.persist(h, true)
		m.mu.Unlock()
		if !h.IsIdle() {
			h.Abort()
		}
		h.Notify("Goal paused. Run /goal resume to continue.", "info")
	case "resume":
		if m.isActive() {
			m.mu.Unlock()
			h.Notify("The goal is already active.", "info")
			return nil
		}
		if m.goal == nil || m.goal.Status != Paused {
			m.mu.Unlock()
			h.Notify("No paused goal to resume.", "info")
			return nil
		}
		g := *m.goal
		g.Status, g.PauseReason, g.Continuations, g.Rejections, g.UpdatedAt = Active, "", 0, 0, m.iso()
		m.goal = &g
		m.persist(h, false)
		m.mu.Unlock()
		h.Notify("Goal resumed: "+OneLine(g.Objective, 70), "info")
		// A running turn continues through agent_before_settle; an idle
		// session needs one explicit continuation.
		if h.IsIdle() {
			m.sendContinuation(h)
		}
	case "cancel":
		if m.goal == nil && m.drafting == nil {
			m.mu.Unlock()
			h.Notify("No goal to cancel.", "info")
			return nil
		}
		wasActive := m.isActive()
		m.goal, m.drafting = nil, nil
		m.persist(h, true)
		m.mu.Unlock()
		if wasActive && !h.IsIdle() {
			h.Abort()
		}
		h.Notify("Goal cleared.", "info")
	case "start":
		if m.goal != nil && m.goal.Status != Done {
			if h.HasUI() {
				objective := m.goal.Objective
				m.mu.Unlock()
				replace := h.Confirm("Replace the current goal?", OneLine(objective, 200))
				m.mu.Lock()
				if !replace {
					m.mu.Unlock()
					return nil
				}
			}
			m.goal = nil
			m.persist(h, true)
		}
		text := command.Text
		m.drafting = &text
		m.publish(h, false)
		m.mu.Unlock()
		return h.Send(DraftPrompt(text), true, MessageDetails{Kind: "draft", Text: text})
	default:
		m.mu.Unlock()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Loop lifecycle
// ---------------------------------------------------------------------------

// BoundaryResult is the agent_before_settle reply. Handled false means no
// reply (the handler returned undefined).
type BoundaryResult struct {
	Handled  bool
	Entries  []any
	Continue bool
}

func stateEntry(goal Goal) map[string]any {
	return map[string]any{"type": "custom", "customType": StateEntry, "data": map[string]any{"goal": goal}}
}

// BeforeSettle is agent_before_settle: while the goal is active it adds the
// state entry and one hidden continuation and asks for one more run.
func (m *Machine) BeforeSettle(h Host, outcome string, entries []any) BoundaryResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.isActive() || outcome == "aborted" { // agent_settled pauses an aborted run
		return BoundaryResult{}
	}
	out := append([]any{}, entries...)
	stop := func(reason string) BoundaryResult {
		m.markPaused(reason)
		out = append(out, stateEntry(*m.goal))
		m.publish(h, true)
		m.attention(h, reason)
		if h.HasUI() {
			h.Notify("Goal paused: "+reason+". Run /goal resume to continue.", "warning")
		}
		return BoundaryResult{Handled: true, Entries: out}
	}
	if outcome == "error" {
		return stop("the model stopped with an error")
	}
	if m.goal.Continuations >= MaxContinuations {
		return stop(fmt.Sprintf("reached %d automatic continuations", MaxContinuations))
	}
	g := *m.goal
	g.Continuations++
	g.UpdatedAt = m.iso()
	m.goal = &g
	out = append(out, stateEntry(g), map[string]any{
		"type":       "custom_message",
		"customType": MessageType,
		"content":    ContinuationPrompt(g),
		"display":    false,
		"details":    MessageDetails{Kind: "continue"},
	})
	m.publish(h, false)
	return BoundaryResult{Handled: true, Entries: out, Continue: true}
}

// Settled is agent_settled: an aborted run pauses the goal.
func (m *Machine) Settled(h Host, aborted bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if aborted && m.isActive() {
		m.pause(h, "stopped with Esc", false)
	}
}

// SessionStart restores the newest goal; an active goal is held paused.
func (m *Machine) SessionStart(h Host, entries []json.RawMessage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.drafting, m.reviewing = nil, false
	m.goal = LatestGoal(entries)
	if m.isActive() {
		m.markPaused("session reopened")
		m.persist(h, true)
		if h.HasUI() {
			h.Notify("Goal paused: "+OneLine(m.goal.Objective, 70)+". Run /goal resume to continue.", "info")
		}
		return
	}
	m.publish(h, false)
}

// Shutdown forgets the state and clears the status.
func (m *Machine) Shutdown(h Host) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.goal, m.drafting, m.reviewing = nil, nil, false
	if h.HasUI() {
		h.SetStatus("", "")
	}
}
