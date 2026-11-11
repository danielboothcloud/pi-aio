package copywidget

// The marked token tree pi-tui's Markdown component renders, rebuilt from
// goldmark's AST.

import (
	"strings"

	"github.com/yuin/goldmark/ast"
	extast "github.com/yuin/goldmark/extension/ast"
)

// token is a marked block token.
type token struct {
	typ      string // space, code, heading, paragraph, text, list, blockquote, hr, html, table
	depth    int
	lang     string
	text     string
	raw      string
	inline   []inlineToken
	ordered  bool
	start    int
	loose    bool
	items    []listItem
	children []*token
	header   [][]inlineToken
	rows     [][][]inlineToken
}

type listItem struct {
	task, checked bool
	tokens        []*token
}

// inlineToken is a marked inline token.
type inlineToken struct {
	typ      string // text, strong, em, codespan, link, br, del, html
	text     string
	href     string
	children []inlineToken
}

// lex is markdownParser.lexer(text) for pi-tui's Markdown.
func lex(markdown string) []*token {
	d := parseMarkdown(markdown)
	return d.blockTokens(d.root)
}

// quoteDepth counts the blockquotes around n.
func quoteDepth(n ast.Node) int {
	depth := 0
	for p := n.Parent(); p != nil; p = p.Parent() {
		if p.Kind() == ast.KindBlockquote {
			depth++
		}
	}
	return depth
}

func (d *document) blockTokens(parent ast.Node) []*token {
	out := []*token{}
	for c := parent.FirstChild(); c != nil; c = c.NextSibling() {
		t := d.blockToken(c)
		if t == nil {
			continue
		}
		// goldmark marks a container's first block as following a blank line.
		if c.HasBlankPreviousLines() && c != parent.FirstChild() {
			out = append(out, &token{typ: "space"})
		}
		out = append(out, t)
	}
	return out
}

func (d *document) blockToken(c ast.Node) *token {
	switch x := c.(type) {
	case *ast.Paragraph:
		return &token{typ: "paragraph", inline: d.inlines(x)}
	case *ast.TextBlock:
		return &token{typ: "text", inline: d.inlines(x)}
	case *ast.Heading:
		return &token{typ: "heading", depth: x.Level, inline: d.inlines(x)}
	case *ast.ThematicBreak:
		return &token{typ: "hr"}
	case *ast.CodeBlock:
		return &token{typ: "code", text: strings.TrimRight(d.segmentsText(x), "\n")}
	case *ast.FencedCodeBlock:
		if d.markedParagraphTail(x) {
			return nil
		}
		code, info := d.fencedCode(x)
		return &token{typ: "code", text: code, lang: info}
	case *ast.Blockquote:
		return &token{typ: "blockquote", children: d.blockTokens(x)}
	case *ast.List:
		t := &token{typ: "list", ordered: x.IsOrdered(), start: x.Start, loose: !x.IsTight}
		for item := x.FirstChild(); item != nil; item = item.NextSibling() {
			li := listItem{tokens: d.blockTokens(item)}
			if first := item.FirstChild(); first != nil {
				if box, ok := first.FirstChild().(*extast.TaskCheckBox); ok {
					li.task, li.checked = true, box.IsChecked
				}
			}
			t.items = append(t.items, li)
		}
		return t
	case *ast.HTMLBlock:
		raw := d.segmentsText(x)
		if x.HasClosure() {
			raw += string(x.ClosureLine.Value(d.src))
		}
		return &token{typ: "html", raw: raw}
	case *extast.Table:
		t := &token{typ: "table"}
		if start, stop, ok := span(x); ok {
			var raw []string
			depth := quoteDepth(x)
			for i := d.lineOf(start); i <= d.lineOf(max(start, stop-1)); i++ {
				line := d.line(i)
				for k := 0; k < depth; k++ {
					line = quoteMarkerRe.ReplaceAllString(line, "")
				}
				raw = append(raw, line)
			}
			t.raw = strings.Join(raw, "\n")
		}
		for row := x.FirstChild(); row != nil; row = row.NextSibling() {
			var cells [][]inlineToken
			for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
				cells = append(cells, d.inlines(cell))
			}
			if _, ok := row.(*extast.TableHeader); ok {
				t.header = cells
			} else {
				t.rows = append(t.rows, cells)
			}
		}
		return t
	}
	return nil
}

