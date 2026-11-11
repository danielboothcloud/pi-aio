package yamlhooks

// Glob matching: a port of Node's path.matchesGlob, which runs minimatch
// (with brace-expansion and balanced-match) with these options:
// { nocase: macOS or Windows, windowsPathsNoEscape: true, nonegate: true,
// nocomment: true, optimizationLevel: 2, platform: "posix",
// nocaseMagicOnly: true }. Segment regular expressions use regexp2 in
// ECMAScript mode, because minimatch builds lookahead patterns.

import (
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/dlclark/regexp2"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// globNocase is Node's `nocase: isMacOS || isWindows`.
var globNocase = runtime.GOOS == "darwin" || runtime.GOOS == "windows"

// MatchesGlob is path.matchesGlob(path, pattern) on this platform.
func MatchesGlob(path, pattern string) bool { return matchGlob(path, pattern, globNocase) }

var globCache sync.Map // key: nocase+"\x00"+pattern → *minimatch

func matchGlob(path, pattern string, nocase bool) bool {
	key := "0"
	if nocase {
		key = "1"
	}
	key += "\x00" + pattern
	var mm *minimatch
	if cached, ok := globCache.Load(key); ok {
		mm = cached.(*minimatch)
	} else {
		mm = newMinimatch(pattern, nocase)
		globCache.Store(key, mm)
	}
	return mm.match(path)
}

// ---- segment patterns ----

type segKind int

const (
	segString segKind = iota
	segGlobstar
	segRegexp
)

type segment struct {
	kind segKind
	str  string
	re   *regexp2.Regexp
	fast func(string) bool
}

func (s segment) test(f string) bool {
	if s.fast != nil {
		return s.fast(f)
	}
	ok, err := s.re.MatchString(f)
	return err == nil && ok
}

type minimatch struct {
	nocase bool
	empty  bool
	set    [][]segment
}

func newMinimatch(pattern string, nocase bool) *minimatch {
	mm := &minimatch{nocase: nocase}
	pattern = strings.ReplaceAll(pattern, "\\", "/")
	if pattern == "" {
		mm.empty = true
		return mm
	}
	globSet := uniqueStrings(braceExpand(pattern))
	raw := make([][]string, len(globSet))
	for i, g := range globSet {
		raw[i] = slashSplit(g)
	}
	parts := secondPhasePreProcess(firstPhasePreProcess(raw))
	for _, p := range parts {
		segs := make([]segment, len(p))
		for i, s := range p {
			segs[i] = mm.parse(s)
		}
		mm.set = append(mm.set, segs)
	}
	return mm
}

var slashRun = regexp.MustCompile(`/+`)

func slashSplit(p string) []string { return slashRun.Split(p, -1) }

func (mm *minimatch) match(f string) bool {
	if mm.empty {
		return f == ""
	}
	ff := slashSplit(f)
	for _, pattern := range mm.set {
		if mm.matchOne(ff, pattern) {
			return true
		}
	}
	return false
}

var (
	starRE        = regexp.MustCompile(`^\*+$`)
	starDotExtRE  = regexp.MustCompile(`^\*+([^+@!?*\[(]*)$`)
	qmarksRE      = regexp.MustCompile(`^\?+([^+@!?*\[(]*)?$`)
	starDotStarRE = regexp.MustCompile(`^\*+\.\*+$`)
	dotStarRE     = regexp.MustCompile(`^\.\*+$`)
)

func (mm *minimatch) parse(pattern string) segment {
	if pattern == "**" {
		return segment{kind: segGlobstar}
	}
	if pattern == "" {
		return segment{kind: segString}
	}
	var fast func(string) bool
	if starRE.MatchString(pattern) {
		fast = func(f string) bool { return f != "" && !strings.HasPrefix(f, ".") }
	} else if m := starDotExtRE.FindStringSubmatch(pattern); m != nil {
		ext := m[1]
		if mm.nocase {
			ext = strings.ToLower(ext)
			fast = func(f string) bool { return !strings.HasPrefix(f, ".") && strings.HasSuffix(strings.ToLower(f), ext) }
		} else {
			fast = func(f string) bool { return !strings.HasPrefix(f, ".") && strings.HasSuffix(f, ext) }
		}
	} else if m := qmarksRE.FindStringSubmatch(pattern); m != nil {
		n := jsstr.Len16(m[0]) - jsstr.Len16(m[1])
		qs := strings.Repeat("?", n)
		_ = qs
		length := n
		ext := m[1]
		noext := func(f string) bool { return jsstr.Len16(f) == length && !strings.HasPrefix(f, ".") }
		// qmarksTestNoExt uses the length of the whole match ($0).
		total := jsstr.Len16(m[0])
		noext = func(f string) bool { return jsstr.Len16(f) == total && !strings.HasPrefix(f, ".") }
		switch {
		case ext == "":
			fast = noext
		case mm.nocase:
			lower := strings.ToLower(ext)
			fast = func(f string) bool { return noext(f) && strings.HasSuffix(strings.ToLower(f), lower) }
		default:
			fast = func(f string) bool { return noext(f) && strings.HasSuffix(f, ext) }
		}
	} else if starDotStarRE.MatchString(pattern) {
		fast = func(f string) bool { return !strings.HasPrefix(f, ".") && strings.Contains(f, ".") }
	} else if dotStarRE.MatchString(pattern) {
		fast = func(f string) bool { return f != "." && f != ".." && strings.HasPrefix(f, ".") }
	}
	ast := astFromGlob(pattern)
	src, body, magic, isRegexp := ast.toMMPattern()
	if !isRegexp {
		_ = magic
		return segment{kind: segString, str: body}
	}
	opts := regexp2.RegexOptions(regexp2.ECMAScript)
	if mm.nocase {
		opts |= regexp2.IgnoreCase
	}
	re, err := regexp2.Compile("^"+src+"$", opts)
	if err != nil {
		// Without ECMAScript mode for \p{...} classes.
		re, err = regexp2.Compile("^"+src+"$", opts&^regexp2.ECMAScript)
		if err != nil {
			re = regexp2.MustCompile(`^$.`, 0)
		}
	}
	return segment{kind: segRegexp, re: re, fast: fast}
}

// ---- matching ----

func levelTwoFileOptimize(parts []string) []string {
	parts = append([]string{}, parts...)
	for {
		did := false
		for i := 1; i < len(parts)-1; i++ {
			p := parts[i]
			if i == 1 && p == "" && parts[0] == "" {
				continue
			}
			if p == "." || p == "" {
				did = true
				parts = append(parts[:i:i], parts[i+1:]...)
				i--
			}
		}
		if len(parts) == 2 && parts[0] == "." && (parts[1] == "." || parts[1] == "") {
			did = true
			parts = parts[:1]
		}
		dd := 0
		for {
			dd = indexFrom(parts, "..", dd+1)
			if dd == -1 {
				break
			}
			p := parts[dd-1]
			if p != "" && p != "." && p != ".." && p != "**" {
				did = true
				parts = append(parts[:dd-1:dd-1], parts[dd+1:]...)
				dd -= 2
			}
		}
		if !did {
			break
		}
	}
	if len(parts) == 0 {
		return []string{""}
	}
	return parts
}

func indexFrom(list []string, v string, from int) int {
	if from < 0 {
		from = 0
	}
	for i := from; i < len(list); i++ {
		if list[i] == v {
			return i
		}
	}
	return -1
}

func (mm *minimatch) matchOne(file []string, pattern []segment) bool {
	file = levelTwoFileOptimize(file)
	for _, s := range pattern {
		if s.kind == segGlobstar {
			return mm.matchGlobstar(file, pattern)
		}
	}
	return matchSegments(file, pattern, 0, 0)
}

func badDot(f string) bool { return f == "." || f == ".." || strings.HasPrefix(f, ".") }

func (mm *minimatch) matchGlobstar(file []string, pattern []segment) bool {
	firstgs, lastgs := -1, -1
	for i, s := range pattern {
		if s.kind == segGlobstar {
			if firstgs == -1 {
				firstgs = i
			}
			lastgs = i
		}
	}
	head, tail := pattern[:firstgs], pattern[lastgs+1:]
	var body []segment
	if lastgs > firstgs {
		body = pattern[firstgs+1 : lastgs]
	}
	fileIndex := 0
	if len(head) > 0 {
		end := len(head)
		if end > len(file) {
			end = len(file)
		}
		if !matchSegments(file[:end], head, 0, 0) {
			return false
		}
		fileIndex += len(head)
	}
	fileTailMatch := 0
	if len(tail) > 0 {
		if len(tail)+fileIndex > len(file) {
			return false
		}
		tailStart := len(file) - len(tail)
		if matchSegments(file, tail, tailStart, 0) {
			fileTailMatch = len(tail)
		} else {
			if file[len(file)-1] != "" || fileIndex+len(tail) == len(file) {
				return false
			}
			tailStart--
			if !matchSegments(file, tail, tailStart, 0) {
				return false
			}
			fileTailMatch = len(tail) + 1
		}
	}
	if len(body) == 0 {
		sawSome := fileTailMatch > 0
		for i := fileIndex; i < len(file)-fileTailMatch; i++ {
			sawSome = true
			if badDot(file[i]) {
				return false
			}
		}
		return sawSome
	}
	type section struct {
		body  []segment
		after int
	}
	sections := []*section{{}}
	current := sections[0]
	nonGs := 0
	sums := []int{0}
	for _, b := range body {
		if b.kind == segGlobstar {
			sums = append(sums, nonGs)
			current = &section{}
			sections = append(sections, current)
		} else {
			current.body = append(current.body, b)
			nonGs++
		}
	}
	i := len(sections) - 1
	fileLength := len(file) - fileTailMatch
	for _, s := range sections {
		s.after = fileLength - (sums[i] + len(s.body))
		i--
	}
	var walk func(fileIndex, bodyIndex, depth int, sawTail bool) int // 1 true, 0 false, -1 null
	walk = func(fileIndex, bodyIndex, depth int, sawTail bool) int {
		if bodyIndex >= len(sections) {
			for i := fileIndex; i < len(file); i++ {
				sawTail = true
				if badDot(file[i]) {
					return 0
				}
			}
			if sawTail {
				return 1
			}
			return 0
		}
		s := sections[bodyIndex]
		for fileIndex <= s.after {
			end := fileIndex + len(s.body)
			if end > len(file) {
				end = len(file)
			}
			if matchSegments(file[:end], s.body, fileIndex, 0) && depth < 200 {
				if sub := walk(fileIndex+len(s.body), bodyIndex+1, depth+1, sawTail); sub != 0 {
					return sub
				}
			}
			if fileIndex < len(file) && badDot(file[fileIndex]) {
				return 0
			}
			if fileIndex >= len(file) {
				// file[fileIndex] is undefined: undefined.startsWith throws in
				// JavaScript only when reached; the loop bound prevents it.
				return 0
			}
			fileIndex++
		}
		return -1
	}
	return walk(fileIndex, 0, 0, fileTailMatch > 0) == 1
}

func matchSegments(file []string, pattern []segment, fi, pi int) bool {
	fl, pl := len(file), len(pattern)
	for ; fi < fl && pi < pl; fi, pi = fi+1, pi+1 {
		p, f := pattern[pi], file[fi]
		if p.kind == segGlobstar {
			return false
		}
		var hit bool
		if p.kind == segString {
			hit = f == p.str
		} else {
			hit = p.test(f)
		}
		if !hit {
			return false
		}
	}
	if fi == fl && pi == pl {
		return true
	}
	if fi == fl {
		return false
	}
	if pi == pl {
		return fi == fl-1 && file[fi] == ""
	}
	return false
}

// ---- preprocessing (optimizationLevel 2) ----

func firstPhasePreProcess(globParts [][]string) [][]string {
	for {
		did := false
		for gi := 0; gi < len(globParts); gi++ {
			parts := globParts[gi]
			gs := -1
			for {
				gs = indexFrom(parts, "**", gs+1)
				if gs == -1 {
					break
				}
				gss := gs
				for gss+1 < len(parts) && parts[gss+1] == "**" {
					gss++
				}
				if gss > gs {
					parts = append(parts[:gs+1:gs+1], parts[gss+1:]...)
				}
				next, p, p2 := at(parts, gs+1), at(parts, gs+2), at(parts, gs+3)
				if next == nil || *next != ".." {
					continue
				}
				if p == nil || *p == "" || *p == "." || *p == ".." || p2 == nil || *p2 == "" || *p2 == "." || *p2 == ".." {
					continue
				}
				did = true
				parts = append(parts[:gs:gs], parts[gs+1:]...)
				other := append([]string{}, parts...)
				other[gs] = "**"
				globParts = append(globParts, other)
				gs--
			}
			for i := 1; i < len(parts)-1; i++ {
				p := parts[i]
				if i == 1 && p == "" && parts[0] == "" {
					continue
				}
				if p == "." || p == "" {
					did = true
					parts = append(parts[:i:i], parts[i+1:]...)
					i--
				}
			}
			if len(parts) == 2 && parts[0] == "." && (parts[1] == "." || parts[1] == "") {
				did = true
				parts = parts[:1]
			}
			dd := 0
			for {
				dd = indexFrom(parts, "..", dd+1)
				if dd == -1 {
					break
				}
				p := parts[dd-1]
				if p != "" && p != "." && p != ".." && p != "**" {
					did = true
					needDot := dd == 1 && dd+1 < len(parts) && parts[dd+1] == "**"
					rest := append([]string{}, parts[dd+1:]...)
					parts = append(parts[:dd-1:dd-1], func() []string {
						if needDot {
							return []string{"."}
						}
						return nil
					}()...)
					parts = append(parts, rest...)
					if len(parts) == 0 {
						parts = append(parts, "")
					}
					dd -= 2
				}
			}
			globParts[gi] = parts
		}
		if !did {
			break
		}
	}
	return globParts
}

func at(list []string, i int) *string {
	if i < 0 || i >= len(list) {
		return nil
	}
	return &list[i]
}

func secondPhasePreProcess(globParts [][]string) [][]string {
	for i := 0; i < len(globParts)-1; i++ {
		for j := i + 1; j < len(globParts); j++ {
			if matched, ok := partsMatch(globParts[i], globParts[j]); ok {
				globParts[i] = nil
				globParts[j] = matched
				break
			}
		}
	}
	var out [][]string
	for _, g := range globParts {
		if len(g) > 0 {
			out = append(out, g)
		}
	}
	return out
}

func partsMatch(a, b []string) ([]string, bool) {
	ai, bi := 0, 0
	var result []string
	which := ""
	for ai < len(a) && bi < len(b) {
		switch {
		case a[ai] == b[bi]:
			if which == "b" {
				result = append(result, b[bi])
			} else {
				result = append(result, a[ai])
			}
			ai++
			bi++
		case a[ai] == "**" && ai+1 < len(a) && b[bi] == a[ai+1]:
			result = append(result, a[ai])
			ai++
		case b[bi] == "**" && bi+1 < len(b) && a[ai] == b[bi+1]:
			result = append(result, b[bi])
			bi++
		case a[ai] == "*" && b[bi] != "" && !strings.HasPrefix(b[bi], ".") && b[bi] != "**":
			if which == "b" {
				return nil, false
			}
			which = "a"
			result = append(result, a[ai])
			ai++
			bi++
		case b[bi] == "*" && a[ai] != "" && !strings.HasPrefix(a[ai], ".") && a[ai] != "**":
			if which == "a" {
				return nil, false
			}
			which = "b"
			result = append(result, b[bi])
			ai++
			bi++
		default:
			return nil, false
		}
	}
	if len(a) != len(b) {
		return nil, false
	}
	return result, true
}

// ---- brace expansion (brace-expansion 5 with balanced-match) ----

const (
	escSlash  = "\x00SLASH\x00"
	escOpen   = "\x00OPEN\x00"
	escClose  = "\x00CLOSE\x00"
	escComma  = "\x00COMMA\x00"
	escPeriod = "\x00PERIOD\x00"
)

// hasBraceSet is /\{(?:(?!\{).)*\}/.test(pattern).
func hasBraceSet(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] != '{' {
			continue
		}
		for j := i + 1; j < len(s); j++ {
			if s[j] == '}' {
				return true
			}
			if s[j] == '{' || s[j] == '\n' || s[j] == '\r' {
				break
			}
			if j+2 < len(s) && s[j] == 0xe2 && s[j+1] == 0x80 && (s[j+2] == 0xa8 || s[j+2] == 0xa9) {
				break
			}
		}
	}
	return false
}

