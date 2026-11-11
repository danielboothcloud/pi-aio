package yamlhooks

// Port of minimatch's ast.js and brace-expressions.js (parseClass): one
// path segment of a glob to a regular expression source. Extglobs
// (@ ! ? + *) are supported, including the "!(...)" negation tails.

import (
	"regexp"
	"strings"

	"github.com/dlclark/regexp2"
)

type globAST struct {
	typ         byte // 0 for a plain sequence, else one of ! ? + * @
	root        *globAST
	parent      *globAST
	parentIndex int
	parts       []any // string or *globAST
	hasMagic    *bool
	negs        []*globAST
	filledNegs  bool
	emptyExt    bool
}

func newGlobAST(typ byte, parent *globAST) *globAST {
	a := &globAST{typ: typ, parent: parent}
	if typ != 0 {
		t := true
		a.hasMagic = &t
	}
	if parent != nil {
		a.root = parent.root
		a.parentIndex = len(parent.parts)
	} else {
		a.root = a
	}
	if typ == '!' && !a.root.filledNegs {
		a.root.negs = append(a.root.negs, a)
	}
	return a
}

func isExtglobType(c byte) bool { return c == '!' || c == '?' || c == '+' || c == '*' || c == '@' }

func (a *globAST) push(parts ...any) {
	for _, p := range parts {
		if s, ok := p.(string); ok && s == "" {
			continue
		}
		a.parts = append(a.parts, p)
	}
}

func (a *globAST) String() string {
	var b strings.Builder
	if a.typ == 0 {
		for _, p := range a.parts {
			b.WriteString(partString(p))
		}
		return b.String()
	}
	b.WriteByte(a.typ)
	b.WriteByte('(')
	for i, p := range a.parts {
		if i > 0 {
			b.WriteByte('|')
		}
		b.WriteString(partString(p))
	}
	b.WriteByte(')')
	return b.String()
}

func partString(p any) string {
	if s, ok := p.(string); ok {
		return s
	}
	return p.(*globAST).String()
}

func (a *globAST) isStart() bool {
	if a.root == a {
		return true
	}
	if !a.parent.isStart() {
		return false
	}
	if a.parentIndex == 0 {
		return true
	}
	for i := 0; i < a.parentIndex && i < len(a.parent.parts); i++ {
		pp, ok := a.parent.parts[i].(*globAST)
		if !ok || pp.typ != '!' {
			return false
		}
	}
	return true
}

func (a *globAST) isEnd() bool {
	if a.root == a {
		return true
	}
	if a.parent.typ == '!' {
		return true
	}
	if !a.parent.isEnd() {
		return false
	}
	if a.typ == 0 {
		return a.parent.isEnd()
	}
	return a.parentIndex == len(a.parent.parts)-1
}

func (a *globAST) copyIn(p any) {
	if s, ok := p.(string); ok {
		a.push(s)
		return
	}
	a.push(p.(*globAST).clone(a))
}

func (a *globAST) clone(parent *globAST) *globAST {
	c := newGlobAST(a.typ, parent)
	for _, p := range a.parts {
		c.copyIn(p)
	}
	return c
}

func astFromGlob(pattern string) *globAST {
	a := newGlobAST(0, nil)
	parseGlobAST(pattern, a, 0, 0)
	return a
}

func (a *globAST) canAdoptType(c byte, m map[byte]string) bool {
	return strings.IndexByte(m[a.typ], c) >= 0
}

var (
	adoptionMap          = map[byte]string{'!': "@", '?': "?@", '@': "@", '*': "*+?@", '+': "+@"}
	adoptionWithSpaceMap = map[byte]string{'!': "?", '@': "?", '+': "?*"}
	adoptionAnyMap       = map[byte]string{'!': "?@", '?': "?@", '@': "?@", '*': "*+?@", '+': "+@?*"}
	usurpMap             = map[byte]map[byte]byte{
		'!': {'!': '@'},
		'?': {'*': '*', '+': '*'},
		'@': {'!': '!', '?': '?', '@': '@', '*': '*', '+': '+'},
		'+': {'?': '*', '*': '*'},
	}
)

