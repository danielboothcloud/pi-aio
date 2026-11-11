// Package styles is the Go port of styles/: opt-in interaction styles that
// add one hidden per-turn instruction. A style never gates tools. This
// package does not import the PiG SDK; go/aio wires it to the host.
package styles

import "strings"

// Names shared with the TypeScript version.
const (
	EntryType   = "styles"
	ContextType = "styles-context"
	StatusKey   = "style"
)

// Styles are the style names, in menu order.
var Styles = []string{"none", "collaborate", "tutor", "concise", "ste"}

// Summaries are the one-line descriptions of each style.
var Summaries = map[string]string{
	"none":        "no interaction style (default)",
	"collaborate": "build it together in reviewable increments sized to the task",
	"tutor":       "learn step by step: explanations, active practice, and feedback",
	"concise":     "minimal commentary: key decisions, blockers, and results",
	"ste":         "Simplified Technical English: clear, direct wording based on ASD-STE100",
}

// Metadata is the icon, label, and theme role of an active style.
type Metadata struct {
	Icon  string
	Label string
	Role  string
}

// StyleMetadata returns the status data for an active style.
func StyleMetadata(style string) Metadata {
	switch style {
	case "concise":
		return Metadata{"≡", "Concise", "accent"}
	case "ste":
		return Metadata{"◇", "Simplified Technical English", "accent"}
	case "collaborate":
		return Metadata{"⇄", "Collaborate", "success"}
	}
	return Metadata{"✎", "Tutor", "accent"}
}

// IsStyle reports whether value is a canonical style name.
func IsStyle(value string) bool {
	for _, s := range Styles {
		if s == value {
			return true
		}
	}
	return false
}

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// ParseStyle accepts the styles plus `off`, `mentor`, and `humanised`.
func ParseStyle(value string) (string, bool) {
	switch s := strings.ToLower(strings.Trim(value, jsSpace)); s {
	case "off":
		return "none", true
	case "mentor":
		return "tutor", true
	case "humanised":
		return "ste", true
	default:
		return s, IsStyle(s)
	}
}

const scopeNote = "This style changes how you interact with the user, never which tools you may use: the active permission mode still decides that."

const planNote = "\nIn plan mode, still produce the required numbered implementation plan with actionable steps and verification. The final plan is still the stopping point."

func isPassive(mode string) bool { return mode == "ask" || mode == "plan" }

func autoModeNote(pauses string) string {
	return `Auto mode only removes permission prompts. Its "proceed without asking for confirmation" applies to tool approval, not to the ` + pauses + ` this style asks for.`
}

func collaborateModeNote(mode string) string {
	switch mode {
	case "plan":
		return "In plan mode, co-design the plan: resolve the key decision points with the user before you emit the final numbered Plan. Shape the increments around those decisions and the size of the task, not a fixed pause after every step. The plan is still the stopping point."
	case "ask":
		return "In ask mode, match the depth to the question. Answer a clear question directly. Clarify or offer to go deeper when the question is ambiguous or the user is exploring."
	case "auto":
		return autoModeNote("check-ins and review pauses") + " Auto mode is not permission to skip a real decision, and it is not a requirement to pause after every small step."
	}
	return "Default mode's per-edit approvals are not a substitute for these check-ins: agree on the approach when the breakdown is not obvious, and pause when a review would change the next step. An approval is not itself a collaboration checkpoint, and it is not a reason to split one task into extra turns."
}

func tutorPracticeGuidance(mode string) string {
	if isPassive(mode) {
		extra := " Keep the lesson focused on the user's question."
		if mode == "plan" {
			extra = " Co-design the plan while teaching the reasoning; label a step as the user's to write only if they agree. The final plan is still the stopping point."
		}
		return "File edits are disabled in " + mode + " mode, so do not plant TODO(human) markers or change files for an exercise. Invite the user to trace an example, predict a result, explain a trade-off, or draft a small snippet in chat." + extra
	}
	return "Offer a small, meaningful piece the user can try: a condition, function body, test case, or debugging check. Give the exact file or symbol, the goal, and a way to check their work. Ask whether they want to try it before reserving work for them; do not insert TODO(human) markers, leave broken code, or withhold a completed solution unless they explicitly agree to a hands-on exercise. They can also reason in chat while you handle the editing and tools."
}

func fill(body string) string { return strings.ReplaceAll(body, "{{SCOPE}}", scopeNote) }

// BuildContext is the per-turn instruction for an active style under a mode.
func BuildContext(style, mode string) string {
	plan := ""
	if mode == "plan" {
		plan = planNote
	}
	switch style {
	case "ste":
		return "[STE STYLE ACTIVE]\n" + fill(steBody) + plan
	case "concise":
		return "[CONCISE STYLE ACTIVE]\n" + fill(conciseBody) + plan
	case "collaborate":
		return "[COLLABORATE STYLE ACTIVE]\n" + fill(collaborateBody) + collaborateModeNote(mode)
	}
	auto := ""
	if mode == "auto" {
		auto = "\n" + autoModeNote("practice pauses and learning questions")
	}
	return "[TUTOR STYLE ACTIVE]\n" + strings.ReplaceAll(fill(tutorBody), "{{PRACTICE}}", tutorPracticeGuidance(mode)) + auto
}

// FilterContext keeps only the latest style instruction while a style is
// active and drops all of them when the style is "none". It returns
// ok=false when nothing needs filtering.
func FilterContext(messages []any, style string) ([]any, bool) {
	isStyle := func(raw any) bool {
		m, ok := raw.(map[string]any)
		return ok && m["customType"] == ContextType
	}
	latest, count := -1, 0
	for i, m := range messages {
		if isStyle(m) {
			latest = i
			count++
		}
	}
	keep := style != "none"
	if count == 0 || (keep && count == 1) {
		return nil, false
	}
	out := make([]any, 0, len(messages))
	for i, m := range messages {
		if !isStyle(m) || (keep && i == latest) {
			out = append(out, m)
		}
	}
	return out, true
}

// LatestPersisted is the latest /style choice on the branch. It returns
// ok=false when the branch has no styles entry. Former names map to
// canonical ones; an unknown value is "none".
func LatestPersisted(entries []map[string]any) (string, bool) {
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry["type"] != "custom" || entry["customType"] != EntryType {
			continue
		}
		data, _ := entry["data"].(map[string]any)
		value, _ := data["style"].(string)
		switch {
		case value == "mentor":
			return "tutor", true
		case value == "humanised":
			return "ste", true
		case IsStyle(value):
			return value, true
		}
		return "none", true
	}
	return "", false
}

// Notice is the notification after a /style change.
func Notice(style string) string {
	if style == "none" {
		return "Style: none — interaction style off"
	}
	return "Style: " + StyleMetadata(style).Label + " — " + Summaries[style]
}

// UnknownNotice is the error for an unknown /style argument.
func UnknownNotice(requested string) string {
	return `Unknown style "` + requested + `". Use: ` + strings.Join(Styles, " | ")
}
