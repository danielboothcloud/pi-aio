package askuserquestion

// Port of view/dialog-builder.ts, view/tab-content-strategy.ts,
// view/props-adapter.ts, state/selectors/projections.ts, and
// state/build-questionnaire.ts.

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Hint and review texts.
const (
	HintPartEnter           = "Enter to select"
	HintPartNav             = "↑/↓/j/k to navigate"
	HintPartToggle          = "Space to toggle"
	HintPartNotes           = "n to add notes"
	HintPartTab             = "Tab/h/l switch"
	HintPartCancel          = "Esc to cancel"
	HintPartCollapse        = "Ctrl+] to collapse"
	HintPartExpand          = "Ctrl+] to expand"
	CollapsedHint           = HintPartExpand + " · " + HintPartCancel
	ReviewHeading           = "Review your answers"
	ReadyPrompt             = "Ready to submit your answers?"
	IncompleteWarningPrefix = "⚠ Answer remaining questions before submitting:"
	NotesHeader             = "Notes:"
)

// BuildHintText ports buildHintText.
func BuildHintText(q *Question, isMulti bool, s State) string {
	parts := []string{T("hint.enter", HintPartEnter), T("hint.navigate", HintPartNav)}
	if q != nil && q.IsMulti() {
		parts = append(parts, T("hint.toggle", HintPartToggle))
	}
	if q != nil && !q.IsMulti() && s.FocusedOptionHasPreview && !s.NotesVisible {
		parts = append(parts, T("hint.notes", HintPartNotes))
	}
	if isMulti {
		parts = append(parts, T("hint.tab", HintPartTab))
	}
	parts = append(parts, T("hint.cancel", HintPartCancel), T("hint.collapse", HintPartCollapse))
	return strings.Join(parts, " · ")
}

// oneLineClippedText ports OneLineClippedText.
type oneLineClippedText struct {
	text        string
	paddingLeft int
}

func (o oneLineClippedText) render(width int) []string {
	return []string{strings.Repeat(" ", o.paddingLeft) + tuiwidth.TruncateToWidth(o.text, max(0, width-o.paddingLeft), "…", false)}
}

// tabComponents ports TabComponents.
type tabComponents struct {
	optionList  *optionListView
	preview     *previewPane
	multiSelect *multiSelectView
}

func (t *tabComponents) bodyHeights(width int) (current, maxHeight int) {
	if t.multiSelect != nil {
		h := t.multiSelect.naturalHeight(width)
		return h, h
	}
	return t.preview.naturalHeight(width), t.preview.maxNaturalHeight(width)
}

// dialogView ports DialogView with its two strategies.
type dialogView struct {
	b            *built
	state        State
	activePane   *previewPane
	maxFooterRow int
}

func (d *dialogView) question(s State) *Question {
	if s.CurrentTab >= 0 && s.CurrentTab < len(d.b.questions) {
		return &d.b.questions[s.CurrentTab]
	}
	return nil
}

func (d *dialogView) onSubmit(s State) bool {
	return d.b.isMulti && s.CurrentTab == len(d.b.questions)
}

func (d *dialogView) footerRowCount(s State) int {
	if d.onSubmit(s) {
		return 5
	}
	return 2
}

func (d *dialogView) headingRows(s State) []component {
	t := d.b.theme
	if d.onSubmit(s) {
		return []component{textComponent{t.Bold(t.Fg("accent", T("review.heading", ReviewHeading))), 1, 0}, spacer(1)}
	}
	var out []component
	q := d.question(s)
	if !d.b.isMulti && q != nil && q.Header != "" {
		out = append(out, textComponent{t.Bg("selectedBg", " "+q.Header+" "), 1, 0}, spacer(1))
	}
	if q != nil {
		out = append(out, textComponent{t.Bold(q.Question), 1, 0}, spacer(1))
	}
	return out
}