func parseGlobAST(str string, ast *globAST, pos, extDepth int) int {
	const maxDepth = 2
	escaping, inBrace, braceNeg := false, false, false
	braceStart := -1
	if ast.typ == 0 {
		i := pos
		acc := ""
		for i < len(str) {
			c := str[i]
			i++
			if escaping || c == '\\' {
				escaping = !escaping
				acc += string(c)
				continue
			}
			if inBrace {
				if i == braceStart+1 {
					if c == '^' || c == '!' {
						braceNeg = true
					}
				} else if c == ']' && !(i == braceStart+2 && braceNeg) {
					inBrace = false
				}
				acc += string(c)
				continue
			} else if c == '[' {
				inBrace, braceStart, braceNeg = true, i, false
				acc += string(c)
				continue
			}
			if isExtglobType(c) && i < len(str) && str[i] == '(' && extDepth <= maxDepth {
				ast.push(acc)
				acc = ""
				ext := newGlobAST(c, ast)
				i = parseGlobAST(str, ext, i, extDepth+1)
				ast.push(ext)
				continue
			}
			acc += string(c)
		}
		ast.push(acc)
		return i
	}
	i := pos + 1
	part := newGlobAST(0, ast)
	var parts []any
	acc := ""
	for i < len(str) {
		c := str[i]
		i++
		if escaping || c == '\\' {
			escaping = !escaping
			acc += string(c)
			continue
		}
		if inBrace {
			if i == braceStart+1 {
				if c == '^' || c == '!' {
					braceNeg = true
				}
			} else if c == ']' && !(i == braceStart+2 && braceNeg) {
				inBrace = false
			}
			acc += string(c)
			continue
		} else if c == '[' {
			inBrace, braceStart, braceNeg = true, i, false
			acc += string(c)
			continue
		}
		if isExtglobType(c) && i < len(str) && str[i] == '(' && (extDepth <= maxDepth || ast.canAdoptType(c, adoptionAnyMap)) {
			depthAdd := 1
			if ast.canAdoptType(c, adoptionAnyMap) {
				depthAdd = 0
			}
			part.push(acc)
			acc = ""
			ext := newGlobAST(c, part)
			part.push(ext)
			i = parseGlobAST(str, ext, i, extDepth+depthAdd)
			continue
		}
		if c == '|' {
			part.push(acc)
			acc = ""
			parts = append(parts, part)
			part = newGlobAST(0, ast)
			continue
		}
		if c == ')' {
			if acc == "" && len(ast.parts) == 0 {
				ast.emptyExt = true
			}
			part.push(acc)
			acc = ""
			ast.push(append(parts, part)...)
			return i
		}
		acc += string(c)
	}
	ast.typ = 0
	ast.hasMagic = nil
	ast.parts = []any{str[pos-1:]}
	return i
}

func (a *globAST) canAdopt(child any, m map[byte]string) bool {
	c, ok := child.(*globAST)
	if !ok || c.typ != 0 || len(c.parts) != 1 || a.typ == 0 {
		return false
	}
	gc, ok := c.parts[0].(*globAST)
	if !ok || gc.typ == 0 {
		return false
	}
	return a.canAdoptType(gc.typ, m)
}

func (a *globAST) adopt(child *globAST, index int) {
	gc := child.parts[0].(*globAST)
	newParts := append([]any{}, a.parts[:index]...)
	newParts = append(newParts, gc.parts...)
	newParts = append(newParts, a.parts[index+1:]...)
	a.parts = newParts
	for _, p := range gc.parts {
		if g, ok := p.(*globAST); ok {
			g.parent = a
		}
	}
}

func (a *globAST) adoptWithSpace(child *globAST, index int) {
	gc := child.parts[0].(*globAST)
	blank := newGlobAST(0, gc)
	blank.parts = append(blank.parts, "")
	gc.push(blank)
	a.adopt(child, index)
}

func (a *globAST) canUsurp(child any) bool {
	c, ok := child.(*globAST)
	if !ok || c.typ != 0 || len(c.parts) != 1 || a.typ == 0 || len(a.parts) != 1 {
		return false
	}
	gc, ok := c.parts[0].(*globAST)
	if !ok || gc.typ == 0 {
		return false
	}
	_, ok = usurpMap[a.typ][gc.typ]
	return ok
}

func (a *globAST) usurp(child *globAST) {
	gc := child.parts[0].(*globAST)
	nt := usurpMap[a.typ][gc.typ]
	a.parts = gc.parts
	for _, p := range a.parts {
		if g, ok := p.(*globAST); ok {
			g.parent = a
		}
	}
	a.typ = nt
	a.emptyExt = false
}

