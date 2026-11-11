package copywidget

// Port of picker.ts: the CopyBlockPicker overlay and its preview.

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

const (
	maxVisibleItems   = 6
	maxPreviewLines   = 8
	quoteSnippetChars = 40
)

func longestRun(text string, char rune) int {
	longest, current := 0, 0
	for _, r := range text {
		if r == char {
			current++
			longest = max(longest, current)
		} else {
			current = 0
		}
	}
	return longest
}

// asFencedMarkdown ports asFencedMarkdown.
func asFencedMarkdown(b Block) string {
	backticks := max(3, longestRun(b.Text, '`')+1)
	tildes := max(3, longestRun(b.Text, '~')+1)
	fence := strings.Repeat("`", backticks)
	if backticks > tildes {
		fence = strings.Repeat("~", tildes)
	}
	code := b.Text
	if !strings.HasSuffix(code, "\n") {
		code += "\n"
	}
	return fence + b.Language + "\n" + code + fence
}

// asQuotedMarkdown ports asQuotedMarkdown.
func asQuotedMarkdown(b Block) string {
	lines := strings.Split(b.Text, "\n")
	for i, l := range lines {
		if l == "" {
			lines[i] = ">"
		} else {
			lines[i] = "> " + l
		}
	}
	return strings.Join(lines, "\n")
}

// PreviewMarkdown ports previewMarkdown.
func PreviewMarkdown(b Block) string {
	if b.Kind == "quote" {
		return asQuotedMarkdown(b)
	}
	return asFencedMarkdown(b)
}

var spacesRe = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

func quoteSnippet(text string) string {
	flat := jsstr.Trim(spacesRe.ReplaceAllString(text, " "))
	if jsstr.Len16(flat) > quoteSnippetChars {
		return jsstr.TrimEnd(jsstr.Slice(flat, 0, quoteSnippetChars-1)) + "…"
	}
	return flat
}

// BlockLabel ports blockLabel.
func BlockLabel(b Block) string {
	if b.Kind == "quote" {
		words := len(strings.FieldsFunc(b.Text, jsstr.IsJSSpace))
		return "#" + strconv.Itoa(b.Ordinal) + " · quote · " + chrome.Plural(words, "word") + " · " + quoteSnippet(b.Text)
	}
	lang := b.Language
	if lang == "" {
		lang = "plain text"
	}
	unit := "lines"
	if b.LineCount == 1 {
		unit = "line"
	}
	return "#" + strconv.Itoa(b.Ordinal) + " · " + lang + " · " + strconv.Itoa(b.LineCount) + " " + unit
}

// PickerOptions configure a Picker.
type PickerOptions struct {
	Blocks []Block
	Theme  chrome.Theme
	// MaxRows is getMaxRows(): floor(terminal rows * 0.9).
	MaxRows func() int
	// Matches is pi-tui's matchesKey(data, keyId).
	Matches func(data, keyID string) bool
	// Markdown is getMarkdownTheme() for the preview.
	Markdown MarkdownTheme
	// RequestRender is tui.requestRender (optional).
	RequestRender func()
}

// Picker ports CopyBlockPicker.
type Picker struct {
	o        PickerOptions
	selected int
	done     bool
	result   *Block
}

// NewPicker returns a picker with the first block selected.
func NewPicker(o PickerOptions) *Picker { return &Picker{o: o} }

// Done reports whether the picker finished, and the chosen block (nil for
// a cancel).
func (p *Picker) Done() (*Block, bool) { return p.result, p.done }

func (p *Picker) maxRows() int { return max(1, p.o.MaxRows()) }

func (p *Picker) visibleItemCount() int {
	maxRows := p.maxRows()
	visible := min(maxVisibleItems, len(p.o.Blocks))
	for visible > 1 {
		fixed := 6
		if len(p.o.Blocks) > visible {
			fixed++
		}
		if maxRows-fixed-visible >= 1 {
			break
		}
		visible--
	}
	return visible
}

func (p *Picker) finish(b *Block) {
	p.done, p.result = true, b
}

