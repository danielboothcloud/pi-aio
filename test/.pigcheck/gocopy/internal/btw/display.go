package btw

import (
	"fmt"
	"strings"
)

// Display keys and limits.
const (
	// EntryType is the custom entry rendered as the transcript box. Custom
	// entries never reach the model.
	EntryType = "by-the-way"
	// WidgetKey is the above-editor card widget.
	WidgetKey = "aio-btw"
	// StatusKey is the footer status while a question is in flight.
	StatusKey = "btw"

	// MaxCardAnswerRows is the answer rows in the card, including the
	// "+N more lines" row.
	MaxCardAnswerRows = 4
	// MaxCardRows caps every card render.
	MaxCardRows = 9

	boxLabel      = "BY THE WAY"
	glyphQuestion = "✦"
	glyphAsking   = "↯"
)

// Layout measures and fits terminal text (pi-tui's visibleWidth,
// truncateToWidth, and wrapTextWithAnsi). go/aio passes the SDK's tui
// functions; tests pass a simple ASCII version.
type Layout interface {
	Width(text string) int
	Truncate(text string, width int, ellipsis string) string
	Wrap(text string, width int) []string
}

// FitLine is ui/chrome fitLine: truncate to width with an ellipsis.
func FitLine(l Layout, text string, width int, ellipsis string) string {
	if width <= 0 {
		return ""
	}
	return l.Truncate(text, width, ellipsis)
}

func padToWidth(l Layout, text string, width int) string {
	fitted := FitLine(l, text, width, "")
	pad := width - l.Width(fitted)
	if pad < 0 {
		pad = 0
	}
	return fitted + strings.Repeat(" ", pad)
}

// Theme is the foreground part of ui/chrome ChromeTheme.
type Theme interface {
	Fg(role, text string) string
}

// PlainTheme leaves text uncolored (the identity theme).
type PlainTheme struct{}

// Fg returns text unchanged.
func (PlainTheme) Fg(_, text string) string { return text }

// FrameRule is the plain (uncolored) form of ui/chrome chromeFrameRule.
func FrameRule(l Layout, width int, edge, label string) string {
	return frameRule(l, PlainTheme{}, width, edge, label)
}

// frameRule is ui/chrome chromeFrameRule.
func frameRule(l Layout, t Theme, width int, edge, label string) string {
	if width <= 0 {
		return ""
	}
	if width <= 4 {
		return divider(l, t, width, label)
	}
	left, right := "├", "┤"
	switch edge {
	case "top":
		left, right = "╭", "╮"
	case "bottom":
		left, right = "╰", "╯"
	}
	inner := width - 2
	title := ""
	if label != "" {
		title = FitLine(l, "─ "+label+" ", inner, "")
	}
	fill := inner - l.Width(title)
	if fill < 0 {
		fill = 0
	}
	return t.Fg("borderMuted", left+title+strings.Repeat("─", fill)+right)
}

// divider is ui/chrome chromeDivider.
func divider(l Layout, t Theme, width int, label string) string {
	if width <= 0 {
		return ""
	}
	if label == "" {
		return t.Fg("borderMuted", strings.Repeat("─", width))
	}
	decorated := "─ " + label + " "
	suffix := strings.Repeat("─", max(0, width-Len16(decorated)))
	return FitLine(l, t.Fg("borderMuted", decorated+suffix), width, "")
}

// FrameRow is the plain form of ui/chrome chromeFrameRow.
func FrameRow(l Layout, text string, width int) string {
	return frameRow(l, PlainTheme{}, text, width)
}

// frameRow is ui/chrome chromeFrameRow.
func frameRow(l Layout, t Theme, text string, width int) string {
	if width <= 4 {
		return FitLine(l, text, width, "")
	}
	border := t.Fg("borderMuted", "│")
	return border + " " + padToWidth(l, text, width-4) + " " + border
}

// EntryData is the `by-the-way` entry: the transcript box.
type EntryData struct {
	Question        string  `json:"question"`
	Answer          string  `json:"answer"`
	Model           string  `json:"model"`
	AnsweredMidFlow bool    `json:"answeredMidFlow"`
	Usage           *Usage  `json:"usage,omitempty"`
	LatencyMs       float64 `json:"latencyMs"`
	Timestamp       float64 `json:"timestamp"`
}

// FormatTokens is "1.2k tok", "200 tok", or "" without usage.
func FormatTokens(usage *Usage) string {
	if usage == nil {
		return ""
	}
	tokens := usage.InputTokens + usage.OutputTokens
	if tokens <= 0 {
		return ""
	}
	if tokens > 0 && tokens < 1000 {
		return NumberString(tokens) + " tok"
	}
	return ToFixed(tokens/1000, 1) + "k tok"
}

// FormatSeconds is "1.2s".
func FormatSeconds(ms float64) string {
	if ms < 0 {
		ms = 0
	}
	return ToFixed(ms/1000, 1) + "s"
}

// ToastText is the one-line arrival notice.
func ToastText(l Layout, data EntryData) string {
	line := ""
	for _, entry := range strings.Split(data.Answer, "\n") {
		if trimmed := Trim(entry); trimmed != "" {
			line = trimmed
			break
		}
	}
	return "btw — " + FitLine(l, line, 120, "…")
}

