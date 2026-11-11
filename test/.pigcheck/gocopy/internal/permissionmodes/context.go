package permissionmodes

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Custom message and entry types (shared with the TypeScript version).
const (
	ContextType    = "modes-context"
	StateEntry     = "modes"
	ExecuteType    = "modes-execute"
	PlanListType   = "modes-plan-list"
	PlanDoneType   = "plan-complete"
	PlanTodoWidget = "plan-todos"
)

const askContext = `[ASK MODE ACTIVE]
You are in ask mode — a passive, read-only mode for questions, explanations, and codebase exploration.

Restrictions:
- edit, write, and apply_patch tools are disabled
- bash and hypa_shell are restricted to a conservative allowlist of simple read-only commands
- scripts, compound commands, and execution-capable wrappers are blocked
- reads (read/grep/find/ls) pass through

Answer the user's request directly. Ground answers in what you can read (files, logs, git history); when something can only be determined by running it, say so rather than guessing.
Inspect the codebase when useful, but do not modify files or system state.
Do not create an implementation plan unless the user explicitly asks for one.`

const planContext = `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- edit, write, and apply_patch tools are disabled
- bash and hypa_shell are restricted to a conservative allowlist of simple read-only commands
- scripts, compound commands, and execution-capable wrappers are blocked
- reads (read/grep/find/ls) pass through

The plan decides what to do and what to measure; it does not solve the problem. Emitting it is the stopping point — do not resolve unknowns in order to finish.

Plan:
1. First step description
2. Second step description
...

For diagnostic tasks you may add "Hypotheses:" or "Open questions:" sections before the "Plan:" header when they help; anything that can only be settled by running something can stay an open question.

Do NOT attempt to make changes — just plan. Prefer a read-only look (file, log, git history) over predicting behavior.`

const autoContext = `[AUTO MODE ACTIVE]
All tool calls (edit, write, apply_patch, bash, hypa_shell) are auto-approved — no permission prompts.
Exception: edit, write, and apply_patch on files outside the working directory (and its subdirectories) still require manual user approval; keep changes inside it unless the task needs otherwise.
No approval prompts are needed for tool calls. Still ask the user when the request itself is ambiguous.
When a cheap check (test, command, log) would answer a question, run it rather than speculating.
If a todo list is active, toggle each finished step with the todo tool before continuing.`

const defaultContext = `[DEFAULT MODE ACTIVE]
- edit, write, and apply_patch tools require per-call user approval (files outside the working directory get a separate outside-directory approval)
- bash and hypa_shell commands outside the simple read-only allowlist require per-call user approval
- Python/Node scripts, compound commands, and execution-capable wrappers require approval too; never use them to bypass edit/write approval
- simple read-only shell commands and reads (read/grep/find/ls) pass through without prompting
When a cheap check (test, command, log) would answer a question, run it rather than speculating.`

func isEnabledEnvValue(value string, set bool) bool {
	if !set {
		return false
	}
	switch strings.ToLower(jsTrim(value)) {
	case "1", "true", "on", "yes", "enabled":
		return true
	}
	return false
}

func cursorModeGuidance(mode Mode) string {
	if mode == ModeAuto {
		return ""
	}
	if IsPassive(mode) {
		fallback := "Answer the user's request without making changes or creating a plan unless they explicitly request one."
		if mode == ModePlan {
			fallback = "Describe requested mutations in the plan instead."
		}
		return fmt.Sprintf(`[CURSOR PROVIDER SAFETY]
Cursor host tools execute inside the headless Cursor SDK and bypass Pi's tool_call gate.
Do not use Cursor host edit, write, delete, or mutating shell tools in %s mode. Use only read/search operations. %s`, mode, fallback)
	}
	return `[CURSOR PROVIDER PERMISSION ROUTING]
Cursor host edit/write/delete/shell tools bypass Pi's permission prompt. For every file mutation or mutating command, use the exposed Pi bridge tools (` + cursorBridgeMutationList + `) instead of Cursor host tools so Pi can show the diff and ask before execution. Cursor host read/search tools remain allowed. If the required pi__ tool is unavailable, do not mutate anything; explain that permission routing is unavailable.`
}

// ModeContext is the hidden per-turn instruction for a mode. bridgeEnv is the
// value of CursorBridgeBuiltinsEnv and bridgeSet whether it is set.
func ModeContext(mode Mode, provider, bridgeEnv string, bridgeSet bool) string {
	body := defaultContext
	switch mode {
	case ModeAsk:
		body = askContext
	case ModePlan:
		body = planContext
	case ModeAuto:
		body = autoContext
	}
	if provider == "cursor" {
		if guidance := cursorModeGuidance(mode); guidance != "" {
			body += "\n\n" + guidance
		}
		if mode == ModeDefault && !isEnabledEnvValue(bridgeEnv, bridgeSet) {
			body += "\n\nPi bridge mutation tools are currently unavailable because " + CursorBridgeBuiltinsEnv + " is disabled. Do not mutate files or run mutating commands."
		}
	}
	return body
}

func numbered(items []TodoItem, onlyOpen bool) string {
	var lines []string
	for _, item := range items {
		if onlyOpen && item.Completed {
			continue
		}
		lines = append(lines, fmt.Sprintf("%d. %s", item.Step, item.Text))
	}
	return strings.Join(lines, "\n")
}

