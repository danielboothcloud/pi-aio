// Package copywidget is the Go port of copy-widget/: /pick and ctrl+p list
// the fenced code blocks and top-level block quotes of the last assistant
// response and copy the chosen one. TypeScript lexes Markdown with marked;
// this port parses it with goldmark and rebuilds marked's results (golden-
// checked against the real parse.ts). This package does not import the PiG
// SDK; key matching, highlighting, and the clipboard are injected.
package copywidget

import (
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Block is CopyableBlock. Info and Language are empty when absent.
type Block struct {
	Kind      string `json:"kind"` // "code" or "quote"
	Text      string `json:"text"`
	Info      string `json:"info,omitempty"`
	Language  string `json:"language,omitempty"`
	LineCount int    `json:"lineCount"`
	Ordinal   int    `json:"ordinal"`
}

// document is one goldmark parse with its source and line starts.
type document struct {
	src   []byte
	root  ast.Node
	lines []int // byte offset of each line start
}

// parseMarkdown parses GitHub-flavored Markdown as marked's default lexer
// does: carriage returns become newlines first.
func parseMarkdown(markdown string) *document {
	src := []byte(strings.ReplaceAll(strings.ReplaceAll(markdown, "\r\n", "\n"), "\r", "\n"))
	md := goldmark.New(goldmark.WithExtensions(extension.GFM))
	root := md.Parser().Parse(text.NewReader(src))
	lines := []int{0}
	for i, b := range src {
		if b == '\n' {
			lines = append(lines, i+1)
		}
	}
	return &document{src: src, root: root, lines: lines}
}

// lineOf is the index of the line that holds byte offset.
func (d *document) lineOf(offset int) int {
	lo, hi := 0, len(d.lines)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if d.lines[mid] <= offset {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo
}

// line is the text of line i without its newline.
func (d *document) line(i int) string {
	end := len(d.src)
	if i+1 < len(d.lines) {
		end = d.lines[i+1] - 1
	}
	return string(d.src[d.lines[i]:end])
}

// span is the byte range of the source text a node and its descendants
// cover; ok=false when they have none.
func span(n ast.Node) (start, stop int, ok bool) {
	start, stop = -1, -1
	add := func(s text.Segment) {
		if s.Stop < s.Start {
			return
		}
		if start < 0 || s.Start < start {
			start = s.Start
		}
		if s.Stop > stop {
			stop = s.Stop
		}
	}
	_ = ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if c.Type() == ast.TypeBlock {
			lines := c.Lines()
			for i := 0; i < lines.Len(); i++ {
				add(lines.At(i))
			}
		}
		switch x := c.(type) {
		case *ast.Text:
			add(x.Segment)
		case *ast.FencedCodeBlock:
			if x.Info != nil {
				add(x.Info.Segment)
			}
		case *ast.RawHTML:
			for i := 0; i < x.Segments.Len(); i++ {
				add(x.Segments.At(i))
			}
		case *ast.HTMLBlock:
			if x.HasClosure() {
				add(x.ClosureLine)
			}
		}
		return ast.WalkContinue, nil
	})
	return start, stop, start >= 0
}

var (
	fencedStartRe = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
	hardBreakRe   = regexp.MustCompile(`( {2,}|\\)$`)
	quoteLineRe   = regexp.MustCompile(`^[ \t]*>`)
	quoteMarkerRe = regexp.MustCompile(`^[ \t]*>[ \t]?`)
	punctEscapeRe = regexp.MustCompile("\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]^_`{|}~])")
)

func countLines(s string) int {
	if s == "" {
		return 0
	}
	return len(strings.Split(s, "\n"))
}

// segmentsText concatenates a block's line segments.
func (d *document) segmentsText(n ast.Node) string {
	var b strings.Builder
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		s := lines.At(i)
		b.Write(s.Value(d.src))
	}
	return b.String()
}

// fencedCode is the text and info of a fenced code token.
func (d *document) fencedCode(n *ast.FencedCodeBlock) (code, info string) {
	code = strings.TrimSuffix(d.segmentsText(n), "\n")
	if n.Info != nil {
		info = jsstr.Trim(punctEscapeRe.ReplaceAllString(string(n.Info.Segment.Value(d.src)), "$1"))
	}
	return code, info
}

