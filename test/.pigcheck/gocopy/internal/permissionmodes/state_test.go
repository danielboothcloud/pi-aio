package permissionmodes

import (
	"reflect"
	"testing"
)

func custom(customType string, data any) map[string]any {
	return map[string]any{"type": "custom", "customType": customType, "data": data}
}

func assistant(text string) map[string]any {
	return map[string]any{"type": "message", "message": map[string]any{
		"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}},
	}}
}

func TestRestoreState(t *testing.T) {
	// The latest "modes" entry wins over the starting mode.
	r := RestoreState(ModeDefault, []map[string]any{
		custom(StateEntry, map[string]any{"currentMode": "auto"}),
		custom(StateEntry, map[string]any{"currentMode": "plan", "toolsBeforePlanMode": []any{"read", "edit"}}),
	}, false)
	if r.Mode != ModePlan || !reflect.DeepEqual(r.ToolsBeforePassive, []string{"read", "edit"}) {
		t.Fatalf("restore = %+v", r)
	}
	// A plan that was executing resumes in auto with its done steps marked.
	r = RestoreState(ModeAsk, []map[string]any{
		custom(StateEntry, map[string]any{"currentMode": "plan"}),
		custom(ExecuteType, nil),
		assistant("Plan:\n1. Write the parser module\n2. Add tests for the parser\n"),
		assistant("did it [DONE:1]"),
	}, false)
	if r.Mode != ModeAuto || !r.PlanExecuting || len(r.PlanTodos) != 2 || !r.PlanTodos[0].Completed || r.PlanTodos[1].Completed || r.ToolsBeforePassive != nil {
		t.Fatalf("executing restore = %+v", r)
	}
	// A todo tool result after the marker is the newest list.
	r = RestoreState(ModeDefault, []map[string]any{
		custom(ExecuteType, nil),
		{"type": "message", "message": map[string]any{"role": "toolResult", "toolName": "todo",
			"details": map[string]any{"todos": []any{map[string]any{"step": 1, "text": "only", "completed": true}}}}},
	}, false)
	if !r.PlanExecuting || !reflect.DeepEqual(r.PlanTodos, []TodoItem{{1, "only", true}}) {
		t.Fatalf("todo restore = %+v", r)
	}
	// Subagent children are always auto, whatever the transcript says.
	r = RestoreState(ModePlan, []map[string]any{custom(StateEntry, map[string]any{"currentMode": "ask"})}, true)
	if r.Mode != ModeAuto || r.PlanExecuting || r.ToolsBeforePassive != nil {
		t.Fatalf("child restore = %+v", r)
	}
}

func TestModeHelpers(t *testing.T) {
	for in, want := range map[string]Mode{"PLAN": ModePlan, "normal": ModeDefault, "accept-edits": ModeAuto, "bogus": ModeDefault} {
		if got := NormalizeMode(in); got != want {
			t.Errorf("NormalizeMode(%q) = %s", in, got)
		}
	}
	if NormalizeMode(nil) != ModeDefault || NextMode(ModeAuto) != ModeDefault || NextMode(ModeDefault) != ModeAsk {
		t.Error("mode cycle")
	}
	if got := PassiveTools([]string{"read", "edit", "write", "bash", "todo"}); !reflect.DeepEqual(got, []string{"read", "bash", "todo", "grep", "find", "ls"}) {
		t.Errorf("PassiveTools = %v", got)
	}
	messages := []any{
		map[string]any{"customType": ContextType, "content": "old"},
		map[string]any{"role": "user"},
		map[string]any{"customType": ContextType, "content": "new"},
	}
	if got := FilterContext(messages); len(got) != 2 || got[1].(map[string]any)["content"] != "new" {
		t.Errorf("FilterContext = %v", got)
	}
}