func (a *globAST) flatten() {
	if a.typ == 0 {
		for _, p := range a.parts {
			if g, ok := p.(*globAST); ok {
				g.flatten()
			}
		}
		return
	}
	for iterations := 0; iterations < 10; iterations++ {
		done := true
		for i := 0; i < len(a.parts); i++ {
			c, ok := a.parts[i].(*globAST)
			if !ok {
				continue
			}
			c.flatten()
			if a.canAdopt(c, adoptionMap) {
				done = false
				a.adopt(c, i)
			} else if a.canAdopt(c, adoptionWithSpaceMap) {
				done = false
				a.adoptWithSpace(c, i)
			} else if a.canUsurp(c) {
				done = false
				a.usurp(c)
			}
		}
		if done {
			break
		}
	}
}

func (a *globAST) fillNegs() {
	if a.filledNegs {
		return
	}
	a.filledNegs = true
	for len(a.negs) > 0 {
		n := a.negs[len(a.negs)-1]
		a.negs = a.negs[:len(a.negs)-1]
		if n.typ != '!' {
			continue
		}
		p := n
		pp := p.parent
		for pp != nil {
			for i := p.parentIndex + 1; pp.typ == 0 && i < len(pp.parts); i++ {
				for _, part := range n.parts {
					part.(*globAST).copyIn(pp.parts[i])
				}
			}
			p = pp
			pp = p.parent
		}
	}
}

const (
	startNoTraversal = `(?!(?:^|/)\.\.?(?:$|/))`
	startNoDot       = `(?!\.)`
	globQmark        = `[^/]`
	globStar         = globQmark + `*?`
	globStarNoEmpty  = globQmark + `+?`
)

var regExpEscapeRE = regexp.MustCompile(`[-\[\]{}()*+?.,\\^$|#\s]`)

func regExpEscape(s string) string { return regExpEscapeRE.ReplaceAllString(s, `\$0`) }

var reSpecials = "().*{}+?[]^$\\!"

// toMMPattern returns the regexp source, the unescaped body, whether the
// segment has magic, and whether it needs a regular expression.
func (a *globAST) toMMPattern() (string, string, bool, bool) {
	re, body, magic := a.toRegExpSource(false, false)
	anyMagic := magic || (a.hasMagic != nil && *a.hasMagic)
	return re, body, magic, anyMagic
}

func (a *globAST) toRegExpSource(allowDot, allowDotSet bool) (string, string, bool) {
	_ = allowDotSet
	dot := allowDot
	if a.root == a {
		a.flatten()
		_ = a.String()
		a.fillNegs()
	}
	if a.typ == 0 {
		noEmpty := a.isStart() && a.isEnd()
		for _, p := range a.parts {
			if _, ok := p.(string); !ok {
				noEmpty = false
			}
		}
		var src strings.Builder
		for _, p := range a.parts {
			var re string
			var magic bool
			if s, ok := p.(string); ok {
				re, _, magic = parseGlobString(s, a.hasMagic != nil && *a.hasMagic, noEmpty)
			} else {
				re, _, magic = p.(*globAST).toRegExpSource(allowDot, allowDotSet)
			}
			hm := (a.hasMagic != nil && *a.hasMagic) || magic
			a.hasMagic = &hm
			src.WriteString(re)
		}
		s := src.String()
		start := ""
		if a.isStart() {
			if first, ok := firstPart(a); ok {
				dotTrav := len(a.parts) == 1 && (first == "." || first == "..")
				if !dotTrav {
					aps := func(c byte) bool { return c == '[' || c == '.' }
					needNoTrav := (dot && len(s) > 0 && aps(s[0])) ||
						(strings.HasPrefix(s, `\.`) && len(s) > 2 && aps(s[2])) ||
						(strings.HasPrefix(s, `\.\.`) && len(s) > 4 && aps(s[4]))
					needNoDot := !dot && !allowDot && len(s) > 0 && aps(s[0])
					if needNoTrav {
						start = startNoTraversal
					} else if needNoDot {
						start = startNoDot
					}
				}
			}
		}
		end := ""
		if a.isEnd() && a.root.filledNegs && a.parent != nil && a.parent.typ == '!' {
			end = `(?:$|\/)`
		}
		hm := a.hasMagic != nil && *a.hasMagic
		return start + s + end, globUnescape(s), hm
	}
	repeated := a.typ == '*' || a.typ == '+'
	open := "(?:"
	if a.typ == '!' {
		open = "(?:(?!(?:"
	}
	body := a.partsToRegExp(dot)
	if a.isStart() && a.isEnd() && body == "" && a.typ != '!' {
		s := a.String()
		a.parts = []any{s}
		a.typ = 0
		a.hasMagic = nil
		return s, globUnescape(a.String()), false
	}
	bodyDotAllowed := ""
	if repeated && !allowDot && !dot {
		bodyDotAllowed = a.partsToRegExp(true)
	}
	if bodyDotAllowed == body {
		bodyDotAllowed = ""
	}
	if bodyDotAllowed != "" {
		body = "(?:" + body + ")(?:" + bodyDotAllowed + ")*?"
	}
	final := ""
	if a.typ == '!' && a.emptyExt {
		if a.isStart() && !dot {
			final = startNoDot
		}
		final += globStarNoEmpty
	} else {
		var close string
		switch {
		case a.typ == '!':
			close = "))"
			if a.isStart() && !dot && !allowDot {
				close += startNoDot
			}
			close += globStar + ")"
		case a.typ == '@':
			close = ")"
		case a.typ == '?':
			close = ")?"
		case a.typ == '+' && bodyDotAllowed != "":
			close = ")"
		case a.typ == '*' && bodyDotAllowed != "":
			close = ")?"
		default:
			close = ")" + string(a.typ)
		}
		final = open + body + close
	}
	hm := a.hasMagic != nil && *a.hasMagic
	return final, globUnescape(body), hm
}

