package askuserquestion

// Port of view/components/preview/*: the box renderer, the layout decider,
// the Markdown content cache, the preview block renderer, and the preview
// pane. Markdown renders through copywidget's port of pi-tui's Markdown.

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Preview constants.
const (
	MaxPreviewHeightSideBySide   = 20
	MaxPreviewHeightStacked      = 15
	NoPreviewText                = "No preview available"
	NotesAffordanceOverhead      = 2
	NotesAffordanceText          = "Notes: press n to add notes"
	BorderVerticalOverhead       = 2
	BorderHorizontalOverhead     = 2
	BorderInnerPaddingHorizontal = 1
	BoxMinContentWidth           = 40
	PreviewMinWidth              = 100
	PreviewColumnGap             = 2
	PreviewPaddingLeft           = 1
	StackedGapRows               = 1
	MinLeft                      = 30
	MinPreviewWidth              = 45
	ConfirmedOverhead            = 2
)

// Layout modes.
const (
	LayoutSideBySide = "side-by-side"
	LayoutStacked    = "stacked"
)

var (
	ansiSGR     = regexp.MustCompile("\x1b\\[[0-9;]*m")
	ansiOSC8    = regexp.MustCompile("\x1b\\]8;[^\x07\x1b]*(?:\x07|\x1b\\\\)")
	fenceMarker = regexp.MustCompile("^`{3}")
)

// StripFenceMarkers ports stripFenceMarkers.
func StripFenceMarkers(lines []string) []string {
	out := []string{}
	for _, line := range lines {
		clean := ansiOSC8.ReplaceAllString(ansiSGR.ReplaceAllString(line, ""), "")
		if !fenceMarker.MatchString(clean) {
			out = append(out, line)
		}
	}
	return out
}

// RenderBorderedBox ports renderBorderedBox.
func RenderBorderedBox(lines []string, width int, color func(string) string, hidden int) []string {
	dashSpan := max(1, width-BorderHorizontalOverhead)
	contentInner := max(1, dashSpan-2*BorderInnerPaddingHorizontal)
	pad := strings.Repeat(" ", BorderInnerPaddingHorizontal)
	out := []string{color("┌" + strings.Repeat("─", dashSpan) + "┐")}
	for _, line := range lines {
		padded := tuiwidth.TruncateToWidth(line, contentInner, "", true)
		out = append(out, color("│")+pad+padded+pad+color("│"))
	}
	if hidden > 0 {
		indicator := " ✂ ── " + strconv.Itoa(hidden) + " lines hidden ── "
		space := dashSpan - jsstr.Len16(indicator)
		left := strings.Repeat("─", max(0, floorDiv(space, 2)))
		right := strings.Repeat("─", max(0, dashSpan-jsstr.Len16(left)-jsstr.Len16(indicator)))
		out = append(out, color("└"+left+indicator+right+"┘"))
	} else {
		out = append(out, color("└"+strings.Repeat("─", dashSpan)+"┘"))
	}
	return out
}

// ComputeBoxDimensions ports computeBoxDimensions.
func ComputeBoxDimensions(contentLines []string, maxInnerWidth int) (innerWidth, boxWidth int) {
	widest := min(BoxMinContentWidth, maxInnerWidth)
	for _, line := range contentLines {
		if w := tuiwidth.VisibleWidth(jsstr.TrimEnd(line)); w > widest {
			widest = w
		}
	}
	innerWidth = min(widest, maxInnerWidth)
	return innerWidth, innerWidth + BorderHorizontalOverhead + 2*BorderInnerPaddingHorizontal
}

// DecideLayout ports decideLayout.
func DecideLayout(terminalWidth, paneWidth int) string {
	if terminalWidth >= PreviewMinWidth && paneWidth >= PreviewMinWidth {
		return LayoutSideBySide
	}
	return LayoutStacked
}

// AdaptiveLeftWidth ports adaptiveLeftWidth.
func AdaptiveLeftWidth(items []Item, totalForNumbering, paneWidth int) int {
	prefixW := len(strconv.Itoa(max(1, totalForNumbering))) + 4
	maxLabel := 0
	for _, it := range items {
		maxLabel = max(maxLabel, tuiwidth.VisibleWidth(it.Label))
	}
	desired := maxLabel + prefixW + ConfirmedOverhead
	ratioCapped := min(desired, floorDiv(paneWidth, 2))
	available := paneWidth - PreviewColumnGap - MinPreviewWidth
	return max(MinLeft, min(ratioCapped, max(1, available)))
}