func (d *dialogView) submitBody(s State) container {
	t := d.b.theme
	var c container
	for i, q := range d.b.questions {
		a, ok := s.Answers[i]
		if !ok {
			continue
		}
		label := q.Header
		if label == "" {
			label = "Q" + strconv.Itoa(i+1)
		}
		c = append(c,
			textComponent{t.Fg("muted", " ● "+label), 1, 0},
			textComponent{"   " + t.Fg("muted", "→") + " " + t.Fg("text", FormatAnswerScalar(a)), 1, 0},
		)
		if a.Notes != nil && *a.Notes != "" {
			c = append(c, textComponent{t.Fg("dim", "     notes: "+*a.Notes), 1, 0})
		}
	}
	return c
}

func (d *dialogView) bodyComponent(s State) component {
	if d.onSubmit(s) {
		return d.submitBody(s)
	}
	q := d.question(s)
	if q != nil && q.IsMulti() && d.b.tabs[s.CurrentTab].multiSelect != nil {
		return renderFunc(d.b.tabs[s.CurrentTab].multiSelect.render)
	}
	return renderFunc(d.activePane.render)
}

func (d *dialogView) bodyHeight(width int, s State) int {
	if d.onSubmit(s) {
		return len(d.submitBody(s).render(width))
	}
	return d.b.currentBodyHeight(width)
}

func (d *dialogView) midRows(s State) []component {
	if d.onSubmit(s) || !s.NotesVisible {
		return nil
	}
	return []component{
		textComponent{d.b.theme.Fg("muted", T("notes.header", NotesHeader)), 1, 0},
		renderFunc(d.b.notesInput.Render),
		spacer(1),
	}
}

func (d *dialogView) footerRows(s State) []component {
	t := d.b.theme
	if d.onSubmit(s) {
		var missing []string
		for i, q := range d.b.questions {
			if _, ok := s.Answers[i]; !ok {
				if q.Header != "" {
					missing = append(missing, q.Header)
				} else {
					missing = append(missing, "Q"+strconv.Itoa(i+1))
				}
			}
		}
		prompt := t.Fg("muted", T("review.ready", ReadyPrompt))
		if len(missing) > 0 {
			prompt = t.Fg("warning", T("review.incomplete", IncompleteWarningPrefix)+" "+strings.Join(missing, ", "))
		}
		out := []component{spacer(1), textComponent{prompt, 1, 0}, spacer(1)}
		if d.b.submitPicker != nil {
			return append(out, d.b.submitPicker)
		}
		return append(out, spacer(1), spacer(1))
	}
	return []component{spacer(1), oneLineClippedText{t.Fg("dim", BuildHintText(d.question(s), d.b.isMulti, s)), 1}}
}

func (d *dialogView) focusedItemRowRange(width int, s State) *[2]int {
	if d.onSubmit(s) {
		return nil
	}
	q := d.question(s)
	var r [2]int
	if q != nil && q.IsMulti() && d.b.tabs[s.CurrentTab].multiSelect != nil {
		r = d.b.tabs[s.CurrentTab].multiSelect.focusedItemRowRange(width)
	} else {
		r = d.activePane.focusedItemRowRange(width)
	}
	return &r
}

const (
	overflowUp   = "↑"
	overflowDown = "↓"
	overflowBoth = "↕"
)

