package difftools

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsdiff"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/xxhash32"
)

// Hashline anchors (hashline.ts): 3-char URL-safe base64 of xxHash32 over
// the canonical line (CR and trailing blanks removed), with ":R<n>" for
// collisions.
const (
	hashDict = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	hashLen  = 3
	hashMod  = 64 * 64 * 64
	// HashSep is the anchor separator U+2502.
	HashSep = "\u2502"
)

var trailingBlankRe = regexp.MustCompile(`[ \t]+$`)

func canonicalize(line string) string {
	line = strings.TrimSuffix(line, "\r")
	return trailingBlankRe.ReplaceAllString(line, "")
}

func toDict(n uint32) string {
	var b [hashLen]byte
	for i := hashLen - 1; i >= 0; i-- {
		b[i] = hashDict[n&63]
		n >>= 6
	}
	return string(b[:])
}

// HashLines ports hashLines: one anchor per line.
func HashLines(content string) ([]string, error) {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(content, "\n")
	hashes := make([]string, 0, len(lines))
	seen := map[string]bool{}
	for _, line := range lines {
		canon := canonicalize(line)
		hash := toDict(xxhash32.Sum(canon, 0) % hashMod)
		if seen[hash] {
			resolved := ""
			for retry := 1; retry < 1000; retry++ {
				candidate := toDict(xxhash32.Sum(canon, uint32(retry))%hashMod) + ":R" + strconv.Itoa(retry)
				if !seen[candidate] {
					resolved = candidate
					break
				}
			}
			if resolved == "" {
				return nil, fmt.Errorf("[E_HASH_COLLISION] cannot resolve collision for line: %s", jsstr.Slice16(canon, 80))
			}
			hash = resolved
		}
		seen[hash] = true
		hashes = append(hashes, hash)
	}
	return hashes, nil
}

// ParseAnchor ports parseAnchor: the anchor before "│", trimmed.
func ParseAnchor(ref string) string {
	if i := strings.Index(ref, HashSep); i >= 0 {
		ref = ref[:i]
	}
	return jsTrim(ref)
}

// AnchorSuggestion is a nearby line for a stale anchor.
type AnchorSuggestion struct {
	Line int    `json:"line"`
	Ref  string `json:"ref"`
}

// AnchorResolve is resolveAnchor's result.
type AnchorResolve struct {
	OK          bool               `json:"ok"`
	Line        int                `json:"line,omitempty"`
	Error       string             `json:"error,omitempty"`
	Ref         string             `json:"ref"`
	Suggestions []AnchorSuggestion `json:"suggestions,omitempty"`
}

// ResolveAnchor ports resolveAnchor.
func ResolveAnchor(ref string, hashes []string) AnchorResolve {
	if ref == "" {
		return AnchorResolve{Error: "empty", Ref: ref}
	}
	var matches []int
	for i, h := range hashes {
		if h == ref {
			matches = append(matches, i)
		}
	}
	switch len(matches) {
	case 1:
		return AnchorResolve{OK: true, Line: matches[0], Ref: ref}
	case 0:
		suggestions := []AnchorSuggestion{}
		for i, h := range hashes {
			if len(suggestions) >= 5 {
				break
			}
			if jsstr.Len16(h) >= 3 && (strings.HasPrefix(h, ref) || strings.HasPrefix(ref, jsstr.Slice16(h, 3))) {
				suggestions = append(suggestions, AnchorSuggestion{i, h})
			}
		}
		return AnchorResolve{Error: "not_found", Ref: ref, Suggestions: suggestions}
	}
	return AnchorResolve{Error: "ambiguous", Ref: ref}
}

