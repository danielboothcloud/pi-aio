package yamlhooks

// Hook definition parsing and validation (port of yaml-hooks/schema.ts).
// Error codes and messages are append-only contracts: keep them identical.

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// createError is schema.ts createError.
func createError(filePath, code, message, path string) ValidationError {
	return ValidationError{Code: code, FilePath: filePath, Message: message, Path: path}
}

type parsedDefinition struct {
	hook     *HookConfig
	override *Override
	errors   []ValidationError
}

// parseHookDefinition is schema.ts parseHookDefinition.
func parseHookDefinition(filePath string, def any, index int, seenIDs map[string]bool) parsedDefinition {
	obj, ok := def.(*Object)
	if !ok || obj == nil {
		return parsedDefinition{errors: []ValidationError{createError(filePath, "invalid_hook", fmt.Sprintf("hooks[%d] must be an object.", index), fmt.Sprintf("hooks[%d]", index))}}
	}
	id, idErrors := parseHookID(filePath, obj, index, seenIDs)
	target, isDisable, overrideErrors := parseOverrideTarget(filePath, obj, index)
	if isDisable {
		return parsedDefinition{
			override: &Override{TargetID: target, Disable: true, Source: Source{filePath, index}},
			errors:   append(append([]ValidationError{}, idErrors...), overrideErrors...),
		}
	}
	event := obj.Get("event")
	if !isHookEvent(event) {
		errs := append(append([]ValidationError{}, idErrors...), overrideErrors...)
		errs = append(errs, createError(filePath, "invalid_event", fmt.Sprintf("hooks[%d].event is not a supported hook event.", index), fmt.Sprintf("hooks[%d].event", index)))
		return parsedDefinition{errors: errs}
	}
	eventName := event.(string)

	scope, scopeErrors := parseScope(filePath, obj.Get("scope"), obj.Has("scope"), index)
	runIn, runInErrors := parseRunIn(filePath, obj.Get("runIn"), obj.Has("runIn"), index)
	action, actionErrors := parseHookAction(filePath, obj.Get("action"), obj.Has("action"), eventName, index)
	async, asyncErrors := parseAsync(filePath, obj.Get("async"), obj.Has("async"), eventName, obj.Get("actions"), obj.Get("action"), index)
	conditions, hasConds, condErrors := parseConditions(filePath, obj.Get("conditions"), obj.Has("conditions"), eventName, index)
	actions, actionsErrors := parseActions(filePath, obj.Get("actions"), index)
	promptErrors := validatePromptActions(filePath, eventName, actions, index)

	var errs []ValidationError
	for _, list := range [][]ValidationError{idErrors, overrideErrors, scopeErrors, runInErrors, actionErrors, asyncErrors, condErrors, actionsErrors, promptErrors} {
		errs = append(errs, list...)
	}
	if len(errs) > 0 || len(actions) == 0 {
		return parsedDefinition{errors: errs}
	}
	hook := &HookConfig{
		ID:         id,
		Event:      eventName,
		Action:     action,
		Actions:    actions,
		Scope:      scope,
		RunIn:      runIn,
		Async:      async,
		Conditions: conditions,
		HasConds:   hasConds,
		Source:     Source{filePath, index},
	}
	if target != "" {
		return parsedDefinition{override: &Override{TargetID: target, Replacement: hook, Source: Source{filePath, index}}, errors: errs}
	}
	return parsedDefinition{hook: hook, errors: errs}
}

func parseHookID(filePath string, obj *Object, index int, seen map[string]bool) (*string, []ValidationError) {
	if !obj.Has("id") {
		return nil, nil
	}
	id := obj.Get("id")
	if !isNonEmptyString(id) {
		return nil, []ValidationError{createError(filePath, "invalid_hook", fmt.Sprintf("hooks[%d].id must be a non-empty string.", index), fmt.Sprintf("hooks[%d].id", index))}
	}
	s := id.(string)
	if seen[s] {
		return nil, []ValidationError{createError(filePath, "duplicate_hook_id", fmt.Sprintf("hooks[%d].id duplicates hook id \"%s\".", index, s), fmt.Sprintf("hooks[%d].id", index))}
	}
	seen[s] = true
	return &s, nil
}

