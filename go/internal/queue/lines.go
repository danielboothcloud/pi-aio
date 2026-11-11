package queue

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/ui"
)

// MaxRows is MAX_QUEUE_ROWS.
const MaxRows = 5

// FirstLinePreview is firstLinePreview.
func FirstLinePreview(text string) (line string, truncated bool) {
	if i := strings.Index(text, "\n"); i >= 0 {
		return text[:i], true
	}
	return text, false
}

// BuildLines is buildQueueLines: the below-editor widget. maxRows 0 is
// MAX_QUEUE_ROWS.
func BuildLines(entries []Message, width int, theme chrome.Theme, maxRows int) []string {
	if len(entries) == 0 || width <= 0 {
		return []string{}
	}
	if maxRows == 0 {
		maxRows = MaxRows
	}
	maxRows = max(1, maxRows)
	lines := []string{chrome.Header(theme, chrome.HeaderOptions{
		Title: "queue",
		Meta:  chrome.Plural(len(entries), "pending message") + " · Enter sends next",
	}, width)}
	visible := entries[:min(len(entries), maxRows)]
	for i, entry := range visible {
		line, truncated := FirstLinePreview(entry.Text)
		if truncated {
			line += " …"
		}
		meta, tone := "follow", "muted"
		if entry.Mode == "steer" {
			meta, tone = "steer", "accent"
		}
		lines = append(lines, chrome.Item(theme, chrome.ItemOptions{
			Label: line, Meta: meta, Marker: strconv.Itoa(i + 1), Tone: tone, Indent: chrome.Indent(1),
		}, width))
	}
	if remaining := len(entries) - len(visible); remaining > 0 {
		lines = append(lines, chrome.Hint(theme, "+"+strconv.Itoa(remaining)+" more queued", width, 2))
	}
	return lines
}

// PanelLines is the frame panel provider registerQueue installs: compact
// rows the frame renders above its bottom border.
func PanelLines(enabled bool, entries []Message) []string {
	if !enabled || len(entries) == 0 {
		return []string{}
	}
	lines := []string{"queue · " + chrome.Plural(len(entries), "pending message") + " · Enter sends next"}
	for i, entry := range entries[:min(len(entries), MaxRows)] {
		line, truncated := FirstLinePreview(entry.Text)
		if truncated {
			line += " …"
		}
		meta := ""
		if entry.Mode == "steer" {
			meta = " · steer"
		}
		lines = append(lines, strconv.Itoa(i+1)+" "+line+meta)
	}
	return lines
}

// MergeRestore is restoreTextsToEditor's merge: texts the editor already
// holds are skipped, the rest go before the current text.
func MergeRestore(current string, texts []string) string {
	var merged []string
	for _, t := range texts {
		if !strings.Contains(current, t) {
			merged = append(merged, t)
		}
	}
	var parts []string
	for _, t := range []string{strings.Join(merged, "\n\n"), current} {
		if jsstr.Trim(t) != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, "\n\n")
}

// ExtractUserText is extractUserText: a user message's text blocks joined.
func ExtractUserText(message map[string]any) string {
	if message["role"] != "user" {
		return ""
	}
	switch content := message["content"].(type) {
	case string:
		return content
	case []any:
		var b strings.Builder
		for _, block := range content {
			m, _ := block.(map[string]any)
			if m["type"] == "text" {
				s, _ := m["text"].(string)
				b.WriteString(s)
			}
		}
		return b.String()
	}
	return ""
}

// StatusText is the /queue status notice; level is its notify level.
func StatusText(enabled bool, entries []Message) string {
	state := "off"
	if enabled {
		state = "on"
	}
	if len(entries) == 0 {
		return "Queue UI " + state + " · no pending messages"
	}
	rows := make([]string, len(entries))
	for i, e := range entries {
		rows[i] = strconv.Itoa(i+1) + ". [" + e.Mode + "] " + e.Text
	}
	return "Queue UI " + state + " · pending:\n" + strings.Join(rows, "\n")
}

