package prettytools

// Port of tools/{read,bash,ls,find,grep,metrics}.ts: the execute logic over
// rtk and the host's built-in tools, and the renderCall/renderResult cards.

import (
	"errors"
	"math"
	"path"
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/rtk"
)

// Content is one content block of a tool result. Text nil is a block
// without a text member (an image).
type Content struct {
	Type     string  `json:"type"`
	Text     *string `json:"text,omitempty"`
	Data     string  `json:"data,omitempty"`
	MimeType string  `json:"mimeType,omitempty"`
}

// TextContent is a text block.
func TextContent(text string) Content { return Content{Type: "text", Text: &text} }

// Result is AgentToolResult. Details nil is undefined or null.
type Result struct {
	Content []Content
	IsError bool
	Details map[string]any
}

// Host is the injected host side of the tools.
type Host struct {
	// Exec is pi.exec: it runs a command without a shell in cwd. An error is
	// a throw (rtk could not execute); a run with a non-zero exit is not an
	// error.
	Exec func(command string, args []string, cwd string) (rtk.ExecResult, error)
	// Builtin is the host built-in tool's execute (sdkTool.execute). An
	// error is the tool's throw.
	Builtin func(tool string, params map[string]any) (Result, error)
	// Getenv reads the environment (PRETTY_BASH_GREP_GUARD per call).
	Getenv func(string) string
	// NowMs is performance.now() in milliseconds.
	NowMs func() float64
}

// Tools is registerPrettyTools' tool set.
type Tools struct {
	*Pretty
	Host
	// Cwd is process.cwd() at registration, Home is $HOME: shortPath's
	// arguments in the call cards.
	Cwd  string
	Home string
}

// Names lists the tools in registration order.
var Names = []string{"read", "bash", "ls", "find", "grep"}

// EnabledTools ports isToolEnabled: PRETTY_DISABLE_TOOLS may disable only
// bash; the RTK-covered read-only tools always register.
func EnabledTools(getenv func(string) string) []string {
	disabled := map[string]bool{}
	for _, name := range strings.Split(getenv("PRETTY_DISABLE_TOOLS"), ",") {
		name = strings.ToLower(jsstr.Trim(name))
		if name != "" {
			disabled[name] = true
		}
	}
	out := []string{}
	for _, name := range Names {
		if name == "bash" && disabled[name] {
			continue
		}
		out = append(out, name)
	}
	return out
}

// Meta is the registration metadata of a tool over the built-in's
// description.
type Meta struct {
	Label            string
	Description      string
	PromptSnippet    string
	PromptGuidelines []string
}

// ToolMeta ports the registerTool fields of each tool.
func ToolMeta(name, sdkDescription string) Meta {
	desc := func(fallback string) string {
		if sdkDescription != "" {
			return sdkDescription
		}
		return fallback
	}
	switch name {
	case "read":
		return Meta{Label: "Read", Description: desc("Read file contents")}
	case "bash":
		d := "Execute shell commands. For text search: `rg -n`."
		if sdkDescription != "" {
			d = sdkDescription + " For text search: `rg -n`."
		}
		return Meta{Label: "Bash", Description: d, PromptSnippet: "Execute commands via bash. For text search: `rg -n`.", PromptGuidelines: []string{
			"For text search: `rg -n`. If no results, try `rg -u` (respects .gitignore by default).",
			"In rg: | means alternation, \\| means literal pipe. Opposite of GNU grep. Never use \\| for alternation.",
			"GNU grep (grep/egrep/fgrep) is blocked in bash; use the grep tool or `rg -n` instead.",
			"rg is recursive by default; its `-r` means `--replace`, so never write `rg -rn` (it replaces every match with `n`).",
		}}
	case "ls":
		return Meta{Label: "List", Description: desc("List directory contents")}
	case "find":
		return Meta{Label: "Find", Description: desc("Find files matching a glob pattern")}
	case "grep":
		return Meta{Label: "Grep", Description: desc("Search file contents by pattern") + " Every supported search is executed through rtk grep; the SDK is used only when RTK cannot execute.",
			PromptSnippet: "Search file contents through RTK-enforced grep", PromptGuidelines: []string{
				"Always use the grep tool for content search; aio enforces RTK routing for it.",
				"In grep patterns, | means alternation and \\| means a literal pipe.",
				"If no matches, try a broader pattern or pass path/glob explicitly.",
			}}
	}
	return Meta{}
}

// ---- JavaScript value helpers ----

// jsString is String(v) for decoded JSON values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsstr.NumberJS(x)
	case int:
		return jsstr.NumberJS(float64(x))
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// stringOr is String(v ?? fallback).
func stringOr(m map[string]any, key, fallback string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return fallback
	}
	return jsString(v)
}