// CrossTabMaxLeftWidth ports crossTabMaxLeftWidth.
func CrossTabMaxLeftWidth(itemsByTab [][]Item, tabs, paneWidth int) int {
	best := MinLeft
	for i := 0; i < tabs; i++ {
		var items []Item
		if i < len(itemsByTab) {
			items = itemsByTab[i]
		}
		best = max(best, AdaptiveLeftWidth(items, len(items), paneWidth))
	}
	return best
}

// PreviewSourceWidth ports previewSourceWidth.
func PreviewSourceWidth(q Question) int {
	best := 0
	for _, o := range q.Options {
		if o.Preview == nil || *o.Preview == "" {
			continue
		}
		for _, line := range strings.Split(*o.Preview, "\n") {
			best = max(best, tuiwidth.VisibleWidth(line))
		}
	}
	return best
}

// CrossTabPreviewBudget ports crossTabPreviewBudget.
func CrossTabPreviewBudget(questions []Question, paneWidth int) int {
	best := MinPreviewWidth
	for _, q := range questions {
		capped := min(PreviewSourceWidth(q), paneWidth-PreviewColumnGap-MinLeft)
		best = max(best, capped+BorderHorizontalOverhead+2*BorderInnerPaddingHorizontal+PreviewPaddingLeft)
	}
	return best
}

// CrossTabLeftWidthWithDonation ports crossTabLeftWidthWithDonation.
func CrossTabLeftWidthWithDonation(itemsByTab [][]Item, questions []Question, paneWidth int) int {
	labelDriven := CrossTabMaxLeftWidth(itemsByTab, len(questions), paneWidth)
	if labelDriven <= MinLeft {
		return labelDriven
	}
	slack := paneWidth - PreviewColumnGap - CrossTabPreviewBudget(questions, paneWidth)
	ceiling := paneWidth - PreviewColumnGap - MinPreviewWidth
	return min(max(labelDriven, slack), max(1, ceiling))
}

// ColumnWidths ports columnWidths.
func ColumnWidths(paneWidth, adaptiveLeft int) (left, right, gap int) {
	gap = PreviewColumnGap
	left = min(adaptiveLeft, max(1, paneWidth-gap-1))
	right = max(1, paneWidth-left-gap)
	return left, right, gap
}

// BodyWidths ports bodyWidths.
func BodyWidths(paneWidth int, mode string, adaptiveLeft int) (optionsWidth, previewWidth int) {
	if mode == LayoutStacked {
		return paneWidth, paneWidth
	}
	left, right, _ := ColumnWidths(paneWidth, adaptiveLeft)
	return left, max(1, right-PreviewPaddingLeft)
}

// markdownCache ports MarkdownContentCache. Rendered bodies are cached per
// option and width, as the Markdown components cache their render.
type markdownCache struct {
	theme    Theme
	md       copywidget.MarkdownTheme
	previews map[int]string
	cache    map[[2]int][]string
}

func newMarkdownCache(q Question, theme Theme, md copywidget.MarkdownTheme) *markdownCache {
	c := &markdownCache{theme: theme, md: md, previews: map[int]string{}, cache: map[[2]int][]string{}}
	for i, o := range q.Options {
		if o.HasPreview() {
			c.previews[i] = *o.Preview
		}
	}
	return c
}

func (c *markdownCache) hasAnyPreview() bool { return len(c.previews) > 0 }
func (c *markdownCache) has(index int) bool  { _, ok := c.previews[index]; return ok }
func (c *markdownCache) invalidate()         { c.cache = map[[2]int][]string{} }

func (c *markdownCache) bodyFor(index, innerWidth int) []string {
	text, ok := c.previews[index]
	if !ok {
		placeholder := c.theme.Fg("dim", T("preview.no_preview", NoPreviewText))
		return []string{placeholder + strings.Repeat(" ", max(0, innerWidth-tuiwidth.VisibleWidth(placeholder)))}
	}
	key := [2]int{index, innerWidth}
	if lines, ok := c.cache[key]; ok {
		return lines
	}
	lines := StripFenceMarkers(copywidget.RenderMarkdown(text, 0, 0, innerWidth, c.md))
	c.cache[key] = lines
	return lines
}

// previewBlock ports PreviewBlockRenderer.
type previewBlock struct {
	theme Theme
	cache *markdownCache
}

func previewCap(mode string) int {
	if mode == LayoutSideBySide {
		return MaxPreviewHeightSideBySide
	}
	return MaxPreviewHeightStacked
}

func (b *previewBlock) blockHeight(width, index int, mode string) int {
	budget := max(1, previewCap(mode)-BorderVerticalOverhead-NotesAffordanceOverhead)
	inner := max(1, width-BorderHorizontalOverhead-2*BorderInnerPaddingHorizontal)
	return BorderVerticalOverhead + min(len(b.cache.bodyFor(index, inner)), budget) + NotesAffordanceOverhead
}

