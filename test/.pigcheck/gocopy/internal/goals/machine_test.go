package goals

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// quietHost is a minimal Host for state-machine tests.
type quietHost struct {
	mu      sync.Mutex
	hasUI   bool
	sends   []MessageDetails
	m       *Machine
	reenter bool
	reply   string
	notes   []string
}

func (h *quietHost) HasUI() bool { return h.hasUI }
func (h *quietHost) Notify(message, _ string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notes = append(h.notes, message)
}
func (h *quietHost) SetStatus(string, string)    {}
func (h *quietHost) Persist(*Goal) error         { return nil }
func (h *quietHost) Confirm(string, string) bool { return true }
func (h *quietHost) IsIdle() bool                { return true }
func (h *quietHost) Abort()                      {}
func (h *quietHost) Branch() []json.RawMessage   { return nil }
func (h *quietHost) HasModel() bool              { return true }
func (h *quietHost) Mode() string                { return "tui" }
func (h *quietHost) SessionID() string           { return "s" }
func (h *quietHost) Emit(string, map[string]any) {}
func (h *quietHost) NextPromptID() int           { return 1 }
func (h *quietHost) Exec(string, []string) (string, int, error) {
	return "", 0, nil
}
func (h *quietHost) Complete(string, string) (map[string]any, error) {
	return map[string]any{"stopReason": "stop", "content": []any{map[string]any{"type": "text", "text": h.reply}}}, nil
}

// Send can start a run whose settle boundary calls back into the machine
// before Send returns; the machine must not hold its lock here.
func (h *quietHost) Send(_ string, _ bool, details MessageDetails) error {
	h.sends = append(h.sends, details)
	if h.reenter {
		done := make(chan struct{})
		go func() { h.m.BeforeSettle(h, "completed", nil); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			return fmt.Errorf("deadlock: BeforeSettle blocked during Send")
		}
	}
	return nil
}

func activeMachine(t *testing.T, h *quietHost) *Machine {
	t.Helper()
	m := NewMachine(func() time.Time { return time.Unix(1_700_000_000, 0) })
	h.m = m
	if err := m.Command(h, "do it"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Propose(h, "Objective", "Done"); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestContinuationCapPausesAt50(t *testing.T) {
	h := &quietHost{}
	m := activeMachine(t, h)
	for i := 1; i <= MaxContinuations; i++ {
		r := m.BeforeSettle(h, "completed", nil)
		if !r.Continue || len(r.Entries) != 2 {
			t.Fatalf("continuation %d: %+v", i, r)
		}
	}
	r := m.BeforeSettle(h, "completed", nil)
	goal, _ := m.Snapshot()
	if r.Continue || goal.Status != Paused || goal.PauseReason != "reached 50 automatic continuations" {
		t.Fatalf("after the cap: %+v, goal %+v", r, goal)
	}
	_ = m.Command(h, "resume")
	goal, _ = m.Snapshot()
	if goal.Status != Active || goal.Continuations != 1 {
		t.Fatalf("resume must reset the count and send one continuation: %+v", goal)
	}
}

func TestThreeRejectionsPause(t *testing.T) {
	h := &quietHost{reply: "REJECTED: no tests"}
	m := activeMachine(t, h)
	for i := 1; i <= MaxRejections; i++ {
		text, err := m.Done(h, "s", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		goal, _ := m.Snapshot()
		if goal.Rejections != i {
			t.Fatalf("rejection %d: %+v", i, goal)
		}
		if paused := goal.Status == Paused; paused != (i == MaxRejections) || (paused && !strings.Contains(text, "paused after 3 rejected reviews")) {
			t.Fatalf("rejection %d: status %s, text %q", i, goal.Status, text)
		}
	}
	h.reply = "APPROVED"
	_ = m.Command(h, "resume")
	if _, err := m.Done(h, "s", nil, nil); err != nil {
		t.Fatal(err)
	}
	if goal, _ := m.Snapshot(); goal.Status != Done || goal.Rejections != 0 {
		t.Fatalf("approval after resume: %+v", goal)
	}
}

func TestSendRunsWithoutTheLock(t *testing.T) {
	h := &quietHost{reenter: true}
	m := activeMachine(t, h)
	_ = m.Command(h, "pause")
	if err := m.Command(h, "resume"); err != nil {
		t.Fatal(err)
	}
	for _, note := range h.notes {
		if strings.Contains(note, "could not continue") {
			t.Fatal(note)
		}
	}
	if err := m.Command(h, "another goal"); err != nil {
		t.Fatalf("start: %v", err)
	}
}