func firstPart(a *globAST) (string, bool) {
	if len(a.parts) == 0 {
		return "", false
	}
	s, ok := a.parts[0].(string)
	return s, ok
}

func (a *globAST) partsToRegExp(dot bool) string {
	var out []string
	for _, p := range a.parts {
		re, _, _ := p.(*globAST).toRegExpSource(dot, true)
		if !(a.isStart() && a.isEnd()) || re != "" {
			out = append(out, re)
		}
	}
	return strings.Join(out, "|")
}

var (
	unescapeBracket = regexp2.MustCompile(`((?!\\).|^)\[([^/\\])\]`, regexp2.ECMAScript)
	unescapeSlash   = regexp.MustCompile(`\\([^/])`)
	allStars        = regexp.MustCompile(`^[*]+$`)
)

// globUnescape is minimatch's unescape(s) with its default options (ast.js
// calls it without options).
func globUnescape(s string) string {
	out, err := unescapeBracket.Replace(s, "$1$2", -1, -1)
	if err != nil {
		out = s
	}
	return unescapeSlash.ReplaceAllString(out, "$1")
}

func parseGlobString(glob string, hasMagic, noEmpty bool) (string, string, bool) {
	escaping, inStar := false, false
	var re strings.Builder
	for i := 0; i < len(glob); i++ {
		c := glob[i]
		if escaping {
			escaping = false
			if strings.IndexByte(reSpecials, c) >= 0 {
				re.WriteByte('\\')
			}
			re.WriteByte(c)
			continue
		}
		if c == '*' {
			if inStar {
				continue
			}
			inStar = true
			if noEmpty && allStars.MatchString(glob) {
				re.WriteString(globStarNoEmpty)
			} else {
				re.WriteString(globStar)
			}
			hasMagic = true
			continue
		}
		inStar = false
		if c == '\\' {
			if i == len(glob)-1 {
				re.WriteString(`\\`)
			} else {
				escaping = true
			}
			continue
		}
		if c == '[' {
			src, consumed, magic := parseClass(glob, i)
			if consumed > 0 {
				re.WriteString(src)
				i += consumed - 1
				hasMagic = hasMagic || magic
				continue
			}
		}
		if c == '?' {
			re.WriteString(globQmark)
			hasMagic = true
			continue
		}
		re.WriteString(regExpEscape(string(c)))
	}
	return re.String(), globUnescape(glob), hasMagic
}

