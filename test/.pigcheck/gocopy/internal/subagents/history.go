package subagents

// Port of subagents/history.ts: the public projection of a run (tool details
// and checkpoints), and the restore of runs from the selected branch. The
// schema checks follow the TypeBox schemas: known fields are type-checked,
// unknown fields are ignored and never restored.

import (
	"math"
	"slices"
	"time"
)

// StateEntry is the custom entry type of run checkpoints.
const StateEntry = "aio-subagent-state"

// CompleteMessage is the custom message type of background completions.
const CompleteMessage = "aio-subagent-complete"

var runStates = []string{"queued", "running", "completed", "failed", "stopped"}

// PublicRun is publicRun: an explicit projection without process handles or
// private prompts. The result marshals to the same JSON as TypeScript.
func PublicRun(run *Run) *Object {
	children := make([]any, len(run.Children))
	for i, c := range run.Children {
		child := NewObject("index", float64(c.Index), "agent", c.Agent, "task", c.Task, "state", c.State)
		setOpt(child, "model", c.Model)
		setOpt(child, "thinking", c.Thinking)
		setNum(child, "startedAt", c.StartedAt)
		setNum(child, "endedAt", c.EndedAt)
		if c.Output != nil {
			child.Set("output", *c.Output)
		}
		setOpt(child, "error", c.Error)
		setOpt(child, "sessionFile", c.SessionFile)
		attempts := 1
		if c.Attempts != nil {
			attempts = *c.Attempts
		}
		child.Set("attempts", float64(attempts))
		if a := c.Activity; a != nil {
			tools := make([]any, len(a.RunningTools))
			for j, t := range a.RunningTools {
				tools[j] = NewObject("id", t.ID, "name", t.Name, "summary", t.Summary, "startedAt", t.StartedAt)
			}
			activity := NewObject("phase", a.Phase, "lastEventAt", a.LastEventAt, "turns", float64(a.Turns),
				"toolCount", float64(a.ToolCount), "runningTools", tools)
			if a.Retry != nil {
				retry := NewObject("attempt", a.Retry.Attempt, "maxAttempts", a.Retry.MaxAttempts)
				if a.Retry.Error != nil {
					retry.Set("error", *a.Retry.Error)
				}
				activity.Set("retry", retry)
			}
			setNum(activity, "settledAt", a.SettledAt)
			child.Set("activity", activity)
		}
		if c.ReapedAfterSettle != nil {
			child.Set("reapedAfterSettle", *c.ReapedAfterSettle)
		}
		children[i] = child
	}
	out := NewObject("id", run.ID, "state", run.State, "mode", run.Mode, "context", run.Context, "cwd", run.Cwd,
		"startedAt", run.StartedAt)
	setNum(out, "endedAt", run.EndedAt)
	setOpt(out, "error", run.Error)
	if run.ResumedFrom != nil {
		out.Set("resumedFrom", NewObject("runId", run.ResumedFrom.RunID, "index", float64(run.ResumedFrom.Index)))
	}
	out.Set("children", children)
	return out
}

func setOpt(o *Object, key, value string) {
	if value != "" {
		o.Set(key, value)
	}
}

func setNum(o *Object, key string, value *float64) {
	if value != nil {
		o.Set(key, *value)
	}
}

// ---- schema checks (TypeBox Value.Check) ----

func isString(v any) bool { _, ok := v.(string); return ok }

