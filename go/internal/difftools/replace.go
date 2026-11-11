package difftools

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

func jsTrim(s string) string { return jsstr.Trim(s) }

func itoa(n int) string { return strconv.Itoa(n) }

// ReplaceResult is replace.ts ReplaceResult.
type ReplaceResult struct {
	Content  string `json:"content"`
	Changed  bool   `json:"changed"`
	Strategy string `json:"strategy"`
	Count    int    `json:"count"`
}

func noMatch(content string) ReplaceResult {
	return ReplaceResult{Content: content, Strategy: "none"}
}

// countOccurrences ports replace.ts countOccurrences.
func countOccurrences(content, sub string) int {
	if sub == "" {
		return 0
	}
	return strings.Count(content, sub)
}

// levenshtein ports replace.ts levenshtein over UTF-16 code units.
func levenshtein(as, bs string) int {
	a, b := jsstr.Units(as), jsstr.Units(bs)
	if len(a) == 0 || len(b) == 0 {
		return max(len(a), len(b))
	}
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

// jsReplaceAll is String.prototype.replaceAll(string, string), including
// the $$, $&, $`, and $' replacement patterns.
func jsReplaceAll(s, pattern, replacement string) string {
	if pattern == "" {
		return s
	}
	var b strings.Builder
	last := 0
	for {
		i := strings.Index(s[last:], pattern)
		if i < 0 {
			break
		}
		pos := last + i
		b.WriteString(s[last:pos])
		b.WriteString(substitution(s, pos, pattern, replacement))
		last = pos + len(pattern)
	}
	b.WriteString(s[last:])
	return b.String()
}

// substitution is GetSubstitution for a string pattern (no captures).
func substitution(s string, pos int, matched, replacement string) string {
	if !strings.Contains(replacement, "$") {
		return replacement
	}
	var b strings.Builder
	for i := 0; i < len(replacement); i++ {
		c := replacement[i]
		if c != '$' || i+1 >= len(replacement) {
			b.WriteByte(c)
			continue
		}
		switch replacement[i+1] {
		case '$':
			b.WriteByte('$')
			i++
		case '&':
			b.WriteString(matched)
			i++
		case '`':
			b.WriteString(s[:pos])
			i++
		case '\'':
			b.WriteString(s[pos+len(matched):])
			i++
		default:
			b.WriteByte('$')
		}
	}
	return b.String()
}

type replacer struct {
	name string
	find func(content, find string) []string
}

var escapeRe = regexp.MustCompile("\\\\([nrt'\"`\\\\$])")

// unescapeStr is EscapeNormalizedReplacer's unescapeStr.
func unescapeStr(s string) string {
	return escapeRe.ReplaceAllStringFunc(s, func(m string) string {
		switch m[1] {
		case 'n':
			return "\n"
		case 't':
			return "\t"
		case 'r':
			return "\r"
		}
		return m[1:]
	})
}

// escapeNormalized ports EscapeNormalizedReplacer.
func escapeNormalized(content, find string) []string {
	unescaped := unescapeStr(find)
	if unescaped == find || unescaped == "" {
		return nil
	}
	if strings.Contains(content, unescaped) {
		return []string{unescaped}
	}
	contentLines := strings.Split(content, "\n")
	findLines := strings.Split(unescaped, "\n")
	for i := 0; i <= len(contentLines)-len(findLines); i++ {
		block := strings.Join(contentLines[i:i+len(findLines)], "\n")
		if block == unescaped || jsTrim(block) == jsTrim(unescaped) {
			return []string{block}
		}
	}
	return nil
}

// lineSpan is the byte range of lines [from, to] in the joined content.
func lineSpan(contentLines []string, from, to int) (int, int) {
	start := 0
	for k := 0; k < from; k++ {
		start += len(contentLines[k]) + 1
	}
	end := start
	for k := from; k <= to; k++ {
		end += len(contentLines[k])
		if k < to {
			end++
		}
	}
	return start, end
}

// lineTrimmed ports LineTrimmedReplacer.
func lineTrimmed(content, find string) []string {
	contentLines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")
	if len(findLines) > 1 && findLines[len(findLines)-1] == "" {
		findLines = findLines[:len(findLines)-1]
	}
	if len(findLines) > len(contentLines) {
		return nil
	}
	var out []string
	for i := 0; i <= len(contentLines)-len(findLines); i++ {
		matches := true
		for j := range findLines {
			if jsTrim(contentLines[i+j]) != jsTrim(findLines[j]) {
				matches = false
				break
			}
		}
		if matches {
			start, end := lineSpan(contentLines, i, i+len(findLines)-1)
			out = append(out, content[start:end])
		}
	}
	return out
}

func blockSimilarity(contentLines, findLines []string, startLine, endLine int) float64 {
	middle := min(len(findLines)-2, endLine-startLine+1-2)
	if middle <= 0 {
		return 1
	}
	similarity := 0.0
	for j := 1; j <= middle; j++ {
		original := jsTrim(contentLines[startLine+j])
		search := jsTrim(findLines[j])
		maxLen := max(jsstr.Len16(original), jsstr.Len16(search))
		if maxLen == 0 {
			continue
		}
		similarity += 1 - float64(levenshtein(original, search))/float64(maxLen)
	}
	return similarity / float64(middle)
}

// blockAnchor ports BlockAnchorReplacer.
func blockAnchor(content, find string) []string {
	contentLines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")
	if len(findLines) < 3 {
		return nil
	}
	if findLines[len(findLines)-1] == "" {
		findLines = findLines[:len(findLines)-1]
	}
	if len(findLines) < 3 {
		return nil
	}
	first, last := jsTrim(findLines[0]), jsTrim(findLines[len(findLines)-1])
	type cand struct{ start, end int }
	var candidates []cand
	for i := range contentLines {
		if jsTrim(contentLines[i]) != first {
			continue
		}
		for j := i + 2; j < len(contentLines); j++ {
			if jsTrim(contentLines[j]) == last {
				candidates = append(candidates, cand{i, j})
				break
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	if len(candidates) == 1 {
		c := candidates[0]
		if blockSimilarity(contentLines, findLines, c.start, c.end) >= 0.25 {
			start, end := lineSpan(contentLines, c.start, c.end)
			return []string{content[start:end]}
		}
		return nil
	}
	best, bestSim := -1, -1.0
	for k, c := range candidates {
		if sim := blockSimilarity(contentLines, findLines, c.start, c.end); sim > bestSim {
			best, bestSim = k, sim
		}
	}
	if best < 0 || bestSim < 0.4 {
		return nil
	}
	start, end := lineSpan(contentLines, candidates[best].start, candidates[best].end)
	return []string{content[start:end]}
}

func normalizeWS(s string) string { return jsTrim(jsstr.CollapseSpace(s)) }

// whitespaceNormalized ports WhitespaceNormalizedReplacer.
func whitespaceNormalized(content, find string) []string {
	normalizedFind := normalizeWS(find)
	if normalizedFind == "" {
		return nil
	}
	contentLines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")
	var out []string
	if len(findLines) <= 1 || (len(findLines) == 2 && findLines[1] == "") {
		for _, line := range contentLines {
			if normalizeWS(line) == normalizedFind {
				out = append(out, line)
			}
		}
		return out
	}
	effective := findLines
	if findLines[len(findLines)-1] == "" {
		effective = findLines[:len(findLines)-1]
	}
	for i := 0; i <= len(contentLines)-len(effective); i++ {
		block := strings.Join(contentLines[i:i+len(effective)], "\n")
		if normalizeWS(block) == normalizedFind {
			out = append(out, block)
		}
	}
	return out
}

// trimmedBoundary ports TrimmedBoundaryReplacer.
func trimmedBoundary(content, find string) []string {
	trimmed := jsTrim(find)
	if trimmed == find || trimmed == "" {
		return nil
	}
	if strings.Contains(content, trimmed) {
		return []string{trimmed}
	}
	contentLines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")
	for i := 0; i <= len(contentLines)-len(findLines); i++ {
		block := strings.Join(contentLines[i:i+len(findLines)], "\n")
		if jsTrim(block) == trimmed {
			return []string{block}
		}
	}
	return nil
}

// replacers is REPLACERS without SimpleReplacer, which replace handles first.
var replacers = []replacer{
	{"escape-normalized", escapeNormalized},
	{"line-trimmed", lineTrimmed},
	{"block-anchor", blockAnchor},
	{"whitespace-normalized", whitespaceNormalized},
	{"trimmed-boundary", trimmedBoundary},
}

// Replace ports replace.ts replace: exact match first, then the fuzzy
// cascade. A fuzzy strategy with several candidates is skipped.
func Replace(content, oldString, newString string, replaceAll bool) ReplaceResult {
	if oldString == "" || oldString == newString {
		return noMatch(content)
	}
	if replaceAll && strings.Contains(content, oldString) {
		if result := jsReplaceAll(content, oldString, newString); result != content {
			return ReplaceResult{Content: result, Changed: true, Strategy: "simple-replaceAll", Count: countOccurrences(content, oldString)}
		}
	}
	if !replaceAll {
		if idx := strings.Index(content, oldString); idx != -1 && idx == strings.LastIndex(content, oldString) {
			return ReplaceResult{Content: content[:idx] + newString + content[idx+len(oldString):], Changed: true, Strategy: "simple", Count: 1}
		}
	}
	for _, r := range replacers {
		candidates := r.find(content, oldString)
		if len(candidates) == 0 {
			continue
		}
		if replaceAll {
			result, total := content, 0
			for _, candidate := range candidates {
				if count := countOccurrences(result, candidate); count > 0 {
					result = jsReplaceAll(result, candidate, newString)
					total += count
				}
			}
			if total > 0 {
				return ReplaceResult{Content: result, Changed: true, Strategy: r.name + "-replaceAll", Count: total}
			}
			continue
		}
		if len(candidates) == 1 {
			candidate := candidates[0]
			if idx := strings.Index(content, candidate); idx != -1 {
				return ReplaceResult{Content: content[:idx] + newString + content[idx+len(candidate):], Changed: true, Strategy: r.name, Count: 1}
			}
		}
	}
	return noMatch(content)
}

var leadingWSRe = regexp.MustCompile(`^[\t ]*`)

func leadingWhitespace(line string) string { return leadingWSRe.FindString(line) }

type indentAdjustment struct {
	kind       string // add, remove, none
	whitespace string
}

// getIndentAdjustment ports replace.ts getIndentAdjustment.
func getIndentAdjustment(expected, actual []string) *indentAdjustment {
	var adj *indentAdjustment
	for i := range expected {
		if jsTrim(expected[i]) == "" {
			continue
		}
		e, a := leadingWhitespace(expected[i]), leadingWhitespace(actual[i])
		var cur *indentAdjustment
		switch {
		case a == e:
			cur = &indentAdjustment{kind: "none"}
		case strings.HasSuffix(a, e):
			cur = &indentAdjustment{kind: "add", whitespace: a[:len(a)-len(e)]}
		case strings.HasSuffix(e, a):
			cur = &indentAdjustment{kind: "remove", whitespace: e[:len(e)-len(a)]}
		default:
			return nil
		}
		if adj == nil {
			adj = cur
		} else if adj.kind != cur.kind || (adj.kind != "none" && adj.whitespace != cur.whitespace) {
			return nil
		}
	}
	if adj == nil {
		return &indentAdjustment{kind: "none"}
	}
	return adj
}

var crlfSplitRe = regexp.MustCompile(`\r?\n`)

// applyIndentAdjustment ports replace.ts applyIndentAdjustment.
func applyIndentAdjustment(newText string, adj *indentAdjustment, lineEnding string) (string, bool) {
	lines := crlfSplitRe.Split(newText, -1)
	for i, line := range lines {
		if jsTrim(line) == "" || adj.kind == "none" {
			continue
		}
		if adj.kind == "add" {
			lines[i] = adj.whitespace + line
			continue
		}
		if !strings.HasPrefix(line, adj.whitespace) {
			return "", false
		}
		lines[i] = line[len(adj.whitespace):]
	}
	return strings.Join(lines, lineEnding), true
}

// ReplaceForPatch ports replace.ts replaceForPatch: exact text, then one
// unambiguous block that differs only by a uniform indentation shift.
func ReplaceForPatch(content, oldText, newText string) ReplaceResult {
	if oldText == "" || oldText == newText {
		return noMatch(content)
	}
	exact := countOccurrences(content, oldText)
	if exact == 1 {
		index := strings.Index(content, oldText)
		from := max(index-1, 0)
		lineStart := strings.LastIndex(content[:min(from+1, len(content))], "\n") + 1
		omitted := ""
		if lineStart <= index {
			omitted = content[lineStart:index]
		}
		oldIndent, newIndent := leadingWhitespace(oldText), leadingWhitespace(newText)
		if ((strings.Contains(oldText, "\n") || strings.Contains(newText, "\n")) && index != lineStart) ||
			(index != lineStart && jsTrim(omitted) == "" && oldIndent != "" && oldIndent != newIndent) {
			return noMatch(content)
		}
		return ReplaceResult{Content: content[:index] + newText + content[index+len(oldText):], Changed: true, Strategy: "simple", Count: 1}
	}
	if exact > 1 {
		return noMatch(content)
	}
	oldLines := strings.Split(oldText, "\n")
	if len(oldLines) > 1 && oldLines[len(oldLines)-1] == "" {
		oldLines = oldLines[:len(oldLines)-1]
	}
	contentLines := strings.Split(content, "\n")
	type cand struct {
		start  int
		text   string
		indent *indentAdjustment
	}
	var candidates []cand
	start := 0
	for i := 0; i <= len(contentLines)-len(oldLines); i++ {
		actual := contentLines[i : i+len(oldLines)]
		ok := true
		for k, line := range actual {
			if jsTrim(line) != jsTrim(oldLines[k]) {
				ok = false
				break
			}
		}
		if !ok {
			start += len(contentLines[i]) + 1
			continue
		}
		indent := getIndentAdjustment(oldLines, actual)
		trailing := strings.HasSuffix(oldText, "\n") && i+len(oldLines) < len(contentLines)
		if indent != nil {
			text := strings.Join(actual, "\n")
			if trailing {
				text += "\n"
			}
			candidates = append(candidates, cand{start, text, indent})
		}
		start += len(contentLines[i]) + 1
	}
	if len(candidates) != 1 {
		return noMatch(content)
	}
	c := candidates[0]
	ending := "\n"
	if strings.Contains(c.text, "\r\n") || strings.HasSuffix(c.text, "\r") {
		ending = "\r\n"
	}
	adjusted, ok := applyIndentAdjustment(newText, c.indent, ending)
	if !ok {
		return noMatch(content)
	}
	replacement := adjusted
	if strings.HasSuffix(c.text, "\r") && !strings.HasSuffix(adjusted, "\r") {
		replacement += "\r"
	}
	return ReplaceResult{Content: content[:c.start] + replacement + content[c.start+len(c.text):], Changed: true, Strategy: "indent-adjusted", Count: 1}
}
