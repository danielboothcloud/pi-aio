package subagents

// The above-editor widget rows of subagents/index.ts
// (buildSubagentWidgetLines) and the status list text.

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// InspectorShortcut opens the inspector (also /subagents).
const InspectorShortcut = "alt+s"

const maxChildRows = 3

// WidgetLines is buildSubagentWidgetLines. The caller holds Mu.
func WidgetLines(active []*Run, width int, theme chrome.Theme, maxRows int, now float64) []string {
	if len(active) == 0 || width <= 0 {
		return []string{}
	}
	lines := []string{chrome.Header(theme, chrome.HeaderOptions{
		Title: "subagents",
		Meta:  chrome.PluralForm(len(active), "active run", "active runs") + " · " + InspectorShortcut + " inspect",
	}, width)}
	visible := active[:min(len(active), max(1, maxRows))]
	for _, run := range visible {
		marker := "◌"
		if run.State == "running" {
			marker = "◐"
		}
		if len(run.Children) == 1 {
			only := run.Children[0]
			f := FormatChildActivity(only, now)
			tone := "accent"
			if f.Stale || only.State == "failed" {
				tone = "warning"
			}
			lines = append(lines, chrome.Item(theme, chrome.ItemOptions{Label: jsstr.Slice16(run.ID, 8) + " " + only.Agent,
				Meta: f.Text, Marker: marker, Tone: tone, Indent: chrome.Indent(1)}, width))
			continue
		}
		done, failed := 0, 0
		var running []*Child
		for _, c := range run.Children {
			switch c.State {
			case "completed":
				done++
			case "failed":
				failed++
			case "running":
				running = append(running, c)
			}
		}
		meta := strconv.Itoa(done) + "/" + strconv.Itoa(len(run.Children)) + " done"
		tone := "accent"
		if failed > 0 {
			meta += " · " + strconv.Itoa(failed) + " failed"
			tone = "warning"
		}
		lines = append(lines, chrome.Item(theme, chrome.ItemOptions{Label: jsstr.Slice16(run.ID, 8), Meta: meta,
			Marker: marker, Tone: tone, Indent: chrome.Indent(1)}, width))
		for _, c := range running[:min(len(running), maxChildRows)] {
			f := FormatChildActivity(c, now)
			tone := "muted"
			if f.Stale {
				tone = "warning"
			}
			lines = append(lines, chrome.Item(theme, chrome.ItemOptions{Label: c.Agent, Meta: f.Text, Marker: "↳",
				Tone: tone, Indent: chrome.Indent(3)}, width))
		}
		if len(running) > maxChildRows {
			lines = append(lines, chrome.Hint(theme, "+"+strconv.Itoa(len(running)-maxChildRows)+" more running", width, 5))
		}
	}
	if remaining := len(active) - len(visible); remaining > 0 {
		lines = append(lines, chrome.Hint(theme, "+"+strconv.Itoa(remaining)+" more runs", width, 2))
	}
	return lines
}

// RunActivitySuffix is runActivitySuffix of the status list.
func RunActivitySuffix(run *Run, now float64) string {
	if run.State != "running" {
		return ""
	}
	var b strings.Builder
	for _, c := range run.Children {
		b.WriteString("\n  " + c.Agent + " · " + FormatChildActivity(c, now).Text)
	}
	return b.String()
}

// StatusList is the text of `subagent action=status` without an id.
func StatusList(runs []*Run, now float64) string {
	if len(runs) == 0 {
		return "No subagent runs are recorded in this process."
	}
	lines := make([]string, len(runs))
	for i, run := range runs {
		lines[i] = run.ID + "  " + run.State + "  " + run.Mode + "  " + strconv.Itoa(len(run.Children)) + " child(ren)" + RunActivitySuffix(run, now)
	}
	return strings.Join(lines, "\n")
}

// AgentList is formatAgentList.
func AgentList(agents []AgentConfig) string {
	if len(agents) == 0 {
		return "No subagents are configured."
	}
	lines := make([]string, len(agents))
	for i, a := range agents {
		lines[i] = "- " + a.Name + " (" + a.Source + "): " + a.Description
	}
	return strings.Join(lines, "\n")
}
