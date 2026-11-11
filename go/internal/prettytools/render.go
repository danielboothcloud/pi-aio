package prettytools

// Port of render.ts: the ANSI rendering helpers of the tool cards.

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

var ansiCaptureRe = regexp.MustCompile(`\x1b\[([0-9;]*)m`)

// ResetWithoutBg is RESET_WITHOUT_BG.
const ResetWithoutBg = "\x1b[22;23;24;25;27;28;29;39m"

// IsLowContrastShikiFg ports isLowContrastShikiFg.
func IsLowContrastShikiFg(params string) bool {
	switch params {
	case "30", "90", "38;5;0", "38;5;8":
		return true
	}
	if !strings.HasPrefix(params, "38;2;") {
		return false
	}
	parts := strings.Split(params, ";")
	if len(parts) != 5 {
		return false
	}
	nums := make([]float64, 5)
	for i, part := range parts {
		n, ok := jsNumber(part)
		if !ok {
			return false
		}
		nums[i] = n
	}
	luminance := 0.2126*nums[2] + 0.7152*nums[3] + 0.0722*nums[4]
	return luminance < 72
}

// jsNumber is Number(s) for a string of digits ("" is 0); ok=false is NaN.
func jsNumber(s string) (float64, bool) {
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func normalizeShikiContrast(ansi string) string {
	return ansiCaptureRe.ReplaceAllStringFunc(ansi, func(seq string) string {
		if IsLowContrastShikiFg(ansiCaptureRe.FindStringSubmatch(seq)[1]) {
			return FgMuted
		}
		return seq
	})
}

// PreserveBoxBackground ports preserveBoxBackground: SGR sequences lose
// their background parts, and full resets keep the background.
func PreserveBoxBackground(ansi string) string {
	return ansiCaptureRe.ReplaceAllStringFunc(ansi, func(seq string) string {
		params := ansiCaptureRe.FindStringSubmatch(seq)[1]
		if params == "" || params == "0" {
			return ResetWithoutBg
		}
		var parts []string
		for _, p := range strings.Split(params, ";") {
			if p != "" {
				parts = append(parts, p)
			}
		}
		at := func(i int) (string, bool) {
			if i < len(parts) {
				return parts[i], true
			}
			return "", false
		}
		var kept []string
		for i := 0; i < len(parts); {
			code, _ := jsNumber(parts[i])
			switch {
			case code == 38:
				kept = append(kept, parts[i])
				next, _ := at(i + 1)
				switch next {
				case "5":
					kept = append(kept, next)
					i += 2
				case "2":
					for k := 1; k <= 4; k++ {
						v, _ := at(i + k) // undefined joins as ""
						kept = append(kept, v)
					}
					i += 5
				default:
					i++
				}
			case code == 48:
				next, _ := at(i + 1)
				switch next {
				case "5":
					i += 3
				case "2":
					i += 6
				default:
					i++
				}
			case code == 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107):
				i++
			default:
				kept = append(kept, parts[i])
				i++
			}
		}
		if len(kept) == 0 {
			return ""
		}
		return "\x1b[" + strings.Join(kept, ";") + "m"
	})
}

// FillToolBackground ports fillToolBackground. width 0 is undefined (no
// fitting); bg "" adds no background.
func FillToolBackground(text, bg string, width int) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if width == 0 {
			lines[i] = bg + PreserveBoxBackground(line)
			continue
		}
		plainLead := ansiCaptureRe.ReplaceAllString(line, "")
		skipPad := strings.HasPrefix(line, ToolResultIndent) || strings.HasPrefix(plainLead, ToolResultIndent)
		fitted := tuiwidth.TruncateToWidth(line, width, "", !skipPad)
		lines[i] = bg + PreserveBoxBackground(fitted)
	}
	return strings.Join(lines, "\n")
}

// TextRender is pi-tui's Text(text, 0, 0).render(width): wrapped and padded
// lines, none for blank text.
func TextRender(text string, width int) []string {
	if text == "" || jsstr.Trim(text) == "" {
		return []string{}
	}
	normalized := strings.ReplaceAll(text, "\t", "   ")
	out := []string{}
	for _, line := range tuiwidth.WrapTextWithAnsi(normalized, max(1, width)) {
		out = append(out, line+strings.Repeat(" ", max(0, width-tuiwidth.VisibleWidth(line))))
	}
	return out
}

func lnum(n string, w int) string {
	return FgLnum + strings.Repeat(" ", max(0, w-len(n))) + n + RST
}

