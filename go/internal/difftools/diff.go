// Package difftools is the Go port of diff-tools: the write, edit, and
// apply_patch tools, the cascading replace engine, apply_patch parsing and
// application, merge-conflict parsing, BOM/CRLF handling, hashline anchors,
// mutation previews for approval prompts, the edit guard, the pi-diff.json
// config, the git review helpers, the diff renderers, and the approval
// overlay. It does not import the PiG SDK; go/aio/difftools.go wires it.
//
// The TypeScript code measures strings in UTF-16 code units. Functions that
// only cut a string at positions they found in the same string use Go byte
// offsets, which give the same result. Lengths that leave the package
// (counts, similarity, chars) use jsstr.Len16.
package difftools

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsdiff"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// jsSpaceClass is JavaScript's \s inside a character class.
const jsSpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsDot is JavaScript's "." without the s flag.
const jsDot = `[^\n\r\x{2028}\x{2029}]`

// HunkMeta is hunk metadata attached to separator lines.
type HunkMeta struct {
	OldStart int     `json:"oldStart"`
	OldLines int     `json:"oldLines"`
	NewStart int     `json:"newStart"`
	NewLines int     `json:"newLines"`
	Context  *string `json:"context,omitempty"`
}

// DiffLine is one rendered diff row. OldNum/NewNum nil is null.
type DiffLine struct {
	Type     string    `json:"type"`
	OldNum   *int      `json:"oldNum"`
	NewNum   *int      `json:"newNum"`
	Content  string    `json:"content"`
	HunkMeta *HunkMeta `json:"hunkMeta,omitempty"`
}

// ParsedDiff is core/diff.ts ParsedDiff.
type ParsedDiff struct {
	Lines   []DiffLine `json:"lines"`
	Added   int        `json:"added"`
	Removed int        `json:"removed"`
	Chars   int        `json:"chars"`
}

func intp(n int) *int { return &n }

var hunkHeaderRe = regexp.MustCompile(`^@@[` + jsSpaceClass + `]+-(\d+)(?:,(\d+))?[` + jsSpaceClass + `]+\+(\d+)(?:,(\d+))?[` + jsSpaceClass + `]+@@(?:[` + jsSpaceClass + `]+(` + jsDot + `*))?$`)

// parseHunkHeader ports core/diff.ts parseHunkHeader.
func parseHunkHeader(line string) *HunkMeta {
	m := hunkHeaderRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	num := func(s string, fallback int) int {
		if s == "" {
			return fallback
		}
		n, _ := strconv.Atoi(s)
		return n
	}
	meta := &HunkMeta{OldStart: num(m[1], 0), OldLines: num(m[2], 1), NewStart: num(m[3], 0), NewLines: num(m[4], 1)}
	if ctx := jsstr.Trim(m[5]); ctx != "" {
		meta.Context = &ctx
	}
	return meta
}

var patchMetaRe = regexp.MustCompile(`^(---|\+\+\+|diff --git|index |new file|old mode|new mode|deleted|rename|similarity|copy)`)

// parseOneFile ports core/diff.ts parseOneFile.
func parseOneFile(lines []string) *ParsedDiff {
	var all []DiffLine
	added, removed := 0, 0
	nonSep := 0
	for i := 0; i < len(lines); {
		hdr := parseHunkHeader(lines[i])
		if hdr == nil {
			i++
			continue
		}
		sep := DiffLine{Type: "sep", HunkMeta: hdr}
		if len(all) == 0 || nonSep > 0 {
			all = append(all, sep)
		} else {
			all[len(all)-1] = sep
		}
		oL, nL := hdr.OldStart, hdr.NewStart
		i++
		for i < len(lines) {
			line := lines[i]
			if strings.HasPrefix(line, "@@") {
				break
			}
			if strings.HasPrefix(line, `\ `) || patchMetaRe.MatchString(line) {
				i++
				continue
			}
			switch {
			case line == "" || line[0] == ' ':
				all = append(all, DiffLine{Type: "ctx", OldNum: intp(oL), NewNum: intp(nL), Content: sliceFirst(line)})
				oL++
				nL++
				nonSep++
			case line[0] == '+':
				all = append(all, DiffLine{Type: "add", NewNum: intp(nL), Content: line[1:]})
				nL++
				added++
				nonSep++
			case line[0] == '-':
				all = append(all, DiffLine{Type: "del", OldNum: intp(oL), Content: line[1:]})
				oL++
				removed++
				nonSep++
			}
			i++
		}
	}
	if len(all) == 0 {
		return nil
	}
	chars := 0
	for _, l := range all {
		if l.Type != "sep" {
			chars += jsstr.Len16(l.Content)
		}
	}
	return &ParsedDiff{Lines: all, Added: added, Removed: removed, Chars: chars}
}

func sliceFirst(s string) string {
	if s == "" {
		return ""
	}
	return s[1:]
}

// ParsePatchFiles ports core/diff.ts parsePatchFiles.
func ParsePatchFiles(patch string) []ParsedDiff {
	if jsstr.Trim(patch) == "" {
		return []ParsedDiff{}
	}
	lines := strings.Split(patch, "\n")
	var sections [][]string
	var cur []string
	for _, l := range lines {
		if strings.HasPrefix(l, "diff --git ") || (strings.HasPrefix(l, "--- ") && len(cur) > 0 && strings.HasPrefix(cur[0], "+++")) {
			if len(cur) > 0 {
				sections = append(sections, cur)
			}
			cur = nil
		}
		cur = append(cur, l)
	}
	if len(cur) > 0 {
		sections = append(sections, cur)
	}
	var result []ParsedDiff
	for _, sec := range sections {
		if parsed := parseOneFile(sec); parsed != nil {
			result = append(result, *parsed)
		}
	}
	if len(result) > 0 {
		return result
	}
	if parsed := parseOneFile(lines); parsed != nil {
		return []ParsedDiff{*parsed}
	}
	return []ParsedDiff{{Lines: []DiffLine{}}}
}

