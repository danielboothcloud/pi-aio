package hypa

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Pi's default output limits.
const (
	DefaultMaxBytes     = 50 * 1024
	DefaultMaxLines     = 2000
	MaxInlineImageBytes = 5 * 1024 * 1024
	ImageSniffBytes     = 4100
)

// FormatSize is hypa's formatSize (KB rounds to an integer).
func FormatSize(bytes int) string {
	switch {
	case bytes < 1024:
		return strconv.Itoa(bytes) + "B"
	case bytes < 1024*1024:
		return strconv.Itoa(int(math.Floor(float64(bytes)/1024+0.5))) + "KB"
	}
	return strconv.FormatFloat(math.Round(float64(bytes)/(1024*1024)*10)/10, 'f', 1, 64) + "MB"
}

// Truncation is truncateText's result.
type Truncation struct {
	Content     string `json:"content"`
	Truncated   bool   `json:"truncated"`
	TotalLines  int    `json:"totalLines"`
	OutputLines int    `json:"outputLines"`
	TotalBytes  int    `json:"totalBytes"`
	OutputBytes int    `json:"outputBytes"`
}

// TruncateText is truncateText: keep the head (or the tail) within the
// line and byte limits, cutting by 10% of the UTF-16 length per step.
func TruncateText(text string, preferTail bool) Truncation {
	lines := strings.Split(text, "\n")
	selected := lines
	if len(lines) > DefaultMaxLines {
		if preferTail {
			selected = lines[len(lines)-DefaultMaxLines:]
		} else {
			selected = lines[:DefaultMaxLines]
		}
	}
	units := utf16.Encode([]rune(strings.Join(selected, "\n")))
	content := string(utf16.Decode(units))
	for len(content) > DefaultMaxBytes && len(units) > 0 {
		if preferTail {
			units = units[int(math.Ceil(float64(len(units))*0.1)):]
		} else {
			units = units[:int(math.Floor(float64(len(units))*0.9))]
		}
		content = string(utf16.Decode(units))
	}
	out := 0
	if len(units) > 0 {
		out = strings.Count(content, "\n") + 1
	}
	return Truncation{Content: content, Truncated: len(selected) < len(lines) || len(text) > DefaultMaxBytes,
		TotalLines: len(lines), OutputLines: out, TotalBytes: len(text), OutputBytes: len(content)}
}

// NormalizePath strips a leading @ and expands a leading ~.
func NormalizePath(path, home string) string {
	p := strings.TrimPrefix(path, "@")
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return home + p[1:]
	}
	return p
}

func floorInt(f float64) int { return int(math.Floor(f)) }

// ReadCommand is buildReadCommand. offset and limit are nil when absent.
func ReadCommand(path, home string, offset, limit *float64) string {
	p := NormalizePath(path, home)
	if offset != nil || limit != nil {
		start := 1
		if offset != nil {
			start = max(1, floorInt(*offset))
		}
		end := "$"
		if limit != nil {
			end = strconv.Itoa(start + max(1, floorInt(*limit)) - 1)
		}
		if strings.HasPrefix(p, "-") {
			p = "./" + p
		}
		return "sed -n " + ShellQuote(fmt.Sprintf("%d,%sp", start, end)) + " " + ShellQuote(p)
	}
	return "cat -- " + ShellQuote(p)
}

// GrepParams are the hypa_grep inputs.
type GrepParams struct {
	Pattern, Path, Glob string
	HasPath             bool // TS `path ?? "."`: an empty string stays empty
	IgnoreCase, Literal bool
	Context, Limit      *float64
}

func quoteAll(args []string) string {
	for i, a := range args {
		args[i] = ShellQuote(a)
	}
	return strings.Join(args, " ")
}

// GrepCommand is buildGrepCommand.
func GrepCommand(p GrepParams, home string) string {
	args := []string{"rg", "--heading", "--line-number", "--color=never"}
	if p.IgnoreCase {
		args = append(args, "--ignore-case")
	}
	if p.Literal {
		args = append(args, "--fixed-strings")
	}
	if p.Context != nil {
		args = append(args, "--context", strconv.Itoa(max(0, floorInt(*p.Context))))
	}
	if p.Limit != nil {
		args = append(args, "--max-count", strconv.Itoa(max(1, floorInt(*p.Limit))))
	}
	if p.Glob != "" {
		args = append(args, "--glob", p.Glob)
	}
	path := p.Path
	if !p.HasPath {
		path = "."
	}
	return quoteAll(append(args, "-e", p.Pattern, "--", NormalizePath(path, home)))
}

// FindCommand is buildFindCommand (the limit applies to the output).
func FindCommand(pattern, path string, hasPattern, hasPath bool, home string) string {
	if !hasPattern {
		pattern = "*"
	}
	if !hasPath {
		path = "."
	}
	return quoteAll([]string{"rg", "--files", "--glob", pattern, NormalizePath(path, home)})
}

