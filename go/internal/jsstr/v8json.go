package jsstr

// JSON.parse with V8's SyntaxError texts (moved from browsersearch, where
// settings files and worker lines need them; hypa's MCP bridge reports them
// too).

import "fmt"

// V8JSONError returns V8's JSON.parse error message for text, or "" when
// text is valid JSON.
func V8JSONError(text string) string {
	p := &v8parser{src: []rune(text)}
	p.skipWS()
	if p.value("") {
		p.skipWS()
		if p.pos < len(p.src) {
			line, col := p.lineCol(p.pos)
			p.err = fmt.Sprintf("Unexpected non-whitespace character after JSON at position %d (line %d column %d)", p.pos, line, col)
		}
	}
	return p.err
}

type v8parser struct {
	src []rune
	pos int
	err string
}

const v8ContextChars = 10

func (p *v8parser) lineCol(pos int) (int, int) {
	line, col := 1, 1
	for i := 0; i < pos && i < len(p.src); i++ {
		if p.src[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
}

// fail records "<msg> in JSON at position N (line L column C)" (V8 counts in
// UTF-16 units; the inputs here are BMP text, so runes match).
func (p *v8parser) fail(pos int, msg string) {
	if p.err != "" {
		return
	}
	line, col := p.lineCol(pos)
	p.err = fmt.Sprintf("%s in JSON at position %d (line %d column %d)", msg, pos, line, col)
}

// unexpected reports the token at pos without an expectation (V8's
// LookUpErrorMessageForJsonToken).
func (p *v8parser) unexpected(pos int) {
	if p.err != "" {
		return
	}
	if pos >= len(p.src) {
		p.err = "Unexpected end of JSON input"
		return
	}
	c := p.src[pos]
	switch {
	case c == '"':
		p.fail(pos, "Unexpected string")
		return
	case c == '-' || (c >= '0' && c <= '9'):
		p.fail(pos, "Unexpected number")
		return
	}
	source := string(p.src)
	if source == "undefined" || source == "NaN" || source == "Infinity" || source == "[object Object]" {
		p.err = `"` + source + `" is not valid JSON`
		return
	}
	n := len(p.src)
	token := string(c)
	switch {
	case n <= 2*v8ContextChars:
		p.err = fmt.Sprintf("Unexpected token '%s', \"%s\" is not valid JSON", token, source)
	case pos < v8ContextChars:
		p.err = fmt.Sprintf("Unexpected token '%s', \"%s\"... is not valid JSON", token, string(p.src[:pos+v8ContextChars]))
	case pos < n-v8ContextChars:
		p.err = fmt.Sprintf("Unexpected token '%s', ...\"%s\"... is not valid JSON", token, string(p.src[pos-v8ContextChars:pos+v8ContextChars]))
	default:
		p.err = fmt.Sprintf("Unexpected token '%s', ...\"%s\" is not valid JSON", token, string(p.src[pos-v8ContextChars:]))
	}
}

func (p *v8parser) skipWS() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

// expect reports msg at the current token (also at the end of input).
func (p *v8parser) expect(msg string) bool {
	p.fail(p.pos, msg)
	return false
}

func (p *v8parser) value(_ string) bool {
	if p.pos >= len(p.src) {
		p.unexpected(p.pos)
		return false
	}
	switch c := p.src[p.pos]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 't':
		return p.literal("true")
	case c == 'f':
		return p.literal("false")
	case c == 'n':
		return p.literal("null")
	}
	p.unexpected(p.pos)
	return false
}

func (p *v8parser) literal(word string) bool {
	for i, r := range word {
		if p.pos+i >= len(p.src) {
			p.unexpected(len(p.src))
			return false
		}
		if p.src[p.pos+i] != r {
			p.unexpected(p.pos + i)
			return false
		}
	}
	p.pos += len(word)
	return true
}

func isDigit(r rune) bool { return r >= '0' && r <= '9' }

func (p *v8parser) number() bool {
	if p.src[p.pos] == '-' {
		p.pos++
		if p.pos >= len(p.src) || !isDigit(p.src[p.pos]) {
			p.fail(p.pos, "No number after minus sign")
			return false
		}
	}
	if p.src[p.pos] == '0' {
		p.pos++
		if p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.fail(p.pos, "Unexpected number")
			return false
		}
	} else {
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
	}
	if p.pos < len(p.src) && p.src[p.pos] == '.' {
		p.pos++
		if p.pos >= len(p.src) || !isDigit(p.src[p.pos]) {
			p.fail(p.pos, "Unterminated fractional number")
			return false
		}
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
	}
	if p.pos < len(p.src) && (p.src[p.pos] == 'e' || p.src[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.src) && (p.src[p.pos] == '+' || p.src[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.src) || !isDigit(p.src[p.pos]) {
			p.fail(p.pos, "Exponent part is missing a number")
			return false
		}
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
	}
	return true
}

func isHex(r rune) bool {
	return isDigit(r) || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

func (p *v8parser) str() bool {
	p.pos++
	for {
		if p.pos >= len(p.src) {
			p.fail(p.pos, "Unterminated string")
			return false
		}
		c := p.src[p.pos]
		switch {
		case c == '"':
			p.pos++
			return true
		case c < 0x20:
			p.fail(p.pos, "Bad control character in string literal")
			return false
		case c == '\\':
			p.pos++
			if p.pos >= len(p.src) {
				p.fail(p.pos, "Unterminated string")
				return false
			}
			switch p.src[p.pos] {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
				p.pos++
			case 'u':
				for i := 1; i <= 4; i++ {
					if p.pos+i >= len(p.src) || !isHex(p.src[p.pos+i]) {
						p.fail(p.pos+i, "Bad Unicode escape")
						return false
					}
				}
				p.pos += 5
			default:
				p.fail(p.pos, "Bad escaped character")
				return false
			}
		default:
			p.pos++
		}
	}
}

func (p *v8parser) array() bool {
	p.pos++
	p.skipWS()
	if p.pos < len(p.src) && p.src[p.pos] == ']' {
		p.pos++
		return true
	}
	for {
		if !p.value("") {
			return false
		}
		p.skipWS()
		if p.pos < len(p.src) && p.src[p.pos] == ',' {
			p.pos++
			p.skipWS()
			continue
		}
		if p.pos < len(p.src) && p.src[p.pos] == ']' {
			p.pos++
			return true
		}
		return p.expect("Expected ',' or ']' after array element")
	}
}

func (p *v8parser) object() bool {
	p.pos++
	p.skipWS()
	if p.pos < len(p.src) && p.src[p.pos] == '}' {
		p.pos++
		return true
	}
	first := true
	for {
		if p.pos >= len(p.src) || p.src[p.pos] != '"' {
			if first {
				return p.expect("Expected property name or '}'")
			}
			return p.expect("Expected double-quoted property name")
		}
		first = false
		if !p.str() {
			return false
		}
		p.skipWS()
		if p.pos >= len(p.src) || p.src[p.pos] != ':' {
			return p.expect("Expected ':' after property name")
		}
		p.pos++
		p.skipWS()
		if !p.value("") {
			return false
		}
		p.skipWS()
		if p.pos < len(p.src) && p.src[p.pos] == ',' {
			p.pos++
			p.skipWS()
			continue
		}
		if p.pos < len(p.src) && p.src[p.pos] == '}' {
			p.pos++
			return true
		}
		return p.expect("Expected ',' or '}' after property value")
	}
}
