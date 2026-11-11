package askuserquestion

// Port of the view components: view/components/wrapping-select.ts,
// inline-input.ts, option-list-view.ts, multi-select-view.ts,
// submit-picker.ts, tab-bar.ts, and the pi-tui Text, Spacer, Container,
// and DynamicBorder pieces the dialog composes.

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Theme is the questionnaire's Theme slice: fg, bold, bg.
type Theme = chrome.Theme

// component is pi-tui's Component.render.
type component interface {
	render(width int) []string
}

type renderFunc func(width int) []string

func (f renderFunc) render(width int) []string { return f(width) }

// textComponent is pi-tui's Text(text, paddingX, paddingY) without a
// background.
type textComponent struct {
	text               string
	paddingX, paddingY int
}

func (t textComponent) render(width int) []string {
	if t.text == "" || jsstr.Trim(t.text) == "" {
		return []string{}
	}
	normalized := strings.ReplaceAll(t.text, "\t", "   ")
	px := min(t.paddingX, max(0, floorDiv(width-1, 2)))
	contentWidth := max(1, width-px*2)
	margin := strings.Repeat(" ", px)
	empty := strings.Repeat(" ", max(0, width))
	var out []string
	for range t.paddingY {
		out = append(out, empty)
	}
	for _, line := range tuiwidth.WrapTextWithAnsi(normalized, contentWidth) {
		withMargins := margin + line + margin
		out = append(out, withMargins+strings.Repeat(" ", max(0, width-tuiwidth.VisibleWidth(withMargins))))
	}
	for range t.paddingY {
		out = append(out, empty)
	}
	if len(out) == 0 {
		return []string{""}
	}
	return out
}

func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// spacer is pi-tui's Spacer(n).
type spacer int

func (s spacer) render(int) []string {
	out := make([]string, int(s))
	return out
}

// container is pi-tui's Container.
type container []component

func (c container) render(width int) []string {
	out := []string{}
	for _, child := range c {
		out = append(out, child.render(width)...)
	}
	return out
}

// dynamicBorder is DynamicBorder(color).
type dynamicBorder struct{ color func(string) string }

func (b dynamicBorder) render(width int) []string {
	return []string{b.color(strings.Repeat("─", max(1, width)))}
}

func padStart(s string, width int) string {
	if n := width - jsstr.Len16(s); n > 0 {
		return strings.Repeat(" ", n) + s
	}
	return s
}

// ---------------------------------------------------------------------------
// inline-input.ts
// ---------------------------------------------------------------------------

type inlineInputOptions struct {
	buffer             string
	cursorOffset       int // -1 is undefined
	rowPrefix          string
	continuationPrefix string
	contentWidth       int
	selectedText       func(string) string
	multiline          bool
}

func resolveCursorOffset(buffer string, requested int) int {
	if requested >= 0 && requested <= len(buffer) {
		return requested
	}
	return len(buffer)
}

func buildCursorRaw(buffer string, offset int) string {
	before := buffer[:offset]
	rawAt := firstGrapheme(buffer[offset:])
	atCursor := rawAt
	if rawAt == "" || rawAt == " " {
		atCursor = "\u00a0"
	}
	after := buffer[offset+len(rawAt):]
	return before + tuiwidth.CursorMarker + "\x1b[7m" + atCursor + "\x1b[27m" + after
}

// renderInlineInputRow ports renderInlineInputRow.
func renderInlineInputRow(o inlineInputOptions) []string {
	offset := resolveCursorOffset(o.buffer, o.cursorOffset)
	raw := buildCursorRaw(o.buffer, offset)
	if o.multiline {
		wrapped := tuiwidth.WrapTextWithAnsi(raw, o.contentWidth)
		out := make([]string, len(wrapped))
		for i, segment := range wrapped {
			prefix := o.continuationPrefix
			if i == 0 {
				prefix = o.rowPrefix
			}
			out[i] = o.selectedText(prefix + segment)
		}
		return out
	}
	if tuiwidth.VisibleWidth(raw) <= o.contentWidth {
		return []string{o.selectedText(o.rowPrefix + raw)}
	}
	clipped := tuiwidth.TruncateToWidth(o.buffer, o.contentWidth, "…", false)
	return []string{o.selectedText(o.rowPrefix + clipped)}
}

// ---------------------------------------------------------------------------
// wrapping-select.ts
// ---------------------------------------------------------------------------

