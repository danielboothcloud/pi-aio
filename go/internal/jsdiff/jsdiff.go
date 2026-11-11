// Package jsdiff ports the subset of jsdiff (the npm "diff" package, 7.0.0)
// that diff-tools calls: diffLines, diffWords, structuredPatch, formatPatch,
// createTwoFilesPatch, and createPatch. The Myers walk, the tokenizers, the
// word whitespace cleanup, and the hunk builder follow lib/index.mjs line by
// line, so the change lists and patches match jsdiff byte for byte.
//
// Lengths in JavaScript are UTF-16 code units. Change values here are Go
// strings; callers that need JavaScript lengths use jsstr.Len16.
package jsdiff

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Change is one jsdiff change object.
type Change struct {
	Value   string `json:"value"`
	Count   int    `json:"count"`
	Added   bool   `json:"added"`
	Removed bool   `json:"removed"`
}

type component struct {
	count          int
	added, removed bool
	prev           *component
}

type path struct {
	oldPos int
	last   *component
}

type differ struct {
	equals func(a, b string) bool
	join   func(tokens []string) string
}

func addToPath(p *path, added, removed bool, oldPosInc int) *path {
	last := p.last
	if last != nil && last.added == added && last.removed == removed {
		return &path{oldPos: p.oldPos + oldPosInc, last: &component{count: last.count + 1, added: added, removed: removed, prev: last.prev}}
	}
	return &path{oldPos: p.oldPos + oldPosInc, last: &component{count: 1, added: added, removed: removed, prev: last}}
}

func (d differ) extractCommon(base *path, newTokens, oldTokens []string, diagonal int) int {
	newLen, oldLen := len(newTokens), len(oldTokens)
	oldPos := base.oldPos
	newPos := oldPos - diagonal
	common := 0
	for newPos+1 < newLen && oldPos+1 < oldLen && d.equals(oldTokens[oldPos+1], newTokens[newPos+1]) {
		newPos++
		oldPos++
		common++
	}
	if common > 0 {
		base.last = &component{count: common, prev: base.last}
	}
	base.oldPos = oldPos
	return newPos
}