func braceExpand(pattern string) []string {
	if !hasBraceSet(pattern) {
		return []string{pattern}
	}
	return braceExpandAll(pattern)
}

func braceExpandAll(str string) []string {
	if str == "" {
		return nil
	}
	if strings.HasPrefix(str, "{}") {
		str = "\\{\\}" + str[2:]
	}
	r := strings.NewReplacer("\\\\", escSlash, "\\{", escOpen, "\\}", escClose, "\\,", escComma, "\\.", escPeriod)
	out := expandBraces(r.Replace(str), 0, true)
	un := strings.NewReplacer(escSlash, "\\", escOpen, "{", escClose, "}", escComma, ",", escPeriod, ".")
	for i := range out {
		out[i] = un.Replace(out[i])
	}
	return out
}

type balancedMatch struct{ pre, body, post string }

func balanced(str string) (balancedMatch, bool) {
	start, end, ok := balancedRange(str)
	if !ok {
		return balancedMatch{}, false
	}
	return balancedMatch{pre: str[:start], body: str[start+1 : end], post: str[end+1:]}, true
}

func indexByteFrom(s string, c byte, from int) int {
	if from > len(s) {
		return -1
	}
	if from < 0 {
		from = 0
	}
	i := strings.IndexByte(s[from:], c)
	if i < 0 {
		return -1
	}
	return i + from
}