// plainText is the text of an inline subtree.
func plainText(tokens []inlineToken) string {
	var b strings.Builder
	for _, t := range tokens {
		if len(t.children) > 0 {
			b.WriteString(plainText(t.children))
		} else {
			b.WriteString(t.text)
		}
	}
	return b.String()
}

func (d *document) inlines(n ast.Node) []inlineToken {
	out := []inlineToken{}
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		switch x := c.(type) {
		case *ast.Text:
			value := string(x.Segment.Value(d.src))
			if x.SoftLineBreak() {
				// marked keeps the spaces before a soft break.
				end := x.Segment.Stop
				for end < len(d.src) && (d.src[end] == ' ' || d.src[end] == '\t') {
					end++
				}
				value += string(d.src[x.Segment.Stop:end]) + "\n"
			}
			if x.IsRaw() {
				out = appendText(out, value)
			} else {
				// marked lexes a backslash escape as its own token.
				last := 0
				for _, m := range punctEscapeRe.FindAllStringSubmatchIndex(value, -1) {
					out = appendText(out, value[last:m[0]])
					out = append(out, inlineToken{typ: "escape", text: value[m[2]:m[3]]})
					last = m[1]
				}
				out = appendText(out, value[last:])
			}
			if x.HardLineBreak() {
				out = append(out, inlineToken{typ: "br"})
			}
		case *ast.String:
			out = appendText(out, string(x.Value))
		case *ast.CodeSpan:
			var b strings.Builder
			for t := x.FirstChild(); t != nil; t = t.NextSibling() {
				switch s := t.(type) {
				case *ast.Text:
					b.Write(s.Segment.Value(d.src))
				case *ast.String:
					b.Write(s.Value)
				}
			}
			out = append(out, inlineToken{typ: "codespan", text: strings.ReplaceAll(b.String(), "\n", " ")})
		case *ast.Emphasis:
			typ := "em"
			if x.Level >= 2 {
				typ = "strong"
			}
			out = append(out, inlineToken{typ: typ, children: d.inlines(x)})
		case *ast.Link:
			children := d.inlines(x)
			text := plainText(children)
			out = append(out, inlineToken{typ: "link", href: string(x.Destination), text: text, children: children})
		case *ast.AutoLink:
			label := string(x.Label(d.src))
			href := string(x.URL(d.src))
			if x.AutoLinkType == ast.AutoLinkEmail && !strings.HasPrefix(href, "mailto:") {
				href = "mailto:" + href
			}
			out = append(out, inlineToken{typ: "link", href: href, text: label, children: []inlineToken{{typ: "text", text: label}}})
		case *ast.Image:
			out = append(out, inlineToken{typ: "image", text: plainText(d.inlines(x))})
		case *ast.RawHTML:
			var b strings.Builder
			for i := 0; i < x.Segments.Len(); i++ {
				s := x.Segments.At(i)
				b.Write(s.Value(d.src))
			}
			out = append(out, inlineToken{typ: "html", text: b.String()})
		case *extast.Strikethrough:
			children := d.inlines(x)
			if d.doubleTilde(x) {
				out = append(out, inlineToken{typ: "del", children: children})
			} else {
				// pi-tui's strict tokenizer strikes only ~~text~~.
				out = appendText(out, "~")
				for _, c := range children {
					if c.typ == "text" && len(c.children) == 0 {
						out = appendText(out, c.text)
					} else {
						out = append(out, c)
					}
				}
				out = appendText(out, "~")
			}
		case *extast.TaskCheckBox:
		default:
			out = append(out, d.inlines(c)...)
		}
	}
	return out
}

// appendText adds text, merged into a preceding text token as marked does.
func appendText(out []inlineToken, text string) []inlineToken {
	if text == "" {
		return out
	}
	if n := len(out); n > 0 && out[n-1].typ == "text" && len(out[n-1].children) == 0 {
		out[n-1].text += text
		return out
	}
	return append(out, inlineToken{typ: "text", text: text})
}

// doubleTilde reports a strikethrough written with ~~.
func (d *document) doubleTilde(n ast.Node) bool {
	start, _, ok := span(n)
	return ok && start >= 2 && d.src[start-1] == '~' && d.src[start-2] == '~'
}
