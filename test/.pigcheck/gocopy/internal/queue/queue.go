// Package queue is the Go port of queue/: a mirror of the host's pending
// message queue, the "Enter on empty input interrupts and sends the next
// queued message" controller, the queue widget and frame panel rows, and
// the queue editor's key decisions. The PiG wiring is in go/aio/queue.go.
package queue

import "slices"

// Mode is QueueMode: "steer" or "followUp".
type Mode = string

// Message is QueuedMessage.
type Message struct {
	Text string `json:"text"`
	Mode Mode   `json:"mode"`
}

// Mirror is QueueMirror: steering FIFO, then follow-up FIFO.
type Mirror struct {
	steering, followUp []string
}

// Size is size.
func (m *Mirror) Size() int { return len(m.steering) + len(m.followUp) }

// IsEmpty is isEmpty.
func (m *Mirror) IsEmpty() bool { return m.Size() == 0 }

// Add is add.
func (m *Mirror) Add(text string, mode Mode) {
	if mode == "steer" {
		m.steering = append(m.steering, text)
	} else {
		m.followUp = append(m.followUp, text)
	}
}

// RemoveDelivered is removeDelivered: the first exact match, steering
// first; "" on a miss.
func (m *Mirror) RemoveDelivered(text string) Mode {
	if i := slices.Index(m.steering, text); i >= 0 {
		m.steering = slices.Delete(m.steering, i, i+1)
		return "steer"
	}
	if i := slices.Index(m.followUp, text); i >= 0 {
		m.followUp = slices.Delete(m.followUp, i, i+1)
		return "followUp"
	}
	return ""
}

// Remove is remove: the first exact match in the entry's own queue.
func (m *Mirror) Remove(entry Message) bool {
	queue := &m.followUp
	if entry.Mode == "steer" {
		queue = &m.steering
	}
	i := slices.Index(*queue, entry.Text)
	if i < 0 {
		return false
	}
	*queue = slices.Delete(*queue, i, i+1)
	return true
}

// Next is next.
func (m *Mirror) Next() (Message, bool) {
	if len(m.steering) > 0 {
		return Message{m.steering[0], "steer"}, true
	}
	if len(m.followUp) > 0 {
		return Message{m.followUp[0], "followUp"}, true
	}
	return Message{}, false
}

// RemoveNext is removeNext.
func (m *Mirror) RemoveNext() (Message, bool) {
	next, ok := m.Next()
	if ok {
		m.Remove(next)
	}
	return next, ok
}

// Entries is entries.
func (m *Mirror) Entries() []Message {
	out := []Message{}
	for _, t := range m.steering {
		out = append(out, Message{t, "steer"})
	}
	for _, t := range m.followUp {
		out = append(out, Message{t, "followUp"})
	}
	return out
}

// Clear is clear: it returns the pending entries.
func (m *Mirror) Clear() []Message {
	entries := m.Entries()
	m.steering, m.followUp = nil, nil
	return entries
}

// Deps is QueueControllerDeps.
type Deps struct {
	IsIdle               func() bool
	HasPendingMessages   func() bool
	Abort                func()
	ClearEditor          func()
	RestoreTextsToEditor func(texts []string)
	SendUserMessage      func(text string, mode Mode)
	Notify               func(message, level string)
	UpdateWidget         func()
}

// Controller is QueueController (see queue/controller.ts for the flow).
type Controller struct {
	Mirror      Mirror
	deps        Deps
	requeue     []Message
	pendingNext *Message
}

// NewController returns a controller over deps.
func NewController(deps Deps) *Controller { return &Controller{deps: deps} }

// FlowBusy is flowBusy.
func (c *Controller) FlowBusy() bool { return c.pendingNext != nil || len(c.requeue) > 0 }

// HandleQueuedInput is handleQueuedInput.
func (c *Controller) HandleQueuedInput(text string, mode Mode) {
	c.Mirror.Add(text, mode)
	c.deps.UpdateWidget()
}

// HandleUserMessageText is handleUserMessageText.
func (c *Controller) HandleUserMessageText(text string) {
	c.pendingNext = nil
	c.Mirror.RemoveDelivered(text)
	c.Resync()
}

// Resync is resync.
func (c *Controller) Resync() {
	if c.FlowBusy() {
		return
	}
	if !c.deps.HasPendingMessages() && !c.Mirror.IsEmpty() {
		c.Mirror.Clear()
	}
	c.deps.UpdateWidget()
}

// OnEmptySubmit is onEmptySubmit: true when the key was consumed.
func (c *Controller) OnEmptySubmit() bool {
	if c.deps.IsIdle() {
		if c.FlowBusy() {
			c.restoreOrphans()
			return true
		}
		c.Resync()
		return false
	}
	if c.FlowBusy() {
		return true
	}
	next, ok := c.Mirror.RemoveNext()
	if !ok {
		if !c.deps.HasPendingMessages() {
			c.Mirror.Clear()
		}
		c.deps.UpdateWidget()
		return false
	}
	c.requeue = c.Mirror.Entries()
	c.pendingNext = &next
	c.deps.Abort()
	c.deps.ClearEditor()
	c.deps.UpdateWidget()
	return true
}

// OnAgentStart is onAgentStart.
func (c *Controller) OnAgentStart() {
	if len(c.requeue) == 0 {
		return
	}
	items := c.requeue
	c.requeue = nil
	for _, item := range items {
		c.Mirror.Remove(item)
		c.deps.SendUserMessage(item.Text, item.Mode)
	}
	c.deps.UpdateWidget()
}

// OnAgentSettled is onAgentSettled.
func (c *Controller) OnAgentSettled() {
	if c.pendingNext != nil && c.deps.IsIdle() {
		c.deps.SendUserMessage(c.pendingNext.Text, "steer")
		return
	}
	c.restoreOrphans()
}

func (c *Controller) restoreOrphans() {
	orphaned := c.requeue
	c.requeue = nil
	lostNext := c.pendingNext
	c.pendingNext = nil
	if len(orphaned) > 0 || lostNext != nil {
		var texts []string
		for _, e := range c.Mirror.Clear() {
			texts = append(texts, e.Text)
		}
		if lostNext != nil && !slices.Contains(texts, lostNext.Text) {
			texts = append([]string{lostNext.Text}, texts...)
		}
		c.deps.RestoreTextsToEditor(texts)
		c.deps.Notify("Queue interrupt did not start a run; pending messages restored to the editor", "warning")
	}
	c.Resync()
}