func removeEmpty(tokens []string) []string {
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

// diff is Diff.prototype.diff without callbacks, timeouts, or maxEditLength.
func (d differ) diff(oldTokens, newTokens []string) []*Change {
	oldTokens, newTokens = removeEmpty(oldTokens), removeEmpty(newTokens)
	newLen, oldLen := len(newTokens), len(oldTokens)
	editLength := 1
	maxEditLength := newLen + oldLen
	best := map[int]*path{0: {oldPos: -1}}
	newPos := d.extractCommon(best[0], newTokens, oldTokens, 0)
	if best[0].oldPos+1 >= oldLen && newPos+1 >= newLen {
		return d.buildValues(best[0].last, newTokens, oldTokens)
	}
	const inf = int(^uint(0) >> 1)
	minDiagonal, maxDiagonal := -inf, inf
	for editLength <= maxEditLength {
		lo := max(minDiagonal, -editLength)
		hi := min(maxDiagonal, editLength)
		for diagonal := lo; diagonal <= hi; diagonal += 2 {
			removePath := best[diagonal-1]
			addPath := best[diagonal+1]
			if removePath != nil {
				best[diagonal-1] = nil
			}
			canAdd := false
			if addPath != nil {
				addNewPos := addPath.oldPos - diagonal
				canAdd = 0 <= addNewPos && addNewPos < newLen
			}
			canRemove := removePath != nil && removePath.oldPos+1 < oldLen
			if !canAdd && !canRemove {
				best[diagonal] = nil
				continue
			}
			var base *path
			if !canRemove || (canAdd && removePath.oldPos < addPath.oldPos) {
				base = addToPath(addPath, true, false, 0)
			} else {
				base = addToPath(removePath, false, true, 1)
			}
			newPos = d.extractCommon(base, newTokens, oldTokens, diagonal)
			if base.oldPos+1 >= oldLen && newPos+1 >= newLen {
				return d.buildValues(base.last, newTokens, oldTokens)
			}
			best[diagonal] = base
			if base.oldPos+1 >= oldLen {
				maxDiagonal = min(maxDiagonal, diagonal-1)
			}
			if newPos+1 >= newLen {
				minDiagonal = max(minDiagonal, diagonal+1)
			}
		}
		editLength++
	}
	return nil
}

func (d differ) buildValues(last *component, newTokens, oldTokens []string) []*Change {
	var components []*component
	for c := last; c != nil; c = c.prev {
		components = append(components, c)
	}
	out := make([]*Change, len(components))
	newPos, oldPos := 0, 0
	for i := range components {
		c := components[len(components)-1-i]
		ch := &Change{Count: c.count, Added: c.added, Removed: c.removed}
		if !c.removed {
			ch.Value = d.join(newTokens[newPos : newPos+c.count])
			newPos += c.count
			if !c.added {
				oldPos += c.count
			}
		} else {
			ch.Value = d.join(oldTokens[oldPos : oldPos+c.count])
			oldPos += c.count
		}
		out[i] = ch
	}
	return out
}

// tokenizeLines is lineDiff.tokenize: lines with their "\n" or "\r\n".
func tokenizeLines(value string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(value); i++ {
		switch {
		case value[i] == '\n':
			parts = append(parts, value[start:i], "\n")
			start = i + 1
		case value[i] == '\r' && i+1 < len(value) && value[i+1] == '\n':
			parts = append(parts, value[start:i], "\r\n")
			start = i + 2
			i++
		}
	}
	parts = append(parts, value[start:])
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	var lines []string
	for i, p := range parts {
		if i%2 == 1 {
			lines[len(lines)-1] += p
		} else {
			lines = append(lines, p)
		}
	}
	return lines
}

var lineDiffer = differ{
	equals: func(a, b string) bool { return a == b },
	join:   func(tokens []string) string { return strings.Join(tokens, "") },
}

// DiffLines is jsdiff's diffLines(oldStr, newStr) with no options.
func DiffLines(oldStr, newStr string) []*Change {
	return lineDiffer.diff(tokenizeLines(oldStr), tokenizeLines(newStr))
}

// isExtendedWordChar is jsdiff's extendedWordChars class.
func isExtendedWordChar(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		return true
	case r >= 0xC0 && r <= 0xFF, r >= 0xD8 && r <= 0xF6, r >= 0xF8 && r <= 0x2C6,
		r >= 0x2C8 && r <= 0x2D7, r >= 0x2DE && r <= 0x2FF, r >= 0x1E00 && r <= 0x1EFF:
		return true
	}
	return false
}

// wordParts is value.match(tokenizeIncludingWhitespace): word runs,
// whitespace runs, and single other code points.
func wordParts(value string) []string {
	var parts []string
	for i := 0; i < len(value); {
		r, size := utf8.DecodeRuneInString(value[i:])
		j := i + size
		switch {
		case isExtendedWordChar(r):
			for j < len(value) {
				r2, s2 := utf8.DecodeRuneInString(value[j:])
				if !isExtendedWordChar(r2) {
					break
				}
				j += s2
			}
		case jsstr.IsJSSpace(r):
			for j < len(value) {
				r2, s2 := utf8.DecodeRuneInString(value[j:])
				if !jsstr.IsJSSpace(r2) {
					break
				}
				j += s2
			}
		}
		parts = append(parts, value[i:j])
		i = j
	}
	return parts
}

func hasSpace(s string) bool { return strings.IndexFunc(s, jsstr.IsJSSpace) >= 0 }

