// Package astgrep is the Go port of ast-grep/: the read-only `ast_grep`
// tool that wraps the ast-grep CLI. It holds input validation, argv
// building, JSON parsing, and the result summary. It does not import the
// PiG SDK; go/aio runs the process and registers the tool.
package astgrep

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var spaceRunRe = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

func trim(s string) string { return strings.Trim(s, jsSpace) }

// Input is the normalized tool input.
type Input struct {
	Command     string   `json:"command"`
	Pattern     string   `json:"pattern,omitempty"`
	Kind        string   `json:"kind,omitempty"`
	Language    string   `json:"language,omitempty"`
	Paths       []string `json:"paths"`
	Globs       []string `json:"globs"`
	Config      string   `json:"config,omitempty"`
	Rule        string   `json:"rule,omitempty"`
	InlineRules string   `json:"inlineRules,omitempty"`
	Selector    string   `json:"selector,omitempty"`
	Strictness  string   `json:"strictness,omitempty"`
	Context     *int     `json:"context,omitempty"`
	Before      *int     `json:"before,omitempty"`
	After       *int     `json:"after,omitempty"`
	JSON        string   `json:"json"`
	MaxResults  int      `json:"maxResults"`
	TimeoutMs   int      `json:"timeoutMs"`
	IncludeRaw  bool     `json:"includeRaw"`
}

func optionalString(params map[string]any, key string) (string, bool, error) {
	raw, present := params[key]
	if !present || raw == nil {
		return "", false, nil
	}
	s, ok := raw.(string)
	if !ok {
		return "", false, fmt.Errorf("%s must be a string.", key)
	}
	if trim(s) == "" {
		return "", false, fmt.Errorf("%s must not be empty when provided.", key)
	}
	return trim(s), true, nil
}

func cleanPathLike(value, field string) (string, error) {
	if strings.HasPrefix(value, "@") {
		value = trim(value[1:])
		if value == "" {
			return "", fmt.Errorf("%s must not be empty after stripping a leading @.", field)
		}
	}
	return value, nil
}

func optionalInt(params map[string]any, key string) *int {
	if v, ok := params[key].(float64); ok {
		n := int(v)
		return &n
	}
	return nil
}

