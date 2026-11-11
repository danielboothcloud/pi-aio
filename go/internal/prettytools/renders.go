package prettytools

// The renderCall/renderResult cards of tools/*.ts. Each returns the lines
// pi-tui's Text(text, 0, 0) renders at width; the responsive read and bash
// cards lay their text out at that width, the others at termWidth().

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// RenderCtx is the part of the render context the cards read.
type RenderCtx struct {
	Expanded bool
	IsError  bool
}

// RenderView is the rendered result: content blocks and details.
type RenderView struct {
	Content []Content
	Details map[string]any
}

func (v RenderView) text() string { return textOf(Result{Content: v.Content}) }

// firstText is `fc && "text" in fc ? String(fc.text).slice(0, 120) : fallback`.
func (v RenderView) firstText(fallback string) string {
	if len(v.Content) == 0 || v.Content[0].Text == nil {
		return fallback
	}
	return jsstr.Slice(*v.Content[0].Text, 0, 120)
}

func (v RenderView) detailType() string {
	s, _ := v.Details["_type"].(string)
	return s
}

func (v RenderView) detailString(key string) string {
	s, _ := v.Details[key].(string)
	return s
}

func orError(text string) string {
	if text == "" {
		return "Error"
	}
	return text
}

func tone(rc RenderCtx) string {
	if rc.IsError {
		return "error"
	}
	return "accent"
}

// pluralJS is plural(count, singular) for a JavaScript number.
func pluralJS(count any, singular string) string {
	word := singular + "s"
	if n, ok := count.(float64); ok && n == 1 {
		word = singular
	}
	if count == nil {
		return "undefined " + word
	}
	return jsString(count) + " " + word
}

func joinNonEmpty(values []string, sep string) string {
	var out []string
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return strings.Join(out, sep)
}

// RenderCall renders a tool's call card at width.
func (t *Tools) RenderCall(tool string, theme Theme, args map[string]any, rc RenderCtx, width int) []string {
	return TextRender(t.CallText(tool, theme, args, rc), width)
}

// CallText is the text renderCall sets on its Text component.
func (t *Tools) CallText(tool string, theme Theme, args map[string]any, rc RenderCtx) string {
	t.resolve(theme)
	if args == nil {
		args = map[string]any{}
	}
	bgBase, bgError := t.BG.Get()
	callBg := bgBase
	if rc.IsError {
		callBg = bgError
	}
	switch tool {
	case "read":
		if !rc.IsError {
			return ""
		}
		label := theme.Fg("error", theme.Bold("→ read"))
		return FillToolBackground("\n"+ToolResultIndent+label+" "+theme.Fg("toolTitle", stringOr(args, "path", ""))+"\n", bgError, 0)
	case "bash":
		tw := t.TermWidth()
		if tw == 0 {
			tw = 80
		}
		timeout := ""
		if v, ok := args["timeout"].(float64); ok {
			timeout = "timeout " + jsstr.NumberJS(v) + "s"
		}
		rawCmd := stringOr(args, "command", "")
		budget := tw
		if !rc.Expanded {
			budget = max(8, tw-20)
		}
		cmd := rawCmd
		if rawCmd == "" {
			cmd = "..."
		} else if !rc.Expanded && jsstr.Len16(rawCmd) > budget {
			cmd = jsstr.Slice(rawCmd, 0, max(1, budget)) + "…"
		}
		call := t.renderToolCallChrome(theme, "bash", joinNonEmpty([]string{cmd, timeout}, " · "), tone(rc), "$", tw)
		return FillToolBackground("\n"+call+"\n", bgBase, tw)
	case "ls":
		dir := ""
		if raw, ok := args["path"]; ok && raw != nil && jsString(raw) != "" {
			dir = ShortPath(t.Cwd, t.Home, jsString(raw))
		}
		if dir == "" {
			dir = "."
		}
		meta := joinNonEmpty([]string{dir, limitMeta(args)}, " · ")
		call := t.renderToolCallChrome(theme, "ls", meta, tone(rc), "", 0)
		return FillToolBackground("\n"+call+"\n", callBg, 0)
	case "find":
		pattern := ""
		if v := args["pattern"]; v != nil {
			pattern = jsString(v)
		}
		if pattern == "" {
			pattern = "*"
		}
		pathArg := "<missing>"
		if v := args["path"]; v != nil {
			pathArg = ShortPath(t.Cwd, t.Home, jsString(v))
		}
		meta := joinNonEmpty([]string{pattern, pathArg, limitMeta(args)}, " · ")
		out := t.renderToolCallChrome(theme, "find", meta, tone(rc), "✱", 0)
		return FillToolBackground("\n"+ToolResultIndent+out+"\n", callBg, 0)
	case "grep":
		pattern := "<missing>"
		if v := args["pattern"]; v != nil {
			pattern = jsString(v)
		}
		pathArg := "<missing>"
		if v := args["path"]; v != nil {
			pathArg = ShortPath(t.Cwd, t.Home, jsString(v))
		}
		glob := ""
		if jsstr.Truthy(args["glob"]) {
			glob = jsString(args["glob"])
		}
		literal, ignoreCase := "", ""
		if args["literal"] == true {
			literal = "literal"
		}
		if args["caseInsensitive"] == true || args["ignoreCase"] == true {
			ignoreCase = "ignore case"
		}
		meta := joinNonEmpty([]string{"/" + pattern + "/", pathArg, glob, limitMeta(args), literal, ignoreCase}, " · ")
		out := t.renderToolCallChrome(theme, "grep", meta, tone(rc), "✱", 0)
		return FillToolBackground("\n"+ToolResultIndent+out+"\n", callBg, 0)
	}
	return ""
}