// tokenizeWords is wordDiff.tokenize: whitespace stitched onto neighbours.
func tokenizeWords(value string) []string {
	var tokens []string
	prev, havePrev := "", false
	for _, part := range wordParts(value) {
		switch {
		case hasSpace(part):
			if !havePrev {
				tokens = append(tokens, part)
			} else {
				tokens[len(tokens)-1] += part
			}
		case havePrev && hasSpace(prev):
			if tokens[len(tokens)-1] == prev {
				tokens[len(tokens)-1] += part
			} else {
				tokens = append(tokens, prev+part)
			}
		default:
			tokens = append(tokens, part)
		}
		prev, havePrev = part, true
	}
	return tokens
}

func trimLeftSpace(s string) string { return strings.TrimLeftFunc(s, jsstr.IsJSSpace) }

func leadingSpace(s string) string { return s[:len(s)-len(trimLeftSpace(s))] }

func trailingSpace(s string) string { return s[len(jsstr.TrimEnd(s)):] }

var wordDiffer = differ{
	equals: func(a, b string) bool { return jsstr.Trim(a) == jsstr.Trim(b) },
	join: func(tokens []string) string {
		var b strings.Builder
		for i, t := range tokens {
			if i == 0 {
				b.WriteString(t)
			} else {
				b.WriteString(trimLeftSpace(t))
			}
		}
		return b.String()
	},
}

// DiffWords is jsdiff's diffWords(oldStr, newStr) with no options.
func DiffWords(oldStr, newStr string) []*Change {
	changes := wordDiffer.diff(tokenizeWords(oldStr), tokenizeWords(newStr))
	var lastKeep, insertion, deletion *Change
	for _, c := range changes {
		switch {
		case c.Added:
			insertion = c
		case c.Removed:
			deletion = c
		default:
			if insertion != nil || deletion != nil {
				dedupeWhitespace(lastKeep, deletion, insertion, c)
			}
			lastKeep, insertion, deletion = c, nil, nil
		}
	}
	if insertion != nil || deletion != nil {
		dedupeWhitespace(lastKeep, deletion, insertion, nil)
	}
	return changes
}

func longestCommonPrefix(a, b string) string {
	ua, ub := jsstr.Units(a), jsstr.Units(b)
	i := 0
	for i < len(ua) && i < len(ub) && ua[i] == ub[i] {
		i++
	}
	return jsstr.Slice(a, 0, i)
}

func longestCommonSuffix(a, b string) string {
	ua, ub := jsstr.Units(a), jsstr.Units(b)
	if len(ua) == 0 || len(ub) == 0 || ua[len(ua)-1] != ub[len(ub)-1] {
		return ""
	}
	i := 0
	for i < len(ua) && i < len(ub) && ua[len(ua)-1-i] == ub[len(ub)-1-i] {
		i++
	}
	return jsstr.SliceFrom(a, len(ua)-i)
}

func replacePrefix(s, oldPrefix, newPrefix string) string {
	return newPrefix + strings.TrimPrefix(s, oldPrefix)
}

func replaceSuffix(s, oldSuffix, newSuffix string) string {
	if oldSuffix == "" {
		return s + newSuffix
	}
	return strings.TrimSuffix(s, oldSuffix) + newSuffix
}

// overlapCount is jsdiff's overlapCount (KMP), in UTF-16 units.
func overlapCount(sa, sb string) int {
	a, b := jsstr.Units(sa), jsstr.Units(sb)
	startA := 0
	if len(a) > len(b) {
		startA = len(a) - len(b)
	}
	endB := len(b)
	if len(a) < len(b) {
		endB = len(a)
	}
	if endB == 0 {
		return 0
	}
	m := make([]int, endB)
	k := 0
	for j := 1; j < endB; j++ {
		if b[j] == b[k] {
			m[j] = m[k]
		} else {
			m[j] = k
		}
		for k > 0 && b[j] != b[k] {
			k = m[k]
		}
		if b[j] == b[k] {
			k++
		}
	}
	k = 0
	for i := startA; i < len(a); i++ {
		for k > 0 && a[i] != b[k] {
			k = m[k]
		}
		if a[i] == b[k] {
			k++
		}
	}
	return k
}

func maximumOverlap(a, b string) string { return jsstr.Slice(b, 0, overlapCount(a, b)) }