func (d *dialogView) render(width int) []string {
	s := d.state
	t := d.b.theme
	heading := d.headingRows(s)
	border := dynamicBorder{func(x string) string { return t.Fg("accent", x) }}
	c := container{border}
	if d.b.isMulti && d.b.tabBar != nil {
		c = append(c, d.b.tabBar)
	}
	c = append(c, spacer(1))
	c = append(c, heading...)
	c = append(c, d.bodyComponent(s), spacer(1))
	c = append(c, d.midRows(s)...)
	c = append(c, border)
	c = append(c, d.footerRows(s)...)
	natural := c.render(width)

	footer := d.footerRowCount(s)
	topFixed := 2
	if d.b.isMulti && d.b.tabBar != nil {
		topFixed += 2
	}
	bottomFixed := 1 + footer
	middleRows := len(natural) - topFixed - bottomFixed
	spacerRows := max(0, d.b.globalBodyHeight(width)+d.maxFooterRow-d.bodyHeight(width, s)-footer)
	termRows := d.b.rows()
	if len(natural)+spacerRows <= termRows {
		for range spacerRows {
			natural = append(natural, "")
		}
		return natural
	}
	availableMiddle := max(0, termRows-topFixed-bottomFixed)
	if availableMiddle == 0 {
		chrome := append(append([]string{}, natural[:min(topFixed, len(natural))]...), natural[max(0, len(natural)-bottomFixed):]...)
		if len(chrome) > termRows {
			chrome = chrome[:max(0, termRows)]
		}
		return chrome
	}
	scrollStart := 0
	if r := d.focusedItemRowRange(width, s); r != nil {
		focusedRow := len(heading) + r[0]
		focusedHeight := r[1] - r[0]
		ideal := focusedRow - floorDiv(max(0, availableMiddle-focusedHeight), 2)
		scrollStart = max(0, min(ideal, middleRows-availableMiddle))
	}
	lo := min(len(natural), topFixed+scrollStart)
	hi := min(len(natural), topFixed+scrollStart+availableMiddle)
	middle := append([]string{}, natural[lo:hi]...)
	hasUp := scrollStart > 0
	hasDown := scrollStart+availableMiddle < middleRows
	if hasUp && hasDown && len(middle) == 1 {
		middle[0] = t.Fg("dim", overflowBoth)
	} else {
		if hasUp && len(middle) > 0 {
			middle[0] = t.Fg("dim", overflowUp)
		}
		if hasDown && len(middle) > 0 {
			middle[len(middle)-1] = t.Fg("dim", overflowDown)
		}
	}
	result := append(append(append([]string{}, natural[:topFixed]...), middle...), natural[len(natural)-bottomFixed:]...)
	if len(result) > termRows {
		result = result[:termRows]
	}
	return result
}

// built is the assembled questionnaire (buildQuestionnaire's result).
type built struct {
	theme         Theme
	questions     []Question
	itemsByTab    [][]Item
	isMulti       bool
	tabs          []*tabComponents
	submitPicker  *submitPicker
	tabBar        *tabBar
	dialog        *dialogView
	notesInput    *Input
	inlineInput   *Input
	columns       func() int
	rows          func() int
	currentTab    func() int
	requestRender func()
}

func (b *built) globalBodyHeight(width int) int {
	best := 0
	for _, t := range b.tabs {
		_, h := t.bodyHeights(width)
		best = max(best, h)
	}
	return max(1, best)
}

func (b *built) currentBodyHeight(width int) int {
	idx := min(b.currentTab(), len(b.tabs)-1)
	if idx < 0 || idx >= len(b.tabs) {
		return 0
	}
	h, _ := b.tabs[idx].bodyHeights(width)
	return max(0, h)
}

type buildConfig struct {
	theme         Theme
	markdown      copywidget.MarkdownTheme
	keys          Keys
	questions     []Question
	itemsByTab    [][]Item
	isMulti       bool
	initialState  State
	columns, rows func() int
	currentTab    func() int
	requestRender func()
}

func buildQuestionnaire(cfg buildConfig) *built {
	t := cfg.theme
	sel := selectTheme{
		selectedText: func(s string) string { return t.Fg("accent", t.Bold(s)) },
		description:  func(s string) string { return t.Fg("muted", s) },
		scrollInfo:   func(s string) string { return t.Fg("dim", s) },
	}
	b := &built{
		theme: t, questions: cfg.questions, itemsByTab: cfg.itemsByTab, isMulti: cfg.isMulti,
		notesInput: NewInput(cfg.keys), inlineInput: NewInput(cfg.keys),
		columns: cfg.columns, rows: cfg.rows, currentTab: cfg.currentTab, requestRender: cfg.requestRender,
	}
	globalLeft := func(paneWidth int) int {
		return CrossTabLeftWidthWithDonation(cfg.itemsByTab, cfg.questions, paneWidth)
	}
	for i, q := range cfg.questions {
		var items []Item
		if i < len(cfg.itemsByTab) {
			items = cfg.itemsByTab[i]
		}
		ol := newOptionListView(items, sel)
		tab := &tabComponents{
			optionList: ol,
			preview: &previewPane{
				question: q, terminalWidth: cfg.columns, options: ol,
				block:           &previewBlock{theme: t, cache: newMarkdownCache(q, t, cfg.markdown)},
				globalLeftWidth: globalLeft,
			},
		}
		if q.IsMulti() {
			tab.multiSelect = newMultiSelectView(t, q)
		}
		b.tabs = append(b.tabs, tab)
	}
	if cfg.isMulti {
		b.submitPicker = &submitPicker{theme: t}
		b.tabBar = &tabBar{theme: t}
	}
	paneIdx := SelectActivePreviewPaneIndex(cfg.initialState.CurrentTab, len(cfg.questions))
	b.dialog = &dialogView{b: b, state: cfg.initialState, activePane: b.tabs[paneIdx].preview, maxFooterRow: 2}
	if cfg.isMulti {
		b.dialog.maxFooterRow = 5
	}
	return b
}