func numberParam(m map[string]any, key string) (float64, bool) {
	v, ok := m[key].(float64)
	return v, ok
}

func textOf(result Result) string {
	var parts []string
	for _, c := range result.Content {
		if c.Type == "text" {
			if c.Text != nil {
				parts = append(parts, *c.Text)
			} else {
				parts = append(parts, "")
			}
		}
	}
	return strings.Join(parts, "\n")
}

func splitNonEmpty(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func countNonEmpty(text string) int { return len(splitNonEmpty(text)) }

// charCount ports getOutputCharCount: UTF-16 length of the text blocks
// without carriage returns.
func charCount(result Result) float64 {
	n := 0
	for _, c := range result.Content {
		if c.Type != "text" {
			continue
		}
		text := ""
		if c.Text != nil {
			text = *c.Text
		}
		n += jsstr.Len16(strings.ReplaceAll(text, "\r", ""))
	}
	return float64(n)
}

// Execute runs a tool as its wrapped execute does: wrapExecuteWithMetrics
// over the tool's logic. An error is the execute's throw.
func (t *Tools) Execute(tool string, params map[string]any, cwd string) (Result, error) {
	if params == nil {
		params = map[string]any{}
	}
	start := t.now()
	var result Result
	var err error
	switch tool {
	case "read":
		result, err = t.executeRead(params, cwd)
	case "bash":
		result, err = t.executeBash(params)
	case "ls":
		result, err = t.executeLs(params, cwd)
	case "find":
		result, err = t.executeFind(params, cwd)
	case "grep":
		result, err = t.executeGrep(params, cwd)
	default:
		return Result{}, errors.New("unknown tool " + tool)
	}
	if err != nil {
		return Result{}, err
	}
	if result.Details == nil {
		result.Details = map[string]any{}
	}
	result.Details[ElapsedKey] = t.now() - start
	result.Details[CharsKey] = charCount(result)
	return result, nil
}

func (t *Tools) now() float64 {
	if t.NowMs == nil {
		return 0
	}
	return t.NowMs()
}

func (t *Tools) getenv(name string) string {
	if t.Getenv == nil {
		return ""
	}
	return t.Getenv(name)
}

// routed runs rtk; ok=false is the throw that makes the tool fall back.
func (t *Tools) routed(sub string, args []string, cwd string) (rtk.ExecResult, bool) {
	if t.Exec == nil {
		return rtk.ExecResult{}, false
	}
	result, err := t.Exec("rtk", append([]string{sub}, args...), cwd)
	return result, err == nil
}

var (
	imagePathRe  = regexp.MustCompile(`(?i)\.(?:jpe?g|png|gif|webp|bmp)$`)
	numberedRe   = regexp.MustCompile(`^[` + jsS + `]*(\d+)[` + jsS + `]+[│|][` + jsS + `]?(.*)$`)
	findStaticRe = regexp.MustCompile(`[*?[\]]`)
	findLineRe   = regexp.MustCompile(`^([^` + jsS + `]*/)[` + jsS + `]+(.+)$`)
	jsSpacesRe   = regexp.MustCompile(`[` + jsS + `]+`)
)

func (t *Tools) executeRead(p map[string]any, cwd string) (Result, error) {
	filePath := stringOr(p, "path", "")
	if !imagePathRe.MatchString(filePath) {
		if routed, ok := t.routed("read", []string{filePath, "--line-numbers"}, cwd); ok {
			if err := rtk.RequireSuccess("read", routed, nil); err != nil {
				return Result{}, err
			}
			offset := 1.0
			if v, ok := numberParam(p, "offset"); ok {
				offset = math.Max(1, v)
			}
			end := math.Inf(1)
			if v, ok := numberParam(p, "limit"); ok {
				end = offset + math.Max(0, v)
			}
			var selected []string
			for _, line := range strings.Split(jsstr.TrimEnd(NormalizeLineEndings(routed.Stdout)), "\n") {
				m := numberedRe.FindStringSubmatch(line)
				if m == nil {
					continue
				}
				n, _ := jsNumber(m[1])
				if n >= offset && n < end {
					selected = append(selected, m[2])
				}
			}
			tc := rtk.TruncateOutput(strings.Join(selected, "\n"), 0, 0)
			lineCount := 0
			if tc != "" {
				lineCount = len(strings.Split(tc, "\n"))
			}
			return Result{Content: []Content{TextContent(tc)}, Details: map[string]any{
				"_type": "readFile", "filePath": filePath, "content": tc, "offset": offset - 1, "lineCount": float64(lineCount),
			}}, nil
		}
	}
	result, err := t.builtin("read", p)
	if err != nil {
		return Result{}, err
	}
	for _, c := range result.Content {
		if c.Type == "image" {
			result.Details = map[string]any{"_type": "readImage", "filePath": filePath}
			return result, nil
		}
	}
	tc := NormalizeLineEndings(textOf(result))
	offset := 0.0
	if v, ok := numberParam(p, "offset"); ok {
		offset = v
	}
	lineCount := 0
	if tc != "" {
		lineCount = len(strings.Split(tc, "\n"))
	}
	result.Details = map[string]any{"_type": "readFile", "filePath": filePath, "content": tc, "offset": offset, "lineCount": float64(lineCount)}
	return result, nil
}

func (t *Tools) builtin(tool string, params map[string]any) (Result, error) {
	if t.Builtin == nil {
		return Result{}, errors.New(tool + ": the built-in tool is not available")
	}
	return t.Builtin(tool, params)
}

func bashDetails(text, command string) map[string]any {
	return map[string]any{"_type": "bashResult", "text": text, "exitCode": 1.0, "command": command}
}

func (t *Tools) executeBash(p map[string]any) (Result, error) {
	command := stringOr(p, "command", "")
	if BashGrepGuardEnabled(t.getenv) {
		if blocked := GrepGuardMessage(command); blocked != "" {
			return Result{Content: []Content{TextContent(blocked)}, IsError: true, Details: bashDetails(blocked, command)}, nil
		}
	}
	result, err := t.builtin("bash", p)
	if err != nil {
		msg := err.Error()
		return Result{Content: []Content{TextContent(msg)}, IsError: true, Details: bashDetails(msg, command)}, nil
	}
	return result, nil
}

func (t *Tools) executeLs(p map[string]any, cwd string) (Result, error) {
	dir := stringOr(p, "path", ".")
	limit := 500.0
	if v, ok := numberParam(p, "limit"); ok {
		limit = v
	}
	limit = math.Max(1, limit)
	if routed, ok := t.routed("ls", []string{"-A", dir}, cwd); ok {
		if err := rtk.RequireSuccess("ls", routed, nil); err != nil {
			return Result{}, err
		}
		tc := rtk.LimitLines(routed.Stdout, int(math.Trunc(limit)))
		return Result{Content: []Content{TextContent(tc)}, Details: map[string]any{
			"_type": "lsResult", "text": tc, "path": dir, "entryCount": float64(countNonEmpty(tc)),
		}}, nil
	}
	result, err := t.builtin("ls", p)
	if err != nil {
		return Result{}, err
	}
	tc := textOf(result)
	count := 0
	if tc != "" {
		count = countNonEmpty(jsstr.Trim(tc))
	}
	result.Details = map[string]any{"_type": "lsResult", "text": tc, "path": dir, "entryCount": float64(count)}
	return result, nil
}

// nodeJoin is node:path join for POSIX paths: path.Join, keeping a
// trailing slash of the joined text.
func nodeJoin(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	joined := path.Join(nonEmpty...)
	if strings.HasSuffix(strings.Join(nonEmpty, "/"), "/") && joined != "/" {
		joined += "/"
	}
	return joined
}

// buildRtkFindArgs ports buildRtkFindArgs; ok=false is undefined (a
// wildcard directory segment).
func buildRtkFindArgs(pattern string, dir *string) ([]string, bool) {
	absolute := strings.HasPrefix(pattern, "/")
	stripped := pattern
	if strings.HasPrefix(stripped, "./") {
		stripped = stripped[2:]
	} else if strings.HasPrefix(stripped, "/") {
		stripped = stripped[1:]
	}
	parts := []string{}
	for _, part := range strings.Split(stripped, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	filePattern := pattern
	if len(parts) > 0 {
		filePattern = parts[len(parts)-1]
		parts = parts[:len(parts)-1]
	}
	static := []string{}
	for _, part := range parts {
		if part == "**" {
			continue
		}
		if findStaticRe.MatchString(part) {
			return nil, false
		}
		static = append(static, part)
	}
	base := "."
	if absolute {
		base = "/"
	} else if dir != nil {
		base = *dir
	}
	return []string{filePattern, nodeJoin(append([]string{base}, static...)...)}, true
}

// parseRtkFindOutput ports parseRtkFindOutput.
func parseRtkFindOutput(output string, limit float64) string {
	lines := strings.Split(jsstr.Trim(NormalizeLineEndings(output)), "\n")
	var paths []string
	for _, line := range lines {
		m := findLineRe.FindStringSubmatch(jsstr.Trim(line))
		if m == nil {
			continue
		}
		directory := m[1]
		if directory == "./" {
			directory = ""
		}
		for _, file := range jsSpacesRe.Split(m[2], -1) {
			if file == "" {
				continue
			}
			paths = append(paths, directory+file)
			if float64(len(paths)) >= limit {
				return strings.Join(paths, "\n")
			}
		}
	}
	if len(paths) > 0 {
		return strings.Join(paths, "\n")
	}
	return rtk.LimitLines(output, int(math.Trunc(limit)))
}

func (t *Tools) sdkFindAsFindResult(p map[string]any, pattern string, extra string) (Result, error) {
	result, err := t.builtin("find", p)
	if err != nil {
		return Result{}, err
	}
	tc := textOf(result)
	notices := []any{}
	if prev, ok := result.Details["notices"].([]any); ok {
		notices = append(notices, prev...)
	}
	notices = append(notices, extra)
	count := 0
	if tc != "" {
		count = countNonEmpty(jsstr.Trim(tc))
	}
	result.Details = map[string]any{"_type": "findResult", "text": tc, "pattern": pattern, "matchCount": float64(count), "notices": notices}
	return result, nil
}

func (t *Tools) executeFind(p map[string]any, cwd string) (Result, error) {
	pattern := stringOr(p, "pattern", "")
	var dir *string
	if jsstr.Truthy(p["path"]) {
		s := jsString(p["path"])
		dir = &s
	}
	limit := 100.0
	if v, ok := numberParam(p, "limit"); ok {
		limit = v
	}
	limit = math.Max(1, limit)
	args, ok := buildRtkFindArgs(pattern, dir)
	if !ok {
		return t.sdkFindAsFindResult(p, pattern, "RTK find cannot represent wildcard directory segments; results from SDK find (fd).")
	}
	if routed, ok := t.routed("find", args, cwd); ok {
		if err := rtk.RequireSuccess("find", routed, nil); err != nil {
			return Result{}, err
		}
		text := parseRtkFindOutput(routed.Stdout, limit)
		return Result{Content: []Content{TextContent(text)}, Details: map[string]any{
			"_type": "findResult", "text": text, "pattern": pattern, "matchCount": float64(countNonEmpty(text)),
			"notices": []any{"Search engine: RTK find."},
		}}, nil
	}
	return t.sdkFindAsFindResult(p, pattern, "RTK could not execute; results from SDK find (fd).")
}

func (t *Tools) executeGrep(p map[string]any, cwd string) (Result, error) {
	pattern := stringOr(p, "pattern", "")
	dir := "."
	if jsstr.Truthy(p["path"]) {
		dir = jsString(p["path"])
	}
	context := 0.0
	if v, ok := numberParam(p, "context"); ok {
		context = v
	}
	limit := 200.0
	if v, ok := numberParam(p, "limit"); ok {
		limit = v
	}
	args := []string{"--max", jsstr.NumberJS(math.Max(1, limit)), "-R"}
	if p["literal"] == true {
		args = append(args, "-F")
	} else {
		args = append(args, "-E")
	}
	if p["ignoreCase"] == true || p["caseInsensitive"] == true {
		args = append(args, "-i")
	}
	if context > 0 {
		args = append(args, "-C", jsstr.NumberJS(context))
	}
	if jsstr.Truthy(p["glob"]) {
		args = append(args, "--include="+jsString(p["glob"]))
	}
	args = append(args, "--", pattern, dir)
	if routed, ok := t.routed("grep", args, cwd); ok {
		if err := rtk.RequireSuccess("grep", routed, []int{0, 1}); err != nil {
			return Result{}, err
		}
		tc := rtk.TruncateOutput(NormalizeLineEndings(routed.Stdout), 0, 0)
		count := 0
		if tc != "" {
			count = countNonEmpty(jsstr.Trim(tc))
		}
		return Result{Content: []Content{TextContent(tc)}, Details: map[string]any{
			"_type": "grepResult", "text": tc, "pattern": pattern, "matchCount": float64(count),
		}}, nil
	}
	result, err := t.builtin("grep", p)
	if err != nil {
		return Result{}, err
	}
	for i, c := range result.Content {
		if c.Type == "text" && c.Text != nil {
			normalized := NormalizeLineEndings(*c.Text)
			result.Content[i].Text = &normalized
		}
	}
	tc := textOf(result)
	count := 0
	if tc != "" {
		count = countNonEmpty(jsstr.Trim(tc))
	}
	result.Details = map[string]any{"_type": "grepResult", "text": tc, "pattern": pattern, "matchCount": float64(count)}
	return result, nil
}