func language(info string) string {
	fields := strings.FieldsFunc(jsstr.Trim(info), jsstr.IsJSSpace)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// quoteBody is the blockquote's source with one level of `>` markers
// removed: the text marked lexes as the quote's tokens.
func (d *document) quoteBody(n ast.Node) (string, bool) {
	start, stop, ok := span(n)
	if !ok {
		return "", false
	}
	first, last := d.lineOf(start), d.lineOf(max(start, stop-1))
	for first > 0 && quoteLineRe.MatchString(d.line(first-1)) {
		first--
	}
	for last+1 < len(d.lines) && quoteLineRe.MatchString(d.line(last+1)) {
		last++
	}
	body := make([]string, 0, last-first+1)
	for i := first; i <= last; i++ {
		line := d.line(i)
		if quoteLineRe.MatchString(line) {
			line = quoteMarkerRe.ReplaceAllString(line, "")
		}
		body = append(body, line)
	}
	return strings.Join(body, "\n"), true
}

// unwrapParagraph ports unwrapParagraph: soft-wrapped lines join with a
// space; hard breaks stay as newlines without their markers.
func unwrapParagraph(lines []string) string {
	result := lines[0]
	for _, line := range lines[1:] {
		if hardBreakRe.MatchString(result) {
			result = hardBreakRe.ReplaceAllString(result, "") + "\n" + strings.TrimLeftFunc(line, jsstr.IsJSSpace)
		} else {
			result = jsstr.TrimEnd(result) + " " + strings.TrimLeftFunc(line, jsstr.IsJSSpace)
		}
	}
	return result
}

// quoteText ports quoteText: the quote body with its top-level paragraphs
// unwrapped, trimmed.
func quoteText(body string) string {
	d := parseMarkdown(body)
	lines := strings.Split(string(d.src), "\n")
	out := make([]string, 0, len(lines))
	next := 0
	for c := d.root.FirstChild(); c != nil; c = c.NextSibling() {
		if c.Kind() != ast.KindParagraph {
			continue
		}
		start, stop, ok := span(c)
		if !ok {
			continue
		}
		first, last := d.lineOf(start), d.lineOf(max(start, stop-1))
		if first < next {
			continue
		}
		out = append(out, lines[next:first]...)
		out = append(out, unwrapParagraph(lines[first:last+1]))
		next = last + 1
	}
	out = append(out, lines[next:]...)
	return jsstr.Trim(strings.Join(out, "\n"))
}

func (d *document) collect(n ast.Node, blocks *[]Block, includeQuotes, insideQuote bool) {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		switch x := c.(type) {
		case *ast.FencedCodeBlock:
			if d.markedParagraphTail(x) {
				continue
			}
			code, info := d.fencedCode(x)
			*blocks = append(*blocks, Block{Kind: "code", Text: code, Info: info, Language: language(info), LineCount: countLines(code), Ordinal: len(*blocks) + 1})
		case *ast.Blockquote:
			if includeQuotes && !insideQuote {
				if body, ok := d.quoteBody(x); ok {
					if t := quoteText(body); t != "" {
						*blocks = append(*blocks, Block{Kind: "quote", Text: t, LineCount: countLines(t), Ordinal: len(*blocks) + 1})
					}
				}
			}
			d.collect(c, blocks, includeQuotes, true)
			continue
		}
		if c.Type() == ast.TypeBlock {
			d.collect(c, blocks, includeQuotes, insideQuote)
		}
	}
}

func extract(markdown string, includeQuotes bool) []Block {
	blocks := []Block{}
	if jsstr.Trim(markdown) == "" {
		return blocks
	}
	d := parseMarkdown(markdown)
	d.collect(d.root, &blocks, includeQuotes, false)
	return blocks
}

// ExtractFencedCodeBlocks ports extractFencedCodeBlocks.
func ExtractFencedCodeBlocks(markdown string) []Block { return extract(markdown, false) }

// ExtractCopyableBlocks ports extractCopyableBlocks: fenced code blocks and
// top-level block quotes in source order.
func ExtractCopyableBlocks(markdown string) []Block { return extract(markdown, true) }

// markedParagraphTail reports an empty backtick fence on the last line,
// without a newline, right after a paragraph. marked lets a backtick fence
// interrupt a paragraph only when a newline follows it, so the line stays
// paragraph text there; CommonMark (goldmark) opens an empty code block.
func (d *document) markedParagraphTail(n *ast.FencedCodeBlock) bool {
	if n.Lines().Len() > 0 || n.HasBlankPreviousLines() || len(d.src) == 0 || d.src[len(d.src)-1] == '\n' {
		return false
	}
	prev, ok := n.PreviousSibling().(*ast.Paragraph)
	if !ok {
		return false
	}
	_, stop, ok := span(prev)
	if !ok {
		return false
	}
	last := len(d.lines) - 1
	m := fencedStartRe.FindStringSubmatch(d.line(last))
	return d.lineOf(max(0, stop-1))+1 == last && m != nil && m[1][0] == '`'
}