// HandleInput ports handleInput.
func (p *Picker) HandleInput(data string) {
	if p.o.Matches(data, "escape") || p.o.Matches(data, "ctrl+c") || data == "q" {
		p.finish(nil)
		return
	}
	if p.o.Matches(data, "enter") {
		if p.selected < len(p.o.Blocks) {
			b := p.o.Blocks[p.selected]
			p.finish(&b)
		} else {
			p.finish(nil)
		}
		return
	}
	visible := p.visibleItemCount()
	next := p.selected
	switch {
	case p.o.Matches(data, "up") || data == "k":
		next--
	case p.o.Matches(data, "down") || data == "j":
		next++
	case p.o.Matches(data, "pageUp") || p.o.Matches(data, "ctrl+u"):
		next -= visible
	case p.o.Matches(data, "pageDown") || p.o.Matches(data, "ctrl+d"):
		next += visible
	case data == "g":
		next = 0
	case data == "G":
		next = len(p.o.Blocks) - 1
	default:
		return
	}
	p.selected = max(0, min(len(p.o.Blocks)-1, next))
	if p.o.RequestRender != nil {
		p.o.RequestRender()
	}
}

// Render ports render(width).
func (p *Picker) Render(width int) []string {
	t := p.o.Theme
	if width <= 4 {
		return []string{tuiwidth.TruncateToWidth("Copy block", max(0, width), "", false)}
	}
	inner := width - 4
	row := func(content string) string { return chrome.FrameRow(t, content, width) }
	maxRows := p.maxRows()
	var selected *Block
	if p.selected >= 0 && p.selected < len(p.o.Blocks) {
		selected = &p.o.Blocks[p.selected]
	}
	noneRow := func() string { return row(" " + t.Fg("warning", "No block selected")) }
	if maxRows < 9 {
		top := chrome.FrameRule(t, width, "top", "")
		bottom := chrome.FrameRule(t, width, "bottom", "")
		header := row(chrome.Header(t, chrome.HeaderOptions{Title: "copy", Meta: chrome.Plural(len(p.o.Blocks), "block")}, inner))
		item := noneRow()
		if selected != nil {
			item = row(chrome.Item(t, chrome.ItemOptions{Label: BlockLabel(*selected), Active: true, Marker: "›", Indent: chrome.Indent(0)}, inner))
		}
		help := row(chrome.Hint(t, "j/k move · Enter copy · q cancel", inner, 0))
		switch maxRows {
		case 1:
			return []string{item}
		case 2:
			return []string{item, help}
		case 3:
			return []string{item, help, bottom}
		case 4:
			return []string{header, item, help, bottom}
		}
		return []string{top, header, item, help, bottom}
	}
	lines := []string{chrome.FrameRule(t, width, "top", "")}
	lines = append(lines, row(chrome.Header(t, chrome.HeaderOptions{Title: "copy", Meta: chrome.Plural(len(p.o.Blocks), "block") + " in last response"}, inner)))
	visible := p.visibleItemCount()
	offset := min(max(0, len(p.o.Blocks)-visible), max(0, p.selected-visible/2))
	for i := offset; i < offset+visible && i < len(p.o.Blocks); i++ {
		active := i == p.selected
		marker := "·"
		if active {
			marker = "›"
		}
		lines = append(lines, row(chrome.Item(t, chrome.ItemOptions{Label: BlockLabel(p.o.Blocks[i]), Active: active, Marker: marker, Indent: chrome.Indent(0)}, inner)))
	}
	if len(p.o.Blocks) > visible {
		lines = append(lines, row(" "+t.Fg("dim", "Showing "+strconv.Itoa(offset+1)+"-"+strconv.Itoa(offset+visible)+" of "+strconv.Itoa(len(p.o.Blocks)))))
	}
	lines = append(lines, chrome.FrameRule(t, width, "divider", ""))
	if selected == nil {
		lines = append(lines, noneRow())
		return append(lines, chrome.FrameRule(t, width, "bottom", ""))
	}
	lines = append(lines, row(chrome.Header(t, chrome.HeaderOptions{Title: "preview", Meta: BlockLabel(*selected), Tone: "muted"}, inner)))
	preview := RenderMarkdown(PreviewMarkdown(*selected), 1, 0, inner, p.o.Markdown)
	capacity := max(0, min(maxPreviewLines, maxRows-len(lines)-2))
	shown := append([]string{}, preview[:min(capacity, len(preview))]...)
	if len(preview) > capacity && capacity > 0 {
		shown[capacity-1] = " " + t.Fg("dim", "… "+strconv.Itoa(len(preview)-capacity+1)+" more rendered lines")
	}
	for _, l := range shown {
		lines = append(lines, row(l))
	}
	lines = append(lines, row(chrome.Hint(t, "j/k move · Ctrl+u/d jump · g/G ends · Enter copy · q cancel", inner, 0)))
	return append(lines, chrome.FrameRule(t, width, "bottom", ""))
}