type selectTheme struct {
	selectedText, description, scrollInfo func(string) string
}

const (
	activePointer   = "❯ "
	inactivePointer = "  "
	numberSeparator = ". "
	confirmedMark   = " ✔"
)

type wrappingSelect struct {
	items                  []Item
	maxVisible             int
	theme                  selectTheme
	numberStartOffset      int
	totalItemsForNumbering int

	selectedIndex          int
	focused                bool
	inputBuffer            string
	inputCursorOffset      int
	confirmedIndex         int // -1 is undefined
	confirmedLabelOverride *string
}

func newWrappingSelect(items []Item, maxVisible int, theme selectTheme) *wrappingSelect {
	return &wrappingSelect{
		items: items, maxVisible: max(1, maxVisible), theme: theme, totalItemsForNumbering: len(items),
		focused: true, inputCursorOffset: -1, confirmedIndex: -1,
	}
}

func (w *wrappingSelect) setSelectedIndex(i int) {
	w.selectedIndex = max(0, min(i, len(w.items)-1))
}

func (w *wrappingSelect) setConfirmedIndex(c *Confirmed) {
	if c == nil {
		w.confirmedIndex = -1
		w.confirmedLabelOverride = nil
		return
	}
	w.confirmedIndex = max(0, min(c.Index, len(w.items)-1))
	w.confirmedLabelOverride = c.LabelOverride
}

func (w *wrappingSelect) render(width int) []string {
	if len(w.items) == 0 {
		return []string{}
	}
	start, end := w.visibleWindow()
	numberWidth := len(strconv.Itoa(max(1, w.totalItemsForNumbering)))
	lines := []string{}
	for i := start; i < end; i++ {
		lines = append(lines, w.renderItem(w.items[i], i, i == w.selectedIndex && w.focused, width, numberWidth)...)
	}
	if start > 0 || end < len(w.items) {
		lines = append(lines, w.theme.scrollInfo("  ("+strconv.Itoa(w.selectedIndex+1)+"/"+strconv.Itoa(len(w.items))+")"))
	}
	return lines
}

func (w *wrappingSelect) focusedItemRowRange(width int) [2]int {
	if len(w.items) == 0 {
		return [2]int{0, 0}
	}
	start, end := w.visibleWindow()
	numberWidth := len(strconv.Itoa(max(1, w.totalItemsForNumbering)))
	row := 0
	for i := start; i < end; i++ {
		n := len(w.renderItem(w.items[i], i, i == w.selectedIndex && w.focused, width, numberWidth))
		if i == w.selectedIndex {
			return [2]int{row, row + n}
		}
		row += n
	}
	return [2]int{0, 1}
}

func (w *wrappingSelect) visibleWindow() (int, int) {
	half := w.maxVisible / 2
	start := max(0, min(w.selectedIndex-half, len(w.items)-w.maxVisible))
	end := min(start+w.maxVisible, len(w.items))
	return start, end
}

