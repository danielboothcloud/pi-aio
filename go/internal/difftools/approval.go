package difftools

// Scrollable mutation-approval overlay: port of the ApprovalDialog class in
// permission-modes/approval-dialog.ts. The diff body scrolls; the header,
// the three decision rows, and the hint stay pinned.

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// ApprovalOptions are the select-fallback labels (OPTIONS).
var ApprovalOptions = []string{"Allow", "Allow all (enable auto)", "Block"}

// OutsideApprovalOptions are the outside-workspace labels (OUTSIDE_OPTIONS).
var OutsideApprovalOptions = []string{"Allow once", "Allow this folder for the session", "Block"}

// OutsideBody ports approval-dialog.ts outsideBody.
func OutsideBody(cwd string, scopes []string) string {
	return "⚠ Outside the working directory " + cwd + ". \"" + OutsideApprovalOptions[1] + "\" allows further changes under: " + strings.Join(scopes, ", ")
}

// KeyMatcher reports whether data is the key of a keybinding id such as
// "tui.select.up" (pi-tui getKeybindings().matches).
type KeyMatcher func(data, binding string) bool

type diffRow struct{ text, role string }

// ApprovalDialog ports the ApprovalDialog component.
type ApprovalDialog struct {
	theme      chrome.Theme
	header     string
	diffLines  []string
	outside    bool
	matches    KeyMatcher
	rows       func() int
	columns    func() int
	selected   int
	scroll     int
	cacheWidth int
	wrapped    []diffRow
	done       bool
	decision   string
}

// ApprovalDialogOptions configures NewApprovalDialog.
type ApprovalDialogOptions struct {
	Theme   chrome.Theme
	Header  string
	Diff    string
	Outside bool
	Matches KeyMatcher
	// Rows and Columns are tui.terminal.rows and columns.
	Rows    func() int
	Columns func() int
}

var trailingNL = func(s string) string { return strings.TrimRight(s, "\n") }

// NewApprovalDialog builds the overlay component.
func NewApprovalDialog(o ApprovalDialogOptions) *ApprovalDialog {
	d := &ApprovalDialog{theme: o.Theme, header: o.Header, outside: o.Outside, matches: o.Matches, rows: o.Rows, columns: o.Columns, cacheWidth: -1}
	if trimmed := trailingNL(o.Diff); trimmed != "" {
		d.diffLines = strings.Split(trimmed, "\n")
	}
	return d
}

// Done reports whether a decision was made, and which.
func (d *ApprovalDialog) Done() (string, bool) { return d.decision, d.done }

func classifyLine(line string) string {
	switch {
	case strings.HasPrefix(line, "--- ") && strings.HasSuffix(line, " ---"),
		strings.HasPrefix(line, "+++ "),
		strings.HasPrefix(line, "…"), strings.HasPrefix(line, "move "):
		return "meta"
	case strings.HasPrefix(line, "+"):
		return "add"
	case strings.HasPrefix(line, "-"):
		return "del"
	}
	return "context"
}

func roleColor(role string) string {
	switch role {
	case "add":
		return "toolDiffAdded"
	case "del":
		return "toolDiffRemoved"
	case "meta":
		return "muted"
	}
	return "toolDiffContext"
}

// Invalidate drops the wrap cache.
func (d *ApprovalDialog) Invalidate() { d.cacheWidth = -1 }

func (d *ApprovalDialog) finish(decision string) {
	d.done, d.decision = true, decision
}

func (d *ApprovalDialog) decisionFor(index int) string {
	switch index {
	case 0:
		return "allow"
	case 1:
		if d.outside {
			return "allowScope"
		}
		return "allowAll"
	}
	return "block"
}