// formatAnchorFailureMessage ports formatAnchorFailureMessage.
func formatAnchorFailureMessage(role, refRaw string, fail AnchorResolve, filePath string) string {
	reason := "not found (file changed since hashline_read)"
	switch fail.Error {
	case "ambiguous":
		reason = "ambiguous (multiple lines share this anchor)"
	case "empty":
		reason = "empty anchor"
	}
	msg := "[E_STALE_ANCHOR] " + role + " anchor " + jsstr.QuoteJS(refRaw) + " — " + reason + "."
	rereadStart, rereadEnd := 1, ""
	if len(fail.Suggestions) > 0 {
		hints := make([]string, len(fail.Suggestions))
		lo, hi := math.MaxInt, math.MinInt
		for i, s := range fail.Suggestions {
			hints[i] = fmt.Sprintf("line %d ref %s", s.Line+1, s.Ref)
			lo, hi = min(lo, s.Line+1), max(hi, s.Line+1)
		}
		msg += " Nearby: " + strings.Join(hints, "; ") + "."
		rereadStart, rereadEnd = max(1, lo-2), strconv.Itoa(hi+2)
	}
	msg += " Next: hashline_read path=" + jsstr.QuoteJS(filePath) + " startLine=" + strconv.Itoa(rereadStart)
	if rereadEnd != "" {
		msg += " endLine=" + rereadEnd
	}
	return msg + "."
}

// HashlineEdit is hashline.ts HashlineEdit.
type HashlineEdit struct {
	HashRangeInclusive [2]string `json:"hash_range_inclusive"`
	ContentLines       []string  `json:"content_lines"`
}

// HashlineApply is applyHashlineEdits' result (ok or error shape).
type HashlineApply struct {
	OK               bool               `json:"ok"`
	NewContent       string             `json:"newContent,omitempty"`
	ChangedRange     *[2]int            `json:"changedRange,omitempty"`
	BoundaryWarnings []string           `json:"boundaryWarnings,omitempty"`
	Error            string             `json:"error,omitempty"`
	Code             string             `json:"code,omitempty"`
	Ref              *string            `json:"ref,omitempty"`
	Suggestions      []AnchorSuggestion `json:"suggestions,omitempty"`
	// FinalRaw is the on-disk text (BOM and line endings restored) of
	// applyHashlineEditsToFile.
	FinalRaw string `json:"finalRaw,omitempty"`
	finalSet bool
}

// ApplyHashlineEdits ports applyHashlineEdits.
func ApplyHashlineEdits(fileContent string, changes []HashlineEdit, filePath string) HashlineApply {
	if len(changes) == 0 {
		return HashlineApply{OK: true, NewContent: fileContent, ChangedRange: &[2]int{0, -1}, BoundaryWarnings: []string{}}
	}
	hashes, err := HashLines(fileContent)
	if err != nil {
		return HashlineApply{Error: err.Error(), Code: "E_HASH_COLLISION"}
	}
	type resolved struct {
		start, end int
		change     HashlineEdit
	}
	var rs []resolved
	for _, c := range changes {
		startRaw, endRaw := c.HashRangeInclusive[0], c.HashRangeInclusive[1]
		s := ResolveAnchor(ParseAnchor(startRaw), hashes)
		if !s.OK {
			return HashlineApply{Error: formatAnchorFailureMessage("start", startRaw, s, filePath), Code: "E_STALE_ANCHOR", Ref: &startRaw, Suggestions: s.Suggestions}
		}
		e := ResolveAnchor(ParseAnchor(endRaw), hashes)
		if !e.OK {
			return HashlineApply{Error: formatAnchorFailureMessage("end", endRaw, e, filePath), Code: "E_STALE_ANCHOR", Ref: &endRaw, Suggestions: e.Suggestions}
		}
		if e.Line < s.Line {
			return HashlineApply{Error: fmt.Sprintf(`[E_BAD_RANGE] end anchor "%s" (line %d) is before start anchor "%s" (line %d).`, endRaw, e.Line+1, startRaw, s.Line+1), Code: "E_BAD_RANGE"}
		}
		rs = append(rs, resolved{s.Line, e.Line, c})
	}
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].start > rs[j].start })
	for i := 1; i < len(rs); i++ {
		prev, curr := rs[i-1], rs[i]
		if curr.end >= prev.start {
			return HashlineApply{Error: fmt.Sprintf("[E_OVERLAP] edit ranges overlap. After sorting, range %d (lines %d-%d) overlaps range %d (lines %d-%d). Each 'changes' entry must affect a disjoint line range.",
				i, curr.start+1, curr.end+1, i-1, prev.start+1, prev.end+1), Code: "E_OVERLAP"}
		}
	}
	working := strings.Split(fileContent, "\n")
	minChanged, maxChanged := len(working), -1
	for _, r := range rs {
		newLines := r.change.ContentLines
		if len(newLines) > 0 {
			if r.start > 0 && working[r.start-1] == newLines[0] {
				return HashlineApply{Error: fmt.Sprintf("[E_BOUNDARY_DUP] first replacement line duplicates the line just before the range (line %d). Remove line %s from the start of content_lines.", r.start, jsstr.QuoteJS(newLines[0])), Code: "E_BOUNDARY_DUP"}
			}
			if r.end < len(working)-1 && working[r.end+1] == newLines[len(newLines)-1] {
				return HashlineApply{Error: fmt.Sprintf("[E_BOUNDARY_DUP] last replacement line duplicates the line just after the range (line %d). Remove line %s from the end of content_lines.", r.end+2, jsstr.QuoteJS(newLines[len(newLines)-1])), Code: "E_BOUNDARY_DUP"}
			}
		}
		next := append([]string{}, working[:r.start]...)
		next = append(next, newLines...)
		working = append(next, working[r.end+1:]...)
		minChanged = min(minChanged, r.start)
		maxChanged = max(maxChanged, r.start+len(newLines)-1)
	}
	return HashlineApply{OK: true, NewContent: strings.Join(working, "\n"), ChangedRange: &[2]int{minChanged, maxChanged}, BoundaryWarnings: []string{}}
}