// ExecutingContext is the hidden instruction while a plan executes.
func ExecutingContext(items []TodoItem) string {
	hint := ""
	if len(items) > 0 {
		hint = "\nAfter each step finishes, call todo({ action: \"toggle\", step: n }) for that step before moving on. Use todo({ action: \"list\" }) to verify nothing is left unchecked."
	}
	return "[EXECUTING PLAN — full tool access]\n\nRemaining steps:\n" + numbered(items, true) + "\n" + hint +
		"\n\nExecute each step in order. Mark progress in the todo tool as you go; do not batch toggles at the end.\nWhen a cheap check (test, command, log) would answer a question, run it rather than speculating."
}

// ExecutionBody is the visible "execute the plan" message.
func ExecutionBody(items []TodoItem) string {
	first := "(first step)"
	if len(items) > 0 {
		first = items[0].Text
	}
	hint := ""
	if len(items) > 2 {
		hint = "\nUse the todo tool to list and toggle the steps as you finish them."
	}
	return "Execute the plan now. Steps:\n\n" + numbered(items, false) + "\n\nStart with: " + first + hint +
		"\nAfter finishing each step, include a [DONE:n] tag in your response."
}

// PlanListMessage is the visible list of extracted plan steps.
func PlanListMessage(items []TodoItem) string {
	var lines []string
	for _, item := range items {
		lines = append(lines, fmt.Sprintf("%d. ☐ %s", item.Step, item.Text))
	}
	return fmt.Sprintf("**Plan Steps (%d):**\n\n%s", len(items), strings.Join(lines, "\n"))
}

// PlanCompleteMessage is the visible message when every step is done.
func PlanCompleteMessage(items []TodoItem) string {
	var lines []string
	for _, item := range items {
		lines = append(lines, "~~"+item.Text+"~~")
	}
	return "**Plan Complete!** ✓\n\n" + strings.Join(lines, "\n")
}

// FilterContext keeps only the latest modes-context message.
func FilterContext(messages []any) []any {
	latest := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if m, ok := messages[i].(map[string]any); ok && m["customType"] == ContextType {
			latest = i
			break
		}
	}
	out := make([]any, 0, len(messages))
	for i, raw := range messages {
		if m, ok := raw.(map[string]any); ok && m["customType"] == ContextType && i != latest {
			continue
		}
		out = append(out, raw)
	}
	return out
}

// AssistantText joins the text blocks of an assistant message, or ok=false.
func AssistantText(message any) (string, bool) {
	m, ok := message.(map[string]any)
	if !ok || m["role"] != "assistant" {
		return "", false
	}
	content, ok := m["content"].([]any)
	if !ok {
		return "", false
	}
	var parts []string
	for _, raw := range content {
		if block, ok := raw.(map[string]any); ok && block["type"] == "text" {
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n"), true
}

// PersistedState is the "modes" entry data.
type PersistedState struct {
	CurrentMode            string   `json:"currentMode"`
	ToolsBeforePassiveMode []string `json:"toolsBeforePassiveMode,omitempty"`
	ToolsBeforePlanMode    []string `json:"toolsBeforePlanMode,omitempty"`
}

// Restored is the session state rebuilt from the branch entries.
type Restored struct {
	Mode               Mode
	ToolsBeforePassive []string
	PlanExecuting      bool
	PlanTodos          []TodoItem
}

// RestoreState rebuilds the mode from the starting mode (flag or recipe), the
// latest "modes" entry, and a plan that was executing. A subagent child is
// always auto.
func RestoreState(start Mode, entries []map[string]any, child bool) Restored {
	r := Restored{Mode: start}
	executeIndex := -1
	for i, entry := range entries {
		if entry["type"] != "custom" {
			continue
		}
		switch entry["customType"] {
		case StateEntry:
			data, _ := json.Marshal(entry["data"])
			var state PersistedState
			if entry["data"] != nil && json.Unmarshal(data, &state) == nil {
				r.Mode = NormalizeMode(state.CurrentMode)
				r.ToolsBeforePassive = state.ToolsBeforePassiveMode
				if r.ToolsBeforePassive == nil {
					r.ToolsBeforePassive = state.ToolsBeforePlanMode
				}
			}
		case ExecuteType:
			executeIndex = i
		}
	}
	if executeIndex >= 0 {
		var extracted []TodoItem
		var texts []string
		for _, entry := range entries[executeIndex+1:] {
			if entry["type"] != "message" || entry["message"] == nil {
				texts = append(texts, "")
				continue
			}
			message := entry["message"]
			if text, ok := AssistantText(message); ok {
				texts = append(texts, text)
				if items := ExtractTodoItems(text); len(items) > 0 {
					extracted = items
				}
				continue
			}
			texts = append(texts, "")
			m, _ := message.(map[string]any)
			if m["role"] == "toolResult" && m["toolName"] == "todo" {
				details, _ := m["details"].(map[string]any)
				data, _ := json.Marshal(details["todos"])
				var todos []TodoItem
				if json.Unmarshal(data, &todos) == nil && len(todos) > 0 {
					extracted = todos
				}
			}
		}
		if len(extracted) > 0 {
			r.PlanTodos = extracted
			r.PlanExecuting = true
			r.Mode = ModeAuto
			MarkCompletedSteps(strings.Join(texts, "\n"), r.PlanTodos)
		}
	}
	if child {
		r.Mode = ModeAuto
		r.PlanExecuting = false
		r.PlanTodos = nil
		r.ToolsBeforePassive = nil
	}
	if !IsPassive(r.Mode) {
		r.ToolsBeforePassive = nil
	}
	return r
}