func metaParts(data EntryData) string {
	focus := "answered"
	if data.AnsweredMidFlow {
		focus = "answered mid-flow"
	}
	var parts []string
	for _, part := range []string{focus, data.Model, FormatTokens(data.Usage), FormatSeconds(data.LatencyMs)} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " · ")
}

func questionRow(l Layout, t Theme, question string, width int) string {
	inner := width - 4
	return frameRow(l, t, t.Fg("accent", glyphQuestion+" "+FitLine(l, question, max(1, inner-3), "…")), width)
}

// BoxRows renders the permanent transcript box uncolored.
func BoxRows(l Layout, data EntryData, width int) []string {
	return ThemedBoxRows(l, PlainTheme{}, data, width)
}

// ThemedBoxRows is btw/display.ts buildBtwBoxRows: the transcript box in
// the shared chrome colors.
func ThemedBoxRows(l Layout, t Theme, data EntryData, width int) []string {
	if width <= 4 {
		return nil
	}
	rows := []string{frameRule(l, t, width, "top", boxLabel), questionRow(l, t, data.Question, width), frameRow(l, t, "", width)}
	for _, line := range l.Wrap(data.Answer, max(1, width-4)) {
		rows = append(rows, frameRow(l, t, t.Fg("text", line), width))
	}
	rows = append(rows, frameRule(l, t, width, "bottom", ""), FitLine(l, t.Fg("dim", "· "+metaParts(data)), width, "…"))
	return rows
}

// Card is the above-editor card: pending while the question is in flight,
// then answered until DismissAt (milliseconds).
type Card struct {
	Pending    bool
	Question   string
	Model      string // pending: "provider/id"
	StartedAt  float64
	Answer     string
	AnsweredAt float64
	DismissAt  float64
}

// lastSegment is s.split("/").pop().
func lastSegment(s string) string {
	if i := strings.LastIndex(s, "/"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// CardRows renders the card uncolored at now (milliseconds); it never
// exceeds MaxCardRows rows.
func CardRows(l Layout, card Card, width int, now float64) []string {
	return ThemedCardRows(l, PlainTheme{}, card, width, now)
}

// ThemedCardRows is btw/display.ts buildBtwCardRows: the card in the
// shared chrome colors.
func ThemedCardRows(l Layout, t Theme, card Card, width int, now float64) []string {
	if width <= 4 {
		return nil
	}
	rows := []string{frameRule(l, t, width, "top", boxLabel), questionRow(l, t, card.Question, width)}
	if card.Pending {
		elapsed := int64(0)
		if now > card.StartedAt {
			elapsed = int64((now - card.StartedAt) / 1000)
		}
		rows = append(rows, frameRow(l, t, t.Fg("muted", fmt.Sprintf("%s asking %s · %ds", glyphAsking, lastSegment(card.Model), elapsed)), width))
		return append(rows, frameRule(l, t, width, "bottom", ""))
	}
	answer := l.Wrap(card.Answer, max(1, width-4))
	rows = append(rows, frameRow(l, t, "", width))
	if len(answer) > MaxCardAnswerRows {
		shown := answer[:MaxCardAnswerRows-1]
		for _, line := range shown {
			rows = append(rows, frameRow(l, t, t.Fg("text", line), width))
		}
		rows = append(rows, frameRow(l, t, t.Fg("dim", fmt.Sprintf("…+%d more lines (full answer in the transcript)", len(answer)-len(shown))), width))
	} else {
		for _, line := range answer {
			rows = append(rows, frameRow(l, t, t.Fg("text", line), width))
		}
	}
	rows = append(rows, frameRule(l, t, width, "bottom", ""))
	hideIn := ceilSeconds(card.DismissAt - now)
	return append(rows, FitLine(l, t.Fg("dim", fmt.Sprintf("· auto-hides in %ds", hideIn)), width, "…"))
}

func ceilSeconds(ms float64) int64 {
	if ms <= 0 {
		return 0
	}
	s := int64(ms / 1000)
	if float64(s)*1000 < ms {
		s++
	}
	return s
}

// StatusAskingLine is the footer status while a question is in flight.
func StatusAskingLine(modelID string) string {
	if modelID != "" {
		return glyphAsking + " btw asking · " + modelID
	}
	return glyphAsking + " btw asking"
}

// UsageLine is the /btw usage notice with the in-flight state.
func UsageLine(inFlight bool, modelID string) string {
	state := "no question in flight"
	if inFlight {
		state = "a side question is in flight"
		if modelID != "" {
			state = "a side question is in flight (" + modelID + ")"
		}
	}
	return "Usage: /btw <question> · " + state
}

// ModelID is the id part of a "provider/id" description.
func ModelID(description string) string { return lastSegment(description) }

// FrameAskingMeta is frameAskingMeta: the frame pill while a question is
// in flight (icon, label, theme role).
func FrameAskingMeta(modelID string) (icon, label, role string) {
	label = "btw asking"
	if modelID != "" {
		label += " · " + modelID
	}
	return glyphAsking, label, "accent"
}

// AskingModelID recovers the model id from a StatusAskingLine text; ok is
// false for another text.
func AskingModelID(status string) (modelID string, ok bool) {
	if status == StatusAskingLine("") {
		return "", true
	}
	return strings.CutPrefix(status, StatusAskingLine("")+" · ")
}
