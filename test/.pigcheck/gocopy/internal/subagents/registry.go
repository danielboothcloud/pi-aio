package subagents

// Port of subagents/registry.ts: the runs of this session, run ownership,
// child-session ownership, pruning, and tree reconciliation. All state is
// guarded by Mu; callers hold it while they read or change runs.

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	maxCompletedRuns = 50
	// MaxTranscriptRuns is the finished runs that keep their transcripts.
	MaxTranscriptRuns = 10
)

type owner struct {
	runID string
	index int
}

// Registry holds the runs of one extension process.
type Registry struct {
	Mu            sync.Mutex
	runs          map[string]*Run
	order         []string // insertion order, for Map iteration parity
	owned         map[*Run]bool
	retained      map[string]bool
	sessionOwners map[string]owner
	ownerOrder    []string
	// Now is the clock (Date.now) in milliseconds.
	Now func() float64
	// NewID makes run ids (randomUUID).
	NewID func() string
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{
		runs: map[string]*Run{}, owned: map[*Run]bool{}, retained: map[string]bool{},
		sessionOwners: map[string]owner{},
		Now:           func() float64 { return float64(time.Now().UnixMilli()) },
		NewID:         randomUUID,
	}
}

func randomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (r *Registry) set(run *Run) {
	if _, ok := r.runs[run.ID]; !ok {
		r.order = append(r.order, run.ID)
	}
	r.runs[run.ID] = run
}

func (r *Registry) delete(id string) {
	if _, ok := r.runs[id]; !ok {
		return
	}
	delete(r.runs, id)
	r.order = slices.DeleteFunc(r.order, func(x string) bool { return x == id })
}

// IsOwned is isOwnedRun: launched by this runtime, not decoded history.
func (r *Registry) IsOwned(run *Run) bool { return r.owned[run] }

func sessionKey(file string) string {
	if real, err := filepath.EvalSymlinks(file); err == nil {
		return real
	}
	abs, _ := filepath.Abs(file)
	return abs
}

// ChildSessionOwner is childSessionOwner.
func (r *Registry) ChildSessionOwner(file string) (runID string, index int, ok bool) {
	key := sessionKey(file)
	o, found := r.sessionOwners[key]
	if !found {
		return "", 0, false
	}
	if _, live := r.runs[o.runID]; !live {
		r.deleteOwner(key)
		return "", 0, false
	}
	return o.runID, o.index, true
}

func (r *Registry) deleteOwner(key string) {
	delete(r.sessionOwners, key)
	r.ownerOrder = slices.DeleteFunc(r.ownerOrder, func(x string) bool { return x == key })
}

// ClaimChildSession is claimChildSession.
func (r *Registry) ClaimChildSession(file, runID string, index int) {
	for _, key := range slices.Clone(r.ownerOrder) {
		if _, live := r.runs[r.sessionOwners[key].runID]; !live {
			r.deleteOwner(key)
		}
	}
	key := sessionKey(file)
	if _, ok := r.sessionOwners[key]; !ok {
		r.ownerOrder = append(r.ownerOrder, key)
	}
	r.sessionOwners[key] = owner{runID, index}
}

func runEnd(run *Run) float64 {
	if run.EndedAt != nil {
		return *run.EndedAt
	}
	return run.StartedAt
}

func (r *Registry) prune() {
	var terminal []*Run
	for _, id := range r.order {
		run := r.runs[id]
		live := slices.ContainsFunc(run.Children, func(c *Child) bool { return c.process != nil })
		if !live && Terminal(run.State) {
			terminal = append(terminal, run)
		}
	}
	slices.SortStableFunc(terminal, func(a, b *Run) int { return cmpDesc(runEnd(a), runEnd(b)) })
	var prunable []*Run
	for _, run := range terminal {
		if !r.retained[run.ID] {
			prunable = append(prunable, run)
		}
	}
	if len(prunable) > maxCompletedRuns {
		for _, run := range prunable[maxCompletedRuns:] {
			r.delete(run.ID)
		}
	}
	if len(terminal) > MaxTranscriptRuns {
		for _, run := range terminal[MaxTranscriptRuns:] {
			for _, c := range run.Children {
				c.Transcript = nil
			}
		}
	}
}