// EditorHost is what the queue editor needs from its base (the user-bash
// editor) and the host.
type EditorHost interface {
	// Matches is keybindings.matches(data, id).
	Matches(data, binding string) bool
	// Text is getText.
	Text() string
	// ExpandedText is the text submitValue would submit (paste markers
	// expanded), before trimming.
	ExpandedText() string
	// ShowingAutocomplete is isShowingAutocomplete.
	ShowingAutocomplete() bool
	// SubmitDisabled is disableSubmit.
	SubmitDisabled() bool
	// BackslashBeforeCursor reports a `\` before the cursor, where Enter
	// inserts a newline instead of submitting.
	BackslashBeforeCursor() bool
	// ClearText is submitValue's clear of the editor.
	ClearText()
	// Super is the base editor's handleInput.
	Super(data string)
}

// HandleInput is QueueEditor.handleInput. TypeScript wraps pi's onSubmit
// to show the submitted text to the intercepts; the Go SDK has no submit
// hook, so the submit key's text is predicted here and offered first (see
// go/README.md). onEmptySubmit is the controller hook.
func HandleInput(h EditorHost, data string, onEmptySubmit func() bool) {
	submit := h.Matches(data, "tui.input.submit")
	if submit && jsstr.Trim(h.Text()) == "" && !h.ShowingAutocomplete() && onEmptySubmit() {
		return
	}
	intercepts := ui.EditorIntercepts()
	if intercepts.Escape != nil && h.Matches(data, "app.interrupt") && !h.ShowingAutocomplete() &&
		jsstr.Trim(h.Text()) == "" && intercepts.Escape() {
		return
	}
	if intercepts.Action != nil {
		for _, action := range ui.InterceptedActions {
			if h.Matches(data, action) && intercepts.Action(action) {
				return
			}
		}
	}
	if submit && intercepts.Submit != nil && !h.SubmitDisabled() && !h.BackslashBeforeCursor() {
		text := jsstr.Trim(h.ExpandedText())
		// With the autocomplete open, Enter first applies the selected
		// completion; only the exact text is predicted then.
		if (!h.ShowingAutocomplete() || strings.HasPrefix(text, "/")) && intercepts.Submit(text) {
			h.ClearText()
			return
		}
	}
	h.Super(data)
}

// Feature is registerQueue's state: the enabled flag, the session's
// controller, and the entries the frame panel shows.
type Feature struct {
	Enabled    bool
	Controller *Controller
	latest     []Message
}

// NewFeature returns an enabled feature without a session.
func NewFeature() *Feature { return &Feature{Enabled: true} }

// WidgetUpdate is updateWidget's decision: Clear, or show Entries below
// the editor. In a framed editor the widget is cleared and the frame shows
// the panel rows.
func (f *Feature) WidgetUpdate(framed bool) (entries []Message, show bool) {
	entries = []Message{}
	if f.Enabled && f.Controller != nil {
		entries = f.Controller.Mirror.Entries()
	}
	f.latest = entries
	if len(entries) == 0 || framed {
		return entries, false
	}
	return entries, true
}

// Panel is the frame panel provider.
func (f *Feature) Panel() []string { return PanelLines(f.Enabled, f.latest) }

// Command is the /queue command: the notice, its level, and whether the
// widget must update.
func (f *Feature) Command(args string) (message, level string, update bool) {
	switch strings.ToLower(jsstr.Trim(args)) {
	case "on", "enable":
		f.Enabled = true
		return "Queue UI enabled", "info", true
	case "off", "disable":
		f.Enabled = false
		return "Queue UI disabled (Enter-on-empty interrupt is off)", "info", true
	case "", "status":
		var entries []Message
		if f.Controller != nil {
			entries = f.Controller.Mirror.Entries()
		}
		return StatusText(f.Enabled, entries), "info", false
	}
	return "Usage: /queue [on|off|status]", "warning", false
}

// OnEmptySubmit is the editor hook: the controller's, while enabled.
func (f *Feature) OnEmptySubmit() bool {
	if !f.Enabled || f.Controller == nil {
		return false
	}
	return f.Controller.OnEmptySubmit()
}
