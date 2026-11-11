package yamlhooks

import (
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Unit tests for the concurrency paths the golden scenarios cannot script
// deterministically: single-flight dispatch queueing, async lane limits, and
// the recursion guard.

func TestDispatchQueuesConcurrentRequests(t *testing.T) {
	root := newRoot(t)
	ResetCaches()
	applyFs(t, root, []fsOp{{Op: "write", Path: "agent/hook/hooks.yaml", Content: "hooks:\n  - event: tool.before.bash\n    actions:\n      - bash: gate\n  - event: file.changed\n    actions:\n      - bash: changed\n"}, {Op: "mkdir", Path: "p"}})
	release := make(chan struct{})
	var running, calls atomic.Int32
	rt := NewRuntime(RuntimeOptions{
		Paths: Paths{AgentDir: filepath.Join(root, "agent")}, ProjectDir: filepath.Join(root, "p"), Host: &mockAdapter{log: &recorder{}},
		ExecuteBash: func(req BashRequest) (BashResult, error) {
			calls.Add(1)
			if running.Add(1) > 1 {
				t.Error("two dispatches for one (event, session) ran at once")
			}
			if req.Command == "gate" && calls.Load() == 1 {
				<-release
			}
			running.Add(-1)
			return MapProcessResult(BashResult{ExitCode: 2, Stderr: "no"}, req.Context.Event), nil
		},
	})
	var wg sync.WaitGroup
	results := make(chan error, 3)
	for range 3 {
		wg.Go(func() {
			results <- rt.ToolExecuteBefore("bash", "s1", "c", NewObject())
		})
		time.Sleep(20 * time.Millisecond)
	}
	close(release)
	wg.Wait()
	close(results)
	i := 0
	for err := range results {
		i++
		if _, ok := err.(*BlockedError); !ok {
			t.Errorf("request %d: blocking requests must wait for their own result, got %v", i, err)
		}
	}
	if calls.Load() != 3 {
		t.Errorf("calls = %d, want 3", calls.Load())
	}
	rt.mu.Lock()
	left := len(rt.dispatches)
	rt.mu.Unlock()
	if left != 0 {
		t.Errorf("%d dispatch states leaked", left)
	}
}

func TestAsyncQueueConcurrencyAndPendingCap(t *testing.T) {
	q := newAsyncQueues()
	var active, peak atomic.Int32
	gate := make(chan struct{})
	for range 6 {
		q.enqueue("lane", 2, func() {
			n := active.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			<-gate
			active.Add(-1)
		})
	}
	deadline := time.Now().Add(5 * time.Second)
	for active.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(gate)
	q.wait()
	if peak.Load() != 2 {
		t.Errorf("peak concurrency = %d, want 2", peak.Load())
	}
	q.mu.Lock()
	if len(q.queues) != 0 {
		t.Error("finished lane must be removed")
	}
	q.mu.Unlock()

	t.Setenv("PI_YAML_HOOKS_ASYNC_MAX_PENDING", "1")
	block := make(chan struct{})
	var ran atomic.Int32
	run := func() { ran.Add(1); <-block }
	q.enqueue("cap", 1, run) // starts
	q.enqueue("cap", 1, run) // pending (1)
	q.enqueue("cap", 1, run) // dropped: pending limit reached
	close(block)
	q.wait()
	if ran.Load() != 2 {
		t.Errorf("ran = %d, want 2 (third dropped at the pending cap)", ran.Load())
	}

	// A panicking run does not wedge the lane.
	q.enqueue("panic", 1, func() { panic("boom") })
	var done atomic.Bool
	q.enqueue("panic", 1, func() { done.Store(true) })
	q.wait()
	if !done.Load() {
		t.Error("lane wedged after a panicking run")
	}
}

func TestRecursionGuard(t *testing.T) {
	var inner []bool
	ok := withActionRecursionGuard(nil, "a", func(store *guardStore) {
		inner = append(inner, withActionRecursionGuard(store, "a", func(*guardStore) {}))
		inner = append(inner, withActionRecursionGuard(store, "b", func(*guardStore) {}))
	})
	if !ok || inner[0] || !inner[1] {
		t.Fatalf("guard results: outer %v inner %v", ok, inner)
	}
	log := &consoleLog{}
	restore := SetConsole(log.sink)
	defer restore()
	store := &guardStore{keys: map[string]bool{}, depth: RecursionDepthCap}
	if withActionRecursionGuard(store, "x", func(*guardStore) {}) || withActionRecursionGuard(store, "y", func(*guardStore) {}) {
		t.Error("actions past the depth cap must be skipped")
	}
	if len(log.records) != 1 {
		t.Errorf("depth warning logged %d times, want once", len(log.records))
	}
}
