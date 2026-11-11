package yamlhooks

// Hook actions (port of yaml-hooks/actions.ts): bash, tool (follow-up
// prompt), notify, confirm, and setStatus. Only confirm and blocking bash
// on tool.before.* can block; other failures are logged and swallowed.

import (
	"fmt"
	"math"
	"os"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Delivery is HostDeliveryResult.
type Delivery struct {
	Status  string // accepted or degraded
	Reason  string
	Details *Object
}

func (d Delivery) toObject() *Object {
	o := NewObject("status", d.Status)
	if d.Reason != "" {
		o.Set("reason", d.Reason)
	}
	if d.Details != nil {
		o.Set("details", d.Details)
	}
	return o
}

// HostAdapter is the Pi host surface the runtime calls (types.ts
// HostAdapter, minus runBash, which the runtime calls through its seam).
type HostAdapter interface {
	SendPrompt(sessionID, text string) (Delivery, error)
	Notify(text, level string) (Delivery, error)
	// Confirm returns false for a denial or a UI failure.
	Confirm(title *string, message string, timeout *float64) bool
	SetStatus(hookID, text string) (Delivery, error)
	Abort(sessionID string)
	RootSessionID(sessionID string) string
}

// budget is SynchronousBashBudget (ms).
type budget struct {
	deadline float64
	now      func() float64
}

// ActionContext is RuntimeActionContext. Has* flags mark present fields.
type ActionContext struct {
	Prompt     *string
	Files      []string
	HasFiles   bool
	Changes    []FileChange
	HasChanges bool
	ToolName   *string
	ToolArgs   *Object
	pathMatch  *PathMatchContext
	budget     *budget
}

// Result is HookExecutionResult.
type Result struct {
	Blocked           bool
	BlockReason       string
	HasBlockReason    bool
	StopSession       bool
	AdditionalContext []string
}

type actionInput struct {
	action     Action
	runIn      string
	rt         *Runtime
	event      string
	sessionID  string
	context    ActionContext
	sourceFile string
	hookID     string
	guard      *guardStore
}

func executeAction(in actionInput) (Result, error) {
	switch in.action.Kind {
	case "bash":
		return executeBashAction(in)
	case "tool":
		executeToolAction(in)
	case "notify":
		executeNotifyAction(in)
	case "confirm":
		return executeConfirmAction(in), nil
	case "setStatus":
		executeSetStatusAction(in)
	}
	return Result{}, nil
}

func executeBashAction(in actionInput) (Result, error) {
	a := in.action
	timeout := float64(DefaultBashTimeout)
	if a.Timeout != nil {
		timeout = *a.Timeout
	}
	if b := in.context.budget; b != nil {
		remaining := math.Max(1, b.deadline-b.now())
		timeout = math.Min(timeout, remaining)
	}
	ctx := BashContext{
		SessionID: in.sessionID, Event: in.event, Cwd: in.rt.projectDir,
		Prompt: in.context.Prompt, Files: in.context.Files, HasFiles: in.context.HasFiles,
		Changes: in.context.Changes, HasChange: in.context.HasChanges,
		ToolName: in.context.ToolName, ToolArgs: SanitizeToolArgs(in.context.ToolArgs),
	}
	result, err := in.rt.runBash(BashRequest{Command: a.Command, Timeout: timeout, ProjectDir: in.rt.projectDir, Context: ctx})
	if err != nil {
		return Result{}, err
	}
	logBashActionOutcome(result, in, timeout)
	if in.event == "user.prompt.submit" {
		text := jsstr.Trim(result.Stdout)
		usable := !result.OutputTruncated && !result.StdinTruncated
		if result.Status == "success" && usable && text != "" {
			return Result{AdditionalContext: []string{text}}, nil
		}
		if result.OutputTruncated || result.StdinTruncated {
			actionLog("warn", "action_result", "Discarded prompt hook output from a truncated execution.", in,
				NewObject("status", result.Status, "outputTruncated", result.OutputTruncated, "stdinTruncated", result.StdinTruncated))
		}
		return Result{}, nil
	}
	if result.Blocking {
		reason := RedactSensitiveContent(jsstr.Trim(result.Stderr))
		if reason == "" {
			reason = "Blocked by hook"
		}
		return Result{Blocked: true, BlockReason: reason, HasBlockReason: true}, nil
	}
	return Result{}, nil
}

func toolActionObject(a Action) *Object {
	o := NewObject("name", a.Name)
	if a.ToolArgs != nil {
		o.Set("args", a.ToolArgs)
	}
	return o
}

func errorText(err any) string {
	if e, ok := err.(error); ok {
		return e.Error()
	}
	return fmt.Sprint(err)
}

func executeToolAction(in actionInput) {
	defer func() {
		if r := recover(); r != nil {
			actionLog("error", "action_result", "Tool action failed.", in, NewObject("error", errorText(r)))
		}
	}()
	target, ok := resolveActionSessionID(in.rt, in.sessionID, in.runIn)
	if !ok {
		return
	}
	var args any = &Object{Values: map[string]any{}}
	if in.action.ToolArgs != nil {
		args = in.action.ToolArgs
	}
	prompt := fmt.Sprintf("Use the %s tool with these arguments: %s", in.action.Name, Stringify(args))
	key := in.event + ":" + target + ":tool:" + in.sourceFile + ":" + Stringify(toolActionObject(in.action))
	delivery := Delivery{Status: "accepted"}
	var sendErr error
	withActionRecursionGuard(in.guard, key, func(*guardStore) {
		d, err := in.rt.host.SendPrompt(target, prompt)
		if err != nil {
			sendErr = err
			return
		}
		delivery = normalizeDelivery(d)
	})
	if sendErr != nil {
		actionLog("error", "action_result", "Tool action failed.", in, NewObject("error", sendErr.Error()))
		return
	}
	if delivery.Status == "degraded" {
		actionLog("warn", "action_result", "Tool action degraded before the follow-up prompt was accepted.", in, NewObject("delivery", delivery.toObject()))
	} else {
		actionLog("info", "action_result", "Tool action queued a follow-up prompt.", in, NewObject("toolName", in.action.Name, "delivery", delivery.toObject()))
	}
}

func executeNotifyAction(in actionInput) {
	defer func() {
		if r := recover(); r != nil {
			actionLog("error", "action_result", "Notification action failed.", in, NewObject("error", errorText(r)))
		}
	}()
	level := "info"
	if in.action.Level != nil {
		level = *in.action.Level
	}
	d, err := in.rt.host.Notify(in.action.Text, level)
	if err != nil {
		actionLog("error", "action_result", "Notification action failed.", in, NewObject("error", err.Error()))
		return
	}
	d = normalizeDelivery(d)
	if d.Status == "degraded" {
		actionLog("warn", "action_result", "Notification action degraded before the host accepted it.", in, NewObject("text", in.action.Text, "level", level, "delivery", d.toObject()))
	} else {
		actionLog("info", "action_result", "Notification action delivered.", in, NewObject("text", in.action.Text, "level", level))
	}
}

func executeConfirmAction(in actionInput) (result Result) {
	defer func() {
		if r := recover(); r != nil {
			actionLog("error", "action_result", "Confirmation action failed.", in, NewObject("error", errorText(r)))
			result = Result{}
		}
	}()
	var remaining *float64
	if b := in.context.budget; b != nil {
		v := math.Max(0, b.deadline-b.now())
		remaining = &v
	}
	approved := false
	if remaining == nil || *remaining != 0 {
		approved = in.rt.host.Confirm(in.action.Title, in.action.Message, remaining)
	}
	if !approved {
		return Result{Blocked: true, BlockReason: "Blocked by user via confirm action", HasBlockReason: true}
	}
	return Result{}
}

func executeSetStatusAction(in actionInput) {
	defer func() {
		if r := recover(); r != nil {
			actionLog("error", "action_result", "Status action failed.", in, NewObject("error", errorText(r)))
		}
	}()
	statusID := "aio-yaml-hooks:" + in.hookID
	d, err := in.rt.host.SetStatus(statusID, in.action.Text)
	if err != nil {
		actionLog("error", "action_result", "Status action failed.", in, NewObject("error", err.Error()))
		return
	}
	d = normalizeDelivery(d)
	if d.Status == "degraded" {
		actionLog("warn", "action_result", "Status action degraded before the host accepted it.", in, NewObject("statusHookId", statusID, "text", in.action.Text, "delivery", d.toObject()))
	} else {
		actionLog("info", "action_result", "Status action updated the status surface.", in, NewObject("statusHookId", statusID, "text", in.action.Text))
	}
}

// resolveActionSessionID is actions.ts resolveActionSessionID.
func resolveActionSessionID(rt *Runtime, sessionID, runIn string) (string, bool) {
	target := sessionID
	if runIn == "main" {
		target = rt.state.GetRootSessionID(sessionID, rt.resolveParent)
	}
	if rt.state.IsDeleted(target) {
		return "", false
	}
	return target, true
}

// resolveParent is actions.ts resolveParentSessionID ("" for none).
func (rt *Runtime) resolveParent(sessionID string) (parent string) {
	defer func() {
		if recover() != nil {
			parent = ""
		}
	}()
	root := rt.host.RootSessionID(sessionID)
	if root != "" && root != sessionID {
		return root
	}
	return ""
}

func normalizeDelivery(d Delivery) Delivery {
	if d.Status == "accepted" || d.Status == "degraded" {
		return d
	}
	return Delivery{Status: "accepted"}
}

func logBashActionOutcome(r BashResult, in actionInput, timeout float64) {
	if r.Status != "failed" && r.Status != "timed_out" {
		return
	}
	actionLog("error", "action_result", "Bash action failed.", in, NewObject(
		"command", in.action.ToJSON().Get("bash"),
		"timeout", timeout,
		"status", r.Status,
		"exitCode", float64(r.ExitCode),
		"durationMs", float64(r.DurationMs),
		"stderr", jsstr.Slice16(RedactSensitiveContent(jsstr.Trim(r.Stderr)), 400),
		"stdout", jsstr.Slice16(RedactSensitiveContent(jsstr.Trim(r.Stdout)), 400),
	))
}

// logNow is the log timestamp source (tests replace it).
var logNow = time.Now

func loggingEnabled() bool {
	_, level := os.LookupEnv("PI_YAML_HOOKS_LOG_LEVEL")
	return os.Getenv("PI_YAML_HOOKS_DEBUG") == "1" || level || os.Getenv("PI_YAML_HOOKS_LOG_STDERR") == "1"
}

// actionLog is actions.ts emitStructured (env-gated).
func actionLog(level, kind, message string, in actionInput, details *Object) {
	if !loggingEnabled() {
		return
	}
	payload := NewObject("ts", logNow().UTC().Format("2006-01-02T15:04:05.000Z"), "level", level, "kind", kind, "message", message)
	if in.rt != nil && in.rt.projectDir != "" {
		payload.Set("cwd", in.rt.projectDir)
	}
	if in.event != "" {
		payload.Set("event", in.event)
	}
	if in.sessionID != "" {
		payload.Set("sessionId", in.sessionID)
	}
	if in.hookID != "" {
		payload.Set("hookId", in.hookID)
	}
	if details != nil {
		payload.Set("details", RedactSensitiveContent(Stringify(details)))
	}
	console("info", "[aio-yaml-hooks:"+level+"] "+Stringify(payload))
}