// renderToolCallChrome ports renderToolCallChrome; width 0 is termWidth().
func (p *Pretty) renderToolCallChrome(t Theme, title, meta, tone, icon string, width int) string {
	if width == 0 {
		width = p.TermWidth()
	}
	return chrome.Header(t, chrome.HeaderOptions{Title: title, Meta: meta, Tone: tone, Icon: icon, Indent: 1}, width)
}

// renderToolSummary ports renderToolSummary; width 0 is termWidth().
func (p *Pretty) renderToolSummary(t Theme, label string, facts []string, tone, marker, hint string, width int) string {
	values := []string{}
	for _, v := range append(append([]string{}, facts...), hint) {
		if v != "" {
			values = append(values, v)
		}
	}
	if marker == "" {
		marker = "◇"
	}
	if tone == "" {
		tone = "muted"
	}
	if width == 0 {
		width = p.TermWidth()
	}
	return chrome.Item(t, chrome.ItemOptions{Label: label, Meta: strings.Join(values, " · "), Marker: marker, Tone: tone, Indent: chrome.Indent(1)}, width)
}

// detailNumber reads a number from details.
func detailNumber(details map[string]any, key string) (float64, bool) {
	if details == nil {
		return 0, false
	}
	v, ok := details[key].(float64)
	return v, ok
}

// RenderToolMetrics ports renderToolMetrics.
func RenderToolMetrics(details map[string]any) string {
	if details == nil {
		return ""
	}
	elapsed := FormatElapsedMs(detailNumber(details, ElapsedKey))
	chars := FormatCharCount(detailNumber(details, CharsKey))
	if elapsed == "" && chars == "" {
		return ""
	}
	parts := []string{}
	for _, v := range []string{elapsed, chars} {
		if v != "" {
			parts = append(parts, v)
		}
	}
	return FgDim + "· " + strings.Join(parts, " · ") + RST
}

// RenderToolDuration ports renderToolDuration.
func RenderToolDuration(details map[string]any) string {
	return FormatElapsedMs(detailNumber(details, ElapsedKey))
}

// renderToolError ports renderToolError.
func (p *Pretty) renderToolError(errorText string, t Theme) string {
	lines := CompactErrorLines(errorText)
	for i, line := range lines {
		if line != "" {
			line = t.Fg("error", line)
		}
		lines[i] = ToolResultIndent + line
	}
	_, bgError := p.BG.Get()
	return FillToolBackground(strings.Join(lines, "\n"), bgError, 0)
}

// hlBlock ports hlBlock (without its cache).
func (p *Pretty) hlBlock(code, language string) []string {
	if code == "" {
		return []string{""}
	}
	if language == "" || jsstr.Len16(code) > p.MaxHLChars || p.Highlight == nil {
		return strings.Split(code, "\n")
	}
	ansi, err := p.Highlight(code, language)
	if err != nil {
		return strings.Split(code, "\n")
	}
	ansi = normalizeShikiContrast(ansi)
	ansi = strings.TrimSuffix(ansi, "\n")
	return strings.Split(ansi, "\n")
}

// RenderFileContent ports renderFileContent: highlighted lines fitted to
// width. maxLines 0 is MAX_PREVIEW_LINES; width 0 is termWidth().
func (p *Pretty) RenderFileContent(content, filePath string, maxLines, width int) string {
	if maxLines == 0 {
		maxLines = p.MaxPreviewLines
	}
	lines := strings.Split(NormalizeLineEndings(content), "\n")
	show := lines[:min(len(lines), max(0, maxLines))]
	hl := p.hlBlock(strings.Join(show, "\n"), DetectLang(filePath))
	if width == 0 {
		width = p.TermWidth()
	}
	out := make([]string, len(hl))
	for i, line := range hl {
		out[i] = tuiwidth.TruncateToWidth(line, max(1, width), FgDim+"›", false)
	}
	return strings.Join(out, "\n")
}

// RenderTree ports renderTree: a tree list with file-type icons.
func (p *Pretty) RenderTree(text string) string {
	var lines []string
	for _, l := range strings.Split(jsstr.Trim(text), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return FgDim + "(empty directory)" + RST
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		entry := jsstr.Trim(l)
		prefix := "├── "
		if i == len(lines)-1 {
			prefix = "└── "
		}
		connector := FgRule + prefix + RST
		isDir := strings.HasSuffix(entry, "/")
		if isDir {
			name := strings.TrimSuffix(entry, "/")
			out[i] = connector + p.DirIcon() + FgBlue + "\x1b[1m" + name + RST
		} else {
			out[i] = connector + p.FileIcon(entry) + entry
		}
	}
	return strings.Join(out, "\n")
}