func limitMeta(args map[string]any) string {
	if v, ok := args["limit"]; ok && v != nil {
		return "limit " + jsString(v)
	}
	return ""
}

// RenderResult renders a tool's result card at width.
func (t *Tools) RenderResult(tool string, theme Theme, v RenderView, rc RenderCtx, width int) []string {
	return TextRender(t.ResultText(tool, theme, v, rc, width), width)
}

// ResultText is the text renderResult sets on its Text component; the read
// and bash cards lay it out at width.
func (t *Tools) ResultText(tool string, theme Theme, v RenderView, rc RenderCtx, width int) string {
	t.resolve(theme)
	switch tool {
	case "read":
		return t.readResultText(theme, v, rc, width)
	case "bash":
		return t.bashResultText(theme, v, rc, width)
	case "ls":
		return t.lsResultText(theme, v, rc)
	case "find":
		return t.findResultText(theme, v, rc)
	case "grep":
		return t.grepResultText(theme, v, rc)
	}
	return ""
}

var skillNameRe = regexp.MustCompile(`^name[` + jsS + `]*:[` + jsS + `]*(.+?)[` + jsS + `]*$`)

// getSkillName ports getSkillName: the skill name of a SKILL.md path, or "".
func getSkillName(filePath, content string) string {
	if jsBasename(filePath) != "SKILL.md" {
		return ""
	}
	fallback := jsBasename(jsDirname(filePath))
	lines := strings.Split(content, "\n")
	if jsstr.Trim(lines[0]) == "---" {
		end := -1
		for i := 1; i < len(lines); i++ {
			if jsstr.Trim(lines[i]) == "---" {
				end = i
				break
			}
		}
		if end < 0 {
			end = 1
		}
		for _, line := range lines[1:max(1, end)] {
			m := skillNameRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			value := jsstr.Trim(m[1])
			if (strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) || (strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'")) {
				inner := jsstr.Trim(jsstr.Slice(value, 1, jsstr.Len16(value)-1))
				if inner == "" {
					return fallback
				}
				return inner
			}
			if value == "" {
				return fallback
			}
			return value
		}
	}
	return fallback
}

func renderSkillHeader(name string, expanded bool, theme Theme) string {
	action := "expand"
	if expanded {
		action = "collapse"
	}
	return theme.Fg("accent", "[skill]") + " " + theme.Fg("toolTitle", name) + " " + theme.Fg("dim", "ctrl+o to "+action)
}