func parseOverrideTarget(filePath string, obj *Object, index int) (string, bool, []ValidationError) {
	if !obj.Has("override") {
		if obj.Has("disable") {
			return "", false, []ValidationError{createError(filePath, "invalid_override", fmt.Sprintf("hooks[%d].disable requires override.", index), fmt.Sprintf("hooks[%d].disable", index))}
		}
		return "", false, nil
	}
	override := obj.Get("override")
	if !isNonEmptyString(override) {
		return "", false, []ValidationError{createError(filePath, "invalid_override", fmt.Sprintf("hooks[%d].override must be a non-empty hook id.", index), fmt.Sprintf("hooks[%d].override", index))}
	}
	target := override.(string)
	disable := obj.Get("disable")
	if b, ok := disable.(bool); ok && b {
		return target, true, nil
	}
	if obj.Has("disable") {
		return target, false, []ValidationError{createError(filePath, "invalid_override", fmt.Sprintf("hooks[%d].disable must be a boolean.", index), fmt.Sprintf("hooks[%d].disable", index))}
	}
	return target, false, nil
}

func parseScope(filePath string, scope any, present bool, index int) (string, []ValidationError) {
	if !present {
		return "all", nil
	}
	if s, ok := scope.(string); ok && slices.Contains([]string{"all", "main", "child"}, s) {
		return s, nil
	}
	return "all", []ValidationError{createError(filePath, "invalid_scope", fmt.Sprintf("hooks[%d].scope must be one of: all, main, child.", index), fmt.Sprintf("hooks[%d].scope", index))}
}

func parseRunIn(filePath string, runIn any, present bool, index int) (string, []ValidationError) {
	if !present {
		return "current", nil
	}
	if s, ok := runIn.(string); ok && (s == "current" || s == "main") {
		return s, nil
	}
	return "current", []ValidationError{createError(filePath, "invalid_run_in", fmt.Sprintf("hooks[%d].runIn must be one of: current, main.", index), fmt.Sprintf("hooks[%d].runIn", index))}
}

func parseAsync(filePath string, value any, present bool, event string, actions any, hookAction any, index int) (*AsyncConfig, []ValidationError) {
	if !present {
		return nil, nil
	}
	config, enabled, errs := normalizeAsyncConfig(filePath, value, index)
	if len(errs) > 0 || !enabled {
		return nil, errs
	}
	path := fmt.Sprintf("hooks[%d].async", index)
	if strings.HasPrefix(event, "tool.before") {
		return nil, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async cannot be true for tool.before events because blocking requires synchronous execution.", index), path)}
	}
	if event == "session.idle" {
		return nil, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async cannot be true for session.idle events because idle dispatch must complete before tracked changes are consumed.", index), path)}
	}
	if event == "user.prompt.submit" {
		return nil, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async cannot be true for user.prompt.submit because context must be ready before the agent turn starts.", index), path)}
	}
	if s, ok := hookAction.(string); ok && s == "stop" {
		return nil, []ValidationError{createError(filePath, "invalid_hook_action", fmt.Sprintf("hooks[%d] async hooks cannot use action: stop. action: stop only blocks tool.before.* events, which already disallow async execution.", index), fmt.Sprintf("hooks[%d].action", index))}
	}
	if list, ok := actions.([]any); ok {
		for _, a := range list {
			o, isObj := a.(*Object)
			if !isObj || o == nil {
				continue
			}
			if o.Has("command") || o.Has("tool") || o.Has("notify") || o.Has("confirm") || o.Has("setStatus") {
				return nil, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async hooks must use only bash actions. command, tool, notify, confirm, and setStatus actions either have no timeout, depend on the live UI session, or block the agent turn, and would stall or misroute the async queue.", index), path)}
			}
		}
	}
	return config, nil
}

