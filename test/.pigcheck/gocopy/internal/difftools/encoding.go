package difftools

import (
	"regexp"
	"strings"
)

// LineEnding is "\r\n" or "\n".
type LineEnding = string

// StripBom ports text-encoding.ts stripBom.
func StripBom(content string) (bom, text string) {
	if strings.HasPrefix(content, "\uFEFF") {
		return "\uFEFF", content[len("\uFEFF"):]
	}
	return "", content
}

// DetectLineEnding ports detectLineEnding.
func DetectLineEnding(content string) LineEnding {
	crlf := strings.Index(content, "\r\n")
	lf := strings.Index(content, "\n")
	if lf == -1 || crlf == -1 {
		return "\n"
	}
	if crlf < lf {
		return "\r\n"
	}
	return "\n"
}

// NormalizeToLF ports normalizeToLF.
func NormalizeToLF(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
}

// RestoreLineEndings ports restoreLineEndings.
func RestoreLineEndings(text string, ending LineEnding) string {
	if ending == "\r\n" {
		return strings.ReplaceAll(text, "\n", "\r\n")
	}
	return text
}

// PrepareTextForHashlineEdit ports prepareTextForHashlineEdit.
func PrepareTextForHashlineEdit(raw string) (bom string, ending LineEnding, normalized string) {
	bom, text := StripBom(raw)
	return bom, DetectLineEnding(text), NormalizeToLF(text)
}

// FinalizeHashlineWriteContent ports finalizeHashlineWriteContent.
func FinalizeHashlineWriteContent(bom string, ending LineEnding, lf string) string {
	return bom + RestoreLineEndings(lf, ending)
}

// CollapsedExpandLabel is collapsed-hint.ts COLLAPSED_EXPAND_LABEL.
const CollapsedExpandLabel = "ctrl+o to expand"

// CollapsedSummaryLine ports collapsedSummaryLine.
func CollapsedSummaryLine(countLabel string) string {
	return countLabel + " — " + CollapsedExpandLabel
}

// ConflictRegion is conflicts.ts ConflictRegion.
type ConflictRegion struct {
	CurrentRef  string   `json:"currentRef"`
	Current     []string `json:"current"`
	Base        []string `json:"base"`
	Incoming    []string `json:"incoming"`
	IncomingRef string   `json:"incomingRef"`
	HasBase     bool     `json:"hasBase"`
	StartLine   int      `json:"startLine"`
}

// ConflictParseResult is conflicts.ts ConflictParseResult.
type ConflictParseResult struct {
	Regions      []ConflictRegion `json:"regions"`
	HasConflicts bool             `json:"hasConflicts"`
}

var (
	conflictStartRe  = regexp.MustCompile(`^<<<<<<<[ \t]*(` + jsDot + `*)$`)
	conflictBaseRe   = regexp.MustCompile(`^\|\|\|\|\|\|\|[ \t]*(` + jsDot + `*)$`)
	conflictEndRe    = regexp.MustCompile(`^>>>>>>>[ \t]*(` + jsDot + `*)$`)
	conflictMarkerRe = regexp.MustCompile(`(?m)^<<<<<<<[ \t]?`)
)

// ParseConflicts ports parseConflicts.
func ParseConflicts(content string) ConflictParseResult {
	lines := strings.Split(content, "\n")
	regions := []ConflictRegion{}
	for i := 0; i < len(lines); {
		start := conflictStartRe.FindStringSubmatch(lines[i])
		if start == nil {
			i++
			continue
		}
		r := ConflictRegion{CurrentRef: jsTrim(start[1]), Current: []string{}, Base: []string{}, Incoming: []string{}, StartLine: i + 1}
		state := "current"
		i++
		for i < len(lines) {
			line := lines[i]
			if conflictBaseRe.MatchString(line) {
				state, r.HasBase = "base", true
				i++
				continue
			}
			if line == "=======" {
				state = "incoming"
				i++
				continue
			}
			if end := conflictEndRe.FindStringSubmatch(line); end != nil {
				r.IncomingRef = jsTrim(end[1])
				i++
				break
			}
			switch state {
			case "current":
				r.Current = append(r.Current, line)
			case "base":
				r.Base = append(r.Base, line)
			default:
				r.Incoming = append(r.Incoming, line)
			}
			i++
		}
		regions = append(regions, r)
	}
	return ConflictParseResult{Regions: regions, HasConflicts: len(regions) > 0}
}

// HasConflictMarkers ports hasConflictMarkers. JavaScript's multiline ^
// also starts after "\r", "\u2028", and "\u2029".
func HasConflictMarkers(content string) bool {
	normalized := strings.NewReplacer("\r", "\n", "\u2028", "\n", "\u2029", "\n").Replace(content)
	return conflictMarkerRe.MatchString(normalized)
}

// FormatConflictSummary ports formatConflictSummary.
func FormatConflictSummary(r ConflictRegion) string {
	current, incoming := r.CurrentRef, r.IncomingRef
	if current == "" {
		current = "current"
	}
	if incoming == "" {
		incoming = "incoming"
	}
	s := "Conflict: " + current + " (" + itoa(len(r.Current)) + " lines) vs " + incoming + " (" + itoa(len(r.Incoming)) + " lines)"
	if r.HasBase {
		s += " [3-way]"
	}
	return s
}
