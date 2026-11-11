package aio

// Subagents wiring (port of subagents/index.ts). The runner, registry,
// history, transcript, widget rows, and inspector live in
// internal/subagents; this file registers the subagent tool, /subagents, the
// alt+s shortcut, the above-editor widget, run checkpoints, and the session
// lifecycle.
//
// Locks: the registry lock (reg.Mu) guards run state, s.mu guards this
// file's bookkeeping. Neither is held across a host call.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	notify "github.com/danielboothcloud/pi-aio/go/internal/notifications"
	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
	sa "github.com/danielboothcloud/pi-aio/go/internal/subagents"
)

func init() {
	addRegistrar(OrderSubagents, "subagents", registerSubagents)
}

const (
	subagentWidgetKey   = "aio-subagents"
	activityTickMs      = 1000
	subagentDescription = "Delegate a focused task to a configured child Pi agent. Supports one child or a bounded parallel group, fresh or forked context, foreground or background execution, and basic list/status/stop control. Omit model and thinking to inherit the active parent session values at launch. Use fresh context for independent review. Keep parallel tasks read-only unless their filesystems are deliberately isolated; this reduced runtime does not provide worktrees or nested delegation. A child killed by a stall, timeout, or crash is retried automatically and resumes its own session, so completed work is preserved; a final failure reports the preserved session file."
)

var subagentGuidelines = []string{
	"Use subagent for focused, self-contained delegation and independent parallel review.",
	"Keep one writer in the shared checkout; parallel subagent tasks should normally be read-only.",
	"Use subagent action=list before choosing an unfamiliar configured agent.",
	"Use async=true only when you have other independent work to do meanwhile; its result arrives as a message after your current tool calls finish. If you would just wait for it, run in the foreground instead.",
	"If a child fails after its automatic retry, narrow or split the task instead of re-sending it unchanged.",
}

func subagentSchema() sdk.Schema {
	thinking := map[string]any{"type": "string", "enum": sa.ThinkingLevels}
	task := map[string]any{
		"type":     "object",
		"required": []string{"agent", "task"},
		"properties": map[string]any{
			"agent":    map[string]any{"type": "string", "minLength": 1, "description": "Configured agent name"},
			"task":     map[string]any{"type": "string", "minLength": 1, "description": "Concrete task for this child"},
			"model":    map[string]any{"type": "string", "minLength": 1, "description": "Per-task model override; omitted inherits the parent session model"},
			"thinking": thinking,
		},
	}
	return sdk.Schema{
		"type": "object",
		"properties": map[string]any{
			"action":      map[string]any{"type": "string", "enum": []string{"list", "status", "stop"}},
			"id":          map[string]any{"type": "string", "description": "Run id or unique id prefix for status/stop"},
			"agent":       map[string]any{"type": "string", "description": "Agent name for a single run"},
			"task":        map[string]any{"type": "string", "description": "Task for a single run"},
			"tasks":       map[string]any{"type": "array", "items": task, "minItems": 1, "maxItems": 12, "description": "Independent tasks to execute in parallel"},
			"context":     map[string]any{"type": "string", "enum": []string{"fresh", "fork"}},
			"async":       map[string]any{"type": "boolean", "description": "Run in the background and return a run id immediately"},
			"concurrency": map[string]any{"type": "integer", "minimum": 1, "maximum": 12},
			"model":       map[string]any{"type": "string", "minLength": 1, "description": "Run-wide model override; omitted inherits the parent session model"},
			"thinking":    thinking,
			"timeoutMs": map[string]any{"type": "integer", "minimum": 1000, "maximum": 21_600_000,
				"description": "Hard budget per child in milliseconds (1s to 6h). Defaults to the agent's declared timeoutMs, or 15 minutes when unset. A timed-out child is retried once with its session resumed."},
		},
	}
}

type subagentState struct {
	reg *sa.Registry

	mu                sync.Mutex
	loaded            *sdk.Context
	shuttingDown      bool
	epoch             int
	hidden            map[string]bool
	dirty             map[string]bool
	checkpoints       map[string]string
	checkpointWarning bool
	inspector         *sa.Inspector
	widgetCtx         *sdk.Context
	widgetStop        chan struct{}
}

