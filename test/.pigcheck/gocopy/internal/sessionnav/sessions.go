package sessionnav

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Session is SessionLike (the SDK's SessionInfo). Created and Modified are
// epoch milliseconds.
type Session struct {
	Path            string  `json:"path"`
	ID              string  `json:"id"`
	Cwd             string  `json:"cwd"`
	Name            string  `json:"name,omitempty"`
	Created         float64 `json:"created"`
	Modified        float64 `json:"modified"`
	MessageCount    int     `json:"messageCount"`
	FirstMessage    string  `json:"firstMessage"`
	AllMessagesText string  `json:"allMessagesText,omitempty"`
}

var groupOrder = []string{"today", "yesterday", "this week", "earlier"}

func startOfDay(ms float64, loc *time.Location) float64 {
	t := time.UnixMilli(int64(ms)).In(loc)
	return float64(time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).UnixMilli())
}

// GroupFor is groupFor in loc.
func GroupFor(modified, now float64, loc *time.Location) string {
	today := startOfDay(now, loc)
	if modified >= today {
		return "today"
	}
	const day = 24 * 3600_000
	if modified >= startOfDay(today-day/2, loc) {
		return "yesterday"
	}
	if modified >= today-6*day {
		return "this week"
	}
	return "earlier"
}

// SessionTitle is sessionTitle.
func SessionTitle(s Session) string {
	if name := CollapseSpace(s.Name); name != "" {
		return name
	}
	if title := CleanPromptTitle(s.FirstMessage); title != "" {
		return title
	}
	return "(empty session)"
}

// FilterSessions is filterSessions.
func FilterSessions(sessions []Session, query string) []Session {
	if jsstr.Trim(query) == "" {
		return sessions
	}
	var out []Session
	for _, s := range sessions {
		if MatchesQuery(query, SessionTitle(s), s.Name, s.FirstMessage, s.AllMessagesText, s.Cwd) {
			out = append(out, s)
		}
	}
	return out
}

// GroupRows is SessionGroupRows.
type GroupRows struct {
	Group    string    `json:"group"`
	Sessions []Session `json:"sessions"`
}

// GroupSessions is groupSessions: newest first, bucketed by day.
func GroupSessions(sessions []Session, now float64, loc *time.Location) []GroupRows {
	sorted := append([]Session(nil), sessions...)
	zero := func(v float64) float64 {
		if math.IsNaN(v) {
			return 0
		}
		return v
	}
	sort.SliceStable(sorted, func(i, j int) bool { return zero(sorted[j].Modified)-zero(sorted[i].Modified) < 0 })
	buckets := map[string][]Session{}
	for _, s := range sorted {
		g := GroupFor(s.Modified, now, loc)
		buckets[g] = append(buckets[g], s)
	}
	var out []GroupRows
	for _, g := range groupOrder {
		if list, ok := buckets[g]; ok {
			out = append(out, GroupRows{g, list})
		}
	}
	return out
}

// LastExchange is LastExchange.
type LastExchange struct {
	LastPrompt *string `json:"lastPrompt,omitempty"`
	LastReply  *string `json:"lastReply,omitempty"`
}

// ReadLastExchange is readLastExchange: the latest prompt and reply from
// at most maxBytes at the end of the file.
func ReadLastExchange(path string, maxBytes int64) (LastExchange, error) {
	f, err := os.Open(path)
	if err != nil {
		return LastExchange{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return LastExchange{}, err
	}
	size := info.Size()
	length := min(size, maxBytes)
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, size-length); err != nil && err != io.EOF {
		return LastExchange{}, err
	}
	lines := strings.Split(string(bytes.ToValidUTF8(buf, []byte("\uFFFD"))), "\n")
	if length < size && len(lines) > 0 {
		lines = lines[1:]
	}
	var result LastExchange
	for i := len(lines) - 1; i >= 0; i-- {
		line := jsstr.Trim(lines[i])
		if line == "" {
			continue
		}
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil || entry.Type != "message" {
			continue
		}
		text := jsstr.Trim(ContentText(entry.Message.Content))
		if text == "" {
			continue
		}
		if entry.Message.Role == "assistant" && result.LastReply == nil {
			result.LastReply = &text
		}
		if entry.Message.Role == "user" && result.LastPrompt == nil {
			title := CleanPromptTitle(text)
			result.LastPrompt = &title
		}
		if result.LastReply != nil && result.LastPrompt != nil {
			break
		}
	}
	return result, nil
}

// FrameSection is FrameSection.
type FrameSection struct {
	Label string
	Lines []string
}

// RenderFrame is renderFrame: a rounded frame with labeled sections.
func RenderFrame(theme chrome.Theme, width int, title string, sections []FrameSection) []string {
	if width <= 0 {
		return []string{}
	}
	lines := []string{chrome.FrameRule(theme, width, "top", title)}
	for i, s := range sections {
		if i > 0 {
			lines = append(lines, chrome.FrameRule(theme, width, "divider", s.Label))
		}
		for _, line := range s.Lines {
			lines = append(lines, chrome.FrameRow(theme, line, width))
		}
	}
	lines = append(lines, chrome.FrameRule(theme, width, "bottom", ""))
	for i, line := range lines {
		lines[i] = chrome.FitLineWith(line, width, "")
	}
	return lines
}

// InnerWidth is innerWidth.
func InnerWidth(width int) int {
	if width <= 4 {
		return max(0, width)
	}
	return width - 4
}

// SplitRow is splitRow: left text and right-aligned meta.
func SplitRow(left, right string, width int) string {
	if width <= 0 {
		return ""
	}
	rightWidth := tuiwidth.VisibleWidth(right)
	if right == "" || rightWidth+4 > width {
		return chrome.FitLine(left, width)
	}
	fitted := chrome.FitLine(left, width-rightWidth-2)
	return chrome.PadToWidth(fitted, width-rightWidth) + right
}

// WrapLimited is wrapLimited: plain text in at most maxLines rows.
func WrapLimited(text string, width, maxLines int) []string {
	if width <= 0 || maxLines <= 0 {
		return []string{}
	}
	wrapped := tuiwidth.WrapTextWithAnsi(CollapseSpace(text), width)
	if len(wrapped) <= maxLines {
		return wrapped
	}
	kept := append([]string(nil), wrapped[:maxLines]...)
	kept[maxLines-1] = chrome.FitLine(kept[maxLines-1]+" …", width)
	return kept
}

// Keys is the key matching the pickers use (pi-tui matchesKey and
// decodeKittyPrintable).
type Keys interface {
	MatchesKey(data, keyID string) bool
	DecodeKittyPrintable(data string) (string, bool)
}

// PrintableInput is printableInput.
func PrintableInput(keys Keys, data string) (string, bool) {
	if decoded, ok := keys.DecodeKittyPrintable(data); ok {
		return decoded, true
	}
	if jsstr.Len16(data) == 1 && data >= " " && data != "\x7f" {
		return data, true
	}
	return "", false
}

// VisibleWindow is visibleWindow.
func VisibleWindow(total, selected, size int) (start, end int) {
	if total <= size {
		return 0, total
	}
	start = max(0, min(total-size, selected-size/2))
	return start, start + size
}
