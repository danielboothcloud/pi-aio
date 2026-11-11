// Package goals is the Go port of goals/ (the /goal loop): the goal state,
// prompts, review parsing, the review call, and the state machine behind the
// /goal command, the goal_propose, goal_done, and goal_blocked tools, and the
// agent_before_settle loop. It does not import the SDK; go/aio/goals.go wires
// it to PiG through the Host interface.
package goals

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/btw"
)

const (
	StateEntry  = "aio-goal"
	MessageType = "aio-goal-message"
	StatusKey   = "aio-goal"

	// MaxContinuations is the automatic continuations before the loop
	// pauses (reset by /goal resume).
	MaxContinuations = 50
	// MaxRejections is the consecutive review rejections before the loop
	// pauses.
	MaxRejections = 3
)

// Status is "active", "paused", or "done".
type Status string

const (
	Active Status = "active"
	Paused Status = "paused"
	Done   Status = "done"
)

// Goal is the persisted goal. The JSON field order matches the TypeScript
// object order so a persisted entry looks the same.
type Goal struct {
	ID            string  `json:"id"`
	Objective     string  `json:"objective"`
	DoneWhen      string  `json:"doneWhen"`
	Status        Status  `json:"status"`
	Continuations int     `json:"continuations"`
	Rejections    int     `json:"rejections"`
	PauseReason   string  `json:"pauseReason,omitempty"`
	Summary       *string `json:"summary,omitempty"` // present even when empty, as in TypeScript
	LastReview    string  `json:"lastReview,omitempty"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
}

// Clock is the time source (tests pin it).
type Clock func() time.Time

// ISO is Date.prototype.toISOString.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// NewGoal starts an active goal.
func NewGoal(objective, doneWhen string, now time.Time) Goal {
	at := ISO(now)
	return Goal{
		ID:        "g-" + strconv.FormatInt(now.UnixMilli(), 36),
		Objective: objective,
		DoneWhen:  doneWhen,
		Status:    Active,
		CreatedAt: at,
		UpdatedAt: at,
	}
}

// decodeGoal is isGoal plus a copy: nil unless every required field has the
// right type. Unknown fields drop; optional strings keep only string values.
func decodeGoal(raw any) *Goal {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	str := func(key string) (string, bool) { s, ok := m[key].(string); return s, ok }
	id, ok1 := str("id")
	objective, ok2 := str("objective")
	doneWhen, ok3 := str("doneWhen")
	status, ok4 := str("status")
	continuations, ok5 := m["continuations"].(float64)
	rejections, ok6 := m["rejections"].(float64)
	if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 {
		return nil
	}
	if status != string(Active) && status != string(Paused) && status != string(Done) {
		return nil
	}
	goal := Goal{
		ID: id, Objective: objective, DoneWhen: doneWhen, Status: Status(status),
		Continuations: int(continuations), Rejections: int(rejections),
	}
	goal.PauseReason, _ = str("pauseReason")
	if summary, ok := str("summary"); ok {
		goal.Summary = &summary
	}
	goal.LastReview, _ = str("lastReview")
	goal.CreatedAt, _ = str("createdAt")
	goal.UpdatedAt, _ = str("updatedAt")
	return &goal
}

// LatestGoal is the newest goal state among the session entries; nil when
// there is none or the newest one cleared or is malformed.
func LatestGoal(entries []json.RawMessage) *Goal {
	for i := len(entries) - 1; i >= 0; i-- {
		var entry struct {
			Type       any `json:"type"`
			CustomType any `json:"customType"`
			Data       any `json:"data"`
		}
		if json.Unmarshal(entries[i], &entry) != nil || entry.Type != "custom" || entry.CustomType != StateEntry {
			continue
		}
		data, _ := entry.Data.(map[string]any)
		return decodeGoal(data["goal"])
	}
	return nil
}

// Command is a parsed /goal argument: status, pause, resume, cancel, or
// start (with Text).
type Command struct {
	Kind string
	Text string
}

// Subcommand is one completion entry.
type Subcommand struct{ Name, Description string }

// Subcommands are the /goal completions.
var Subcommands = []Subcommand{
	{"status", "show the current goal"},
	{"pause", "stop the loop"},
	{"resume", "start the loop again"},
	{"cancel", "drop the current goal"},
	{"clear", "drop the current goal"},
}

// ParseArgs routes a single exact subcommand word; any other text is a new goal.
func ParseArgs(args string) Command {
	text := btw.Trim(args)
	if text == "" {
		return Command{Kind: "status"}
	}
	switch word := strings.ToLower(text); word {
	case "status", "pause", "resume", "cancel":
		return Command{Kind: word}
	case "clear":
		return Command{Kind: "cancel"}
	}
	return Command{Kind: "start", Text: text}
}

// Completions are the subcommands that start with the trimmed prefix.
func Completions(prefix string) []Subcommand {
	query := strings.ToLower(btw.Trim(prefix))
	var out []Subcommand
	for _, sub := range Subcommands {
		if strings.HasPrefix(sub.Name, query) {
			out = append(out, sub)
		}
	}
	return out
}

func orNotSpecified(s string) string {
	if s == "" {
		return "(not specified)"
	}
	return s
}

func goalBlock(objective, doneWhen string) string {
	return "Objective: " + objective + "\nDone when: " + orNotSpecified(doneWhen)
}

// DraftPrompt asks the agent to turn /goal text into a confirmed goal.
func DraftPrompt(text string) string {
	return strings.Join([]string{
		"The user started a goal with /goal:",
		"",
		"<goal>",
		text,
		"</goal>",
		"",
		"Before you start the work, turn this into a confirmed goal:",
		"1. Read enough of the code to understand the request.",
		"2. If an important detail is unclear and the answer changes what you build, ask the user with ask_user_question. Ask only what you cannot find out yourself, in one round.",
		"3. Call goal_propose with a precise objective and concrete done criteria (behavior, tests, or checks that prove the work is complete).",
		"If the request is already clear, call goal_propose immediately. Do not edit files before goal_propose confirms the goal.",
	}, "\n")
}

// StartedText is the goal_propose result.
func StartedText(goal Goal) string {
	return strings.Join([]string{
		"Goal confirmed and active. Start the work now.",
		goalBlock(goal.Objective, goal.DoneWhen),
		"",
		"Work through the goal end to end without stopping to ask for permission. When every done criterion is met and verified, call goal_done with a summary and the evidence (tests, commands, changed files). If you cannot continue without the user, call goal_blocked with the reason.",
	}, "\n")
}

// ContinuationPrompt is the hidden message that keeps the loop going.
func ContinuationPrompt(goal Goal) string {
	lines := []string{
		fmt.Sprintf("Continue working on the active goal (automatic continuation %d/%d).", goal.Continuations, MaxContinuations),
		goalBlock(goal.Objective, goal.DoneWhen),
	}
	if goal.Rejections > 0 && goal.LastReview != "" {
		lines = append(lines, "", "The last review rejected the completion: "+goal.LastReview)
	}
	lines = append(lines, "",
		"Take the next concrete step. When every done criterion is met and verified, call goal_done. If you need the user, call goal_blocked. Do not stop with only a status update.")
	return strings.Join(lines, "\n")
}

// ReviewSystemPrompt is the reviewer persona.
var ReviewSystemPrompt = strings.Join([]string{
	"You review whether a coding agent finished a goal.",
	"You get the goal, the agent's completion summary, the recent conversation with tool calls and results, and the git working tree state.",
	"Approve when the evidence shows that every done criterion is met.",
	"Reject when required work is missing, a required check was not run, or a check failed.",
	"Do not reject for style preferences or optional extras.",
	"Reply with APPROVED or REJECTED on the first line, then one short paragraph with the reason. When you reject, name the specific open points.",
}, "\n")

func orFallback(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// ReviewPrompt is the reviewer's user message.
func ReviewPrompt(goal Goal, summary, transcript, workspace string) string {
	return strings.Join([]string{
		"<goal>",
		goalBlock(goal.Objective, goal.DoneWhen),
		"</goal>",
		"",
		"<completion_summary>",
		orFallback(summary, "(no summary)"),
		"</completion_summary>",
		"",
		"<recent_conversation>",
		orFallback(transcript, "(no conversation)"),
		"</recent_conversation>",
		"",
		"<workspace>",
		orFallback(workspace, "(unavailable)"),
		"</workspace>",
		"",
		"Is the goal complete? Answer APPROVED or REJECTED on the first line.",
	}, "\n")
}

// Verdict is a parsed review reply.
type Verdict struct {
	Approved bool   `json:"approved"`
	Reason   string `json:"reason"`
}

var (
	headNoise = regexp.MustCompile(`[*_#` + "`" + `>:.\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}\v]+`)
	verdictRe = regexp.MustCompile(`(?i)^[*_#` + "`" + `> ]*(?:APPROVED|REJECTED)[*_` + "`" + ` ]*[:.\-—]?`)
)

// ParseReview reads the first non-empty line; nil when it has no verdict.
func ParseReview(text string) *Verdict {
	raw := strings.Split(text, "\n")
	lines := make([]string, len(raw))
	first := -1
	for i, line := range raw {
		lines[i] = btw.Trim(line)
		if first < 0 && lines[i] != "" {
			first = i
		}
	}
	if first < 0 {
		return nil
	}
	head := strings.ToUpper(btw.Trim(headNoise.ReplaceAllString(lines[first], " ")))
	var approved bool
	switch {
	case strings.HasPrefix(head, "APPROVED"):
		approved = true
	case strings.HasPrefix(head, "REJECTED"):
		approved = false
	default:
		return nil
	}
	sameLine := btw.Trim(verdictRe.ReplaceAllString(lines[first], ""))
	reason := btw.Trim(strings.Join(append([]string{sameLine}, lines[first+1:]...), "\n"))
	if reason == "" {
		reason = "Rejected without a reason."
		if approved {
			reason = "Approved."
		}
	}
	return &Verdict{Approved: approved, Reason: reason}
}

var spaceRun = regexp.MustCompile(`[\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}\v]+`)

// OneLine flattens whitespace and caps the text at max UTF-16 code units.
func OneLine(text string, max int) string {
	flat := btw.Trim(spaceRun.ReplaceAllString(text, " "))
	if btw.Len16(flat) > max {
		return btw.Slice16(flat, max-1) + "…"
	}
	return flat
}

// StatusText is the footer status text and its tone; "" clears it.
func StatusText(goal *Goal, drafting, reviewing bool) (text, tone string) {
	tone = "accent"
	if goal != nil && goal.Status == Paused {
		tone = "warning"
	}
	switch {
	case reviewing:
		return "◎ goal · reviewing", tone
	case goal != nil && goal.Status == Active:
		return fmt.Sprintf("◎ goal · %d/%d", goal.Continuations, MaxContinuations), tone
	case goal != nil && goal.Status == Paused:
		return "◎ goal · paused", tone
	case drafting:
		return "◎ goal · draft", tone
	}
	return "", tone
}

// DescribeGoal is the /goal status text.
func DescribeGoal(goal Goal) string {
	state := "done"
	switch goal.Status {
	case Active:
		state = fmt.Sprintf("active (%d/%d continuations)", goal.Continuations, MaxContinuations)
	case Paused:
		state = "paused"
		if goal.PauseReason != "" {
			state += ": " + goal.PauseReason
		}
	}
	lines := []string{"Goal: " + goal.Objective, "Status: " + state, "Done when: " + orNotSpecified(goal.DoneWhen)}
	if goal.LastReview != "" {
		lines = append(lines, "Last review: "+OneLine(goal.LastReview, 200))
	}
	if goal.Summary != nil && *goal.Summary != "" {
		lines = append(lines, "Summary: "+OneLine(*goal.Summary, 300))
	}
	if goal.Status == Paused {
		lines = append(lines, "Run /goal resume to continue or /goal cancel to drop it.")
	}
	return strings.Join(lines, "\n")
}

// DraftRows renders the visible draft message: the plain form of the
// chromeHeader card ("◎ GOAL · drafting") with the indented, wrapped text.
func DraftRows(l btw.Layout, text string, width int) []string {
	rows := []string{btw.FitLine(l, "◎ GOAL · drafting", width, "…")}
	for _, line := range l.Wrap(text, max(1, width-2)) {
		rows = append(rows, btw.FitLine(l, "  "+line, width, "…"))
	}
	return rows
}