// dedupeWhitespace is jsdiff's dedupeWhitespaceInChangeObjects.
func dedupeWhitespace(startKeep, deletion, insertion, endKeep *Change) {
	switch {
	case deletion != nil && insertion != nil:
		oldPrefix, oldSuffix := leadingSpace(deletion.Value), trailingSpace(deletion.Value)
		newPrefix, newSuffix := leadingSpace(insertion.Value), trailingSpace(insertion.Value)
		if startKeep != nil {
			common := longestCommonPrefix(oldPrefix, newPrefix)
			startKeep.Value = replaceSuffix(startKeep.Value, newPrefix, common)
			deletion.Value = strings.TrimPrefix(deletion.Value, common)
			insertion.Value = strings.TrimPrefix(insertion.Value, common)
		}
		if endKeep != nil {
			common := longestCommonSuffix(oldSuffix, newSuffix)
			endKeep.Value = replacePrefix(endKeep.Value, newSuffix, common)
			deletion.Value = strings.TrimSuffix(deletion.Value, common)
			insertion.Value = strings.TrimSuffix(insertion.Value, common)
		}
	case insertion != nil:
		if startKeep != nil {
			insertion.Value = trimLeftSpace(insertion.Value)
		}
		if endKeep != nil {
			endKeep.Value = trimLeftSpace(endKeep.Value)
		}
	case startKeep != nil && endKeep != nil:
		newFull := leadingSpace(endKeep.Value)
		delStart, delEnd := leadingSpace(deletion.Value), trailingSpace(deletion.Value)
		newStart := longestCommonPrefix(newFull, delStart)
		deletion.Value = strings.TrimPrefix(deletion.Value, newStart)
		newEnd := longestCommonSuffix(strings.TrimPrefix(newFull, newStart), delEnd)
		deletion.Value = strings.TrimSuffix(deletion.Value, newEnd)
		endKeep.Value = replacePrefix(endKeep.Value, newFull, newEnd)
		startKeep.Value = replaceSuffix(startKeep.Value, newFull, newFull[:len(newFull)-len(newEnd)])
	case endKeep != nil:
		overlap := maximumOverlap(trailingSpace(deletion.Value), leadingSpace(endKeep.Value))
		deletion.Value = strings.TrimSuffix(deletion.Value, overlap)
	case startKeep != nil:
		overlap := maximumOverlap(trailingSpace(startKeep.Value), leadingSpace(deletion.Value))
		deletion.Value = strings.TrimPrefix(deletion.Value, overlap)
	}
}

// Hunk is one structuredPatch hunk.
type Hunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

// Patch is structuredPatch's result. Headers are nil when undefined.
type Patch struct {
	OldFileName string  `json:"oldFileName"`
	NewFileName string  `json:"newFileName"`
	OldHeader   *string `json:"oldHeader,omitempty"`
	NewHeader   *string `json:"newHeader,omitempty"`
	Hunks       []Hunk  `json:"hunks"`
}