func (b *previewBlock) renderBlock(width, index int, mode string, focused, notesVisible bool) []string {
	budget := max(1, previewCap(mode)-BorderVerticalOverhead-NotesAffordanceOverhead)
	maxInner := max(1, width-BorderHorizontalOverhead-2*BorderInnerPaddingHorizontal)
	raw := b.cache.bodyFor(index, maxInner)
	hidden := 0
	content := raw
	if len(raw) > budget {
		hidden = len(raw) - budget
		content = raw[:budget]
	}
	_, boxWidth := ComputeBoxDimensions(content, maxInner)
	boxed := RenderBorderedBox(content, boxWidth, func(s string) string { return b.theme.Fg("accent", s) }, hidden)
	affordance := ""
	if focused && !notesVisible && b.cache.has(index) {
		affordance = b.theme.Fg("muted", T("preview.notes_affordance", NotesAffordanceText))
	}
	return append(append(boxed, ""), affordance)
}

// previewPaneProps ports PreviewPaneProps.
type previewPaneProps struct {
	notesVisible  bool
	selectedIndex int
	focused       bool
	inputMode     bool
}

// previewPane ports PreviewPane.
type previewPane struct {
	question        Question
	terminalWidth   func() int
	options         *optionListView
	block           *previewBlock
	props           previewPaneProps
	globalLeftWidth func(paneWidth int) int
}

func (p *previewPane) plain() bool {
	return p.question.IsMulti() || !p.block.cache.hasAnyPreview() || p.props.inputMode
}

func (p *previewPane) render(width int) []string {
	if p.plain() {
		return p.options.render(width)
	}
	mode := DecideLayout(p.terminalWidth(), width)
	if mode == LayoutSideBySide {
		return p.renderSideBySide(width, mode)
	}
	out := append([]string{}, p.options.render(width)...)
	for range StackedGapRows {
		out = append(out, "")
	}
	return append(out, p.block.renderBlock(width, p.props.selectedIndex, mode, p.props.focused, p.props.notesVisible)...)
}

func (p *previewPane) focusedItemRowRange(width int) [2]int {
	if p.plain() {
		return p.options.focusedItemRowRange(width)
	}
	if DecideLayout(p.terminalWidth(), width) == LayoutStacked {
		return p.options.focusedItemRowRange(width)
	}
	left, _, _ := ColumnWidths(width, p.globalLeftWidth(width))
	return p.options.focusedItemRowRange(left)
}

func (p *previewPane) naturalHeight(width int) int {
	if p.plain() {
		return len(p.options.render(width))
	}
	mode := DecideLayout(p.terminalWidth(), width)
	ow, pw := BodyWidths(width, mode, p.globalLeftWidth(width))
	oh := len(p.options.render(ow))
	bh := p.block.blockHeight(pw, p.props.selectedIndex, mode)
	if mode == LayoutSideBySide {
		return max(oh, bh)
	}
	return oh + StackedGapRows + bh
}

func (p *previewPane) maxNaturalHeight(width int) int {
	if p.plain() {
		return len(p.options.render(width))
	}
	mode := DecideLayout(p.terminalWidth(), width)
	ow, pw := BodyWidths(width, mode, p.globalLeftWidth(width))
	oh := len(p.options.render(ow))
	best := 0
	for i := range p.question.Options {
		best = max(best, p.block.blockHeight(pw, i, mode))
	}
	if mode == LayoutSideBySide {
		return max(oh, best)
	}
	return oh + StackedGapRows + best
}

func (p *previewPane) renderSideBySide(width int, mode string) []string {
	left, right, gap := ColumnWidths(width, p.globalLeftWidth(width))
	leftLines := p.options.render(left)
	inner := max(1, right-PreviewPaddingLeft)
	block := p.block.renderBlock(inner, p.props.selectedIndex, mode, p.props.focused, p.props.notesVisible)
	pad := strings.Repeat(" ", PreviewPaddingLeft)
	rightLines := make([]string, len(block))
	for i, l := range block {
		if l != "" {
			rightLines[i] = pad + l
		}
	}
	rows := max(len(leftLines), len(rightLines))
	gapStr := strings.Repeat(" ", gap)
	out := make([]string, 0, rows)
	for i := 0; i < rows; i++ {
		l, r := "", ""
		if i < len(leftLines) {
			l = leftLines[i]
		}
		if i < len(rightLines) {
			r = rightLines[i]
		}
		clamped := tuiwidth.TruncateToWidth(l, left, "", false)
		leftPad := strings.Repeat(" ", max(0, left-tuiwidth.VisibleWidth(clamped)))
		out = append(out, tuiwidth.TruncateToWidth(clamped+leftPad+gapStr+r, width, "", false))
	}
	return out
}
