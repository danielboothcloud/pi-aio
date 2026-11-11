package yamlhooks

// Hook dispatch (port of yaml-hooks/dispatch.ts) and the hooks runtime
// (port of yaml-hooks/runtime.ts): bucket lookup, single-flight queueing per
// (event, session), scope and path matching, async enqueueing, and the
// runtime entry points the adapter calls.

import (
	"fmt"
	"sync"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/toolpaths"
)

// MaxPromptContextBytes is runtime.ts MAX_PROMPT_CONTEXT_BYTES.
const MaxPromptContextBytes = 64 * 1024

type dispatchResponse struct {
	result Result
	err    error
}

type dispatchRequest struct {
	context  ActionContext
	canBlock bool
	reply    chan dispatchResponse // nil for non-blocking requests
	guard    *guardStore
}

type dispatchState struct {
	active  bool
	pending []dispatchRequest
}

// Runtime is one HooksRuntime (one per project directory).
type Runtime struct {
	paths       Paths
	projectDir  string
	host        HostAdapter
	runBash     ExecuteBashFunc
	budgetMs    *float64
	now         func() float64
	state       *SessionState
	mu          sync.Mutex
	dispatches  map[string]*dispatchState
	queues      *asyncQueues
	warnedStops map[string]bool
}

// RuntimeOptions is CreateHooksRuntimeOptions.
type RuntimeOptions struct {
	Paths                   Paths
	ProjectDir              string
	Host                    HostAdapter
	SynchronousBashBudgetMs *float64
	// Now returns milliseconds (Date.now); nil for the wall clock.
	Now         func() float64
	ExecuteBash ExecuteBashFunc
}