func (s *subagentState) live(epoch int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.shuttingDown && epoch == s.epoch
}

func (s *subagentState) isHidden(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hidden[id]
}

func (s *subagentState) markDirty(id string) {
	s.mu.Lock()
	s.dirty[id] = true
	s.mu.Unlock()
}

// visibleRuns lists the runs not hidden by tree navigation. Caller holds reg.Mu.
func (s *subagentState) visibleRuns() []*sa.Run {
	s.mu.Lock()
	hidden := s.hidden
	s.mu.Unlock()
	var out []*sa.Run
	for _, run := range s.reg.ListRuns() {
		if !hidden[run.ID] {
			out = append(out, run)
		}
	}
	return out
}

// background is the long-lived context for work after a handler returns.
func (s *subagentState) background(fallback sdk.Context) sdk.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded != nil {
		return *s.loaded
	}
	return fallback
}

// checkpoint appends a private aio-subagent-state entry when the run's
// lifecycle changed (or always with force). It reports success.
func (s *subagentState) checkpoint(ctx sdk.Context, run *sa.Run, force bool) bool {
	s.reg.Mu.Lock()
	children := make([][]any, len(run.Children))
	for i, c := range run.Children {
		attempts := any(nil)
		if c.Attempts != nil {
			attempts = *c.Attempts
		}
		children[i] = []any{c.State, c.EndedAt, c.SessionFile, attempts}
	}
	fp, _ := json.Marshal([]any{run.State, run.EndedAt, sa.ChildLaunchStateKey(run), children})
	data := map[string]any{"version": 1, "run": sa.PublicRun(run), "launches": sa.SnapshotChildLaunches(run)}
	s.reg.Mu.Unlock()
	fingerprint := string(fp)
	s.mu.Lock()
	if !force && s.checkpoints[run.ID] == fingerprint {
		s.mu.Unlock()
		return true
	}
	s.mu.Unlock()
	if err := ctx.AppendEntry(sa.StateEntry, data); err != nil {
		s.mu.Lock()
		warn := !s.checkpointWarning
		s.checkpointWarning = true
		s.mu.Unlock()
		if warn {
			fmt.Fprintln(os.Stderr, "[aio subagents] Could not persist run history; historical tool results remain available.")
		}
		return false
	}
	s.mu.Lock()
	s.checkpoints[run.ID] = fingerprint
	s.mu.Unlock()
	return true
}

func (s *subagentState) activeRuns() []*sa.Run {
	s.reg.Mu.Lock()
	defer s.reg.Mu.Unlock()
	var out []*sa.Run
	for _, run := range s.reg.ListRuns() {
		if run.Active() {
			out = append(out, run)
		}
	}
	return out
}

func (s *subagentState) stopWidgetTicker() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.widgetStop != nil {
		close(s.widgetStop)
		s.widgetStop = nil
	}
}

// refreshWidget repaints the above-editor widget from the live registry.
func (s *subagentState) refreshWidget() {
	s.mu.Lock()
	ctx, down := s.widgetCtx, s.shuttingDown
	s.mu.Unlock()
	if down || ctx == nil {
		return
	}
	active := s.activeRuns()
	var visible []*sa.Run
	for _, run := range active {
		if !s.isHidden(run.ID) {
			visible = append(visible, run)
		}
	}
	err := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("%v", r)
			}
		}()
		if len(visible) == 0 {
			return ctx.SetWidget(subagentWidgetKey, nil)
		}
		theme := ctx.UITheme()
		return ctx.SetWidgetRenderer(subagentWidgetKey, func(width int) []string {
			s.reg.Mu.Lock()
			defer s.reg.Mu.Unlock()
			return sa.WidgetLines(visible, width, theme, 4, nowMillis())
		})
	}()
	if err != nil || len(active) == 0 {
		s.stopWidgetTicker()
	}
}