func (w *wrappingSelect) renderItem(item Item, index int, active bool, width, numberWidth int) []string {
	pointer := inactivePointer
	if active {
		pointer = activePointer
	}
	rowPrefix := pointer + padStart(strconv.Itoa(w.numberStartOffset+index+1), numberWidth) + numberSeparator
	continuation := strings.Repeat(" ", tuiwidth.VisibleWidth(rowPrefix))
	contentWidth := max(1, width-tuiwidth.VisibleWidth(rowPrefix))
	if item.Kind == RowOther && active {
		return renderInlineInputRow(inlineInputOptions{
			buffer: w.inputBuffer, cursorOffset: w.inputCursorOffset, rowPrefix: rowPrefix,
			continuationPrefix: continuation, contentWidth: contentWidth, selectedText: w.theme.selectedText, multiline: true,
		})
	}
	confirmed := index == w.confirmedIndex
	label := item.Label
	if confirmed {
		if w.confirmedLabelOverride != nil {
			label = *w.confirmedLabelOverride
		}
		label += confirmedMark
	}
	var out []string
	for i, segment := range tuiwidth.WrapTextWithAnsi(label, contentWidth) {
		prefix := continuation
		if i == 0 {
			prefix = rowPrefix
		}
		line := prefix + segment
		if active || confirmed {
			line = w.theme.selectedText(line)
		}
		out = append(out, line)
	}
	if item.Description != "" {
		for _, segment := range tuiwidth.WrapTextWithAnsi(item.Description, contentWidth) {
			out = append(out, continuation+w.theme.description(segment))
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// option-list-view.ts
// ---------------------------------------------------------------------------

// maxVisibleOptions ports MAX_VISIBLE_OPTIONS.
const maxVisibleOptions = 10

type optionListProps struct {
	selectedIndex     int
	focused           bool
	inputBuffer       string
	inputCursorOffset int
	confirmed         *Confirmed
}

type optionListView struct{ sel *wrappingSelect }

func newOptionListView(items []Item, theme selectTheme) *optionListView {
	return &optionListView{sel: newWrappingSelect(items, min(len(items), maxVisibleOptions), theme)}
}

func (o *optionListView) setProps(p optionListProps) {
	o.sel.setSelectedIndex(p.selectedIndex)
	o.sel.focused = p.focused
	o.sel.setConfirmedIndex(p.confirmed)
	o.sel.inputBuffer = p.inputBuffer
	o.sel.inputCursorOffset = p.inputCursorOffset
}

func (o *optionListView) render(width int) []string { return o.sel.render(width) }
func (o *optionListView) focusedItemRowRange(width int) [2]int {
	return o.sel.focusedItemRowRange(width)
}

// ---------------------------------------------------------------------------
// multi-select-view.ts
// ---------------------------------------------------------------------------

const (
	checkedBox         = "[✔]"
	uncheckedBox       = "[ ]"
	boxLabelGap        = " "
	continuationIndent = "  "
	// MultiSubmitLabel ports MULTI_SUBMIT_LABEL.
	MultiSubmitLabel = "Submit"
)

type multiSelectRow struct{ checked, active bool }

type multiSelectProps struct {
	rows              []multiSelectRow
	otherActive       bool
	otherInputMode    bool
	inputBuffer       string
	inputCursorOffset int
	nextActive        bool
	nextLabel         string
}

type multiSelectView struct {
	theme    Theme
	question Question
	props    multiSelectProps
}

func newMultiSelectView(theme Theme, q Question) *multiSelectView {
	return &multiSelectView{theme: theme, question: q, props: multiSelectProps{inputCursorOffset: -1, nextLabel: DisplayLabel(RowNext)}}
}

func (m *multiSelectView) accentBold(s string) string { return m.theme.Fg("accent", m.theme.Bold(s)) }

func (m *multiSelectView) numberWidth() int {
	return len(strconv.Itoa(max(1, len(m.question.Options)+1)))
}

func (m *multiSelectView) prefixWidth() int {
	return tuiwidth.VisibleWidth(inactivePointer) + m.numberWidth() + tuiwidth.VisibleWidth(numberSeparator+uncheckedBox+boxLabelGap)
}

func (m *multiSelectView) render(width int) []string {
	lines := []string{}
	contentWidth := max(1, width-m.prefixWidth())
	numberWidth := m.numberWidth()
	for i, opt := range m.question.Options {
		if i >= len(m.props.rows) {
			continue
		}
		row := m.props.rows[i]
		pointer := inactivePointer
		if row.active {
			pointer = m.theme.Fg("accent", activePointer)
		}
		box := m.theme.Fg("muted", uncheckedBox)
		if row.checked {
			box = m.theme.Fg("accent", checkedBox)
		}
		label := tuiwidth.TruncateToWidth(opt.Label, contentWidth, "…", false)
		if row.active {
			label = m.accentBold(label)
		}
		line := pointer + padStart(strconv.Itoa(i+1), numberWidth) + numberSeparator + box + boxLabelGap + label
		lines = append(lines, tuiwidth.TruncateToWidth(line, width, "", false))
		if opt.Description != "" {
			for _, segment := range tuiwidth.WrapTextWithAnsi(opt.Description, contentWidth) {
				lines = append(lines, continuationIndent+m.theme.Fg("muted", segment))
			}
		}
	}
	otherPointer := inactivePointer
	if m.props.otherActive {
		otherPointer = m.theme.Fg("accent", activePointer)
	}
	otherBox := m.theme.Fg("muted", uncheckedBox)
	otherNum := padStart(strconv.Itoa(len(m.question.Options)+1), numberWidth)
	var otherLabel string
	if m.props.otherActive && m.props.otherInputMode {
		rendered := renderInlineInputRow(inlineInputOptions{
			buffer: m.props.inputBuffer, cursorOffset: m.props.inputCursorOffset, contentWidth: contentWidth,
			selectedText: m.accentBold, multiline: false,
		})
		if len(rendered) > 0 {
			otherLabel = rendered[0]
		}
	} else {
		otherLabel = tuiwidth.TruncateToWidth(DisplayLabel(RowOther), contentWidth, "…", false)
		if m.props.otherActive {
			otherLabel = m.accentBold(otherLabel)
		}
	}
	lines = append(lines, tuiwidth.TruncateToWidth(otherPointer+otherNum+numberSeparator+otherBox+boxLabelGap+otherLabel, width, "", false))
	nextPointer := inactivePointer
	nextLabel := m.props.nextLabel
	if m.props.nextActive {
		nextPointer = m.theme.Fg("accent", activePointer)
		nextLabel = m.accentBold(nextLabel)
	}
	lines = append(lines, tuiwidth.TruncateToWidth(nextPointer+nextLabel, width, "", false))
	return lines
}

func (m *multiSelectView) focusedItemRowRange(width int) [2]int {
	contentWidth := max(1, width-m.prefixWidth())
	row := 0
	for i, opt := range m.question.Options {
		if i >= len(m.props.rows) {
			continue
		}
		h := 1
		if opt.Description != "" {
			h += len(tuiwidth.WrapTextWithAnsi(opt.Description, contentWidth))
		}
		if m.props.rows[i].active {
			return [2]int{row, row + h}
		}
		row += h
	}
	if m.props.otherActive {
		return [2]int{row, row + 1}
	}
	row++
	if m.props.nextActive {
		return [2]int{row, row + 1}
	}
	return [2]int{0, 0}
}

func (m *multiSelectView) naturalHeight(width int) int {
	contentWidth := max(1, width-m.prefixWidth())
	total := 0
	for _, opt := range m.question.Options {
		total++
		if opt.Description != "" {
			total += len(tuiwidth.WrapTextWithAnsi(opt.Description, contentWidth))
		}
	}
	return total + 2
}

// ---------------------------------------------------------------------------
// submit-picker.ts
// ---------------------------------------------------------------------------

// Submit picker labels.
const (
	SubmitLabel = "Submit answers"
	CancelLabel = "Cancel"
)

type submitPicker struct {
	theme Theme
	rows  [2]bool
}

func (p *submitPicker) render(width int) []string {
	lines := make([]string, 0, 2)
	for i := 0; i < 2; i++ {
		text := T("submit.label", SubmitLabel)
		if i == 1 {
			text = T("submit.cancel", CancelLabel)
		}
		pointer := inactivePointer
		label := p.theme.Fg("text", text)
		if p.rows[i] {
			pointer = activePointer
			label = p.theme.Fg("accent", p.theme.Bold(text))
		}
		lines = append(lines, tuiwidth.TruncateToWidth(pointer+strconv.Itoa(i+1)+numberSeparator+label, width, "", false))
	}
	return lines
}

// ---------------------------------------------------------------------------
// tab-bar.ts
// ---------------------------------------------------------------------------

type tabBarTab struct {
	label            string
	answered, active bool
}

type tabBar struct {
	theme             Theme
	tabs              []tabBarTab
	submitActive      bool
	submitAllAnswered bool
}

func (b *tabBar) render(width int) []string {
	t := b.theme
	pieces := []string{" ", t.Fg("accent", "▎"), t.Fg("muted", " ← ")}
	for _, tab := range b.tabs {
		box := "□"
		if tab.answered {
			box = "■"
		}
		raw := " " + box + " " + tab.label + " "
		var styled string
		switch {
		case tab.active:
			styled = t.Bg("selectedBg", t.Fg("text", raw))
		case tab.answered:
			styled = t.Fg("success", raw)
		default:
			styled = t.Fg("muted", raw)
		}
		pieces = append(pieces, styled, " ")
	}
	const submitText = " ✓ Submit "
	switch {
	case b.submitActive:
		pieces = append(pieces, t.Bg("selectedBg", t.Fg("text", submitText)))
	case b.submitAllAnswered:
		pieces = append(pieces, t.Fg("success", submitText))
	default:
		pieces = append(pieces, t.Fg("dim", submitText))
	}
	pieces = append(pieces, t.Fg("muted", " →"))
	return []string{tuiwidth.TruncateToWidth(strings.Join(pieces, ""), width, "", false), ""}
}