func balancedRange(str string) (int, int, bool) {
	ai := strings.IndexByte(str, '{')
	bi := indexByteFrom(str, '}', ai+1)
	i := ai
	if ai < 0 || bi <= 0 {
		return 0, 0, false
	}
	var begs []int
	left := len(str)
	right := -1
	var result []int
	for i >= 0 && result == nil {
		if i == ai {
			begs = append(begs, i)
			ai = indexByteFrom(str, '{', i+1)
		} else if len(begs) == 1 {
			r := begs[0]
			begs = begs[:0]
			result = []int{r, bi}
		} else {
			beg := begs[len(begs)-1]
			begs = begs[:len(begs)-1]
			if beg < left {
				left = beg
				right = bi
			}
			bi = indexByteFrom(str, '}', i+1)
		}
		if ai < bi && ai >= 0 {
			i = ai
		} else {
			i = bi
		}
	}
	if len(begs) > 0 && right != -1 {
		result = []int{left, right}
	}
	if result == nil {
		return 0, 0, false
	}
	return result[0], result[1], true
}

func parseCommaParts(str string) []string {
	var parts []string
	carry := ""
	for {
		m, ok := balanced(str)
		if !ok {
			tail := strings.Split(str, ",")
			tail[0] = carry + tail[0]
			return append(parts, tail...)
		}
		p := strings.Split(m.pre, ",")
		p[0] = carry + p[0]
		p[len(p)-1] += "{" + m.body + "}"
		if m.post == "" {
			return append(parts, p...)
		}
		carry = p[len(p)-1]
		parts = append(parts, p[:len(p)-1]...)
		str = m.post
	}
}