// trackWidget keeps the widget timers moving while any run is active.
func (s *subagentState) trackWidget(ctx sdk.Context) {
	s.mu.Lock()
	s.widgetCtx = &ctx
	s.mu.Unlock()
	s.refreshWidget()
	s.mu.Lock()
	start := s.widgetStop == nil && ctx.HasUI()
	s.mu.Unlock()
	if !start || len(s.activeRuns()) == 0 {
		return
	}
	stop := make(chan struct{})
	s.mu.Lock()
	s.widgetStop = stop
	s.mu.Unlock()
	go func() {
		ticker := time.NewTicker(activityTickMs * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				s.refreshWidget()
			}
		}
	}()
}

func (s *subagentState) emitBackground(ctx sdk.Context, run *sa.Run, failedLaunch bool) {
	if ctx.Mode() != "tui" || os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	s.reg.Mu.Lock()
	state, stopped, id := run.State, run.StopRequested, run.ID
	s.reg.Mu.Unlock()
	title, body := "Background agents finished", "A background subagent run has ended. Its results are available in Pi."
	switch {
	case failedLaunch:
		title, body = "Background agents failed", "A background subagent run could not finish. Review the error in Pi."
	case state == "stopped" || stopped:
		return
	case state == "failed":
		title = "Background agents failed"
	}
	sessionID, _ := ctx.GetSessionID()
	_ = ctx.Events().Emit(notify.NotificationEvent, map[string]any{"category": "background", "id": "subagent:" + id,
		"sessionId": sessionID, "title": title, "body": body, "replacesCompletion": true})
}

func (s *subagentState) sendComplete(ctx sdk.Context, run *sa.Run) {
	s.reg.Mu.Lock()
	text, details := sa.FormatRunResult(run), sa.PublicRun(run)
	s.reg.Mu.Unlock()
	trigger := true
	_ = ctx.SendCustomMessage(sdk.CustomMessage{CustomType: sa.CompleteMessage, Content: text, Display: true, Details: details},
		sdk.SendMessageOptions{TriggerTurn: &trigger, DeliverAs: "steer"})
}

// aioExtensionPath is the Go extension directory a -ne child must load.
func aioExtensionPath(ctx sdk.Context) string {
	info, ok := ctx.ExtensionSourceInfo()
	if !ok || info.Path == "" {
		return ""
	}
	for _, candidate := range []string{info.Path, filepath.Join(info.Path, "aio")} {
		if filepath.Base(candidate) == "aio" {
			if _, err := os.Stat(filepath.Join(candidate, "extension.go")); err == nil {
				return candidate
			}
		}
	}
	return ""
}

func (s *subagentState) deps(ctx sdk.Context) *sa.Deps {
	agentDir, _ := sdk.AgentDir()
	home, _ := os.UserHomeDir()
	return &sa.Deps{AgentDir: agentDir, AioPath: aioExtensionPath(ctx), CursorExtension: sa.ResolveCursorExtensionPath(home, agentDir), Now: nowMillis}
}

func (s *subagentState) parent(ctx sdk.Context, deps *sa.Deps) sa.Parent {
	provider, id := ctx.ModelProvider(), ctx.Model()
	model := ""
	if id != "" {
		model = provider + "/" + id
	}
	thinking, _ := ctx.GetThinkingLevel()
	sessionFile := ""
	if file, err := ctx.GetSessionFile(); err == nil && file != nil {
		sessionFile = *file
	}
	argv, _ := piargs.HarnessArgv()
	hostCwd, _ := os.Getwd()
	launch := sa.ResolveChildExtensionLaunch(argv, hostCwd, provider, sa.ExtensionEnv{
		AioPath: deps.AioPath, Extra: os.Getenv("AIO_SUBAGENT_EXTRA_EXTENSIONS"), CursorExtension: deps.CursorExtension,
	})
	return sa.Parent{Cwd: ctx.Cwd(), Model: model, ModelProvider: provider, Thinking: thinking, ParentSessionFile: sessionFile, ExtensionLaunch: &launch}
}