func (t *Tools) readResultText(theme Theme, v RenderView, rc RenderCtx, width int) string {
	bgBase, bgError := t.BG.Get()
	if rc.IsError {
		return FillToolBackground(t.renderToolError(orError(v.text()), theme), bgError, 0)
	}
	switch v.detailType() {
	case "readImage":
		note := v.text()
		if note == "" {
			return ""
		}
		return FillToolBackground(note, bgBase, 0)
	case "readFile":
		content := v.detailString("content")
		if content == "" {
			break
		}
		lines := strings.Split(content, "\n")
		total := len(lines)
		filePath := stringOr(v.Details, "filePath", "")
		skillName := getSkillName(filePath, content)
		p2 := ShortPath(t.Cwd, t.Home, filePath)
		off2 := ""
		offsetValue, hasOffset := v.Details["offset"].(float64)
		if hasOffset {
			off2 = ":" + jsstr.NumberJS(offsetValue)
		}
		w := max(1, width)
		if !rc.Expanded {
			var text string
			if skillName != "" {
				text = "\n" + ToolResultIndent + renderSkillHeader(skillName, false, theme) + "\n"
			} else {
				text = "\n" + t.renderToolCallChrome(theme, "read", p2+off2, "", "", w) + "\n" +
					t.renderToolSummary(theme, pluralJS(float64(total), "line"), nil, "", "", "ctrl+o expand", w) + "\n"
			}
			return FillToolBackground(text, bgBase, w)
		}
		numberWidth := max(3, len(strconv.Itoa(total)))
		codeWidth := max(1, w-(numberWidth+4))
		header := renderSkillHeader(skillName, true, theme)
		if skillName == "" {
			header = t.renderToolCallChrome(theme, "read", p2+off2, "", "", w)
		}
		base := 0.0
		if hasOffset && offsetValue != 0 {
			base = offsetValue
		}
		highlighted := strings.Split(t.RenderFileContent(content, filePath, total, codeWidth), "\n")
		padded := make([]string, len(highlighted))
		for i, line := range highlighted {
			lineNo := jsstr.NumberJS(base + float64(i) + 1)
			padded[i] = ToolResultIndent + FgLnum + strings.Repeat(" ", max(0, numberWidth-len(lineNo))) + lineNo + RST + " " + FgRule + "│" + RST + " " + line + RST
		}
		divider := ToolResultIndent + FgRule + strings.Repeat("─", max(1, w-1)) + RST + "\n"
		return FillToolBackground("\n"+header+"\n"+divider+strings.Join(padded, "\n")+"\n", bgBase, w)
	}
	return FillToolBackground(ToolResultIndent+theme.Fg("dim", v.firstText("done")), bgBase, 0)
}

func (t *Tools) bashResultText(theme Theme, v RenderView, rc RenderCtx, width int) string {
	bgBase, _ := t.BG.Get()
	tc := v.text()
	var text string
	var exit any
	exitPresent := false
	switch {
	case v.detailType() == "bashResult":
		text = v.detailString("text")
		exit, exitPresent = v.Details["exitCode"]
	case tc != "" || rc.IsError:
		text = orError(tc)
		fallback := 0
		if rc.IsError {
			fallback = 1
		}
		exitPresent = true
		if code := InferBashExitCode(tc, &fallback); code != nil {
			exit = float64(*code)
		}
	default:
		return FillToolBackground(ToolResultIndent+theme.Fg("dim", v.firstText("done")), bgBase, 0)
	}
	nullish := !exitPresent || exit == nil
	isErr := rc.IsError || !(exitPresent && (exit == nil || exit == 0.0))
	cleaned := StripBashExitStatusLine(text)
	output := cleaned
	if isErr {
		output = strings.Join(CompactErrorLines(cleaned), "\n")
	}
	lineCount := len(strings.Split(output, "\n"))
	exitText := ""
	if nullish {
		exitText = "0"
		if isErr {
			exitText = "1"
		}
	} else {
		exitText = jsString(exit)
	}
	w := max(1, width)
	toneName, marker, hint := "success", "✓", ""
	if isErr {
		toneName, marker = "error", "✕"
	}
	if !rc.Expanded {
		hint = "ctrl+o expand"
	}
	header := t.renderToolSummary(theme, "exit "+exitText, []string{pluralJS(float64(lineCount), "line"), RenderToolDuration(v.Details)}, toneName, marker, hint, w)
	if !rc.Expanded || jsstr.Trim(output) == "" {
		return FillToolBackground(header+"\n", bgBase, w)
	}
	out := []string{header, ""}
	for _, line := range strings.Split(output, "\n") {
		out = append(out, ToolResultIndent+line)
	}
	return FillToolBackground(strings.Join(out, "\n")+"\n", bgBase, w)
}