const (
	expansionMax       = 100_000
	expansionMaxLength = 4_000_000
	expansionMaxDepth  = 1_000
	expansionRewrites  = 1_000
)

var (
	numericSeq = regexp.MustCompile(`^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$`)
	alphaSeq   = regexp.MustCompile(`^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$`)
	paddedNum  = regexp.MustCompile(`^-?0\d`)
	rewriteRE  = regexp2.MustCompile(`,(?!,).*\}`, regexp2.ECMAScript)
)

func combine(acc []string, pre string, values []string, dropEmpties bool) []string {
	var out []string
	length := 0
	for _, a := range acc {
		for _, v := range values {
			if len(out) >= expansionMax {
				return out
			}
			e := a + pre + v
			if dropEmpties && e == "" {
				continue
			}
			if length+jsstr.Len16(e) > expansionMaxLength {
				return out
			}
			out = append(out, e)
			length += jsstr.Len16(e)
		}
	}
	return out
}

func numericValue(s string) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	units := utf16.Encode([]rune(s))
	if len(units) == 0 {
		return 0
	}
	return int(units[0])
}

func expandSequence(body string, alpha bool) []string {
	n := strings.Split(body, "..")
	x, y := numericValue(n[0]), numericValue(n[1])
	width := max(jsstr.Len16(n[0]), jsstr.Len16(n[1]))
	incr := 1
	if len(n) == 3 {
		incr = numericValue(n[2])
		if incr < 0 {
			incr = -incr
		}
		incr = max(incr, 1)
	}
	reverse := y < x
	if reverse {
		incr = -incr
	}
	pad := false
	for _, part := range n {
		if paddedNum.MatchString(part) {
			pad = true
		}
	}
	var out []string
	length := 0
	for i := x; (reverse && i >= y || !reverse && i <= y) && len(out) < expansionMax; i += incr {
		var c string
		if alpha {
			c = string(utf16.Decode([]uint16{uint16(i)}))
			if c == "\\" {
				c = ""
			}
		} else {
			c = strconv.Itoa(i)
			if pad {
				if need := width - len(c); need > 0 {
					z := strings.Repeat("0", need)
					if i < 0 {
						c = "-" + z + c[1:]
					} else {
						c = z + c
					}
				}
			}
		}
		if length+jsstr.Len16(c) > expansionMaxLength {
			break
		}
		out = append(out, c)
		length += jsstr.Len16(c)
	}
	return out
}