// Hunk separator styles.
var sepStyles = map[string]bool{"auto": true, "simple": true, "gap": true, "context": true, "metadata": true}

// ResolveSepStyle ports resolveSepStyle: PI_DIFF_SEP_STYLE or "auto".
func ResolveSepStyle(env string) string {
	if sepStyles[env] {
		return env
	}
	return "auto"
}

func gapLabel(gap *int) (int, bool) {
	if gap != nil && *gap > 0 {
		return *gap, true
	}
	return 0, false
}

// SepLabelUnified ports sepLabelUnified.
func SepLabelUnified(style string, meta *HunkMeta, gap *int, content string) string {
	if content != "" {
		return " " + content + " "
	}
	ctx := ""
	if meta != nil && meta.Context != nil {
		ctx = *meta.Context
	}
	g, hasGap := gapLabel(gap)
	gs := strconv.Itoa(g)
	switch style {
	case "simple":
		return ""
	case "gap":
		if hasGap {
			return " " + gs + " unmodified lines "
		}
		return ""
	case "context":
		if ctx != "" {
			return " " + ctx + " "
		}
		if hasGap {
			return " " + gs + " unmodified lines "
		}
		return ""
	case "metadata":
		if ctx != "" {
			return " " + ctx + " "
		}
		if hasGap {
			return " +" + gs + " lines "
		}
		return ""
	}
	if ctx != "" && hasGap {
		return " " + ctx + " — +" + gs + " lines "
	}
	if ctx != "" {
		return " " + ctx + " "
	}
	if hasGap {
		return " +" + gs + " lines "
	}
	return ""
}

// SepLabelSplit ports sepLabelSplit.
func SepLabelSplit(style string, meta *HunkMeta, gap *int, content string) string {
	if content != "" {
		return content
	}
	ctx := ""
	if meta != nil && meta.Context != nil {
		ctx = *meta.Context
	}
	g, hasGap := gapLabel(gap)
	gs := strconv.Itoa(g)
	switch style {
	case "simple":
		return ""
	case "gap":
		if hasGap {
			return " " + gs + " lines "
		}
		return ""
	case "context":
		if ctx != "" && hasGap {
			return " " + ctx + " — " + gs + " lines "
		}
		if ctx != "" {
			return " " + ctx + " "
		}
		if hasGap {
			return " " + gs + " lines "
		}
		return ""
	case "metadata":
		if ctx != "" {
			return " " + ctx + " "
		}
		if hasGap {
			return " " + gs + " lines "
		}
		return ""
	}
	if ctx != "" && hasGap {
		return " " + ctx + " — +" + gs + " lines "
	}
	if ctx != "" {
		return " " + ctx + " "
	}
	if hasGap {
		return " +" + gs + " lines "
	}
	return ""
}

// HunkBlock is a group of deletions followed by additions.
type HunkBlock struct {
	Deletions []DiffLine `json:"deletions"`
	Additions []DiffLine `json:"additions"`
}

// ComputeHunkBlocks ports computeHunkBlocks.
func ComputeHunkBlocks(diff ParsedDiff) []HunkBlock {
	blocks := []HunkBlock{}
	lines := diff.Lines
	for i := 0; i < len(lines); {
		if lines[i].Type == "sep" || lines[i].Type == "ctx" {
			i++
			continue
		}
		dels, adds := []DiffLine{}, []DiffLine{}
		for i < len(lines) && lines[i].Type == "del" {
			dels = append(dels, lines[i])
			i++
		}
		for i < len(lines) && lines[i].Type == "add" {
			adds = append(adds, lines[i])
			i++
		}
		if len(dels) == 0 && len(adds) == 0 {
			continue
		}
		blocks = append(blocks, HunkBlock{dels, adds})
	}
	return blocks
}

// ParseDiff ports core/diff.ts parseDiff (structuredPatch with context ctx).
func ParseDiff(oldContent, newContent string, ctx int) ParsedDiff {
	patch := jsdiff.StructuredPatch("", "", oldContent, newContent, strp(""), strp(""), ctx)
	lines := []DiffLine{}
	added, removed := 0, 0
	for hi, h := range patch.Hunks {
		meta := &HunkMeta{OldStart: h.OldStart, OldLines: h.OldLines, NewStart: h.NewStart, NewLines: h.NewLines}
		sep := DiffLine{Type: "sep", HunkMeta: meta}
		if hi > 0 {
			prev := patch.Hunks[hi-1]
			if gap := h.OldStart - (prev.OldStart + prev.OldLines); gap > 0 {
				sep.NewNum = intp(gap)
			}
		}
		lines = append(lines, sep)
		oL, nL := h.OldStart, h.NewStart
		for _, raw := range h.Lines {
			if raw == `\ No newline at end of file` {
				continue
			}
			ch, text := byte(0), ""
			if raw != "" {
				ch, text = raw[0], raw[1:]
			}
			switch ch {
			case '+':
				lines = append(lines, DiffLine{Type: "add", NewNum: intp(nL), Content: text})
				nL++
				added++
			case '-':
				lines = append(lines, DiffLine{Type: "del", OldNum: intp(oL), Content: text})
				oL++
				removed++
			default:
				lines = append(lines, DiffLine{Type: "ctx", OldNum: intp(oL), NewNum: intp(nL), Content: text})
				oL++
				nL++
			}
		}
	}
	return ParsedDiff{Lines: lines, Added: added, Removed: removed, Chars: jsstr.Len16(oldContent) + jsstr.Len16(newContent)}
}

func strp(s string) *string { return &s }