func isNumber(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func isInteger(v any, minimum, maximum float64) bool {
	f, ok := v.(float64)
	return ok && f == math.Trunc(f) && !math.IsInf(f, 0) && f >= minimum && f <= maximum
}

// optional checks an optional property: absent passes; present must pass.
func optional(o *Object, key string, check func(any) bool) bool {
	if !o.Has(key) {
		return true
	}
	return check(o.Get(key))
}

func oneOf(values ...string) func(any) bool {
	return func(v any) bool {
		s, ok := v.(string)
		return ok && slices.Contains(values, s)
	}
}

var (
	isState    = oneOf(runStates...)
	isThinking = oneOf(ThinkingLevels...)
	isContext  = oneOf("fresh", "fork")
)

func isBool(v any) bool { _, ok := v.(bool); return ok }

func checkChild(v any) bool {
	o, ok := v.(*Object)
	if !ok {
		return false
	}
	return isInteger(o.Get("index"), 0, 11) && isString(o.Get("agent")) && isString(o.Get("task")) &&
		isState(o.Get("state")) && optional(o, "model", isString) && optional(o, "thinking", isThinking) &&
		optional(o, "startedAt", isNumber) && optional(o, "endedAt", isNumber) && optional(o, "output", isString) &&
		optional(o, "error", isString) && optional(o, "sessionFile", isString) &&
		optional(o, "attempts", func(v any) bool { return isInteger(v, 0, math.Inf(1)) }) &&
		optional(o, "reapedAfterSettle", isBool)
}

func checkRun(v any) bool {
	o, ok := v.(*Object)
	if !ok {
		return false
	}
	id, _ := o.Get("id").(string)
	children, isList := o.Get("children").([]any)
	if id == "" || !isState(o.Get("state")) || !oneOf("single", "parallel")(o.Get("mode")) ||
		!isContext(o.Get("context")) || !isString(o.Get("cwd")) || !isNumber(o.Get("startedAt")) ||
		!optional(o, "endedAt", isNumber) || !optional(o, "error", isString) || !isList ||
		len(children) < 1 || len(children) > 12 {
		return false
	}
	for _, child := range children {
		if !checkChild(child) {
			return false
		}
	}
	return optional(o, "resumedFrom", func(v any) bool {
		r, ok := v.(*Object)
		return ok && isString(r.Get("runId")) && isInteger(r.Get("index"), 0, 11)
	})
}

func checkLaunch(v any) bool {
	o, ok := v.(*Object)
	if !ok {
		return false
	}
	task, _ := o.Get("task").(*Object)
	request, _ := o.Get("request").(*Object)
	agent, _ := o.Get("agent").(*Object)
	parent, _ := o.Get("parent").(*Object)
	if task == nil || request == nil || agent == nil || parent == nil {
		return false
	}
	if !isString(task.Get("agent")) || !isString(task.Get("task")) || !optional(task, "model", isString) ||
		!optional(task, "thinking", isThinking) {
		return false
	}
	if !optional(request, "context", isContext) || !optional(request, "timeoutMs", isNumber) {
		return false
	}
	if !isString(agent.Get("name")) || !isString(agent.Get("description")) || !isString(agent.Get("systemPrompt")) ||
		!oneOf("append", "replace")(agent.Get("systemPromptMode")) || !isBool(agent.Get("inheritProjectContext")) ||
		!isBool(agent.Get("inheritSkills")) || !optional(agent, "tools", isStringList) ||
		!optional(agent, "model", isString) || !optional(agent, "thinking", isThinking) ||
		!optional(agent, "timeoutMs", isNumber) || !oneOf("builtin", "user", "project")(agent.Get("source")) ||
		!isString(agent.Get("filePath")) {
		return false
	}
	launch, _ := parent.Get("extensionLaunch").(*Object)
	if !isString(parent.Get("cwd")) || !optional(parent, "model", isString) || !optional(parent, "modelProvider", isString) ||
		!optional(parent, "thinking", isThinking) || !optional(parent, "parentSessionFile", isString) ||
		launch == nil || !isBool(launch.Get("noExtensions")) || !isStringList(launch.Get("paths")) {
		return false
	}
	return isBool(o.Get("resumed")) && optional(o, "sessionDir", isString) &&
		optional(o, "pid", func(v any) bool { return isInteger(v, 1, math.Inf(1)) })
}

func isStringList(v any) bool {
	list, ok := v.([]any)
	if !ok {
		return false
	}
	for _, item := range list {
		if !isString(item) {
			return false
		}
	}
	return true
}

func str(o *Object, key string) string { s, _ := o.Get(key).(string); return s }

func num(o *Object, key string) *float64 {
	if f, ok := o.Get(key).(float64); ok {
		return fptr(f)
	}
	return nil
}

func firstNum(values ...*float64) float64 {
	for _, v := range values {
		if v != nil {
			return *v
		}
	}
	return 0
}

// DecodeHistoricalRun is decodeHistoricalRun: known fields only; restored
// running or queued records are interrupted, never live processes.
func DecodeHistoricalRun(value any, recordedAt *float64) *Run {
	if !checkRun(value) {
		return nil
	}
	o := value.(*Object)
	raw := o.Get("children").([]any)
	seen := map[float64]bool{}
	for _, c := range raw {
		seen[c.(*Object).Get("index").(float64)] = true
	}
	if len(seen) != len(raw) {
		return nil
	}
	startedAt := o.Get("startedAt").(float64)
	runEnded := num(o, "endedAt")
	var children []*Child
	for _, rawChild := range raw {
		c := rawChild.(*Object)
		state := str(c, "state")
		interrupted := state == "running" || state == "queued"
		if interrupted {
			state = "stopped"
		}
		child := &Child{Index: int(c.Get("index").(float64)), Agent: str(c, "agent"), Task: str(c, "task"), State: state,
			Model: str(c, "model"), Thinking: str(c, "thinking"), StartedAt: num(c, "startedAt"),
			SessionFile: str(c, "sessionFile"), Error: str(c, "error")}
		child.EndedAt = fptr(firstNum(num(c, "endedAt"), runEnded, recordedAt, fptr(startedAt)))
		if out, ok := c.Get("output").(string); ok {
			child.Output = sptr(out)
		}
		if a, ok := c.Get("attempts").(float64); ok {
			child.Attempts = iptr(int(a))
		}
		if !c.Has("error") && interrupted {
			child.Error = "Interrupted when the parent session ended."
		}
		if r, ok := c.Get("reapedAfterSettle").(bool); ok {
			child.ReapedAfterSettle = bptr(r)
		}
		children = append(children, child)
	}
	state := str(o, "state")
	if state == "running" || state == "queued" {
		state = "stopped"
	}
	run := &Run{ID: str(o, "id"), State: state, Mode: str(o, "mode"), Context: str(o, "context"), Cwd: str(o, "cwd"),
		StartedAt: startedAt, EndedAt: fptr(firstNum(runEnded, recordedAt, fptr(startedAt))), Error: str(o, "error"),
		StopRequested: state == "stopped", Children: children}
	if r, ok := o.Get("resumedFrom").(*Object); ok {
		run.ResumedFrom = &ResumedFrom{RunID: str(r, "runId"), Index: int(r.Get("index").(float64))}
	}
	for _, c := range children {
		output := ""
		if c.Output != nil {
			output = *c.Output
		}
		exit := 1
		if c.State == "completed" {
			exit = 0
		}
		attempts := 1
		if c.Attempts != nil {
			attempts = *c.Attempts
		}
		run.Results = append(run.Results, &Result{Index: c.Index, Agent: c.Agent, Task: c.Task, State: c.State,
			Output: output, Error: c.Error, ExitCode: exit, Model: c.Model, Thinking: c.Thinking,
			SessionFile: c.SessionFile, StartedAt: firstNum(c.StartedAt, fptr(startedAt)),
			EndedAt: firstNum(c.EndedAt, runEnded, fptr(startedAt)), Attempts: attempts,
			ReapedAfterSettle: c.ReapedAfterSettle})
	}
	return run
}

// Restored is RestoredRun. Launches is nil when the record has none; a nil
// item means that child has no valid launch.
type Restored struct {
	Run      *Run
	Launches []*LaunchSnapshot
}

// DecodeLaunch decodes a validated launch snapshot.
func DecodeLaunch(v any) *LaunchSnapshot {
	o := v.(*Object)
	task, request, agent, parent := o.Get("task").(*Object), o.Get("request").(*Object), o.Get("agent").(*Object), o.Get("parent").(*Object)
	launch := &LaunchSnapshot{
		Task:    Task{Agent: str(task, "agent"), Task: str(task, "task"), Model: str(task, "model"), Thinking: str(task, "thinking")},
		Request: LaunchRequest{Context: str(request, "context"), TimeoutMs: num(request, "timeoutMs")},
		Agent: AgentConfig{Name: str(agent, "name"), Description: str(agent, "description"), SystemPrompt: str(agent, "systemPrompt"),
			SystemPromptMode: str(agent, "systemPromptMode"), InheritProjectContext: agent.Get("inheritProjectContext") == true,
			InheritSkills: agent.Get("inheritSkills") == true, Model: str(agent, "model"), Thinking: str(agent, "thinking"),
			TimeoutMs: num(agent, "timeoutMs"), Source: str(agent, "source"), FilePath: str(agent, "filePath")},
		Parent: Parent{Cwd: str(parent, "cwd"), Model: str(parent, "model"), ModelProvider: str(parent, "modelProvider"),
			Thinking: str(parent, "thinking"), ParentSessionFile: str(parent, "parentSessionFile")},
		Resumed:    o.Get("resumed") == true,
		SessionDir: str(o, "sessionDir"),
	}
	if tools, ok := agent.Get("tools").([]any); ok {
		launch.Agent.Tools = []string{}
		for _, tool := range tools {
			launch.Agent.Tools = append(launch.Agent.Tools, tool.(string))
		}
	}
	ext := parent.Get("extensionLaunch").(*Object)
	paths := []string{}
	for _, p := range ext.Get("paths").([]any) {
		paths = append(paths, p.(string))
	}
	launch.Parent.ExtensionLaunch = &ExtensionLaunch{NoExtensions: ext.Get("noExtensions") == true, Paths: paths}
	if pid, ok := o.Get("pid").(float64); ok {
		launch.PID = int(pid)
	}
	return launch
}

// EncodeLaunch is the JSON form of a launch snapshot (structuredClone).
func EncodeLaunch(l *LaunchSnapshot) *Object {
	task := NewObject("agent", l.Task.Agent, "task", l.Task.Task)
	setOpt(task, "model", l.Task.Model)
	setOpt(task, "thinking", l.Task.Thinking)
	request := NewObject()
	setOpt(request, "context", l.Request.Context)
	setNum(request, "timeoutMs", l.Request.TimeoutMs)
	agent := NewObject("name", l.Agent.Name, "description", l.Agent.Description, "systemPrompt", l.Agent.SystemPrompt,
		"systemPromptMode", l.Agent.SystemPromptMode, "inheritProjectContext", l.Agent.InheritProjectContext,
		"inheritSkills", l.Agent.InheritSkills)
	if l.Agent.Tools != nil {
		tools := make([]any, len(l.Agent.Tools))
		for i, tool := range l.Agent.Tools {
			tools[i] = tool
		}
		agent.Set("tools", tools)
	}
	setOpt(agent, "model", l.Agent.Model)
	setOpt(agent, "thinking", l.Agent.Thinking)
	setNum(agent, "timeoutMs", l.Agent.TimeoutMs)
	agent.Set("source", l.Agent.Source)
	agent.Set("filePath", l.Agent.FilePath)
	parent := NewObject("cwd", l.Parent.Cwd)
	setOpt(parent, "model", l.Parent.Model)
	setOpt(parent, "modelProvider", l.Parent.ModelProvider)
	setOpt(parent, "thinking", l.Parent.Thinking)
	setOpt(parent, "parentSessionFile", l.Parent.ParentSessionFile)
	if ext := l.Parent.ExtensionLaunch; ext != nil {
		paths := make([]any, len(ext.Paths))
		for i, p := range ext.Paths {
			paths[i] = p
		}
		parent.Set("extensionLaunch", NewObject("noExtensions", ext.NoExtensions, "paths", paths))
	}
	out := NewObject("task", task, "request", request, "agent", agent, "parent", parent, "resumed", l.Resumed)
	setOpt(out, "sessionDir", l.SessionDir)
	if l.PID > 0 {
		out.Set("pid", float64(l.PID))
	}
	return out
}

// CloneLaunch is structuredClone of a launch snapshot.
func CloneLaunch(l *LaunchSnapshot) *LaunchSnapshot {
	if l == nil {
		return nil
	}
	c := *l
	c.Agent.Tools = slices.Clone(l.Agent.Tools)
	if l.Agent.TimeoutMs != nil {
		c.Agent.TimeoutMs = fptr(*l.Agent.TimeoutMs)
	}
	if l.Request.TimeoutMs != nil {
		c.Request.TimeoutMs = fptr(*l.Request.TimeoutMs)
	}
	if ext := l.Parent.ExtensionLaunch; ext != nil {
		c.Parent.ExtensionLaunch = &ExtensionLaunch{NoExtensions: ext.NoExtensions, Paths: slices.Clone(ext.Paths)}
	}
	return &c
}

func parseTimestamp(v any) *float64 {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return fptr(float64(t.UnixMilli()))
		}
	}
	return nil
}