// splitLines is jsdiff's splitLines: lines with their trailing "\n".
func splitLines(text string) []string {
	parts := strings.Split(text, "\n")
	for i := range parts {
		parts[i] += "\n"
	}
	if strings.HasSuffix(text, "\n") {
		return parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	parts[len(parts)-1] = last[:len(last)-1]
	return parts
}

// StructuredPatch is jsdiff's structuredPatch with options.context (4 when
// context < 0, jsdiff's default for an undefined context).
func StructuredPatch(oldFileName, newFileName, oldStr, newStr string, oldHeader, newHeader *string, context int) Patch {
	if context < 0 {
		context = 4
	}
	type entry struct {
		added, removed bool
		lines          []string
	}
	changes := DiffLines(oldStr, newStr)
	diff := make([]entry, 0, len(changes)+1)
	for _, c := range changes {
		diff = append(diff, entry{c.Added, c.Removed, splitLines(c.Value)})
	}
	diff = append(diff, entry{lines: []string{}})
	contextLines := func(lines []string) []string {
		out := make([]string, len(lines))
		for i, l := range lines {
			out[i] = " " + l
		}
		return out
	}
	var hunks []Hunk
	oldRangeStart, newRangeStart := 0, 0
	var curRange []string
	oldLine, newLine := 1, 1
	for i := range diff {
		current := diff[i]
		lines := current.lines
		if current.added || current.removed {
			if oldRangeStart == 0 {
				oldRangeStart, newRangeStart = oldLine, newLine
				if i > 0 {
					prev := diff[i-1].lines
					curRange = []string{}
					if context > 0 {
						from := max(0, len(prev)-context)
						curRange = contextLines(prev[from:])
					}
					oldRangeStart -= len(curRange)
					newRangeStart -= len(curRange)
				}
			}
			sign := "-"
			if current.added {
				sign = "+"
			}
			for _, l := range lines {
				curRange = append(curRange, sign+l)
			}
			if current.added {
				newLine += len(lines)
			} else {
				oldLine += len(lines)
			}
			continue
		}
		if oldRangeStart != 0 {
			if len(lines) <= context*2 && i < len(diff)-2 {
				curRange = append(curRange, contextLines(lines)...)
			} else {
				size := min(len(lines), context)
				curRange = append(curRange, contextLines(lines[:size])...)
				hunks = append(hunks, Hunk{
					OldStart: oldRangeStart, OldLines: oldLine - oldRangeStart + size,
					NewStart: newRangeStart, NewLines: newLine - newRangeStart + size,
					Lines: curRange,
				})
				oldRangeStart, newRangeStart = 0, 0
				curRange = nil
			}
		}
		oldLine += len(lines)
		newLine += len(lines)
	}
	for h := range hunks {
		var out []string
		for _, l := range hunks[h].Lines {
			if strings.HasSuffix(l, "\n") {
				out = append(out, l[:len(l)-1])
			} else {
				out = append(out, l, `\ No newline at end of file`)
			}
		}
		if out == nil {
			out = []string{}
		}
		hunks[h].Lines = out
	}
	if hunks == nil {
		hunks = []Hunk{}
	}
	return Patch{OldFileName: oldFileName, NewFileName: newFileName, OldHeader: oldHeader, NewHeader: newHeader, Hunks: hunks}
}

// FormatPatch is jsdiff's formatPatch for one patch.
func FormatPatch(p Patch) string {
	var ret []string
	if p.OldFileName == p.NewFileName {
		ret = append(ret, "Index: "+p.OldFileName)
	}
	ret = append(ret, "===================================================================")
	header := func(h *string) string {
		if h == nil {
			return ""
		}
		return "\t" + *h
	}
	ret = append(ret, "--- "+p.OldFileName+header(p.OldHeader), "+++ "+p.NewFileName+header(p.NewHeader))
	for _, h := range p.Hunks {
		oldStart, newStart := h.OldStart, h.NewStart
		if h.OldLines == 0 {
			oldStart--
		}
		if h.NewLines == 0 {
			newStart--
		}
		ret = append(ret, "@@ -"+strconv.Itoa(oldStart)+","+strconv.Itoa(h.OldLines)+" +"+strconv.Itoa(newStart)+","+strconv.Itoa(h.NewLines)+" @@")
		ret = append(ret, h.Lines...)
	}
	return strings.Join(ret, "\n") + "\n"
}

// CreateTwoFilesPatch is jsdiff's createTwoFilesPatch.
func CreateTwoFilesPatch(oldFileName, newFileName, oldStr, newStr string, oldHeader, newHeader *string, context int) string {
	return FormatPatch(StructuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, context))
}

// CreatePatch is jsdiff's createPatch.
func CreatePatch(fileName, oldStr, newStr string, oldHeader, newHeader *string, context int) string {
	return CreateTwoFilesPatch(fileName, fileName, oldStr, newStr, oldHeader, newHeader, context)
}