// HashlineRead is formatHashlineReadLines' result.
type HashlineRead struct {
	Text      string
	LineCount int
	StartLine int
	EndLine   int
}

// FormatHashlineReadLines ports formatHashlineReadLines. endLine <= 0 is Infinity.
func FormatHashlineReadLines(fileContent string, startLine, endLine int) (HashlineRead, error) {
	lines := strings.Split(fileContent, "\n")
	hashes, err := HashLines(fileContent)
	if err != nil {
		return HashlineRead{}, err
	}
	startIdx := max(0, startLine-1)
	endIdx := len(lines)
	if endLine > 0 {
		endIdx = min(len(lines), endLine)
	}
	var out []string
	for i := startIdx; i < endIdx; i++ {
		n := strconv.Itoa(i + 1)
		pad := ""
		if len(n) < 6 {
			pad = strings.Repeat(" ", 6-len(n))
		}
		hash := ""
		if i < len(hashes) {
			hash = hashes[i]
		}
		out = append(out, pad+n+HashSep+hash+HashSep+lines[i])
	}
	return HashlineRead{Text: strings.Join(out, "\n"), LineCount: len(out), StartLine: startLine, EndLine: endIdx}, nil
}

// ApplyHashlineEditsToFile ports applyHashlineEditsToFile. raw is the
// already-read file text, or nil to read it.
func ApplyHashlineEditsToFile(filePath string, changes []HashlineEdit, dryRun bool, raw *string) HashlineApply {
	var text string
	if raw != nil {
		text = *raw
	} else {
		data, err := os.ReadFile(filePath)
		if err != nil {
			return HashlineApply{Error: "[E_READ_FAILED] cannot read " + filePath + ": " + nodeError(err, "open", filePath), Code: "E_READ_FAILED"}
		}
		text = string(data)
	}
	bom, ending, normalized := PrepareTextForHashlineEdit(text)
	result := ApplyHashlineEdits(normalized, changes, filePath)
	if !result.OK {
		return result
	}
	finalRaw := FinalizeHashlineWriteContent(bom, ending, result.NewContent)
	if !dryRun {
		if err := atomicWriteFile(filePath, finalRaw, 0, "pi-hashline"); err != nil {
			return HashlineApply{Error: "[E_WRITE_FAILED] cannot write " + filePath + ": " + err.Error(), Code: "E_WRITE_FAILED"}
		}
	}
	result.FinalRaw, result.finalSet = finalRaw, true
	return result
}

// HashlineToolResult is hashline-execute.ts HashlineToolResult.
type HashlineToolResult struct {
	Text    string
	IsError bool
	Details map[string]any
}