func subagentRequest(params map[string]any) sa.Request {
	str := func(key string) string { v, _ := params[key].(string); return v }
	r := sa.Request{Context: str("context"), Model: str("model"), Thinking: str("thinking")}
	if v, ok := params["agent"].(string); ok {
		r.Agent = &v
	}
	if v, ok := params["task"].(string); ok {
		r.Task = &v
	}
	if tasks, ok := params["tasks"].([]any); ok {
		r.HasTasks = true
		r.Tasks = []sa.Task{}
		for _, raw := range tasks {
			t, _ := raw.(map[string]any)
			get := func(key string) string { v, _ := t[key].(string); return v }
			r.Tasks = append(r.Tasks, sa.Task{Agent: get("agent"), Task: get("task"), Model: get("model"), Thinking: get("thinking")})
		}
	}
	r.Async, _ = params["async"].(bool)
	if v, ok := params["concurrency"].(float64); ok {
		r.Concurrency = int(v)
	}
	if v, ok := params["timeoutMs"].(float64); ok {
		r.TimeoutMs = &v
	}
	return r
}

func subagentResult(text string, details any) sdk.ToolResult {
	return sdk.ToolResult{Content: text, Details: details}
}

func (s *subagentState) restore(ctx sdk.Context) {
	s.mu.Lock()
	s.epoch++
	s.shuttingDown = false
	if s.inspector != nil {
		s.reg.Mu.Lock()
		s.inspector.Close()
		s.reg.Mu.Unlock()
	}
	s.widgetCtx = nil
	s.checkpoints = map[string]string{}
	s.hidden = map[string]bool{}
	s.dirty = map[string]bool{}
	s.checkpointWarning = false
	s.mu.Unlock()
	s.stopWidgetTicker()
	restored := sa.RunsFromBranch(decodeBranch(ctx))
	s.reg.Mu.Lock()
	s.reg.Clear()
	for _, r := range restored {
		s.reg.RestoreRun(r.Run)
		if r.Launches != nil {
			sa.RestoreChildLaunches(r.Run, r.Launches)
		}
	}
	s.reg.Mu.Unlock()
}

func decodeBranch(ctx sdk.Context) []any {
	var out []any
	for _, raw := range sessionBranch(ctx) {
		if value, err := sa.Decode(raw); err == nil {
			out = append(out, value)
		}
	}
	return out
}

// subagentInspectorComponent adapts the inspector to an SDK overlay.
type subagentInspectorComponent struct {
	s        *subagentState
	in       *sa.Inspector
	mu       sync.Mutex
	stopTick chan struct{}
}

func (c *subagentInspectorComponent) Render(width int) []string {
	c.s.reg.Mu.Lock()
	defer c.s.reg.Mu.Unlock()
	return c.in.Render(width)
}

func (c *subagentInspectorComponent) HandleInput(data string) (sdk.RemoteComponentResult, error) {
	c.s.reg.Mu.Lock()
	c.in.HandleInput(data)
	closed := c.in.Closed()
	c.s.reg.Mu.Unlock()
	return sdk.RemoteComponentResult{Done: closed}, nil
}

// SetInvalidate repaints on a 500 ms ticker while the overlay is open.
func (c *subagentInspectorComponent) SetInvalidate(invalidate func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopTick != nil {
		close(c.stopTick)
		c.stopTick = nil
	}
	if invalidate == nil {
		return
	}
	stop := make(chan struct{})
	c.stopTick = stop
	go func() {
		ticker := time.NewTicker(sa.InspectorTickMs * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				invalidate()
			}
		}
	}()
}

func (c *subagentInspectorComponent) Dispose() {
	c.SetInvalidate(nil)
	c.s.reg.Mu.Lock()
	c.in.Dispose()
	c.s.reg.Mu.Unlock()
}