func validatePromptActions(filePath, event string, actions []Action, index int) []ValidationError {
	if event != "user.prompt.submit" {
		return nil
	}
	for _, a := range actions {
		if a.Kind != "bash" {
			return []ValidationError{createError(filePath, "invalid_action", fmt.Sprintf("hooks[%d].actions must contain only bash actions for user.prompt.submit.", index), fmt.Sprintf("hooks[%d].actions", index))}
		}
	}
	return nil
}

func isPositiveInteger(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f <= 0 {
		return 0, false
	}
	return int(f), true
}

func normalizeAsyncConfig(filePath string, value any, index int) (*AsyncConfig, bool, []ValidationError) {
	path := fmt.Sprintf("hooks[%d].async", index)
	if b, ok := value.(bool); ok {
		if !b {
			return nil, false, nil
		}
		return &AsyncConfig{True: true}, true, nil
	}
	obj, ok := value.(*Object)
	if !ok || obj == nil {
		return nil, false, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async must be a boolean or { group?, concurrency? }.", index), path)}
	}
	group := obj.Get("group")
	if obj.Has("group") && !isNonEmptyString(group) {
		return nil, false, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async.group must be a non-empty string.", index), path+".group")}
	}
	var concurrency *int
	if obj.Has("concurrency") {
		n, ok := isPositiveInteger(obj.Get("concurrency"))
		if !ok {
			return nil, false, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async.concurrency must be a positive integer.", index), path+".concurrency")}
		}
		concurrency = &n
	}
	for _, key := range obj.Keys {
		if key != "group" && key != "concurrency" {
			return nil, false, []ValidationError{createError(filePath, "invalid_async", fmt.Sprintf("hooks[%d].async only supports group and concurrency.", index), path)}
		}
	}
	config := &AsyncConfig{Concurrency: concurrency}
	if obj.Has("group") {
		g := jsstr.Trim(group.(string))
		config.Group = &g
	}
	if config.Group == nil && config.Concurrency == nil {
		return &AsyncConfig{True: true}, true, nil
	}
	return config, true, nil
}

func parseHookAction(filePath string, action any, present bool, event string, index int) (string, []ValidationError) {
	if !present {
		return "", nil
	}
	path := fmt.Sprintf("hooks[%d].action", index)
	if s, ok := action.(string); !ok || s != "stop" {
		return "", []ValidationError{createError(filePath, "invalid_hook_action", fmt.Sprintf("hooks[%d].action must be: stop.", index), path)}
	}
	if !strings.HasPrefix(event, "tool.before.") {
		return "", []ValidationError{createError(filePath, "invalid_hook_action", fmt.Sprintf("hooks[%d].action is only supported on tool.before.* events.", index), path)}
	}
	return "stop", nil
}

func parseConditions(filePath string, conditions any, present bool, event string, index int) ([]Condition, bool, []ValidationError) {
	if !present {
		return nil, false, nil
	}
	list, ok := conditions.([]any)
	if !ok {
		return nil, false, []ValidationError{createError(filePath, "invalid_conditions", fmt.Sprintf("hooks[%d].conditions must be an array.", index), fmt.Sprintf("hooks[%d].conditions", index))}
	}
	parsed := []Condition{}
	for ci, c := range list {
		if s, ok := c.(string); ok && s == "matchesCodeFiles" {
			parsed = append(parsed, Condition{Legacy: s})
			continue
		}
		cond, err := parseStructuredCondition(filePath, c, event, index, ci)
		if err != nil {
			return nil, false, []ValidationError{*err}
		}
		parsed = append(parsed, cond)
	}
	return parsed, true, nil
}

