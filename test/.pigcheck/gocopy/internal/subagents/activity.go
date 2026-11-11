package subagents

// Port of subagents/activity.ts: live progress folded from the child's JSON
// events, and its one-line and multi-line text. Time is passed in.

import (
	"math"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const (
	// ActivityStaleMs is the quiet time outside a tool that reads as a stall.
	ActivityStaleMs = 120_000
	quietHintMs     = 5_000
	summaryMaxChars = 60
)

// NewActivity is createActivity.
func NewActivity(now float64) *Activity {
	return &Activity{Phase: "starting", LastEventAt: now, RunningTools: []RunningTool{}}
}

// ResetForAttempt is resetActivityForAttempt: counters carry over.
func (a *Activity) ResetForAttempt(now float64) {
	a.Phase = "starting"
	a.LastEventAt = now
	a.RunningTools = []RunningTool{}
	a.Retry = nil
	a.SettledAt = nil
}

// clip collapses whitespace, trims, and cuts to max UTF-16 units with "…".
func clip(text string, max int) string {
	flat := jsstr.Trim(jsstr.CollapseSpace(text))
	if jsstr.Len16(flat) > max {
		return jsstr.Slice16(flat, max-1) + "…"
	}
	return flat
}

// SummarizeToolArgs is summarizeToolArgs. args is the decoded JSON object
// with its key order (see Object).
func SummarizeToolArgs(name string, args any) string {
	// An array is an object too: no named key, then its first string item.
	if items, ok := args.([]any); ok {
		for _, item := range items {
			if value, ok := item.(string); ok && len(jsstr.Trim(value)) > 0 {
				return clip(value, summaryMaxChars)
			}
		}
		return ""
	}
	record, ok := args.(*Object)
	if !ok {
		return ""
	}
	pick := func(keys ...string) (string, bool) {
		for _, key := range keys {
			if value, ok := record.Get(key).(string); ok && jsstr.Trim(value) != "" {
				return value, true
			}
		}
		return "", false
	}
	var preferred string
	var found bool
	switch name {
	case "bash":
		preferred, found = pick("command")
	case "todo":
		preferred, found = pick("action")
	default:
		preferred, found = pick("path", "pattern", "query", "url", "command", "action")
	}
	if found {
		return clip(preferred, summaryMaxChars)
	}
	for _, key := range record.Keys {
		if value, ok := record.Values[key].(string); ok && len(jsstr.Trim(value)) > 0 {
			return clip(value, summaryMaxChars)
		}
	}
	return ""
}

var phaseForDelta = map[string]string{
	"thinking_start": "thinking", "thinking_delta": "thinking", "thinking_end": "thinking",
	"text_start": "writing", "text_delta": "writing", "text_end": "writing",
	"toolcall_start": "writing", "toolcall_delta": "writing", "toolcall_end": "writing",
}

// ApplyEvent is applyActivityEvent. It returns true for a change that should
// re-render at once; streaming deltas return false.
func (a *Activity) ApplyEvent(event *Object, now float64) bool {
	a.LastEventAt = now
	previous := a.Phase
	setPhase := func(phase string) bool {
		if a.SettledAt != nil && phase != "finishing" {
			return false
		}
		a.Phase = phase
		return phase != previous
	}
	switch event.Get("type") {
	case "agent_start", "turn_start":
		if event.Get("type") == "turn_start" {
			a.Turns++
		}
		setPhase("waiting")
		return true
	case "message_update":
		inner, _ := event.Get("assistantMessageEvent").(*Object)
		var phase string
		if inner != nil {
			if t, ok := inner.Get("type").(string); ok {
				phase = phaseForDelta[t]
			}
		}
		if a.Retry != nil && phase != "" {
			a.Retry = nil
		}
		if phase == "" {
			return false
		}
		return setPhase(phase)
	case "tool_execution_start":
		id := "tool-" + strconv.Itoa(a.ToolCount)
		if v := event.Get("toolCallId"); v != nil {
			id = jsString(v)
		}
		toolName := "tool"
		if v := event.Get("toolName"); v != nil {
			toolName = jsString(v)
		}
		summaryName := ""
		if v := event.Get("toolName"); v != nil {
			summaryName = jsString(v)
		}
		a.RunningTools = append(a.RunningTools, RunningTool{
			ID: id, Name: toolName, Summary: SummarizeToolArgs(summaryName, event.Get("args")), StartedAt: now,
		})
		a.ToolCount++
		setPhase("tool")
		return true
	case "tool_execution_end":
		id := ""
		if v := event.Get("toolCallId"); v != nil {
			id = jsString(v)
		}
		kept := a.RunningTools[:0:0]
		for _, tool := range a.RunningTools {
			if tool.ID != id {
				kept = append(kept, tool)
			}
		}
		a.RunningTools = kept
		if len(a.RunningTools) == 0 {
			setPhase("waiting")
		}
		return true
	case "auto_retry_start":
		retry := &Retry{Attempt: jsNumberOr(event.Get("attempt"), 1), MaxAttempts: jsNumberOr(event.Get("maxAttempts"), 1)}
		if msg, ok := event.Get("errorMessage").(string); ok {
			retry.Error = sptr(clip(msg, 80))
		}
		a.Retry = retry
		setPhase("retrying")
		return true
	case "auto_retry_end":
		a.Retry = nil
		setPhase("waiting")
		return true
	case "compaction_start":
		setPhase("compacting")
		return true
	case "compaction_end":
		setPhase("waiting")
		return true
	case "agent_settled":
		a.SettledAt = fptr(now)
		a.RunningTools = []RunningTool{}
		a.Retry = nil
		a.Phase = "finishing"
		return true
	}
	return false
}

// FormatDuration is formatDuration.
func FormatDuration(ms float64) string {
	seconds := int64(math.Max(0, math.Floor(ms/1000)))
	if seconds < 60 {
		return strconv.FormatInt(seconds, 10) + "s"
	}
	minutes := seconds / 60
	if minutes < 60 {
		return strconv.FormatInt(minutes, 10) + "m" + pad2(seconds%60) + "s"
	}
	return strconv.FormatInt(minutes/60, 10) + "h" + pad2(minutes%60) + "m"
}

func pad2(n int64) string {
	if n < 10 {
		return "0" + strconv.FormatInt(n, 10)
	}
	return strconv.FormatInt(n, 10)
}

func describePhase(a *Activity, now float64) string {
	switch a.Phase {
	case "tool":
		if len(a.RunningTools) == 0 {
			return "running tool"
		}
		latest := a.RunningTools[len(a.RunningTools)-1]
		others := len(a.RunningTools) - 1
		label := latest.Name
		if latest.Summary != "" {
			label = latest.Name + ": " + latest.Summary
		}
		more := ""
		if others > 0 {
			more = " +" + strconv.Itoa(others) + " more"
		}
		return label + " (" + FormatDuration(now-latest.StartedAt) + ")" + more
	case "retrying":
		if a.Retry == nil {
			return "provider retry"
		}
		text := "provider retry " + jsstr.NumberJS(a.Retry.Attempt) + "/" + jsstr.NumberJS(a.Retry.MaxAttempts)
		if a.Retry.Error != nil && *a.Retry.Error != "" {
			text += ": " + *a.Retry.Error
		}
		return text
	case "compacting":
		return "compacting context"
	case "finishing":
		settled := now
		if a.SettledAt != nil {
			settled = *a.SettledAt
		}
		return "finished · waiting for exit (" + FormatDuration(now-settled) + ")"
	case "thinking":
		return "thinking"
	case "writing":
		return "writing"
	case "waiting":
		return "waiting for model"
	}
	return "starting"
}

// FormattedActivity is one activity line and whether it reads as a stall.
type FormattedActivity struct {
	Text  string
	Stale bool
}

// FormatChildActivity is formatChildActivity (without the agent name).
func FormatChildActivity(c *Child, now float64) FormattedActivity {
	if c.State != "running" {
		return FormattedActivity{Text: c.State}
	}
	var parts []string
	if c.StartedAt != nil {
		parts = append(parts, "running "+FormatDuration(now-*c.StartedAt))
	}
	if c.Attempts != nil && *c.Attempts > 1 {
		parts = append(parts, "attempt "+strconv.Itoa(*c.Attempts))
	}
	a := c.Activity
	if a == nil {
		text := strings.Join(parts, " · ")
		if text == "" {
			text = "running"
		}
		return FormattedActivity{Text: text}
	}
	parts = append(parts, describePhase(a, now))
	if a.ToolCount > 0 {
		word := "tools"
		if a.ToolCount == 1 {
			word = "tool"
		}
		parts = append(parts, strconv.Itoa(a.ToolCount)+" "+word)
	}
	quiet := now - a.LastEventAt
	inTool := a.Phase == "tool" || a.Phase == "finishing"
	stale := !inTool && quiet >= ActivityStaleMs
	if stale {
		parts = append(parts, "no events for "+FormatDuration(quiet)+" (possible stall)")
	} else if !inTool && quiet >= quietHintMs {
		parts = append(parts, "last event "+FormatDuration(quiet)+" ago")
	}
	return FormattedActivity{Text: strings.Join(parts, " · "), Stale: stale}
}

// FormatRunProgress is formatRunProgress.
func FormatRunProgress(r *Run, now float64) string {
	lines := []string{"Subagent run " + jsstr.Slice16(r.ID, 8) + " " + r.State}
	for _, c := range r.Children {
		f := FormatChildActivity(c, now)
		mark := "·"
		if f.Stale {
			mark = "!"
		}
		lines = append(lines, mark+" "+c.Agent+" · "+f.Text)
	}
	return strings.Join(lines, "\n")
}