// HandleInput ports handleInput.
func (d *ApprovalDialog) HandleInput(data string) {
	switch {
	case d.matches(data, "tui.select.up"):
		d.scrollBy(-1)
	case d.matches(data, "tui.select.down"):
		d.scrollBy(1)
	case data == "k":
		d.selected = (d.selected + 2) % 3
	case data == "j":
		d.selected = (d.selected + 1) % 3
	case d.matches(data, "tui.select.pageUp"):
		d.scrollBy(-max(1, d.windowRows()-1))
	case d.matches(data, "tui.select.pageDown"):
		d.scrollBy(max(1, d.windowRows()-1))
	case data == "g" || data == "\x1b[H" || data == "\x1bOH":
		d.scrollTo(0)
	case data == "G" || data == "\x1b[F" || data == "\x1bOF":
		d.scrollTo(1 << 53)
	case data == "\t":
		d.selected = (d.selected + 1) % 3
	case data == "\x1b[Z":
		d.selected = (d.selected + 2) % 3
	case data == "1" || data == "2" || data == "3":
		d.finish(d.decisionFor(int(data[0] - '1')))
	case d.matches(data, "tui.select.confirm") || data == "\n":
		d.finish(d.decisionFor(d.selected))
	case d.matches(data, "tui.select.cancel"):
		d.finish("block")
	}
}

func (d *ApprovalDialog) ensureWrapped(width int) []diffRow {
	if d.cacheWidth == width {
		return d.wrapped
	}
	d.cacheWidth = width
	contentWidth := width
	if width > 4 {
		contentWidth = width - 4
	}
	contentWidth = max(1, contentWidth)
	var rows []diffRow
	for _, line := range d.diffLines {
		role := classifyLine(line)
		parts := tuiwidth.WrapTextWithAnsi(line, contentWidth)
		if len(parts) == 0 {
			parts = []string{""}
		}
		for _, p := range parts {
			rows = append(rows, diffRow{p, role})
		}
	}
	d.wrapped = rows
	return rows
}

func (d *ApprovalDialog) windowRows() int {
	available := max(0, d.rows()-3-6)
	return min(available, max(len(d.wrapped), 1))
}

func (d *ApprovalDialog) scrollBy(delta int) {
	if d.cacheWidth < 0 {
		d.ensureWrapped(d.columns())
	} else {
		d.ensureWrapped(d.cacheWidth)
	}
	maxStart := max(0, len(d.wrapped)-d.windowRows())
	d.scroll = max(0, min(maxStart, d.scroll+delta))
}

func (d *ApprovalDialog) scrollTo(offset int) {
	if d.cacheWidth < 0 {
		d.ensureWrapped(d.columns())
	} else {
		d.ensureWrapped(d.cacheWidth)
	}
	maxStart := max(0, len(d.wrapped)-d.windowRows())
	d.scroll = max(0, min(maxStart, offset))
}

func (d *ApprovalDialog) inner(width int) int {
	if width > 4 {
		return width - 4
	}
	return width
}