func parseStructuredCondition(filePath string, condition any, event string, hookIndex, conditionIndex int) (Condition, *ValidationError) {
	path := fmt.Sprintf("hooks[%d].conditions[%d]", hookIndex, conditionIndex)
	obj, ok := condition.(*Object)
	if !ok || obj == nil {
		e := createError(filePath, "invalid_conditions", path+" is not a supported condition.", path)
		return Condition{}, &e
	}
	if len(obj.Keys) != 1 {
		e := createError(filePath, "invalid_conditions", path+" must define exactly one supported condition key.", path)
		return Condition{}, &e
	}
	key := obj.Keys[0]
	if key != "matchesAnyPath" && key != "matchesAllPaths" {
		e := createError(filePath, "invalid_conditions", path+"."+key+" is not a supported condition key.", path+"."+key)
		return Condition{}, &e
	}
	if !supportsPathConditions(event) {
		e := createError(filePath, "invalid_conditions", path+"."+key+" is only supported on file.changed, session.idle, and tool.after.* hooks.", path+"."+key)
		return Condition{}, &e
	}
	values, msg, errPath := normalizePathConditionValues(obj.Get(key), path+"."+key)
	if msg != "" {
		e := createError(filePath, "invalid_conditions", msg, errPath)
		return Condition{}, &e
	}
	return Condition{Key: key, Patterns: values}, nil
}

func normalizePathConditionValues(value any, path string) ([]string, string, string) {
	if isNonEmptyString(value) {
		return []string{value.(string)}, "", ""
	}
	list, ok := value.([]any)
	if !ok {
		return nil, path + " must be a non-empty string or non-empty string array.", path
	}
	if len(list) == 0 {
		return nil, path + " must not be an empty array.", path
	}
	out := make([]string, len(list))
	for i, entry := range list {
		if !isNonEmptyString(entry) {
			p := fmt.Sprintf("%s[%d]", path, i)
			return nil, p + " must be a non-empty string.", p
		}
		out[i] = entry.(string)
	}
	return out, "", ""
}

func supportsPathConditions(event string) bool {
	return event == "file.changed" || event == "session.idle" || strings.HasPrefix(event, "tool.after.")
}

func parseActions(filePath string, actions any, index int) ([]Action, []ValidationError) {
	list, ok := actions.([]any)
	if !ok || len(list) == 0 {
		return nil, []ValidationError{createError(filePath, "invalid_actions", fmt.Sprintf("hooks[%d].actions must be a non-empty array.", index), fmt.Sprintf("hooks[%d].actions", index))}
	}
	var parsed []Action
	var errs []ValidationError
	for ai, a := range list {
		action, ok, actionErrs := parseAction(filePath, a, index, ai)
		if ok {
			parsed = append(parsed, action)
		}
		errs = append(errs, actionErrs...)
	}
	return parsed, errs
}

var actionKeys = []string{"command", "tool", "bash", "notify", "confirm", "setStatus"}

func parseAction(filePath string, action any, hookIndex, actionIndex int) (Action, bool, []ValidationError) {
	path := fmt.Sprintf("hooks[%d].actions[%d]", hookIndex, actionIndex)
	fail := func(sub, message string) (Action, bool, []ValidationError) {
		return Action{}, false, []ValidationError{createError(filePath, "invalid_action", message, sub)}
	}
	obj, ok := action.(*Object)
	if !ok || obj == nil {
		return fail(path, path+" must be an object.")
	}
	count := 0
	for _, k := range actionKeys {
		if obj.Has(k) {
			count++
		}
	}
	if count != 1 {
		return fail(path, path+" must define exactly one of command, tool, bash, notify, confirm, or setStatus.")
	}
	switch {
	case obj.Has("command"):
		if a, ok := parseCommandAction(obj.Get("command")); ok {
			return a, true, nil
		}
		return fail(path+".command", path+".command must be a string or { name, args? }.")
	case obj.Has("tool"):
		if a, ok := parseToolAction(obj.Get("tool")); ok {
			return a, true, nil
		}
		return fail(path+".tool", path+".tool must be { name, args? }.")
	case obj.Has("notify"):
		if a, ok := parseNotifyAction(obj.Get("notify")); ok {
			return a, true, nil
		}
		return fail(path+".notify", path+".notify must be a non-empty string or { text, level? } where level is one of info, success, warning, error.")
	case obj.Has("confirm"):
		if a, ok := parseConfirmAction(obj.Get("confirm")); ok {
			return a, true, nil
		}
		return fail(path+".confirm", path+".confirm must be { message, title? } with non-empty message.")
	case obj.Has("setStatus"):
		if a, ok := parseSetStatusAction(obj.Get("setStatus")); ok {
			return a, true, nil
		}
		return fail(path+".setStatus", path+".setStatus must be a non-empty string or { text } with non-empty text.")
	}
	if a, ok := parseBashAction(obj.Get("bash")); ok {
		return a, true, nil
	}
	return fail(path+".bash", path+".bash must be a string or { command, timeout? }.")
}