func (s *subagentState) openInspector(ctx sdk.Context) error {
	if ctx.Mode() != "tui" {
		ctx.Notify("The subagent inspector is only available in the interactive TUI; use subagent action=status instead.", "warning")
		return nil
	}
	s.mu.Lock()
	open := s.inspector != nil
	s.mu.Unlock()
	if open {
		return nil
	}
	s.reg.Mu.Lock()
	empty := len(s.visibleRuns()) == 0
	s.reg.Mu.Unlock()
	if empty {
		ctx.Notify("No subagent runs in this session yet.", "info")
		return nil
	}
	s.mu.Lock()
	epoch := s.epoch
	s.mu.Unlock()
	deps := s.deps(ctx)
	bg := s.background(ctx)
	var inspector *sa.Inspector
	inspector = sa.NewInspector(sa.InspectorOptions{
		Theme:      ctx.UITheme(),
		GetRuns:    s.visibleRuns,
		GetMaxRows: func() int { return int(float64(ctx.Height()) * 0.9) },
		Now:        nowMillis,
		Matches:    func(data, key string) bool { return sdktui.MatchesKey(data, sdktui.KeyID(key)) },
		LoadTranscript: func(file string) *sa.Transcript {
			return sa.LoadSavedTranscript(file, nowMillis())
		},
		ResumeUnavailable: func(t sa.Target) string { return s.reg.ResumeUnavailable(t.Run, t.Child) },
		ResumeChild: func(t sa.Target) {
			// HandleInput holds the registry lock: launch after it returns.
			go s.resumeChild(bg, t, epoch, deps, inspector)
		},
	})
	component := &subagentInspectorComponent{s: s, in: inspector}
	s.mu.Lock()
	s.inspector = inspector
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.inspector == inspector {
			s.inspector = nil
		}
		s.mu.Unlock()
	}()
	_, err := ctx.Custom(component, sdk.RemoteOverlayOptions{Overlay: true, OverlayOptions: &sdk.OverlayOptions{
		Anchor: "center", Margin: &sdk.OverlayMargin{All: new(1)}, MaxHeight: sdk.OverlayPercent(90), MinWidth: 50, Width: sdk.OverlayPercent(90),
	}})
	return err
}

func (s *subagentState) resumeChild(ctx sdk.Context, t sa.Target, epoch int, deps *sa.Deps, inspector *sa.Inspector) {
	if !s.live(epoch) {
		return
	}
	focused := false
	continuation, start, err := s.reg.PrepareResume(sa.ResumeInput{Run: t.Run, Child: t.Child, Deps: deps, OnUpdate: func(run *sa.Run) {
		if !s.live(epoch) {
			return
		}
		if s.isHidden(run.ID) {
			s.markDirty(run.ID)
			return
		}
		s.checkpoint(ctx, t.Run, false)
		s.checkpoint(ctx, run, false)
		s.trackWidget(ctx)
		if !focused {
			focused = true
			s.reg.Mu.Lock()
			inspector.InspectRun(run)
			s.reg.Mu.Unlock()
		}
	}})
	if err != nil {
		if s.live(epoch) {
			ctx.Notify("Could not resume subagent: "+err.Error(), "warning")
		}
		return
	}
	run := start()
	_ = continuation
	if !s.live(epoch) || s.isHidden(run.ID) {
		return
	}
	s.trackWidget(ctx)
	s.emitBackground(ctx, run, false)
	s.sendComplete(ctx, run)
}