var lineSplitRe = regexp.MustCompile(`\r?\n`)

// LimitLines is limitStdoutLines (limit nil: unchanged).
func LimitLines(stdout string, limit *float64) string {
	if limit == nil {
		return stdout
	}
	n := max(1, floorInt(*limit))
	var lines []string
	for _, l := range lineSplitRe.Split(stdout, -1) {
		if l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > n {
		lines = lines[:n]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// LsCommand is buildLsCommand. long is nil when absent (default long).
func LsCommand(path string, hasPath, all bool, long *bool, home string) string {
	flags := ""
	if long == nil || *long {
		flags = "l"
	}
	if all {
		flags += "a"
	}
	args := []string{"ls"}
	if flags != "" {
		args = append(args, "-"+flags)
	}
	if !hasPath {
		path = "."
	}
	if p := NormalizePath(path, home); p != "" {
		args = append(args, "--", p)
	} else {
		args = append(args, "--")
	}
	return quoteAll(args)
}

var rawForbiddenRe = regexp.MustCompile("[\\r\\n'\"\\\\`$%&|;<>^!()]")
var rawSplitRe = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// RawModeError is the hypa_shell raw-mode error.
const RawModeError = "hypa_shell raw mode only supports a simple executable and whitespace-separated arguments; omit raw for shell syntax, quoting, or multiline commands"

// SplitRaw is splitRawCommand.
func SplitRaw(command string) ([]string, error) {
	t := trim(command)
	if t == "" || rawForbiddenRe.MatchString(t) {
		return nil, fmt.Errorf("%s", RawModeError)
	}
	return rawSplitRe.Split(t, -1), nil
}

// RunArgs are the hypa CLI arguments for a tool command.
func RunArgs(command string, timeoutMs *float64, raw bool) ([]string, error) {
	var args []string
	if timeoutMs != nil {
		args = append(args, "--timeout-ms", strconv.Itoa(max(1, floorInt(*timeoutMs))))
	}
	if raw {
		parts, err := SplitRaw(command)
		if err != nil {
			return nil, err
		}
		return append(append(args, "raw"), parts...), nil
	}
	return append(args, "-c", command), nil
}

// ToolText is toToolText without the temp file: Text is the content and
// Truncation reports whether the caller must save Combined.
type ToolText struct {
	Text       string
	Combined   string
	Truncation Truncation
}

// BuildToolText combines stdout and stderr and truncates them.
func BuildToolText(stdout, stderr string, preferTail bool) ToolText {
	var parts []string
	for _, p := range []string{stdout, stderr} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	sep := ""
	if stdout != "" && stderr != "" {
		sep = "\n"
	}
	combined := strings.Join(parts, sep)
	t := TruncateText(combined, preferTail)
	return ToolText{Text: t.Content, Combined: combined, Truncation: t}
}

// FinishText adds the truncation and killed notes, and the empty-output text.
func FinishText(t ToolText, fullPath string, code int, killed bool) string {
	text := t.Text
	if t.Truncation.Truncated {
		text += fmt.Sprintf("\n\n[Output truncated: showing %d of %d lines (%s of %s). Full output saved to: %s]",
			t.Truncation.OutputLines, t.Truncation.TotalLines, FormatSize(t.Truncation.OutputBytes), FormatSize(t.Truncation.TotalBytes), fullPath)
	}
	if killed {
		text += "\n\n[Hypa command timed out or was killed]"
	}
	if text == "" {
		return fmt.Sprintf("(exit %d, no output)", code)
	}
	return text
}

// ImageMime is detectSupportedImageMimeType ("" for unsupported).
func ImageMime(b []byte) string {
	starts := func(off int, prefix string) bool {
		return len(b) >= off+len(prefix) && string(b[off:off+len(prefix)]) == prefix
	}
	switch {
	case starts(0, "\xff\xd8\xff"):
		if len(b) > 3 && b[3] == 0xf7 {
			return ""
		}
		return "image/jpeg"
	case starts(0, "\x89PNG\r\n\x1a\n"):
		if staticPNG(b) {
			return "image/png"
		}
		return ""
	case starts(0, "GIF87a"), starts(0, "GIF89a"):
		return "image/gif"
	case starts(0, "RIFF") && starts(8, "WEBP"):
		return "image/webp"
	}
	return ""
}

func be32(b []byte, off int) uint32 {
	var v uint32
	for i := 0; i < 4; i++ {
		v <<= 8
		if off+i < len(b) {
			v |= uint32(b[off+i])
		}
	}
	return v
}

func staticPNG(b []byte) bool {
	if len(b) < 24 || be32(b, 8) != 13 || string(b[12:16]) != "IHDR" {
		return false
	}
	off := 8
	for off+8 <= len(b) {
		length := int(be32(b, off))
		kind := string(b[off+4 : min(off+8, len(b))])
		if kind == "acTL" {
			return false
		}
		if kind == "IDAT" {
			return true
		}
		next := off + 8 + length + 4
		if next <= off || next > len(b) {
			return true
		}
		off = next
	}
	return true
}

// OpaqueBinary is looksLikeOpaqueBinary: a NUL byte in the sniffed head.
func OpaqueBinary(b []byte) bool {
	if ImageMime(b) != "" {
		return false
	}
	for _, c := range b[:min(len(b), ImageSniffBytes)] {
		if c == 0 {
			return true
		}
	}
	return false
}

// BinaryNote is the hypa_read text for a non-image binary file.
func BinaryNote(path string, size int) string {
	return "SUMMARY\nFile: " + path + "\n\nDETAILS\n" +
		"Binary file detected (" + FormatSize(size) + "); not decoded as text. " +
		"Supported image formats (png/jpeg/gif/webp) are attached as vision content when recognized by content sniffing."
}

// NonVisionNote is the note for a model without image input.
const NonVisionNote = "[Current model does not support images. The image will be omitted from this request.]"

// ImageNote is the hypa_read text before an image; omitted reports a file
// over the inline limit.
func ImageNote(mime string, size int, nonVision bool) (string, bool) {
	note := "Read image file [" + mime + "] (" + FormatSize(size) + ")"
	omitted := size > MaxInlineImageBytes
	if omitted {
		note += "\n[Image omitted: " + FormatSize(size) + " exceeds inline limit of " + FormatSize(MaxInlineImageBytes) + ". Use a smaller asset or host-side resize.]"
	}
	if nonVision {
		note += "\n" + NonVisionNote
	}
	return note, omitted
}

// ReplaceFilter is applyReplaceModeFilter: in replace mode, a builtin is
// removed while its hypa_* replacement is active.
func ReplaceFilter(tools []string, mode string) []string {
	if mode != "replace" {
		return tools
	}
	pairs := map[string]string{"bash": "hypa_shell", "read": "hypa_read", "grep": "hypa_grep", "find": "hypa_find", "ls": "hypa_ls"}
	active := map[string]bool{}
	for _, t := range tools {
		active[t] = true
	}
	var out []string
	for _, t := range tools {
		if r, ok := pairs[t]; ok && active[r] {
			continue
		}
		out = append(out, t)
	}
	return out
}

func num(params map[string]any, key string) *float64 {
	if v, ok := params[key].(float64); ok {
		return &v
	}
	return nil
}

func strParam(params map[string]any, key string) (string, bool) {
	s, ok := params[key].(string)
	return s, ok
}

// Plan is what one hypa_* tool call runs.
type Plan struct {
	Command    string   // the shell command given to hypa -c (or raw)
	Args       []string // hypa CLI arguments
	TimeoutMs  *float64 // the exec timeout (nil: none)
	PreferTail bool     // hypa_shell keeps the tail of long output
	Limit      *float64 // hypa_find keeps the first N output lines
}

// ToolPlan maps a hypa_* tool input to its hypa invocation. hypa_read
// image handling happens before this.
func ToolPlan(tool string, params map[string]any, home string) (Plan, error) {
	var p Plan
	timeout := num(params, "timeoutMs")
	raw, _ := params["raw"].(bool)
	switch tool {
	case "hypa_shell":
		p.Command, _ = strParam(params, "command")
		p.PreferTail = true
	case "hypa_read":
		path, _ := strParam(params, "path")
		p.Command = ReadCommand(path, home, num(params, "offset"), num(params, "limit"))
		timeout, raw = nil, false
	case "hypa_grep":
		path, hasPath := strParam(params, "path")
		glob, _ := strParam(params, "glob")
		pattern, _ := strParam(params, "pattern")
		ic, _ := params["ignoreCase"].(bool)
		lit, _ := params["literal"].(bool)
		p.Command = GrepCommand(GrepParams{Pattern: pattern, Path: path, HasPath: hasPath, Glob: glob, IgnoreCase: ic, Literal: lit,
			Context: num(params, "context"), Limit: num(params, "limit")}, home)
		raw = false
	case "hypa_find":
		pattern, hasPattern := strParam(params, "pattern")
		path, hasPath := strParam(params, "path")
		p.Command = FindCommand(pattern, path, hasPattern, hasPath, home)
		p.Limit = num(params, "limit")
		raw = false
	case "hypa_ls":
		path, hasPath := strParam(params, "path")
		all, _ := params["all"].(bool)
		var long *bool
		if v, ok := params["long"].(bool); ok {
			long = &v
		}
		p.Command = LsCommand(path, hasPath, all, long, home)
		raw = false
	default:
		return p, fmt.Errorf("unknown hypa tool %s", tool)
	}
	args, err := RunArgs(p.Command, timeout, raw)
	p.Args, p.TimeoutMs = args, timeout
	return p, err
}
