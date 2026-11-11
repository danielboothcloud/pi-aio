package copywidget

// Port of pi-tui's Markdown component (components/markdown.js) for the
// picker preview: Markdown(text, paddingX, paddingY, getMarkdownTheme())
// without a default text style. LaTeX rendering is not ported.

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// MarkdownTheme is pi-tui's MarkdownTheme (getMarkdownTheme()).
type MarkdownTheme struct {
	Heading, Link, LinkURL, Code, CodeBlock, CodeBlockBorder func(string) string
	Quote, QuoteBorder, Hr, ListBullet                       func(string) string
	Bold, Italic, Underline, Strikethrough                   func(string) string
	// HighlightCode returns highlighted lines; nil styles each line with
	// CodeBlock.
	HighlightCode func(code, lang string) []string
	// Hyperlinks is getCapabilities().hyperlinks: links render as OSC 8.
	Hyperlinks bool
}

type styleContext struct {
	apply  func(string) string
	prefix string
}

type markdown struct{ theme MarkdownTheme }

func stylePrefix(fn func(string) string) string {
	styled := fn("\x00")
	if i := strings.Index(styled, "\x00"); i >= 0 {
		return styled[:i]
	}
	return ""
}

// RenderMarkdown ports Markdown.render(width).
func RenderMarkdown(text string, paddingX, paddingY, width int, theme MarkdownTheme) []string {
	contentWidth := max(1, width-paddingX*2)
	if text == "" || jsstr.Trim(text) == "" {
		return []string{}
	}
	normalized := strings.ReplaceAll(text, "\t", "   ")
	m := markdown{theme}
	tokens := lex(normalized)
	var rendered []string
	for i, t := range tokens {
		next := ""
		if i+1 < len(tokens) {
			next = tokens[i+1].typ
		}
		rendered = append(rendered, m.renderToken(t, contentWidth, next, nil)...)
	}
	var wrapped []string
	for _, line := range rendered {
		wrapped = append(wrapped, tuiwidth.WrapTextWithAnsi(line, contentWidth)...)
	}
	margin := strings.Repeat(" ", paddingX)
	var result []string
	empty := strings.Repeat(" ", max(0, width))
	for i := 0; i < paddingY; i++ {
		result = append(result, empty)
	}
	for _, line := range wrapped {
		withMargins := margin + line + margin
		result = append(result, withMargins+strings.Repeat(" ", max(0, width-tuiwidth.VisibleWidth(withMargins))))
	}
	for i := 0; i < paddingY; i++ {
		result = append(result, empty)
	}
	if len(result) == 0 {
		return []string{""}
	}
	return result
}

func identity(s string) string { return s }

func (m markdown) defaultContext() *styleContext {
	return &styleContext{apply: identity, prefix: ""}
}

var resetRe = regexp.MustCompile(`\x1b\[0m`)

func (m markdown) renderToken(t *token, width int, next string, sc *styleContext) []string {
	th := m.theme
	var lines []string
	spaced := func() {
		if next != "" && next != "space" {
			lines = append(lines, "")
		}
	}
	switch t.typ {
	case "heading":
		var fn func(string) string
		if t.depth == 1 {
			fn = func(s string) string { return th.Heading(th.Bold(th.Underline(s))) }
		} else {
			fn = func(s string) string { return th.Heading(th.Bold(s)) }
		}
		text := m.renderInline(t.inline, &styleContext{apply: fn, prefix: stylePrefix(fn)})
		if t.depth >= 3 {
			text = fn(strings.Repeat("#", t.depth)+" ") + text
		}
		lines = append(lines, text)
		spaced()
	case "paragraph":
		lines = append(lines, m.renderInline(t.inline, sc))
		if next != "" && next != "list" && next != "space" {
			lines = append(lines, "")
		}
	case "text":
		lines = append(lines, m.renderInline(t.inline, sc))
	case "code":
		lines = append(lines, th.CodeBlockBorder("```"+t.lang))
		if th.HighlightCode != nil {
			for _, l := range th.HighlightCode(t.text, t.lang) {
				lines = append(lines, "  "+l)
			}
		} else {
			for _, l := range strings.Split(t.text, "\n") {
				lines = append(lines, "  "+th.CodeBlock(l))
			}
		}
		lines = append(lines, th.CodeBlockBorder("```"))
		spaced()
	case "list":
		lines = append(lines, m.renderList(t, 0, width, sc)...)
	case "table":
		lines = append(lines, m.renderTable(t, width, next, sc)...)
	case "blockquote":
		quoteStyle := func(s string) string { return th.Quote(th.Italic(s)) }
		prefix := stylePrefix(quoteStyle)
		apply := func(line string) string {
			if prefix == "" {
				return quoteStyle(line)
			}
			return quoteStyle(resetRe.ReplaceAllString(line, "\x1b[0m"+prefix))
		}
		quoteWidth := max(1, width-2)
		inner := &styleContext{apply: identity, prefix: prefix}
		var quoteLines []string
		for i, c := range t.children {
			n := ""
			if i+1 < len(t.children) {
				n = t.children[i+1].typ
			}
			quoteLines = append(quoteLines, m.renderToken(c, quoteWidth, n, inner)...)
		}
		for len(quoteLines) > 0 && quoteLines[len(quoteLines)-1] == "" {
			quoteLines = quoteLines[:len(quoteLines)-1]
		}
		for _, ql := range quoteLines {
			for _, w := range tuiwidth.WrapTextWithAnsi(apply(ql), quoteWidth) {
				lines = append(lines, th.QuoteBorder("│ ")+w)
			}
		}
		spaced()
	case "hr":
		lines = append(lines, th.Hr(strings.Repeat("─", min(width, 80))))
		spaced()
	case "html":
		lines = append(lines, jsstr.Trim(t.raw))
	case "space":
		lines = append(lines, "")
	default:
		if t.text != "" {
			lines = append(lines, t.text)
		}
	}
	return lines
}