func (t *Tools) lsResultText(theme Theme, v RenderView, rc RenderCtx) string {
	bgBase, _ := t.BG.Get()
	if rc.IsError {
		return t.renderToolError(orError(v.text()), theme)
	}
	if v.detailType() == "lsResult" && v.detailString("text") != "" {
		count := v.Details["entryCount"]
		if !rc.Expanded {
			return FillToolBackground(t.renderToolSummary(theme, pluralJS(count, "entry"), nil, "", "", "ctrl+o expand", 0)+RenderToolMetrics(v.Details)+"\n", bgBase, 0)
		}
		tree := strings.Split(t.RenderTree(v.detailString("text")), "\n")
		for i, l := range tree {
			tree[i] = ToolResultIndent + l
		}
		countText := "undefined"
		if count != nil {
			countText = jsString(count)
		}
		return FillToolBackground("\n"+ToolResultIndent+FgDim+countText+" entries"+RST+RenderToolMetrics(v.Details)+"\n"+strings.Join(tree, "\n")+"\n", bgBase, 0)
	}
	return FillToolBackground(ToolResultIndent+theme.Fg("dim", v.firstText("done")), bgBase, 0)
}

func noticeString(theme Theme, notices any) string {
	list, ok := notices.([]any)
	if !ok || len(list) == 0 {
		return ""
	}
	parts := make([]string, len(list))
	for i, n := range list {
		if n != nil {
			parts[i] = jsString(n)
		}
	}
	return "\n" + ToolResultIndent + theme.Fg("warning", "["+strings.Join(parts, ". ")+"]")
}

func (t *Tools) findResultText(theme Theme, v RenderView, rc RenderCtx) string {
	bgBase, _ := t.BG.Get()
	if rc.IsError {
		return t.renderToolError(orError(v.text()), theme)
	}
	if v.detailType() == "findResult" {
		text := v.detailString("text")
		notices := noticeString(theme, v.Details["notices"])
		if jsstr.Trim(text) == "" {
			return FillToolBackground("\n"+ToolResultIndent+theme.Fg("dim", "0 files")+notices+"\n", bgBase, 0)
		}
		count := v.Details["matchCount"]
		duration := RenderToolDuration(v.Details)
		if !rc.Expanded {
			return FillToolBackground(t.renderToolSummary(theme, pluralJS(count, "file"), []string{duration}, "", "", "ctrl+o expand", 0)+"\n", bgBase, 0)
		}
		rendered := strings.Split(RenderFindResults(text, theme), "\n")
		for i, l := range rendered {
			rendered[i] = ToolResultIndent + l
		}
		durationText := ""
		if duration != "" {
			durationText = FgDim + "· " + duration + RST
		}
		countText := "undefined"
		if count != nil {
			countText = jsString(count)
		}
		return FillToolBackground("\n"+ToolResultIndent+theme.Fg("dim", countText+" files")+durationText+"\n"+strings.Join(rendered, "\n")+notices+"\n", bgBase, 0)
	}
	fallback := "0 files"
	if len(v.Content) > 0 && v.Content[0].Text != nil {
		fallback = jsstr.Slice(*v.Content[0].Text, 0, 120)
	}
	return FillToolBackground("\n"+ToolResultIndent+theme.Fg("dim", fallback)+"\n", bgBase, 0)
}

func (t *Tools) grepResultText(theme Theme, v RenderView, rc RenderCtx) string {
	bgBase, _ := t.BG.Get()
	if rc.IsError {
		return t.renderToolError(orError(v.text()), theme)
	}
	if v.detailType() == "grepResult" && v.detailString("text") != "" {
		text := v.detailString("text")
		if !rc.Expanded {
			return FillToolBackground(t.renderToolSummary(theme, pluralJS(float64(len(strings.Split(text, "\n"))), "line"), nil, "", "", "ctrl+o expand", 0)+"\n", bgBase, 0)
		}
		rendered := strings.Split(RenderGrepResults(text, v.detailString("pattern")), "\n")
		for i, l := range rendered {
			rendered[i] = ToolResultIndent + l
		}
		return FillToolBackground(strings.Join(rendered, "\n")+"\n\n", bgBase, 0)
	}
	return FillToolBackground(ToolResultIndent+theme.Fg("dim", v.firstText("no matches")), bgBase, 0)
}