func stringList(params map[string]any, key string) ([]string, bool) {
	raw, ok := params[key].([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, len(raw))
	for i, item := range raw {
		out[i], _ = item.(string)
	}
	return out, true
}

// Normalize validates and fills defaults like normalizeAstGrepInput.
func Normalize(params map[string]any) (Input, error) {
	in := Input{Command: "run", JSON: "compact", MaxResults: 200, TimeoutMs: 30000}
	if c, ok := params["command"].(string); ok {
		in.Command = c
	}
	var err error
	var has map[string]bool = map[string]bool{}
	for _, key := range []string{"pattern", "kind", "language", "selector", "config", "rule", "inlineRules"} {
		var value string
		var present bool
		if value, present, err = optionalString(params, key); err != nil {
			return Input{}, err
		}
		if present && (key == "config" || key == "rule") {
			if value, err = cleanPathLike(value, key); err != nil {
				return Input{}, err
			}
		}
		has[key] = present
		switch key {
		case "pattern":
			in.Pattern = value
		case "kind":
			in.Kind = value
		case "language":
			in.Language = value
		case "selector":
			in.Selector = value
		case "config":
			in.Config = value
		case "rule":
			in.Rule = value
		case "inlineRules":
			in.InlineRules = value
		}
	}
	in.Strictness, _ = params["strictness"].(string)
	in.Context, in.Before, in.After = optionalInt(params, "context"), optionalInt(params, "before"), optionalInt(params, "after")
	if in.Command == "run" {
		if !has["pattern"] && !has["kind"] {
			return Input{}, errors.New("command=run requires either pattern or kind.")
		}
		if has["pattern"] && has["kind"] {
			return Input{}, errors.New("command=run accepts pattern or kind, not both.")
		}
		if has["rule"] || has["inlineRules"] {
			return Input{}, errors.New("rule and inlineRules are only valid with command=scan.")
		}
	} else if has["pattern"] || has["kind"] || has["language"] || has["selector"] || in.Strictness != "" ||
		in.Context != nil || in.Before != nil || in.After != nil {
		return Input{}, errors.New("pattern, kind, language, selector, strictness, context, before, and after are only valid with command=run.")
	}
	if in.Context != nil && (in.Before != nil || in.After != nil) {
		return Input{}, errors.New("context is mutually exclusive with before/after.")
	}
	in.Paths = []string{"."}
	if paths, ok := stringList(params, "paths"); ok && len(paths) > 0 {
		in.Paths = make([]string, len(paths))
		for i, p := range paths {
			field := fmt.Sprintf("paths[%d]", i)
			if trim(p) == "" {
				return Input{}, fmt.Errorf("%s must not be empty when provided.", field)
			}
			if in.Paths[i], err = cleanPathLike(trim(p), field); err != nil {
				return Input{}, err
			}
		}
	}
	in.Globs = []string{}
	if globs, ok := stringList(params, "globs"); ok {
		for i, g := range globs {
			if trim(g) == "" {
				return Input{}, fmt.Errorf("globs[%d] must not be empty when provided.", i)
			}
			in.Globs = append(in.Globs, trim(g))
		}
	}
	if j, ok := params["json"].(string); ok {
		in.JSON = j
	}
	if v := optionalInt(params, "maxResults"); v != nil {
		in.MaxResults = *v
	}
	if v := optionalInt(params, "timeoutMs"); v != nil {
		in.TimeoutMs = *v
	}
	in.IncludeRaw, _ = params["includeRaw"].(bool)
	return in, nil
}

// BuildArgs is buildAstGrepArgs.
func BuildArgs(in Input) []string {
	var args []string
	if in.Config != "" {
		args = append(args, "--config", in.Config)
	}
	args = append(args, in.Command, "--json="+in.JSON)
	for _, g := range in.Globs {
		args = append(args, "--globs", g)
	}
	if in.Command == "run" {
		for _, kv := range [][2]string{{"--pattern", in.Pattern}, {"--kind", in.Kind}, {"--lang", in.Language}, {"--selector", in.Selector}, {"--strictness", in.Strictness}} {
			if kv[1] != "" {
				args = append(args, kv[0], kv[1])
			}
		}
		for _, kv := range []struct {
			flag  string
			value *int
		}{{"--context", in.Context}, {"--before", in.Before}, {"--after", in.After}} {
			if kv.value != nil {
				args = append(args, kv.flag, strconv.Itoa(*kv.value))
			}
		}
	} else {
		if in.Rule != "" {
			args = append(args, "--rule", in.Rule)
		}
		if in.InlineRules != "" {
			args = append(args, "--inline-rules", in.InlineRules)
		}
	}
	return append(args, in.Paths...)
}

var plainRe = regexp.MustCompile(`^[A-Za-z0-9_./:=@%+-]+$`)

// ShellQuote quotes a value for display.
func ShellQuote(value string) string {
	if plainRe.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

// FormatCommand is the display form of a command line.
func FormatCommand(command string, args []string) string {
	parts := []string{ShellQuote(command)}
	for _, a := range args {
		parts = append(parts, ShellQuote(a))
	}
	return strings.Join(parts, " ")
}

// Match is one ast-grep JSON match.
type Match = map[string]any

func normalizeParsed(parsed any) ([]Match, error) {
	switch v := parsed.(type) {
	case []any:
		out := make([]Match, 0, len(v))
		for _, item := range v {
			m, _ := item.(map[string]any)
			out = append(out, m)
		}
		return out, nil
	case map[string]any:
		return []Match{v}, nil
	}
	return nil, errors.New("ast-grep JSON output was not an object or array.")
}

// ParseJSON parses compact or stream output. Error detail after the colon
// differs from JavaScript's JSON.parse text.
func ParseJSON(stdout, mode string) ([]Match, error) {
	trimmed := trim(stdout)
	if trimmed == "" {
		return []Match{}, nil
	}
	if mode == "stream" {
		var out []Match
		for _, line := range regexp.MustCompile(`\r?\n`).Split(trimmed, -1) {
			if trim(line) == "" {
				continue
			}
			var parsed any
			err := json.Unmarshal([]byte(line), &parsed)
			var matches []Match
			if err == nil {
				matches, err = normalizeParsed(parsed)
			}
			if err != nil {
				return nil, fmt.Errorf("ast-grep stream JSON line could not be parsed: %w", err)
			}
			out = append(out, matches...)
		}
		return out, nil
	}
	var parsed any
	err := json.Unmarshal([]byte(trimmed), &parsed)
	var matches []Match
	if err == nil {
		matches, err = normalizeParsed(parsed)
	}
	if err != nil {
		return nil, fmt.Errorf("ast-grep compact JSON output could not be parsed: %w", err)
	}
	return matches, nil
}

// TruncateLine is Pi's truncateLine (maxChars in UTF-16 units).
func TruncateLine(line string, maxChars int) string {
	units := utf16.Encode([]rune(line))
	if len(units) <= maxChars {
		return line
	}
	return string(utf16.Decode(units[:maxChars])) + "... [truncated]"
}

func oneLine(value string, maxChars int) string {
	if value == "" {
		return ""
	}
	return TruncateLine(trim(spaceRunRe.ReplaceAllString(value, " ")), maxChars)
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func location(m Match) string {
	file := str(m, "file")
	if _, ok := m["file"].(string); !ok {
		file = "<unknown>"
	}
	r, _ := m["range"].(map[string]any)
	start, ok := r["start"].(map[string]any)
	if !ok {
		return file
	}
	line, _ := start["line"].(float64)
	column, _ := start["column"].(float64)
	return fmt.Sprintf("%s:%s:%s", file, jsNum(line+1), jsNum(column+1))
}

func jsNum(n float64) string {
	if n == math.Trunc(n) {
		return strconv.FormatInt(int64(n), 10)
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func metaVariables(m Match) []string {
	meta, _ := m["metaVariables"].(map[string]any)
	single, _ := meta["single"].(map[string]any)
	if len(single) == 0 {
		return nil
	}
	names := make([]string, 0, len(single))
	for name := range single {
		names = append(names, name)
	}
	sort.Strings(names)
	shown := names
	if len(shown) > 5 {
		shown = shown[:5]
	}
	rendered := make([]string, len(shown))
	for i, name := range shown {
		entry, _ := single[name].(map[string]any)
		rendered[i] = "$" + name + "=" + oneLine(str(entry, "text"), 120)
	}
	more := ""
	if len(names) > len(shown) {
		more = fmt.Sprintf(", +%d more", len(names)-len(shown))
	}
	return []string{"   metavars: " + strings.Join(rendered, ", ") + more}
}

// Summary is formatMatchSummary: the text and the number of matches shown.
func Summary(in Input, matches []Match) (string, int) {
	limit := max(0, in.MaxResults)
	shown := matches
	if len(shown) > limit {
		shown = shown[:limit]
	}
	omitted := len(matches) - len(shown)
	plural := "es"
	if len(matches) == 1 {
		plural = ""
	}
	lines := []string{fmt.Sprintf("ast_grep %s found %d match%s.", in.Command, len(matches), plural)}
	if len(shown) > 0 {
		note := ""
		if omitted > 0 {
			note = fmt.Sprintf("; %d omitted by maxResults=%d", omitted, limit)
		}
		lines = append(lines, fmt.Sprintf("Showing %d%s.", len(shown), note))
	}
	for i, m := range shown {
		rule := ""
		if id := str(m, "ruleId"); id != "" {
			severity := ""
			if sev := str(m, "severity"); sev != "" {
				severity = "/" + sev
			}
			rule = " [" + id + severity + "]"
		}
		language := ""
		if l := str(m, "language"); l != "" {
			language = " (" + l + ")"
		}
		lines = append(lines, fmt.Sprintf("%d. %s%s%s", i+1, location(m), language, rule))
		if message := str(m, "message"); message != "" {
			lines = append(lines, "   message: "+oneLine(message, 240))
		}
		code := str(m, "lines")
		if code == "" {
			code = str(m, "text")
		}
		if c := oneLine(code, 260); c != "" {
			lines = append(lines, "   code: "+c)
		}
		lines = append(lines, metaVariables(m)...)
	}
	return strings.Join(lines, "\n"), len(shown)
}

// Process is a finished ast-grep run.
type Process struct {
	Command  string   `json:"command"`
	Args     []string `json:"args"`
	Cwd      string   `json:"cwd"`
	Code     *int     `json:"code"`
	Signal   string   `json:"signal"`
	Stdout   string   `json:"stdout"`
	Stderr   string   `json:"stderr"`
	TimedOut bool     `json:"timedOut"`
	Aborted  bool     `json:"aborted"`
}

// Success is shouldTreatExitCodeAsSuccess: exit 0, or exit 1 with no
// matches, empty stderr, and `[]` or empty stdout.
func Success(p Process, matches []Match) bool {
	if p.TimedOut || p.Aborted || p.Code == nil {
		return false
	}
	if *p.Code == 0 {
		return true
	}
	out := trim(p.Stdout)
	return *p.Code == 1 && len(matches) == 0 && trim(p.Stderr) == "" && (out == "[]" || out == "")
}

// Truncation is the head truncation that Pi's truncateHead reports.
type Truncation struct {
	Content                                          string
	Truncated                                        bool
	TruncatedBy                                      string
	TotalLines, TotalBytes, OutputLines, OutputBytes int
	FirstLineExceedsLimit                            bool
	MaxLines, MaxBytes                               int
}

// Pi's default limits.
const (
	DefaultMaxLines = 2000
	DefaultMaxBytes = 50 * 1024
)

// TruncateHead is Pi's truncateHead (keep the first lines and bytes).
func TruncateHead(content string, maxLines, maxBytes int) Truncation {
	var lines []string
	if content != "" {
		lines = strings.Split(content, "\n")
		if strings.HasSuffix(content, "\n") {
			lines = lines[:len(lines)-1]
		}
	}
	t := Truncation{TotalLines: len(lines), TotalBytes: len(content), MaxLines: maxLines, MaxBytes: maxBytes}
	if len(lines) <= maxLines && len(content) <= maxBytes {
		t.Content, t.OutputLines, t.OutputBytes = content, len(lines), len(content)
		return t
	}
	t.Truncated = true
	if len(lines[0]) > maxBytes {
		t.TruncatedBy, t.FirstLineExceedsLimit = "bytes", true
		return t
	}
	var out []string
	used := 0
	t.TruncatedBy = "lines"
	for i := 0; i < len(lines) && i < maxLines; i++ {
		n := len(lines[i])
		if i > 0 {
			n++
		}
		if used+n > maxBytes {
			t.TruncatedBy = "bytes"
			break
		}
		out = append(out, lines[i])
		used += n
	}
	if len(out) >= maxLines && used <= maxBytes {
		t.TruncatedBy = "lines"
	}
	t.Content = strings.Join(out, "\n")
	t.OutputLines, t.OutputBytes = len(out), len(t.Content)
	return t
}

// FormatSize is Pi's formatSize.
func FormatSize(bytes int) string {
	switch {
	case bytes < 1024:
		return strconv.Itoa(bytes) + "B"
	case bytes < 1024*1024:
		return toFixed1(float64(bytes)/1024) + "KB"
	}
	return toFixed1(float64(bytes)/(1024*1024)) + "MB"
}

func toFixed1(v float64) string { return strconv.FormatFloat(math.Round(v*10)/10, 'f', 1, 64) }

// Diagnostic is truncateDiagnostic: stderr/stdout capped at 8 KiB and 200 lines.
func Diagnostic(text string) (string, bool) {
	if trim(text) == "" {
		return "", false
	}
	t := TruncateHead(trim(text), 200, 8*1024)
	if t.Truncated {
		return t.Content + "\n[stderr truncated]", true
	}
	return t.Content, true
}

// FailureMessage is buildCliFailureMessage.
func FailureMessage(p Process) string {
	if p.Aborted {
		return "ast-grep was cancelled."
	}
	if p.TimedOut {
		return "ast-grep timed out."
	}
	stderr, ok := Diagnostic(p.Stderr)
	if !ok {
		stderr = "<empty stderr>"
	}
	stdout, ok := Diagnostic(p.Stdout)
	if !ok {
		stdout = "<empty stdout>"
	}
	code := "null"
	if p.Code != nil {
		code = strconv.Itoa(*p.Code)
	}
	signal := ""
	if p.Signal != "" {
		signal = " (" + p.Signal + ")"
	}
	return fmt.Sprintf("ast-grep failed with exit code %s%s.\nSTDERR:\n%s\nSTDOUT:\n%s", code, signal, stderr, stdout)
}

// Result is the tool result before the full-output file is written.
type Result struct {
	Text       string
	FullText   string
	Truncation Truncation
	ShownCount int
}

// BuildResult is buildAstGrepToolResult without the temp file: when
// Truncation.Truncated is set, the caller saves FullText and calls Notice.
func BuildResult(in Input, p Process, matches []Match) Result {
	summary, shown := Summary(in, matches)
	full := summary
	if in.IncludeRaw {
		raw := trim(p.Stdout)
		if raw == "" {
			raw = "[]"
		}
		full += "\n\nRaw ast-grep JSON:\n" + raw
	}
	t := TruncateHead(full, DefaultMaxLines, DefaultMaxBytes)
	return Result{Text: t.Content, FullText: full, Truncation: t, ShownCount: shown}
}

// TruncationNotice is appended to a truncated result.
func TruncationNotice(t Truncation, path string) string {
	return fmt.Sprintf("\n\n[Output truncated: showing %d of %d lines (%s of %s). Full output saved to: %s]",
		t.OutputLines, t.TotalLines, FormatSize(t.OutputBytes), FormatSize(t.TotalBytes), path)
}