func hyperlink(text, url string) string {
	return "\x1b]8;;" + url + "\x1b\\" + text + "\x1b]8;;\x1b\\"
}

func (m markdown) renderInline(tokens []inlineToken, sc *styleContext) string {
	th := m.theme
	if sc == nil {
		sc = m.defaultContext()
	}
	applyLines := func(text string) string {
		parts := strings.Split(text, "\n")
		for i, p := range parts {
			parts[i] = sc.apply(p)
		}
		return strings.Join(parts, "\n")
	}
	var b strings.Builder
	for _, t := range tokens {
		switch t.typ {
		case "text":
			if len(t.children) > 0 {
				b.WriteString(m.renderInline(t.children, sc))
			} else {
				b.WriteString(applyLines(t.text))
			}
		case "strong":
			b.WriteString(th.Bold(m.renderInline(t.children, sc)) + sc.prefix)
		case "em":
			b.WriteString(th.Italic(m.renderInline(t.children, sc)) + sc.prefix)
		case "codespan":
			b.WriteString(th.Code(t.text) + sc.prefix)
		case "link":
			styled := th.Link(th.Underline(m.renderInline(t.children, sc)))
			if th.Hyperlinks {
				b.WriteString(hyperlink(styled, t.href) + sc.prefix)
				break
			}
			compare := strings.TrimPrefix(t.href, "mailto:")
			if t.text == t.href || t.text == compare {
				b.WriteString(styled + sc.prefix)
			} else {
				b.WriteString(styled + th.LinkURL(" ("+t.href+")") + sc.prefix)
			}
		case "br":
			b.WriteString("\n")
		case "del":
			b.WriteString(th.Strikethrough(m.renderInline(t.children, sc)) + sc.prefix)
		case "html", "escape", "image":
			b.WriteString(applyLines(t.text))
		}
	}
	result := b.String()
	for sc.prefix != "" && strings.HasSuffix(result, sc.prefix) {
		result = strings.TrimSuffix(result, sc.prefix)
	}
	return result
}

func (m markdown) renderList(t *token, depth, width int, sc *styleContext) []string {
	var lines []string
	indent := strings.Repeat("    ", depth)
	start := 1
	if t.ordered {
		start = t.start
	}
	for i, item := range t.items {
		bullet := "- "
		if t.ordered {
			bullet = strconv.Itoa(start+i) + ". "
		}
		marker := bullet
		if item.task {
			if item.checked {
				marker += "[x] "
			} else {
				marker += "[ ] "
			}
		}
		firstPrefix := indent + m.theme.ListBullet(marker)
		continuation := indent + strings.Repeat(" ", tuiwidth.VisibleWidth(marker))
		itemWidth := max(1, width-tuiwidth.VisibleWidth(firstPrefix))
		renderedAny := false
		for _, it := range item.tokens {
			if it.typ == "list" {
				lines = append(lines, m.renderList(it, depth+1, width, sc)...)
				renderedAny = true
				continue
			}
			for _, line := range m.renderToken(it, itemWidth, "", sc) {
				for _, w := range tuiwidth.WrapTextWithAnsi(line, itemWidth) {
					prefix := firstPrefix
					if renderedAny {
						prefix = continuation
					}
					lines = append(lines, prefix+w)
					renderedAny = true
				}
			}
		}
		if !renderedAny {
			lines = append(lines, firstPrefix)
		}
		if t.loose && i < len(t.items)-1 {
			lines = append(lines, "")
		}
	}
	return lines
}

func longestWordWidth(text string, maxWidth int) int {
	longest := 0
	for _, word := range strings.FieldsFunc(text, jsstr.IsJSSpace) {
		longest = max(longest, tuiwidth.VisibleWidth(word))
	}
	return min(longest, maxWidth)
}

func wrapCell(text string, maxWidth int, prefix string) []string {
	lines := tuiwidth.WrapTextWithAnsi(text, max(1, maxWidth))
	for i := range lines {
		reset := ""
		if i < len(lines)-1 {
			reset = "\x1b[22;23;24;25;27;28;29;39m"
		}
		lines[i] = lines[i] + reset + prefix
	}
	return lines
}