func parseCommandAction(v any) (Action, bool) {
	if isNonEmptyString(v) {
		return Action{Kind: "command", Short: true, Name: v.(string)}, true
	}
	obj, ok := v.(*Object)
	if !ok || obj == nil || !isNonEmptyString(obj.Get("name")) {
		return Action{}, false
	}
	a := Action{Kind: "command", Name: obj.Get("name").(string)}
	if obj.Has("args") {
		if !isNonEmptyString(obj.Get("args")) {
			return Action{}, false
		}
		s := obj.Get("args").(string)
		a.CommandArgs = &s
	}
	return a, true
}

func parseToolAction(v any) (Action, bool) {
	obj, ok := v.(*Object)
	if !ok || obj == nil || !isNonEmptyString(obj.Get("name")) {
		return Action{}, false
	}
	a := Action{Kind: "tool", Name: obj.Get("name").(string)}
	if obj.Has("args") {
		args, ok := obj.Get("args").(*Object)
		if !ok || args == nil {
			return Action{}, false
		}
		a.ToolArgs = args
	}
	return a, true
}

func parseBashAction(v any) (Action, bool) {
	if isNonEmptyString(v) {
		return Action{Kind: "bash", Short: true, Command: v.(string)}, true
	}
	obj, ok := v.(*Object)
	if !ok || obj == nil || !isNonEmptyString(obj.Get("command")) {
		return Action{}, false
	}
	a := Action{Kind: "bash", Command: obj.Get("command").(string)}
	if obj.Has("timeout") {
		f, ok := obj.Get("timeout").(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f <= 0 {
			return Action{}, false
		}
		a.Timeout = &f
	}
	return a, true
}

func isNotifyLevel(v any) bool {
	s, ok := v.(string)
	return ok && slices.Contains([]string{"info", "success", "warning", "error"}, s)
}

func parseNotifyAction(v any) (Action, bool) {
	if isNonEmptyString(v) {
		return Action{Kind: "notify", Short: true, Text: v.(string)}, true
	}
	obj, ok := v.(*Object)
	if !ok || obj == nil || !isNonEmptyString(obj.Get("text")) {
		return Action{}, false
	}
	a := Action{Kind: "notify", Text: obj.Get("text").(string)}
	if !obj.Has("level") {
		return a, true
	}
	if !isNotifyLevel(obj.Get("level")) {
		return Action{}, false
	}
	level := obj.Get("level").(string)
	a.Level = &level
	return a, true
}

func parseConfirmAction(v any) (Action, bool) {
	obj, ok := v.(*Object)
	if !ok || obj == nil || !isNonEmptyString(obj.Get("message")) {
		return Action{}, false
	}
	a := Action{Kind: "confirm", Message: obj.Get("message").(string)}
	if obj.Has("title") {
		if !isNonEmptyString(obj.Get("title")) {
			return Action{}, false
		}
		t := obj.Get("title").(string)
		a.Title = &t
	}
	return a, true
}

func parseSetStatusAction(v any) (Action, bool) {
	if isNonEmptyString(v) {
		return Action{Kind: "setStatus", Short: true, Text: v.(string)}, true
	}
	obj, ok := v.(*Object)
	if !ok || obj == nil || !isNonEmptyString(obj.Get("text")) {
		return Action{}, false
	}
	return Action{Kind: "setStatus", Text: obj.Get("text").(string)}, true
}