func plural(n int, word string) string {
	if n == 1 {
		return strconv.Itoa(n) + " " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

// Render ports render.
func (d *ApprovalDialog) Render(width int) []string {
	rows := d.ensureWrapped(width)
	termRows := d.rows()
	available := max(0, termRows-3-6)
	total := len(rows)
	window := min(available, max(total, 1))
	if maxStart := max(0, total-window); d.scroll > maxStart {
		d.scroll = maxStart
	}
	start := d.scroll
	t := d.theme
	out := []string{
		chrome.FrameRule(t, width, "top", ""),
		chrome.FrameRow(t, chrome.Header(t, chrome.HeaderOptions{Title: "Review mutation", Meta: d.header}, d.inner(width)), width),
		chrome.FrameRule(t, width, "divider", "changes"),
	}
	var body []string
	if total == 0 {
		body = append(body, chrome.FrameRow(t, t.Fg("muted", "(no inline diff to review)"), width))
	} else {
		for _, r := range rows[start:min(total, start+window)] {
			body = append(body, chrome.FrameRow(t, t.Fg(roleColor(r.role), r.text), width))
		}
		if len(body) > 0 {
			if start > 0 {
				body[0] = chrome.FrameRow(t, t.Fg("muted", "↑ "+plural(start, "line")+" above"), width)
			}
			if remaining := total - (start + window); remaining > 0 {
				body[len(body)-1] = chrome.FrameRow(t, t.Fg("muted", "↓ "+plural(remaining, "line")+" below"), width)
			}
		}
	}
	out = append(out, body...)
	labels := []string{"Allow once", "Enable auto", "Block"}
	if d.outside {
		labels = []string{"Allow once", "Allow folder this session", "Block"}
	}
	tones := []string{"success", "warning", "error"}
	out = append(out, chrome.FrameRule(t, width, "divider", "decision"))
	for i := range 3 {
		marker := "·"
		if i == d.selected {
			marker = "›"
		}
		item := chrome.Item(t, chrome.ItemOptions{Label: strconv.Itoa(i+1) + " " + labels[i], Marker: marker, Tone: tones[i], Active: i == d.selected, Indent: chrome.Indent(0)}, d.inner(width))
		out = append(out, chrome.FrameRow(t, item, width))
	}
	out = append(out,
		chrome.FrameRow(t, chrome.Hint(t, "↑/↓ scroll · j/k decision · 1–3 pick · Enter confirm · Esc block", d.inner(width), 0), width),
		chrome.FrameRule(t, width, "bottom", ""),
	)
	if len(out) > termRows {
		out = out[:max(0, termRows)]
	}
	return out
}

// ApprovalHeader is the overlay header of showMutationApproval.
func ApprovalHeader(tool, path string, outsideCwd string, outside bool) string {
	if outside {
		return "Outside " + outsideCwd + ": allow " + tool + " on " + path + "?"
	}
	return "Allow " + tool + " on " + path + "?"
}

// ApprovalDiff is the overlay body of showMutationApproval.
func ApprovalDiff(preview string, hasPreview bool, outsideBody string, outside bool) (string, bool) {
	if outside {
		s := outsideBody + "\n" + preview
		return strings.TrimSuffix(s, "\n"), true
	}
	return preview, hasPreview
}

// Outside is approval-dialog.ts OutsideWorkspaceInfo.
type Outside struct {
	Cwd    string
	Scopes []string
}

// SelectPrompt is showMutationApproval's ctx.ui.select fallback: the title
// (outside body, "Allow <tool> on <path>?", and the capped plain preview)
// and the option labels. Relative paths resolve against cwd.
func SelectPrompt(tool, path string, input map[string]any, outside *Outside, cwd string) (string, []string) {
	preview, ok := FormatMutationPreview(tool, input, PreviewOptions{Cwd: cwd})
	prompt := BuildMutationApprovalPrompt(tool, path, preview, ok)
	if outside != nil {
		return OutsideBody(outside.Cwd, outside.Scopes) + "\n" + prompt, OutsideApprovalOptions
	}
	return prompt, ApprovalOptions
}

// SelectDecision maps a select answer to an approval decision.
func SelectDecision(choice string, outside bool) string {
	options := ApprovalOptions
	if outside {
		options = OutsideApprovalOptions
	}
	switch choice {
	case options[0]:
		return "allow"
	case options[1]:
		if outside {
			return "allowScope"
		}
		return "allowAll"
	}
	return "block"
}

// OverlayContent is showMutationApproval's overlay header and diff body,
// with the overlay's uncapped preview.
func OverlayContent(tool, path string, input map[string]any, outside *Outside, cwd string) (header, diff string) {
	preview, ok := FormatMutationPreview(tool, input, PreviewOptions{MaxLines: OverlayMaxLines, MaxChars: OverlayMaxChars, Cwd: cwd})
	if outside != nil {
		header = ApprovalHeader(tool, path, outside.Cwd, true)
		diff, _ = ApprovalDiff(preview, ok, OutsideBody(outside.Cwd, outside.Scopes), true)
		return header, diff
	}
	if !ok {
		preview = ""
	}
	return ApprovalHeader(tool, path, "", false), preview
}

// OverlayDecision maps the overlay result to showMutationApproval's
// decision. A dialog closed without a decision is block.
func OverlayDecision(result string, done, outside bool) string {
	switch {
	case !done:
		return "block"
	case result == "allow":
		return "allow"
	case result == "allowAll" && !outside:
		return "allowAll"
	case result == "allowScope" && outside:
		return "allowScope"
	}
	return "block"
}