func cmpDesc(a, b float64) int {
	switch {
	case a > b:
		return -1
	case a < b:
		return 1
	}
	return 0
}

// CreateRun is createRun. The caller holds Mu.
func (r *Registry) CreateRun(mode, context, cwd string, children []*Child) *Run {
	run := &Run{ID: r.NewID(), State: "queued", Mode: mode, Context: context, Cwd: cwd,
		StartedAt: r.Now(), Children: children, Results: []*Result{}}
	r.set(run)
	r.owned[run] = true
	r.prune()
	return run
}

// RestoreRun is restoreRun: add a decoded historical run, never replacing a
// run this runtime owns.
func (r *Registry) RestoreRun(run *Run) {
	if previous, ok := r.runs[run.ID]; ok && r.owned[previous] {
		return
	}
	r.set(run)
	r.prune()
}

// ReconcileRuns is reconcileRuns: keep live and retained runs, drop the
// rest that the selected branch does not show, then restore its history.
func (r *Registry) ReconcileRuns(history []*Run, retain map[string]bool) {
	if retain == nil {
		retain = map[string]bool{}
	}
	r.retained = retain
	selected := map[string]bool{}
	for _, run := range history {
		selected[run.ID] = true
	}
	for _, id := range slices.Clone(r.order) {
		run := r.runs[id]
		active := run.Active() || slices.ContainsFunc(run.Children, func(c *Child) bool { return c.process != nil })
		if !selected[id] && !active && !retain[id] {
			r.delete(id)
		}
	}
	for _, run := range history {
		r.RestoreRun(run)
	}
}

// GetRun is getRun: an exact id, or a unique prefix.
func (r *Registry) GetRun(id string) *Run {
	if run, ok := r.runs[id]; ok {
		return run
	}
	var match *Run
	count := 0
	for _, key := range r.order {
		if strings.HasPrefix(key, id) {
			match = r.runs[key]
			count++
		}
	}
	if count == 1 {
		return match
	}
	return nil
}

// ListRuns is listRuns: newest first.
func (r *Registry) ListRuns() []*Run {
	out := make([]*Run, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.runs[id])
	}
	slices.SortStableFunc(out, func(a, b *Run) int { return cmpDesc(a.StartedAt, b.StartedAt) })
	return out
}

// TerminationGrace is the SIGTERM → SIGKILL delay of stopRun.
var TerminationGrace = 3 * time.Second

// StopRun is stopRun. The caller holds Mu.
func (r *Registry) StopRun(id string) (*Run, error) {
	run := r.GetRun(id)
	if run == nil {
		return nil, fmt.Errorf("Unknown or ambiguous subagent run '%s'.", id)
	}
	if Terminal(run.State) {
		return run, nil
	}
	run.StopRequested = true
	run.State = "stopped"
	run.EndedAt = fptr(r.Now())
	for _, c := range run.Children {
		if c.State == "queued" {
			c.State = "stopped"
		}
		if c.State == "running" {
			c.State = "stopped"
			c.EndedAt = fptr(r.Now())
			if cmd := c.process; cmd != nil && cmd.Process != nil {
				_ = cmd.Process.Signal(syscall.SIGTERM)
				proc := cmd.Process
				time.AfterFunc(TerminationGrace, func() { _ = proc.Signal(os.Kill) })
			}
		}
	}
	return run, nil
}

// Clear is clearRuns: kill every live child and forget all runs.
func (r *Registry) Clear() {
	for _, id := range r.order {
		for _, c := range r.runs[id].Children {
			if c.process != nil && c.process.Process != nil {
				_ = c.process.Process.Kill()
			}
		}
	}
	r.runs = map[string]*Run{}
	r.order = nil
	r.sessionOwners = map[string]owner{}
	r.ownerOrder = nil
	r.retained = map[string]bool{}
}