// RunsFromBranch is runsFromBranch: scan the selected branch only (newest
// 50 runs), including pre-checkpoint tool results and completions.
func RunsFromBranch(entries []any) []Restored {
	restored := map[string]*Restored{}
	var order []string
	add := func(data any, launches any, hasLaunches bool, recordedAt *float64) {
		run := DecodeHistoricalRun(data, recordedAt)
		if run == nil {
			return
		}
		previous := restored[run.ID]
		var parsed []*LaunchSnapshot
		if list, ok := launches.([]any); hasLaunches && ok {
			parsed = make([]*LaunchSnapshot, len(run.Children))
			for position, child := range run.Children {
				if position >= len(list) || !checkLaunch(list[position]) {
					continue
				}
				launch := DecodeLaunch(list[position])
				if launch.Task.Agent != child.Agent || launch.Task.Task != child.Task || launch.Agent.Name != child.Agent || launch.Parent.Cwd != run.Cwd {
					continue
				}
				parsed[position] = launch
			}
		} else if previous != nil {
			parsed = previous.Launches
		}
		if previous == nil {
			order = append(order, run.ID)
		}
		restored[run.ID] = &Restored{Run: run, Launches: parsed}
	}
	for _, raw := range entries {
		entry, ok := raw.(*Object)
		if !ok {
			continue
		}
		recordedAt := parseTimestamp(entry.Get("timestamp"))
		switch {
		case entry.Get("type") == "custom" && entry.Get("customType") == StateEntry:
			if data, ok := entry.Get("data").(*Object); ok && data.Get("version") == float64(1) {
				add(data.Get("run"), data.Get("launches"), true, recordedAt)
			}
		case entry.Get("type") == "custom_message" && entry.Get("customType") == CompleteMessage:
			add(entry.Get("details"), nil, false, recordedAt)
		case entry.Get("type") == "message":
			message, _ := entry.Get("message").(*Object)
			details, _ := message.Get("details").(*Object)
			if message.Get("role") == "toolResult" && message.Get("toolName") == "subagent" {
				if runs, ok := details.Get("runs").([]any); ok {
					for _, run := range runs {
						add(run, nil, false, recordedAt)
					}
				}
				add(details.Get("run"), nil, false, recordedAt)
			} else if message.Get("role") == "custom" && message.Get("customType") == CompleteMessage {
				add(message.Get("details"), nil, false, recordedAt)
			}
		}
	}
	// A continuation claims its ancestor even if a crash prevented its final
	// checkpoint: never two writers to one preserved child session.
	for _, id := range order {
		from := restored[id].Run.ResumedFrom
		if from == nil {
			continue
		}
		source := restored[from.RunID]
		if source == nil {
			continue
		}
		position := slices.IndexFunc(source.Run.Children, func(c *Child) bool { return c.Index == from.Index })
		if position >= 0 && position < len(source.Launches) && source.Launches[position] != nil {
			source.Launches[position].Resumed = true
		}
	}
	out := make([]Restored, 0, len(order))
	for _, id := range order {
		out = append(out, *restored[id])
	}
	slices.SortStableFunc(out, func(a, b Restored) int { return cmpDesc(a.Run.StartedAt, b.Run.StartedAt) })
	if len(out) > 50 {
		out = out[:50]
	}
	return out
}