// apply ports QuestionnairePropsAdapter.apply: every component's props
// from the canonical state.
func (b *built) apply(s State) {
	total := len(b.questions)
	activeView := SelectActiveView(s, total)
	paneIndex := SelectActivePreviewPaneIndex(s.CurrentTab, total)
	activePane := b.tabs[0].preview
	if paneIndex < len(b.tabs) {
		activePane = b.tabs[paneIndex].preview
	}
	buffer := b.inlineInput.Value()
	cursor := b.inlineInput.Cursor()
	focused := activeView == ViewOptions

	b.dialog.state = s
	b.dialog.activePane = activePane
	if b.submitPicker != nil {
		submitFocused := activeView == ViewSubmit
		b.submitPicker.rows = [2]bool{submitFocused && s.SubmitChoiceIndex == 0, submitFocused && s.SubmitChoiceIndex == 1}
	}
	if b.tabBar != nil {
		tabs := make([]tabBarTab, total)
		for i, q := range b.questions {
			label := q.Header
			if label == "" {
				label = "Q" + strconv.Itoa(i+1)
			}
			_, answered := s.Answers[i]
			tabs[i] = tabBarTab{label: label, answered: answered, active: i == s.CurrentTab}
		}
		b.tabBar.tabs = tabs
		b.tabBar.submitActive = s.CurrentTab == total
		b.tabBar.submitAllAnswered = len(s.Answers) == total && total > 0
	}
	for i, tab := range b.tabs {
		if i == paneIndex {
			var items []Item
			if i < len(b.itemsByTab) {
				items = b.itemsByTab[i]
			}
			tab.optionList.setProps(optionListProps{
				selectedIndex: s.OptionIndex, focused: focused, inputBuffer: buffer, inputCursorOffset: cursor,
				confirmed: SelectConfirmedIndicator(b.questions, s.CurrentTab, s.Answers, items),
			})
			tab.preview.props = previewPaneProps{notesVisible: s.NotesVisible, selectedIndex: s.OptionIndex, focused: focused, inputMode: s.InputMode}
		}
		if tab.multiSelect != nil {
			q := b.questions[i]
			rows := make([]multiSelectRow, len(q.Options))
			for j := range q.Options {
				rows[j] = multiSelectRow{checked: s.MultiSelectChecked[j], active: focused && j == s.OptionIndex}
			}
			nextLabel := DisplayLabel(RowNext)
			if i == total-1 {
				nextLabel = MultiSubmitLabel
			}
			tab.multiSelect.props = multiSelectProps{
				rows: rows, otherActive: focused && s.OptionIndex == len(q.Options), otherInputMode: s.InputMode,
				inputBuffer: buffer, inputCursorOffset: cursor,
				nextActive: focused && s.OptionIndex == len(q.Options)+1, nextLabel: nextLabel,
			}
		}
	}
	if b.requestRender != nil {
		b.requestRender()
	}
}

// invalidate ports QuestionnairePropsAdapter.invalidate.
func (b *built) invalidate() {
	for _, tab := range b.tabs {
		tab.preview.block.cache.invalidate()
	}
}