func (m markdown) renderTable(t *token, available int, next string, sc *styleContext) []string {
	var lines []string
	numCols := len(t.header)
	if numCols == 0 {
		return lines
	}
	prefix := ""
	if sc != nil {
		prefix = sc.prefix
	}
	overhead := 3*numCols + 1
	forCells := available - overhead
	if forCells < numCols {
		// Too narrow for a stable table: the raw Markdown, wrapped.
		var fallback []string
		if t.raw != "" {
			fallback = tuiwidth.WrapTextWithAnsi(t.raw, available)
		}
		if next != "" && next != "space" {
			fallback = append(fallback, "")
		}
		return fallback
	}
	const maxUnbroken = 30
	natural := make([]int, numCols)
	minWord := make([]int, numCols)
	for i := 0; i < numCols; i++ {
		text := m.renderInline(t.header[i], sc)
		natural[i] = tuiwidth.VisibleWidth(text)
		minWord[i] = max(1, longestWordWidth(text, maxUnbroken))
	}
	for _, row := range t.rows {
		for i := 0; i < len(row) && i < numCols; i++ {
			text := m.renderInline(row[i], sc)
			natural[i] = max(natural[i], tuiwidth.VisibleWidth(text))
			minWord[i] = max(minWord[i], longestWordWidth(text, maxUnbroken))
		}
	}
	minCols := append([]int{}, minWord...)
	sum := func(xs []int) int {
		s := 0
		for _, x := range xs {
			s += x
		}
		return s
	}
	minCells := sum(minCols)
	if minCells > forCells {
		for i := range minCols {
			minCols[i] = 1
		}
		remaining := forCells - numCols
		if remaining > 0 {
			total := 0
			for _, w := range minWord {
				total += max(0, w-1)
			}
			allocated := 0
			for i, w := range minWord {
				grow := 0
				if total > 0 {
					grow = int(float64(max(0, w-1)) / float64(total) * float64(remaining))
				}
				minCols[i] += grow
				allocated += grow
			}
			leftover := remaining - allocated
			for i := 0; leftover > 0 && i < numCols; i++ {
				minCols[i]++
				leftover--
			}
		}
		minCells = sum(minCols)
	}
	var widths []int
	if sum(natural)+overhead <= available {
		widths = make([]int, numCols)
		for i := range natural {
			widths[i] = max(natural[i], minCols[i])
		}
	} else {
		potential := 0
		for i := range natural {
			potential += max(0, natural[i]-minCols[i])
		}
		extra := max(0, forCells-minCells)
		widths = make([]int, numCols)
		for i := range minCols {
			grow := 0
			if potential > 0 {
				grow = int(float64(max(0, natural[i]-minCols[i])) / float64(potential) * float64(extra))
			}
			widths[i] = minCols[i] + grow
		}
		remaining := forCells - sum(widths)
		for remaining > 0 {
			grew := false
			for i := 0; i < numCols && remaining > 0; i++ {
				if widths[i] < natural[i] {
					widths[i]++
					remaining--
					grew = true
				}
			}
			if !grew {
				break
			}
		}
	}
	border := func(left, mid, right string) string {
		cells := make([]string, numCols)
		for i, w := range widths {
			cells[i] = strings.Repeat("─", w)
		}
		return left + "─" + strings.Join(cells, "─"+mid+"─") + "─" + right
	}
	lines = append(lines, border("┌", "┬", "┐"))
	cellLines := func(cells [][]inlineToken) [][]string {
		out := make([][]string, len(cells))
		for i, c := range cells {
			w := 1
			if i < numCols {
				w = widths[i]
			}
			out[i] = wrapCell(m.renderInline(c, sc), w, prefix)
		}
		return out
	}
	emit := func(cells [][]string, bold bool) {
		count := 0
		for _, c := range cells {
			count = max(count, len(c))
		}
		for li := 0; li < count; li++ {
			parts := make([]string, len(cells))
			for ci, c := range cells {
				text := ""
				if li < len(c) {
					text = c[li]
				}
				w := 0
				if ci < numCols {
					w = widths[ci]
				}
				padded := text + strings.Repeat(" ", max(0, w-tuiwidth.VisibleWidth(text)))
				if bold {
					padded = m.theme.Bold(padded)
				}
				parts[ci] = padded
			}
			lines = append(lines, "│ "+strings.Join(parts, " │ ")+" │")
		}
	}
	emit(cellLines(t.header), true)
	separator := border("├", "┼", "┤")
	lines = append(lines, separator)
	for ri, row := range t.rows {
		emit(cellLines(row), false)
		if ri < len(t.rows)-1 {
			lines = append(lines, separator)
		}
	}
	lines = append(lines, border("└", "┴", "┘"))
	if next != "" && next != "space" {
		lines = append(lines, "")
	}
	return lines
}