func embrace(list []string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = "{" + s + "}"
	}
	return out
}

func expandBraces(str string, depth int, isTop bool) []string {
	if depth > expansionMaxDepth {
		return []string{str}
	}
	acc := []string{""}
	rewrites := 0
	dropEmpties := false
	firstGroup := true
	for {
		m, ok := balanced(str)
		if !ok {
			return combine(acc, str, []string{""}, dropEmpties)
		}
		pre := m.pre
		if strings.HasSuffix(pre, "$") {
			acc = combine(acc, pre+"{"+m.body+"}", []string{""}, dropEmpties && m.post == "")
			firstGroup = false
			if m.post == "" {
				break
			}
			str = m.post
			continue
		}
		isNum := numericSeq.MatchString(m.body)
		isAlpha := alphaSeq.MatchString(m.body)
		isSeq := isNum || isAlpha
		isOptions := strings.Contains(m.body, ",")
		if !isSeq && !isOptions {
			if matched, _ := rewriteRE.MatchString(m.post); rewrites < expansionRewrites && matched {
				rewrites++
				str = m.pre + "{" + m.body + escClose + m.post
				isTop = true
				continue
			}
			return combine(acc, pre+"{"+m.body+"}"+m.post, []string{""}, dropEmpties)
		}
		if firstGroup {
			dropEmpties = isTop && !isSeq
			firstGroup = false
		}
		var values []string
		if isSeq {
			values = expandSequence(m.body, isAlpha)
		} else {
			n := parseCommaParts(m.body)
			if len(n) == 1 {
				n = embrace(expandBraces(n[0], depth+1, false))
				if len(n) == 1 {
					acc = combine(acc, pre+n[0], []string{""}, dropEmpties && m.post == "")
					if m.post == "" {
						break
					}
					str = m.post
					continue
				}
			}
			drops := dropEmpties && m.post == "" && pre == ""
			for _, a := range acc {
				if a != "" {
					drops = false
				}
			}
			values = []string{}
			valuesLength := 0
		outer:
			for _, part := range n {
				for _, v := range expandBraces(part, depth+1, false) {
					if drops && v == "" {
						continue
					}
					if len(values) >= expansionMax || valuesLength+jsstr.Len16(v) > expansionMaxLength {
						break outer
					}
					values = append(values, v)
					valuesLength += jsstr.Len16(v)
				}
			}
		}
		acc = combine(acc, pre, values, dropEmpties && m.post == "")
		if m.post == "" {
			break
		}
		str = m.post
	}
	return acc
}