func registerSubagents(e *sdk.Extension) {
	s := &subagentState{reg: sa.NewRegistry(), hidden: map[string]bool{}, dirty: map[string]bool{}, checkpoints: map[string]string{}}
	e.OnLoaded(func(ctx sdk.Context) {
		s.mu.Lock()
		s.loaded = &ctx
		s.mu.Unlock()
	})

	e.RegisterCommand("subagents", sdk.CommandOptions{
		Description: "Inspect subagent runs live: thinking, responses, tool calls and results, logs",
		Handler:     func(ctx sdk.Context, _ string) error { return s.openInspector(ctx) },
	})
	e.Shortcut(sa.InspectorShortcut, "Open the live subagent inspector", s.openInspector)

	e.RegisterTool(sdk.ToolDefinition{
		Name:             "subagent",
		Label:            "Subagent",
		Description:      subagentDescription,
		PromptSnippet:    "Delegate focused work to one or more isolated child agents",
		PromptGuidelines: subagentGuidelines,
		Parameters:       subagentSchema(),
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			return s.execute(ctx, params)
		},
	})

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.restore(ctx)
		return nil, nil
	})

	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		if s.inspector != nil {
			s.reg.Mu.Lock()
			s.inspector.Close()
			s.reg.Mu.Unlock()
		}
		dirty := map[string]bool{}
		for id := range s.dirty {
			dirty[id] = true
		}
		s.mu.Unlock()
		history := sa.RunsFromBranch(decodeBranch(ctx))
		selected := map[string]bool{}
		runs := make([]*sa.Run, len(history))
		for i, r := range history {
			selected[r.Run.ID] = true
			runs[i] = r.Run
		}
		s.reg.Mu.Lock()
		s.reg.ReconcileRuns(runs, dirty)
		hidden := map[string]bool{}
		for _, run := range s.reg.ListRuns() {
			if !selected[run.ID] {
				hidden[run.ID] = true
			}
		}
		var flush []*sa.Run
		for _, r := range history {
			current := s.reg.GetRun(r.Run.ID)
			if current == r.Run && r.Launches != nil {
				sa.RestoreChildLaunches(r.Run, r.Launches)
			}
			if current != nil && s.reg.IsOwned(current) && dirty[current.ID] {
				flush = append(flush, current)
			}
		}
		s.reg.Mu.Unlock()
		s.mu.Lock()
		s.hidden = hidden
		s.mu.Unlock()
		for _, run := range flush {
			if s.checkpoint(ctx, run, true) {
				s.mu.Lock()
				delete(s.dirty, run.ID)
				s.mu.Unlock()
			}
		}
		s.reg.Mu.Lock()
		s.mu.Lock()
		for id := range s.dirty {
			if s.reg.GetRun(id) == nil {
				delete(s.dirty, id)
			}
		}
		s.mu.Unlock()
		s.reg.Mu.Unlock()
		s.trackWidget(ctx)
		return nil, nil
	})

	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		s.epoch++
		s.shuttingDown = true
		if s.inspector != nil {
			s.reg.Mu.Lock()
			s.inspector.Close()
			s.reg.Mu.Unlock()
		}
		s.widgetCtx = nil
		hidden, dirty := s.hidden, s.dirty
		s.mu.Unlock()
		s.stopWidgetTicker()
		s.reg.Mu.Lock()
		var save []*sa.Run
		for _, run := range s.reg.ListRuns() {
			active := run.Active()
			if active {
				_, _ = s.reg.StopRun(run.ID)
			}
			if !hidden[run.ID] && (active || dirty[run.ID]) {
				save = append(save, run)
			}
		}
		s.reg.Mu.Unlock()
		for _, run := range save {
			s.checkpoint(ctx, run, false)
		}
		if ctx.HasUI() {
			_ = ctx.SetWidget(subagentWidgetKey, nil)
		}
		return nil, nil
	})
}

