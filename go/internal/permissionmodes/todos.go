package permissionmodes

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// TodoItem is one plan step.
type TodoItem struct {
	Step      int    `json:"step"`
	Text      string `json:"text"`
	Completed bool   `json:"completed"`
}

var (
	boldRe       = regexp.MustCompile(`\*{1,2}([^*]+)\*{1,2}`)
	codeRe       = regexp.MustCompile("`([^`]+)`")
	leadVerbRe   = js(`(?i)^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?`)
	spacesRe     = js(`\s+`)
	planHeaderRe = js(`(?i)\*{0,2}Plan:\*{0,2}\s*\n`)
	numberedRe   = js(`(?m)^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)`)
	trailStarRe  = regexp.MustCompile(`\*{1,2}$`)
	doneRe       = regexp.MustCompile(`(?i)\[DONE:(\d+)\]`)
	jsSpaceSet   = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.Trim(s, jsSpaceSet) }

// jsLen is the UTF-16 length, as JavaScript's String.length.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// jsSlice is String.prototype.slice(0, n) on UTF-16 units.
func jsSlice(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if n > len(units) {
		n = len(units)
	}
	return string(utf16.Decode(units[:n]))
}

// CleanStepText shortens a plan step for the todo list.
func CleanStepText(text string) string {
	cleaned := boldRe.ReplaceAllString(text, "${1}")
	cleaned = codeRe.ReplaceAllString(cleaned, "${1}")
	cleaned = leadVerbRe.ReplaceAllString(cleaned, "")
	cleaned = jsTrim(spacesRe.ReplaceAllString(cleaned, " "))
	if cleaned != "" {
		runes := []rune(cleaned)
		cleaned = strings.ToUpper(string(runes[0])) + string(runes[1:])
	}
	if jsLen(cleaned) > 50 {
		cleaned = jsSlice(cleaned, 47) + "..."
	}
	return cleaned
}

// ExtractTodoItems reads the numbered steps after a "Plan:" header.
func ExtractTodoItems(message string) []TodoItem {
	items := []TodoItem{}
	loc := planHeaderRe.FindStringIndex(message)
	if loc == nil {
		return items
	}
	section := message[loc[1]:]
	for _, match := range numberedRe.FindAllStringSubmatch(section, -1) {
		text := jsTrim(trailStarRe.ReplaceAllString(jsTrim(match[2]), ""))
		if jsLen(text) > 5 && !strings.HasPrefix(text, "`") && !strings.HasPrefix(text, "/") && !strings.HasPrefix(text, "-") {
			cleaned := CleanStepText(text)
			if jsLen(cleaned) > 3 {
				items = append(items, TodoItem{Step: len(items) + 1, Text: cleaned})
			}
		}
	}
	return items
}

// ExtractDoneSteps reads the [DONE:n] tags in a message.
func ExtractDoneSteps(message string) []int {
	steps := []int{}
	for _, match := range doneRe.FindAllStringSubmatch(message, -1) {
		if step, err := strconv.Atoi(match[1]); err == nil {
			steps = append(steps, step)
		}
	}
	return steps
}

// MarkCompletedSteps marks the steps that text tags as done and returns the tag count.
func MarkCompletedSteps(text string, items []TodoItem) int {
	done := ExtractDoneSteps(text)
	for _, step := range done {
		for i := range items {
			if items[i].Step == step {
				items[i].Completed = true
				break
			}
		}
	}
	return len(done)
}

// TodoRequest is one todo tool call.
type TodoRequest struct {
	Action   string
	Step     *int
	Text     *string
	Position *int
}

// ApplyTodo runs one todo tool action on items. It returns the new list, the
// result text, and an error code ("" on success), as the TypeScript tool does.
func ApplyTodo(items []TodoItem, req TodoRequest) ([]TodoItem, string, string) {
	renumber := func() {
		for i := range items {
			items[i].Step = i + 1
		}
	}
	text := func() string {
		if req.Text == nil {
			return ""
		}
		return jsTrim(*req.Text)
	}
	if req.Action == "list" {
		if len(items) == 0 {
			return items, "No active todo list", ""
		}
		lines := make([]string, len(items))
		for i, item := range items {
			marker := "[ ]"
			if item.Completed {
				marker = "[x]"
			}
			lines[i] = fmt.Sprintf("%s #%d: %s", marker, item.Step, item.Text)
		}
		return items, strings.Join(lines, "\n"), ""
	}
	if req.Action == "create" {
		t := text()
		if t == "" {
			return items, "Error: text required for create", "text required"
		}
		position := len(items) + 1
		if req.Position != nil {
			position = *req.Position
		}
		if position < 1 || position > len(items)+1 {
			e := fmt.Sprintf("position must be between 1 and %d", len(items)+1)
			return items, "Error: " + e, e
		}
		items = append(items[:position-1], append([]TodoItem{{Step: position, Text: t}}, items[position-1:]...)...)
		renumber()
		return items, fmt.Sprintf("Created step %d: %s", position, t), ""
	}
	if req.Step == nil || *req.Step < 1 {
		return items, "Error: step required for " + req.Action, "step required"
	}
	step := *req.Step
	index := -1
	for i, item := range items {
		if item.Step == step {
			index = i
			break
		}
	}
	if index < 0 {
		return items, fmt.Sprintf("Step %d not found", step), fmt.Sprintf("step %d not found", step)
	}
	switch req.Action {
	case "toggle":
		items[index].Completed = !items[index].Completed
		state := "undone"
		if items[index].Completed {
			state = "done"
		}
		return items, fmt.Sprintf("Step %d %s", step, state), ""
	case "rename":
		t := text()
		if t == "" {
			return items, "Error: text required for rename", "text required"
		}
		items[index].Text = t
		return items, fmt.Sprintf("Renamed step %d: %s", step, t), ""
	case "reorder":
		if req.Position == nil || *req.Position < 1 || *req.Position > len(items) {
			e := fmt.Sprintf("position must be between 1 and %d", len(items))
			return items, "Error: " + e, e
		}
		item := items[index]
		items = append(items[:index], items[index+1:]...)
		p := *req.Position - 1
		items = append(items[:p], append([]TodoItem{item}, items[p:]...)...)
		renumber()
		return items, fmt.Sprintf("Moved step %d to position %d", step, *req.Position), ""
	}
	removed := items[index]
	items = append(items[:index], items[index+1:]...)
	renumber()
	return items, fmt.Sprintf("Deleted step %d: %s", step, removed.Text), ""
}