// RenderFindResults ports renderFindResults: files grouped by directory.
// t nil is the call without a theme.
func RenderFindResults(text string, t Theme) string {
	var lines []string
	for _, l := range strings.Split(jsstr.Trim(text), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		if t != nil {
			return t.Fg("dim", "(no matches)")
		}
		return FgDim + "(no matches)" + RST
	}
	var order []string
	groups := map[string][]string{}
	for _, line := range lines {
		trimmed := jsstr.Trim(line)
		dir := jsDirname(trimmed)
		if dir == "" {
			dir = "."
		}
		if _, ok := groups[dir]; !ok {
			order = append(order, dir)
		}
		groups[dir] = append(groups[dir], jsBasename(trimmed))
	}
	out := []string{}
	count := 0
	for _, dir := range order {
		if count > 0 {
			out = append(out, "")
		}
		if t != nil {
			out = append(out, t.Fg("accent", t.Bold(dir+"/")))
		} else {
			out = append(out, FgBlue+"\x1b[1m"+dir+"/"+RST)
		}
		for _, file := range groups[dir] {
			out = append(out, ToolResultIndent+file)
			count++
		}
	}
	return strings.Join(out, "\n")
}

var grepLineRe = regexp.MustCompile(`^(.+?)[:-](\d+)[:-](.*)$`)

// RenderGrepResults ports renderGrepResults: matches grouped by file with
// line numbers and the pattern highlighted.
func RenderGrepResults(text, pattern string) string {
	lines := strings.Split(NormalizeLineEndings(text), "\n")
	if len(lines) == 1 && jsstr.Trim(lines[0]) == "" {
		return FgDim + "(no matches)" + RST
	}
	out := []string{}
	currentFile := ""
	for _, line := range lines {
		if m := grepLineRe.FindStringSubmatch(line); m != nil {
			file, lineNo, content := m[1], m[2], m[3]
			if file != currentFile {
				if currentFile != "" {
					out = append(out, "")
				}
				out = append(out, FgBlue+"\x1b[1m"+file+RST)
				currentFile = file
			}
			nw := max(3, len(lineNo))
			n, _ := strconv.ParseFloat(lineNo, 64)
			out = append(out, ToolResultIndent+lnum(jsstr.NumberJS(n), nw)+" "+FgRule+"│"+RST+" "+highlightLiteralMatches(content, pattern)+RST)
		} else if jsstr.Trim(line) == "--" {
			out = append(out, ToolResultIndent+FgDim+"  ···"+RST)
		} else if jsstr.Trim(line) != "" {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

// jsLower16 is toLocaleLowerCase in UTF-16 units (İ becomes i + U+0307).
func jsLower16(s string) []uint16 {
	var b strings.Builder
	for _, r := range s {
		if r == 'İ' {
			b.WriteString("i\u0307")
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return utf16.Encode([]rune(b.String()))
}

func indexOf16(s, sub []uint16, from int) int {
	if len(sub) == 0 {
		return min(from, len(s))
	}
	for i := from; i+len(sub) <= len(s); i++ {
		match := true
		for j := range sub {
			if s[i+j] != sub[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func slice16(units []uint16, start, end int) string {
	start = max(0, min(start, len(units)))
	end = max(start, min(end, len(units)))
	return string(utf16.Decode(units[start:end]))
}

// highlightLiteralMatches ports highlightLiteralMatches. Indexes found in
// the lowercased text slice the original, as in TypeScript.
func highlightLiteralMatches(content, pattern string) string {
	if pattern == "" {
		return content
	}
	units := utf16.Encode([]rune(content))
	lowerContent := jsLower16(content)
	lowerPattern := jsLower16(pattern)
	patternLen := jsstr.Len16(pattern)
	var parts []string
	offset := 0
	for offset < len(units) {
		match := indexOf16(lowerContent, lowerPattern, offset)
		if match < 0 {
			break
		}
		parts = append(parts, slice16(units, offset, match))
		parts = append(parts, RST+FgYellow+"\x1b[1m"+slice16(units, match, match+patternLen)+RST)
		offset = match + patternLen
	}
	parts = append(parts, slice16(units, offset, len(units)))
	return strings.Join(parts, "")
}