// buildHashlineDiff ports hashline-execute.ts buildDiff.
func buildHashlineDiff(before, after, fp string) *ParsedDiff {
	if before == after {
		return nil
	}
	b, a := "before", "after"
	parsed := ParsePatchFiles(jsdiff.CreatePatch(fp, before, after, &b, &a, 3))
	if len(parsed) == 0 {
		return nil
	}
	return &parsed[0]
}

// RunHashlineEdit ports runHashlineEdit.
func RunHashlineEdit(fp string, changes []HashlineEdit, dryRun bool) HashlineToolResult {
	before := ""
	var raw *string
	if data, err := os.ReadFile(fp); err == nil {
		before = string(data)
		raw = &before
	}
	result := ApplyHashlineEditsToFile(fp, changes, dryRun, raw)
	if !result.OK {
		details := map[string]any{"_type": "hashlineEditError", "path": fp, "code": result.Code}
		if result.Ref != nil {
			details["ref"] = *result.Ref
		}
		if result.Suggestions != nil {
			details["suggestions"] = result.Suggestions
		}
		next := "hashline_read path=" + jsstr.QuoteJS(fp)
		if len(result.Suggestions) > 0 {
			lo, hi := math.MaxInt, math.MinInt
			for _, s := range result.Suggestions {
				lo, hi = min(lo, s.Line+1), max(hi, s.Line+1)
			}
			hint := map[string]any{"path": fp, "startLine": max(1, lo-2), "endLine": hi + 2}
			details["hashlineRereadHint"] = hint
			next += fmt.Sprintf(" startLine=%d endLine=%d", max(1, lo-2), hi+2)
		}
		details["nextStep"] = next
		return HashlineToolResult{Text: result.Error, IsError: true, Details: details}
	}
	after := result.FinalRaw
	diff := buildHashlineDiff(before, after, fp)
	start, end := result.ChangedRange[0]+1, result.ChangedRange[1]+1
	prefix, verb := "[OK]", "edited"
	kind := "hashlineEditInfo"
	if dryRun {
		prefix, verb, kind = "[DRY-RUN]", "would edit", "hashlineEditDryRun"
	}
	text := fmt.Sprintf("%s %s %s (lines %d-%d)", prefix, fp, verb, start, end)
	if w := result.BoundaryWarnings; len(w) > 0 {
		text += fmt.Sprintf("\n[%d boundary warning(s)]\n%s", len(w), strings.Join(w, "\n"))
	}
	var diffValue any
	if diff != nil {
		diffValue = diff
	}
	return HashlineToolResult{Text: text, Details: map[string]any{
		"_type": kind, "path": fp, "diff": diffValue, "dryRun": dryRun, "result": result, "before": before,
	}}
}

// ExecuteHashlineRead ports executeHashlineRead.
func ExecuteHashlineRead(fp, content string, startLine, endLine int) (HashlineToolResult, error) {
	r, err := FormatHashlineReadLines(content, startLine, endLine)
	if err != nil {
		return HashlineToolResult{}, err
	}
	return HashlineToolResult{Text: r.Text, Details: map[string]any{
		"_type": "hashlineReadInfo", "path": fp, "lineCount": r.LineCount, "startLine": r.StartLine, "endLine": r.EndLine,
	}}, nil
}

// MarshalJSON writes the ok or error shape of the TypeScript result.
func (h HashlineApply) MarshalJSON() ([]byte, error) {
	if h.OK {
		out := map[string]any{"ok": true, "newContent": h.NewContent, "changedRange": h.ChangedRange, "boundaryWarnings": h.BoundaryWarnings}
		if h.FinalRaw != "" || h.finalSet {
			out["finalRaw"] = h.FinalRaw
		}
		return json.Marshal(out)
	}
	out := map[string]any{"ok": false, "error": h.Error, "code": h.Code}
	if h.Ref != nil {
		out["ref"] = *h.Ref
	}
	if h.Suggestions != nil {
		out["suggestions"] = h.Suggestions
	}
	return json.Marshal(out)
}