// NewRuntime is runtime.ts createHooksRuntime.
func NewRuntime(o RuntimeOptions) *Runtime {
	if o.ProjectDir == "" {
		panic("createHooksRuntime requires a project directory")
	}
	now := o.Now
	if now == nil {
		now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	run := o.ExecuteBash
	if run == nil {
		run = ExecuteBashHook
	}
	return &Runtime{
		paths: o.Paths, projectDir: o.ProjectDir, host: o.Host, runBash: run,
		budgetMs: o.SynchronousBashBudgetMs, now: now,
		state:      NewSessionState(nil),
		dispatches: map[string]*dispatchState{}, queues: newAsyncQueues(),
		warnedStops: map[string]bool{},
	}
}

// State returns the session store (tests).
func (rt *Runtime) State() *SessionState { return rt.state }

// WaitAsync blocks until every queued async hook finished (tests).
func (rt *Runtime) WaitAsync() { rt.queues.wait() }

func (rt *Runtime) newBudget() *budget {
	if rt.budgetMs == nil {
		return nil
	}
	return &budget{deadline: rt.now() + *rt.budgetMs, now: rt.now}
}

func (rt *Runtime) discover() *HookMap {
	return LoadDiscoveredHooks(LoadOptions{Paths: rt.paths, ProjectDir: rt.projectDir}).Hooks
}

// UserPromptSubmit is runtime "user.prompt.submit".
func (rt *Runtime) UserPromptSubmit(sessionID, prompt string) ([]string, error) {
	b := rt.newBudget()
	hooks := rt.discover()
	p := prompt
	res, err := rt.dispatchHooks(hooks, "user.prompt.submit", sessionID, ActionContext{Prompt: &p, budget: b}, false, nil)
	if err != nil {
		return nil, err
	}
	accepted := []string{}
	used := 0
	for _, c := range res.AdditionalContext {
		n := byteLength(c)
		if used+n > MaxPromptContextBytes {
			continue
		}
		accepted = append(accepted, c)
		used += n
	}
	return accepted, nil
}

// BlockedError is the error a blocked tool.before dispatch throws.
type BlockedError struct{ Reason string }

func (e *BlockedError) Error() string { return e.Reason }

// ToolExecuteBefore is runtime "tool.execute.before". A block is a
// *BlockedError; other errors come from the bash seam.
func (rt *Runtime) ToolExecuteBefore(tool, sessionID, callID string, args *Object) error {
	if sessionID == "" {
		return nil
	}
	b := rt.newBudget()
	hooks := rt.discover()
	if args == nil {
		args = &Object{Values: map[string]any{}}
	}
	rt.state.SetPendingToolCall(callID, sessionID, args)
	name := tool
	res, err := rt.dispatchToolHooks(hooks, "before", tool, sessionID, ActionContext{ToolName: &name, ToolArgs: args, budget: b})
	if err != nil {
		return err
	}
	if res.Blocked {
		rt.state.ConsumePendingToolCall(callID)
		if res.StopSession {
			rt.host.Abort(sessionID)
		}
		reason := res.BlockReason
		if !res.HasBlockReason || reason == "" {
			reason = "Blocked by hook"
		}
		return &BlockedError{reason}
	}
	return nil
}

// ToolExecuteAfter is runtime "tool.execute.after".
func (rt *Runtime) ToolExecuteAfter(tool, sessionID, callID string, args *Object) error {
	if sessionID == "" {
		return nil
	}
	b := rt.newBudget()
	hooks := rt.discover()
	_, pending, _ := rt.state.ConsumePendingToolCall(callID)
	toolArgs := args
	if args == nil || args.Len() == 0 {
		if pending != nil {
			toolArgs = pending
		} else if args == nil {
			toolArgs = &Object{Values: map[string]any{}}
		}
	}
	changes := toolpaths.FileChanges(tool, ToGo(toolArgs).(map[string]any))
	if changes == nil {
		changes = []FileChange{}
	}
	var files []string
	hasFiles := false
	if len(changes) > 0 {
		files = changedPaths(changes)
		hasFiles = true
	}
	rt.state.AddFileChanges(sessionID, changes)
	name := tool
	if len(changes) > 0 {
		if _, err := rt.dispatchHooks(hooks, "file.changed", sessionID, ActionContext{
			Files: files, HasFiles: hasFiles, Changes: changes, HasChanges: true, ToolName: &name, ToolArgs: toolArgs, budget: b,
		}, false, nil); err != nil {
			return err
		}
	}
	_, err := rt.dispatchToolHooks(hooks, "after", tool, sessionID, ActionContext{
		Files: files, HasFiles: hasFiles, Changes: changes, HasChanges: true, ToolName: &name, ToolArgs: toolArgs, budget: b,
	})
	return err
}

// SessionCreated is runtime event "session.created".
func (rt *Runtime) SessionCreated(sessionID string) error {
	b := rt.newBudget()
	hooks := rt.discover()
	if jsstr.Trim(sessionID) == "" {
		return nil
	}
	rt.state.RememberSession(sessionID, nil)
	_, err := rt.dispatchHooks(hooks, "session.created", sessionID, ActionContext{budget: b}, false, nil)
	return err
}

// SessionDeleted is runtime event "session.deleted".
func (rt *Runtime) SessionDeleted(sessionID string) error {
	b := rt.newBudget()
	hooks := rt.discover()
	if jsstr.Trim(sessionID) == "" {
		return nil
	}
	rt.state.RememberSession(sessionID, nil)
	rt.state.DeleteSession(sessionID)
	_, err := rt.dispatchHooks(hooks, "session.deleted", sessionID, ActionContext{budget: b}, false, nil)
	return err
}

// SessionIdle is runtime event "session.idle".
func (rt *Runtime) SessionIdle(sessionID string) error {
	b := rt.newBudget()
	hooks := rt.discover()
	if jsstr.Trim(sessionID) == "" {
		return nil
	}
	changes := rt.state.GetFileChanges(sessionID)
	files := rt.state.GetModifiedPaths(sessionID)
	rt.state.BeginIdleDispatch(sessionID, changes)
	_, err := rt.dispatchHooks(hooks, "session.idle", sessionID, ActionContext{
		Files: files, HasFiles: true, Changes: changes, HasChanges: true, budget: b,
	}, false, nil)
	rt.state.ConsumeFileChanges(sessionID, changes)
	return err
}

// dispatchToolHooks is dispatch.ts dispatchToolHooks.
func (rt *Runtime) dispatchToolHooks(hooks *HookMap, phase, tool, sessionID string, ctx ActionContext) (Result, error) {
	canBlock := phase == "before"
	res, err := rt.dispatchHooks(hooks, "tool."+phase+".*", sessionID, ctx, canBlock, nil)
	if err != nil || res.Blocked {
		return res, err
	}
	names := mutationToolHookNames(tool)
	if len(names) == 0 {
		names = []string{tool}
	}
	if len(names) > 1 {
		seen := map[*HookConfig]bool{}
		var union []*HookConfig
		for _, n := range names {
			for _, h := range hooks.Get("tool." + phase + "." + n) {
				if !seen[h] {
					seen[h] = true
					union = append(union, h)
				}
			}
		}
		if len(union) == 0 {
			return Result{}, nil
		}
		event := "tool." + phase + "." + names[len(names)-1]
		alias := NewHookMap()
		alias.Set(event, union)
		return rt.dispatchHooks(alias, event, sessionID, ctx, canBlock, nil)
	}
	for _, n := range names {
		res, err := rt.dispatchHooks(hooks, "tool."+phase+"."+n, sessionID, ctx, canBlock, nil)
		if err != nil || res.Blocked {
			return res, err
		}
	}
	return Result{}, nil
}

// mutationToolHookNames is tool-paths.ts getMutationToolHookNames.
func mutationToolHookNames(tool string) []string {
	switch n := toolpaths.NormalizeTool(tool); n {
	case "":
		return nil
	case "apply_patch":
		return []string{"patch", "apply_patch"}
	default:
		return []string{n}
	}
}

// dispatchHooks is dispatch.ts dispatchHooks.
func (rt *Runtime) dispatchHooks(hooks *HookMap, event, sessionID string, ctx ActionContext, canBlock bool, guard *guardStore) (Result, error) {
	bucket := hooks.Get(event)
	if len(bucket) == 0 {
		return Result{}, nil
	}
	key := event + ":" + sessionID
	rt.mu.Lock()
	state := rt.dispatches[key]
	if state != nil && state.active {
		if !canBlock {
			state.pending = append(state.pending, dispatchRequest{context: ctx, guard: guard})
			rt.mu.Unlock()
			return Result{}, nil
		}
		reply := make(chan dispatchResponse, 1)
		state.pending = append(state.pending, dispatchRequest{context: ctx, canBlock: true, reply: reply, guard: guard})
		rt.mu.Unlock()
		r := <-reply
		return r.result, r.err
	}
	if state == nil {
		state = &dispatchState{}
	}
	state.active = true
	rt.dispatches[key] = state
	rt.mu.Unlock()

	result, err := rt.executeDispatchRequest(bucket, event, sessionID, dispatchRequest{context: ctx, canBlock: canBlock, guard: guard})

	for {
		rt.mu.Lock()
		if len(state.pending) == 0 {
			state.active = false
			state.pending = nil
			if rt.dispatches[key] == state {
				delete(rt.dispatches, key)
			}
			rt.mu.Unlock()
			break
		}
		next := state.pending[0]
		state.pending = state.pending[1:]
		rt.mu.Unlock()
		r, e := rt.executeDispatchRequest(bucket, event, sessionID, next)
		if next.reply != nil {
			next.reply <- dispatchResponse{r, e}
		}
	}
	return result, err
}

func (rt *Runtime) executeDispatchRequest(bucket []*HookConfig, event, sessionID string, req dispatchRequest) (Result, error) {
	var additional []string
	ctx := req.context
	if ctx.pathMatch == nil {
		pm := BuildPathMatchContext(rt.projectDir, ctx.Files, ctx.Changes)
		ctx.pathMatch = &pm
	}
	for _, hook := range bucket {
		r, err := rt.executeHook(hook, event, sessionID, ctx, req.canBlock, req.guard)
		if err != nil {
			return Result{}, err
		}
		additional = append(additional, r.AdditionalContext...)
		if r.Blocked {
			r.AdditionalContext = additional
			return r, nil
		}
	}
	return Result{AdditionalContext: additional}, nil
}

// HookIdentifier is dispatch.ts getHookIdentifier.
func HookIdentifier(h *HookConfig) string {
	if h.ID != nil {
		return *h.ID
	}
	return formatHookSource(h)
}

func formatHookSource(h *HookConfig) string {
	return fmt.Sprintf("%s#hooks[%d]", h.Source.FilePath, h.Source.Index)
}

func (rt *Runtime) shouldRunHook(h *HookConfig, sessionID string, ctx ActionContext) (matched bool) {
	defer func() {
		if recover() != nil {
			matched = false
		}
	}()
	pm := ctx.pathMatch
	if pm == nil {
		v := BuildPathMatchContext(rt.projectDir, ctx.Files, ctx.Changes)
		pm = &v
	}
	if !rt.state.EvaluateScope(sessionID, h.Scope, rt.resolveParent) {
		return false
	}
	return EvaluatePathConditions(h.Conditions, *pm) == nil
}

func (rt *Runtime) executeHook(h *HookConfig, event, sessionID string, ctx ActionContext, canBlock bool, guard *guardStore) (Result, error) {
	hookID := HookIdentifier(h)
	if !rt.shouldRunHook(h, sessionID, ctx) {
		return Result{}, nil
	}
	if h.Async != nil {
		if h.Action == "stop" {
			source := formatHookSource(h)
			rt.mu.Lock()
			first := !rt.warnedStops[source]
			rt.warnedStops[source] = true
			rt.mu.Unlock()
			if first {
				console("warn", fmt.Sprintf("[aio yaml hooks] hook %s declares both async and action: stop; the stop directive is ignored because async hooks cannot block dispatch.", source))
			}
		}
		key, concurrency := asyncExecutionConfig(h, sessionID)
		asyncCtx := ctx
		asyncCtx.budget = nil
		rt.queues.enqueue(key, concurrency, func() {
			for _, a := range h.Actions {
				if _, err := executeAction(actionInput{action: a, runIn: h.RunIn, rt: rt, event: event, sessionID: sessionID, context: asyncCtx, sourceFile: h.Source.FilePath, hookID: hookID, guard: guard}); err != nil {
					return
				}
			}
		})
		return Result{}, nil
	}
	var additional []string
	for _, a := range h.Actions {
		r, err := executeAction(actionInput{action: a, runIn: h.RunIn, rt: rt, event: event, sessionID: sessionID, context: ctx, sourceFile: h.Source.FilePath, hookID: hookID, guard: guard})
		if err != nil {
			return Result{}, err
		}
		additional = append(additional, r.AdditionalContext...)
		if r.Blocked && canBlock {
			r.StopSession = h.Action == "stop"
			r.AdditionalContext = additional
			return r, nil
		}
	}
	return Result{AdditionalContext: additional}, nil
}