func (s *subagentState) execute(ctx sdk.Context, params map[string]any) (any, error) {
	trusted, _ := ctx.IsProjectTrusted()
	agentDir, _ := sdk.AgentDir()
	action, _ := params["action"].(string)
	id, _ := params["id"].(string)
	now := nowMillis()
	switch action {
	case "list":
		agents, err := sa.DiscoverAgents(ctx.Cwd(), agentDir, trusted)
		if err != nil {
			return nil, err
		}
		details := []map[string]any{}
		for _, a := range agents {
			details = append(details, map[string]any{"name": a.Name, "description": a.Description, "source": a.Source})
		}
		return subagentResult(sa.AgentList(agents), map[string]any{"agents": details}), nil
	case "status":
		s.reg.Mu.Lock()
		defer s.reg.Mu.Unlock()
		if id != "" {
			run := s.reg.GetRun(id)
			if run == nil {
				return nil, fmt.Errorf("Unknown or ambiguous subagent run '%s'.", id)
			}
			text := sa.FormatRunResult(run)
			if run.Active() {
				text = sa.FormatRunProgress(run, now)
			}
			return subagentResult(text, map[string]any{"run": sa.PublicRun(run)}), nil
		}
		runs := s.visibleRuns()
		public := []any{}
		for _, run := range runs {
			public = append(public, sa.PublicRun(run))
		}
		return subagentResult(sa.StatusList(runs, now), map[string]any{"runs": public}), nil
	case "stop":
		if id == "" {
			return nil, errors.New("Subagent stop requires an id.")
		}
		s.reg.Mu.Lock()
		run, err := s.reg.StopRun(id)
		var text string
		var details any
		if err == nil {
			text, details = "Subagent run "+run.ID+" is "+run.State+".", map[string]any{"run": sa.PublicRun(run)}
		}
		s.reg.Mu.Unlock()
		if err != nil {
			return nil, err
		}
		if s.isHidden(run.ID) {
			s.markDirty(run.ID)
		} else {
			s.checkpoint(ctx, run, false)
		}
		s.trackWidget(ctx)
		return subagentResult(text, details), nil
	case "":
	default:
		return nil, fmt.Errorf("Unsupported subagent action '%s'.", action)
	}

	request := subagentRequest(params)
	agents, err := sa.DiscoverAgents(ctx.Cwd(), agentDir, trusted)
	if err != nil {
		return nil, err
	}
	deps := s.deps(ctx)
	parent := s.parent(ctx, deps)
	s.mu.Lock()
	epoch := s.epoch
	s.mu.Unlock()

	if request.Async {
		bg := s.background(ctx)
		updateWidget := func(run *sa.Run) {
			if !s.live(epoch) {
				return
			}
			if run != nil && s.isHidden(run.ID) {
				s.markDirty(run.ID)
				return
			}
			if run != nil {
				s.checkpoint(bg, run, false)
			}
			s.trackWidget(bg)
		}
		run, start, err := s.reg.Prepare(sa.RunInput{Request: request, Agents: agents, Parent: parent, Deps: deps, OnUpdate: updateWidget}, nil)
		if err != nil {
			return nil, err
		}
		go func() {
			defer func() {
				if r := recover(); r != nil {
					fmt.Fprintf(os.Stderr, "aio subagents: background run stopped: %v\n", r)
				}
			}()
			finished := start()
			if !s.live(epoch) || s.isHidden(finished.ID) {
				return
			}
			updateWidget(nil)
			s.emitBackground(bg, finished, false)
			s.sendComplete(bg, finished)
		}()
		s.reg.Mu.Lock()
		text, details := "Subagent run "+run.ID+" started in the background.", map[string]any{"run": sa.PublicRun(run)}
		s.reg.Mu.Unlock()
		return subagentResult(text, details), nil
	}

	var current *sa.Run
	var currentMu sync.Mutex
	updateForeground := func(run *sa.Run) {
		currentMu.Lock()
		current = run
		currentMu.Unlock()
		if !s.live(epoch) {
			return
		}
		if s.isHidden(run.ID) {
			s.markDirty(run.ID)
			return
		}
		s.checkpoint(ctx, run, false)
		s.trackWidget(ctx)
		s.reg.Mu.Lock()
		text, details := sa.FormatRunProgress(run, nowMillis()), map[string]any{"run": sa.PublicRun(run)}
		s.reg.Mu.Unlock()
		_ = ctx.OnUpdate(sdk.ToolResult{Content: text, Details: details})
	}
	stopTicker := make(chan struct{})
	go func() {
		ticker := time.NewTicker(activityTickMs * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopTicker:
				return
			case <-ticker.C:
				currentMu.Lock()
				run := current
				currentMu.Unlock()
				if run == nil {
					continue
				}
				s.reg.Mu.Lock()
				running := run.State == "running"
				s.reg.Mu.Unlock()
				if running {
					updateForeground(run)
				}
			}
		}
	}()
	run, err := s.reg.Execute(sa.RunInput{Request: request, Agents: agents, Parent: parent, Deps: deps, Done: ctx.Done(), OnUpdate: updateForeground}, nil)
	close(stopTicker)
	if err != nil {
		return nil, err
	}
	if s.live(epoch) {
		s.trackWidget(ctx)
	}
	s.reg.Mu.Lock()
	defer s.reg.Mu.Unlock()
	return subagentResult(sa.FormatRunResult(run), map[string]any{"run": sa.PublicRun(run)}), nil
}
