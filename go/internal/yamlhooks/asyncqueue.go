package yamlhooks

// Async hook queues (port of yaml-hooks/async-queue.ts) and the action
// recursion guard (port of yaml-hooks/recursion-guard.ts).

import (
	"fmt"
	"sync"
	"time"
)

type asyncQueue struct {
	active  int
	pending []func()
}

// asyncQueues holds the per-runtime lanes keyed by queue key.
type asyncQueues struct {
	mu     sync.Mutex
	queues map[string]*asyncQueue
	wg     sync.WaitGroup
}

func newAsyncQueues() *asyncQueues { return &asyncQueues{queues: map[string]*asyncQueue{}} }

// asyncExecutionConfig is resolveAsyncExecutionConfig.
func asyncExecutionConfig(h *HookConfig, sessionID string) (string, int) {
	if h.Async == nil || h.Async.True {
		return h.Event + ":" + sessionID, 1
	}
	concurrency := 1
	if h.Async.Concurrency != nil {
		concurrency = *h.Async.Concurrency
	}
	if h.Async.Group != nil && *h.Async.Group != "" {
		return sessionID + ":" + *h.Async.Group, concurrency
	}
	return h.Event + ":" + sessionID, concurrency
}

// enqueue is enqueueAsyncHook. A run that panics or fails never wedges the
// lane. Warnings (pending limit, watchdog) are dropped, as in TypeScript.
func (q *asyncQueues) enqueue(key string, concurrency int, run func()) {
	q.mu.Lock()
	defer q.mu.Unlock()
	state := q.queues[key]
	if state == nil {
		state = &asyncQueue{}
		q.queues[key] = state
	}
	if len(state.pending) >= envMaxAsyncPending() {
		return
	}
	state.pending = append(state.pending, run)
	q.startNextLocked(key, state, concurrency)
}

func (q *asyncQueues) startNextLocked(key string, state *asyncQueue, concurrency int) {
	watchdog := envAsyncWatchdogMs()
	for state.active < concurrency && len(state.pending) > 0 {
		next := state.pending[0]
		state.pending = state.pending[1:]
		state.active++
		q.wg.Go(func() {
			var timer *time.Timer
			if watchdog > 0 {
				timer = time.AfterFunc(time.Duration(watchdog)*time.Millisecond, func() {})
			}
			func() {
				defer func() { _ = recover() }()
				next()
			}()
			if timer != nil {
				timer.Stop()
			}
			q.mu.Lock()
			defer q.mu.Unlock()
			state.active--
			if state.active == 0 && len(state.pending) == 0 {
				if q.queues[key] == state {
					delete(q.queues, key)
				}
				return
			}
			q.startNextLocked(key, state, concurrency)
		})
	}
}

// wait blocks until every queued async hook has finished.
func (q *asyncQueues) wait() { q.wg.Wait() }

// RecursionDepthCap is recursion-guard.ts RECURSION_DEPTH_CAP.
const RecursionDepthCap = 32

// guardStore is the AsyncLocalStorage store of one action chain: the
// active action keys and the nesting depth. The Go port passes it down the
// call chain explicitly.
type guardStore struct {
	mu     sync.Mutex
	keys   map[string]bool
	depth  int
	logged bool
}

// withActionRecursionGuard is recursion-guard.ts withActionRecursionGuard.
// It returns false when the action was skipped. execute receives the store
// that is active inside the guard frame.
func withActionRecursionGuard(active *guardStore, key string, execute func(*guardStore)) bool {
	if active == nil {
		root := &guardStore{keys: map[string]bool{key: true}, depth: 1}
		defer func() {
			root.mu.Lock()
			delete(root.keys, key)
			root.depth = 0
			root.mu.Unlock()
		}()
		execute(root)
		return true
	}
	active.mu.Lock()
	if active.keys[key] {
		active.mu.Unlock()
		return false
	}
	if active.depth >= RecursionDepthCap {
		first := !active.logged
		active.logged = true
		active.mu.Unlock()
		if first {
			console("warn", fmt.Sprintf("[aio yaml hooks] Hook action recursion depth exceeded %d; skipping further nested actions.", RecursionDepthCap))
		}
		return false
	}
	active.keys[key] = true
	active.depth++
	active.mu.Unlock()
	defer func() {
		active.mu.Lock()
		delete(active.keys, key)
		active.depth--
		if active.depth == 0 {
			active.logged = false
		}
		active.mu.Unlock()
	}()
	execute(active)
	return true
}