var posixClasses = []struct {
	name, unip string
	neg        bool
}{
	{"[:alnum:]", `\p{L}\p{Nl}\p{Nd}`, false},
	{"[:alpha:]", `\p{L}\p{Nl}`, false},
	{"[:ascii:]", `\x00-\x7f`, false},
	{"[:blank:]", `\p{Zs}\t`, false},
	{"[:cntrl:]", `\p{Cc}`, false},
	{"[:digit:]", `\p{Nd}`, false},
	{"[:graph:]", `\p{Z}\p{C}`, true},
	{"[:lower:]", `\p{Ll}`, false},
	{"[:print:]", `\p{C}`, false},
	{"[:punct:]", `\p{P}`, false},
	{"[:space:]", `\p{Z}\t\r\n\v\f`, false},
	{"[:upper:]", `\p{Lu}`, false},
	{"[:word:]", `\p{L}\p{Nl}\p{Nd}\p{Pc}`, false},
	{"[:xdigit:]", `A-Fa-f0-9`, false},
}

var braceEscapeRE = regexp.MustCompile(`[\[\]\\-]`)

func braceEscape(s string) string { return braceEscapeRE.ReplaceAllString(s, `\$0`) }

var singleCharClass = regexp.MustCompile(`^\\?.$`)

// parseClass is brace-expressions.js parseClass over bytes; it returns the
// source, the number of bytes consumed (0 for a literal "["), and magic.
func parseClass(glob string, pos int) (string, int, bool) {
	var ranges, negs []string
	i := pos + 1
	sawStart, escaping, negate := false, false, false
	endPos := pos
	rangeStart := ""
outer:
	for i < len(glob) {
		c := glob[i]
		if (c == '!' || c == '^') && i == pos+1 {
			negate = true
			i++
			continue
		}
		if c == ']' && sawStart && !escaping {
			endPos = i + 1
			break
		}
		sawStart = true
		if c == '\\' && !escaping {
			escaping = true
			i++
			continue
		}
		if c == '[' && !escaping {
			for _, cls := range posixClasses {
				if strings.HasPrefix(glob[i:], cls.name) {
					if rangeStart != "" {
						return "$.", len(glob) - pos, true
					}
					i += len(cls.name)
					if cls.neg {
						negs = append(negs, cls.unip)
					} else {
						ranges = append(ranges, cls.unip)
					}
					continue outer
				}
			}
		}
		escaping = false
		// Read one whole UTF-8 character.
		r := glob[i : i+utf8Len(glob[i])]
		if rangeStart != "" {
			if r > rangeStart {
				ranges = append(ranges, braceEscape(rangeStart)+"-"+braceEscape(r))
			} else if r == rangeStart {
				ranges = append(ranges, braceEscape(r))
			}
			rangeStart = ""
			i += len(r)
			continue
		}
		if strings.HasPrefix(glob[i+len(r):], "-]") {
			ranges = append(ranges, braceEscape(r+"-"))
			i += len(r) + 1
			continue
		}
		if strings.HasPrefix(glob[i+len(r):], "-") {
			rangeStart = r
			i += len(r) + 1
			continue
		}
		ranges = append(ranges, braceEscape(r))
		i += len(r)
	}
	if endPos < i {
		return "", 0, false
	}
	if len(ranges) == 0 && len(negs) == 0 {
		return "$.", len(glob) - pos, true
	}
	if len(negs) == 0 && len(ranges) == 1 && singleCharClass.MatchString(ranges[0]) && !negate {
		r := ranges[0]
		if len(r) == 2 && r[0] == '\\' {
			r = r[1:]
		}
		return regExpEscape(r), endPos - pos, false
	}
	neg := ""
	if negate {
		neg = "^"
	}
	notNeg := "^"
	if negate {
		notNeg = ""
	}
	sranges := "[" + neg + strings.Join(ranges, "") + "]"
	snegs := "[" + notNeg + strings.Join(negs, "") + "]"
	switch {
	case len(ranges) > 0 && len(negs) > 0:
		return "(" + sranges + "|" + snegs + ")", endPos - pos, true
	case len(ranges) > 0:
		return sranges, endPos - pos, true
	}
	return snegs, endPos - pos, true
}

func utf8Len(b byte) int {
	switch {
	case b < 0x80:
		return 1
	case b>>5 == 0x6:
		return 2
	case b>>4 == 0xe:
		return 3
	case b>>3 == 0x1e:
		return 4
	}
	return 1
}
