package difftools

// Tool execution and tool-card rendering: port of the write, edit, and
// apply_patch parts of diff-tools/index.ts. The Go renderers are
// synchronous, so each returns the final lines that the TypeScript
// width-aware Text shows after its async render task finishes.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

const toolResultIndent = " "

var arrowHeaders = map[string]bool{"write": true, "create": true, "edit": true, "apply_patch": true}

// FormatToolHeaderName ports formatToolHeaderName.
func FormatToolHeaderName(name string) string {
	if arrowHeaders[name] {
		return "← " + name
	}
	return name
}

// FormatToolHeaderPath ports formatToolHeaderPath.
func FormatToolHeaderPath(t chrome.Theme, filePath string) string {
	return t.Fg("toolTitle", filePath)
}

// IsToolResultError ports isToolResultError.
func IsToolResultError(resultIsError, ctxIsError bool) bool { return resultIsError || ctxIsError }

// Tools is the state of diffRendererExtension's closure.
type Tools struct {
	Palette *Palette
	// Cwd is process.cwd() in TypeScript: the base of shortPath and of
	// relative tool paths.
	Cwd  string
	Home string
	// TermWidth is termW(): the terminal columns before the -4 margin.
	TermWidth func() int

	mu         sync.Mutex
	writeStats map[string][2]int
}

// NewTools returns the closure state.
func NewTools(p *Palette, cwd, home string, termWidth func() int) *Tools {
	return &Tools{Palette: p, Cwd: cwd, Home: home, TermWidth: termWidth, writeStats: map[string][2]int{}}
}

// termW ports termW.
func (t *Tools) termW() int {
	raw := 0
	if t.TermWidth != nil {
		raw = t.TermWidth()
	}
	if raw == 0 {
		raw = 200
	}
	return max(80, min(raw-4, 210))
}

// resolvePath resolves a tool path like Node's fs against process.cwd().
func (t *Tools) resolvePath(p string) string {
	if p == "" || filepath.IsAbs(p) || t.Cwd == "" {
		return p
	}
	return filepath.Join(t.Cwd, p)
}

// ShortPath ports shortPath.
func (t *Tools) ShortPath(p string) string {
	if p == "" {
		return ""
	}
	abs := t.resolvePath(p)
	if !filepath.IsAbs(abs) {
		abs, _ = filepath.Abs(abs)
	}
	base := t.Cwd
	if base == "" {
		base, _ = os.Getwd()
	}
	r, err := filepath.Rel(base, filepath.Clean(abs))
	if err == nil {
		if r == "." {
			r = ""
		}
		if !strings.HasPrefix(r, "..") && !strings.HasPrefix(r, "/") {
			return r
		}
	}
	return strings.Replace(p, t.Home, "~", 1)
}

// summarize ports index.ts summarize (index.ts palette).
func (s *paletteState) summarize(a, d int) string {
	var parts []string
	if a > 0 {
		parts = append(parts, s.fgAdd+"+"+strconv.Itoa(a)+s.rst)
	}
	if d > 0 {
		parts = append(parts, s.fgDel+"-"+strconv.Itoa(d)+s.rst)
	}
	if len(parts) == 0 {
		return s.fgDim + "no changes" + s.rst
	}
	return strings.Join(parts, " ")
}

// Summarize is summarize with the current index.ts palette.
func (t *Tools) Summarize(a, d int) string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.Palette.ix.summarize(a, d)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func readText(p string) (string, bool) {
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		return "", false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func stringParam(params map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := params[k]; ok && v != nil {
			s, _ := v.(string)
			return s
		}
	}
	return ""
}

// WriteBefore is the first half of write's execute: the old content, or
// ok=false when the file does not exist or cannot be read.
func (t *Tools) WriteBefore(params map[string]any) (fp, old string, ok bool) {
	fp = stringParam(params, "path", "file_path")
	if fp == "" {
		return fp, "", false
	}
	old, ok = readText(t.resolvePath(fp))
	return fp, old, ok
}

// WriteDetails is the second half of write's execute: the result details
// after the built-in write ran.
func (t *Tools) WriteDetails(toolCallID, fp, old string, hadOld bool, params map[string]any) map[string]any {
	content := stringParam(params, "content")
	switch {
	case hadOld && old != content:
		diff := ParseDiff(old, content, 3)
		if toolCallID != "" {
			t.mu.Lock()
			t.writeStats[toolCallID] = [2]int{diff.Added, diff.Removed}
			t.mu.Unlock()
		}
		details := map[string]any{"_type": "diff", "summary": t.Summarize(diff.Added, diff.Removed), "filePath": fp, "diff": diff, "oldContent": old, "newContent": content}
		if lg := Lang(fp); lg != "" {
			details["language"] = lg
		}
		return details
	case !hadOld:
		lines := 0
		if content != "" {
			lines = strings.Count(content, "\n") + 1
		}
		return map[string]any{"_type": "new", "lines": lines, "content": content, "filePath": fp}
	}
	return map[string]any{"_type": "noChange"}
}

func lineOf(content, needle string) int {
	idx := strings.Index(content, needle)
	if idx < 0 {
		return 0
	}
	return strings.Count(content[:idx], "\n") + 1
}

func (t *Tools) summarizeEditOperations(ops []EditOperation) ([]ParsedDiff, string) {
	diffs := make([]ParsedDiff, len(ops))
	added, removed := 0, 0
	for i, op := range ops {
		diffs[i] = ParseDiff(op.OldText, op.NewText, 3)
		added += diffs[i].Added
		removed += diffs[i].Removed
	}
	return diffs, t.Summarize(added, removed)
}

func mergeDiffs(diffs []ParsedDiff) ParsedDiff {
	merged := ParsedDiff{Lines: []DiffLine{}}
	for i, d := range diffs {
		if i > 0 {
			merged.Lines = append(merged.Lines, DiffLine{Type: "sep", Content: "───── Edit " + strconv.Itoa(i+1) + " ─────"})
		}
		merged.Lines = append(merged.Lines, d.Lines...)
		merged.Added += d.Added
		merged.Removed += d.Removed
		merged.Chars += d.Chars
	}
	return merged
}

func withLine(summary string, line int) string {
	if line > 0 {
		return summary + " at line " + strconv.Itoa(line)
	}
	return summary
}

// EditResult is the outcome of the cascading edit.
type EditResult struct {
	Text    string
	Details map[string]any
}

// EditFast ports edit's execute fast path: the cascading Replace over every
// operation, written in one go. ok=false falls back to the built-in edit
// with the normalized params.
func (t *Tools) EditFast(params map[string]any) (EditResult, map[string]any, bool) {
	normalized := NormalizeEditParams(params)
	fp := stringParam(normalized, "path", "file_path")
	ops := GetEditOperations(normalized)
	full := t.resolvePath(fp)
	if fp == "" || len(ops) == 0 || !fileExists(full) {
		return EditResult{}, normalized, false
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return EditResult{}, normalized, false
	}
	content := string(data)
	strategy := ""
	for _, op := range ops {
		r := Replace(content, op.OldText, op.NewText, false)
		if !r.Changed {
			return EditResult{}, normalized, false
		}
		content = r.Content
		if strategy == "" {
			strategy = r.Strategy
		}
	}
	info, _ := os.Stat(full)
	if err := os.WriteFile(full, []byte(content), info.Mode().Perm()); err != nil {
		return EditResult{}, normalized, false
	}
	diffs, summary := t.summarizeEditOperations(ops)
	text := "Edited " + t.ShortPath(fp)
	if len(ops) == 1 {
		line := lineOf(content, ops[0].NewText)
		details := map[string]any{"_type": "editInfo", "summary": withLine(summary, line), "filePath": fp, "editLine": line,
			"diff": diffs[0], "oldContent": ops[0].OldText, "newContent": ops[0].NewText, "_replaceStrategy": strategy}
		if lg := Lang(fp); lg != "" {
			details["language"] = lg
		}
		return EditResult{text, details}, normalized, true
	}
	line := 0
	if ops[0].NewText != "" {
		line = lineOf(content, ops[0].NewText)
	}
	merged := mergeDiffs(diffs)
	details := map[string]any{"_type": "multiEditInfo", "summary": withLine(summary, line), "filePath": fp, "editCount": len(ops), "diffLineCount": len(merged.Lines), "diff": merged}
	if lg := Lang(fp); lg != "" {
		details["language"] = lg
	}
	return EditResult{text, details}, normalized, true
}

// EditFallbackDetails ports the details edit's execute attaches after the
// built-in edit ran. ok=false keeps the built-in result as it is.
func (t *Tools) EditFallbackDetails(normalized map[string]any) (map[string]any, bool) {
	fp := stringParam(normalized, "path", "file_path")
	ops := GetEditOperations(normalized)
	if len(ops) == 0 {
		return nil, false
	}
	diffs, summary := t.summarizeEditOperations(ops)
	current, readOK := "", false
	if fp != "" {
		current, readOK = readText(t.resolvePath(fp))
	}
	line := 0
	if readOK {
		line = lineOf(current, ops[0].NewText)
	}
	var details map[string]any
	if len(ops) == 1 {
		details = map[string]any{"_type": "editInfo", "summary": withLine(summary, line), "filePath": fp, "editLine": line,
			"diff": diffs[0], "oldContent": ops[0].OldText, "newContent": ops[0].NewText}
	} else {
		merged := mergeDiffs(diffs)
		details = map[string]any{"_type": "multiEditInfo", "summary": withLine(summary, line), "filePath": fp, "editCount": len(ops), "diffLineCount": len(merged.Lines), "diff": merged}
	}
	if lg := Lang(fp); lg != "" {
		details["language"] = lg
	}
	return details, true
}

// ApplyPatch ports apply_patch's execute.
func (t *Tools) ApplyPatch(params map[string]any) (string, bool, map[string]any) {
	result := ExecuteApplyPatch(ResolveApplyPatchChanges(params))
	return FormatApplyPatchResult(result), !result.OK, map[string]any{"_type": "applyPatchInfo", "result": result}
}

// ---- rendering ----

// RenderCtx is the part of the tool render context the renderers read.
type RenderCtx struct {
	ToolCallID   string
	ArgsComplete bool
	IsError      bool
}

// ToolResultView is the rendered result: its text blocks and details.
type ToolResultView struct {
	Texts   []*string // content blocks of type text (nil text is undefined)
	First   *string   // result.content[0].text
	IsError bool
	Details any
}

// textView is pi-tui's Text(text, 0, 0) with an optional background fn.
type textView struct {
	text string
	bg   func(string) string
}

// render ports Text.render.
func (v textView) render(width int) []string {
	if v.text == "" || jsTrim(v.text) == "" {
		return []string{}
	}
	normalized := strings.ReplaceAll(v.text, "\t", "   ")
	contentWidth := max(1, width)
	var out []string
	for _, line := range tuiwidth.WrapTextWithAnsi(normalized, contentWidth) {
		if v.bg != nil {
			out = append(out, v.bg(line+strings.Repeat(" ", max(0, width-tuiwidth.VisibleWidth(line)))))
		} else {
			out = append(out, line+strings.Repeat(" ", max(0, width-tuiwidth.VisibleWidth(line))))
		}
	}
	return out
}

func (t *Tools) headerBg() func(string) string {
	ix := t.Palette.ix
	return func(line string) string { return ix.injectBg(line, nil, ix.bgBase, ix.bgBase) }
}

func (t *Tools) errorBg(theme Theme) func(string) string {
	ix := t.Palette.ix
	background := ix.bgBase
	if theme != nil {
		if bg, err := theme.GetBgAnsi("toolErrorBg"); err == nil {
			background = bg
		}
	}
	return func(line string) string { return ix.injectBg(line, nil, background, background) }
}

// bgLine ports bgLine.
func (t *Tools) bgLine(content string, width int) string {
	w := max(1, width)
	fitted := chrome.PadToWidth(chrome.FitLine(content, w), w)
	return t.Palette.ix.injectBg(fitted, nil, t.Palette.ix.bgBase, t.Palette.ix.bgBase)
}

type frameOpts struct {
	topPad, bottomPad, headerLeftPad int
	suffix, label, filePath          string
	theme                            Theme
	meta                             *string
}

// frameHeaderText ports formatToolFrameHeaderText.
func (t *Tools) frameHeaderText(o frameOpts) string {
	rail := "▎"
	if o.theme != nil {
		rail = o.theme.Fg("accent", "▎")
	}
	var header string
	if o.meta != nil {
		header = *o.meta + o.suffix
	} else {
		header = o.theme.Fg("toolTitle", o.theme.Bold(FormatToolHeaderName(o.label))) + " " + FormatToolHeaderPath(o.theme, t.ShortPath(o.filePath)) + o.suffix
	}
	content := strings.Repeat(" ", o.headerLeftPad) + rail + " " + header
	return strings.Repeat("\n", o.topPad) + content + strings.Repeat("\n", o.bottomPad)
}

// frameHeader ports formatToolFrameHeader.
func (t *Tools) frameHeader(o frameOpts, width int) string {
	top, bottom := o.topPad, o.bottomPad
	o.topPad, o.bottomPad = 0, 0
	return strings.Repeat("\n", top) + t.bgLine(t.frameHeaderText(o), width) + strings.Repeat("\n", bottom)
}

// padDiffBody ports padDiffBody.
func (t *Tools) padDiffBody(rendered string, pad int) string {
	left := t.Palette.ix.bgBase + strings.Repeat(" ", pad) + t.Palette.ix.rst
	lines := strings.Split(rendered, "\n")
	for i := range lines {
		lines[i] = left + lines[i]
	}
	return strings.Join(lines, "\n")
}

// errorResult ports formatToolErrorResult.
func (t *Tools) errorResult(name, message string, theme Theme) string {
	meta := theme.Fg("error", theme.Bold(FormatToolHeaderName(name)))
	header := t.frameHeaderText(frameOpts{meta: &meta, theme: theme, headerLeftPad: 1, bottomPad: 1})
	return header + "\n " + theme.Fg("error", message) + "\n"
}

type previewFrame struct {
	headerLeftPad, bodyLeftPad, topPad, bottomPad, previewBottomPad int
	omitHeader, compactGutter                                       bool
}

// diffPreview ports setDiffPreviewTask's final render.
func (t *Tools) diffPreview(header func(int) string, diff ParsedDiff, language string, maxLines int, theme Theme, f previewFrame, width int) textView {
	colors := t.Palette.resolveLocked(theme)
	if f.omitHeader {
		header = func(int) string { return "" }
	}
	bodyWidth := max(1, width-f.bodyLeftPad)
	body := t.padDiffBody(t.Palette.renderSplit(diff, language, maxLines, colors, bodyWidth, RenderOptions{CompactGutter: f.compactGutter}), f.bodyLeftPad)
	h := header(width)
	main := body
	if h != "" {
		main = h + "\n" + body
	}
	if f.previewBottomPad > 0 {
		bottom := make([]string, f.previewBottomPad)
		for i := range bottom {
			bottom[i] = t.bgLine("", width)
		}
		main += "\n" + strings.Join(bottom, "\n")
	}
	return textView{text: main}
}

var trailingNewlinesRe = regexp.MustCompile(`\n+$`)

// filePreview is the highlighted new-file preview of create/new results.
func (t *Tools) filePreview(header string, content, language string, width int) textView {
	lines := t.Palette.hlBlockWith(t.Palette.ix, content, language)
	for i, l := range lines {
		lines[i] = chrome.FitLine(l, width)
	}
	preview := trailingNewlinesRe.ReplaceAllString(strings.Join(lines, "\n"), "")
	return textView{text: header + "\n" + t.padDiffBody(preview, 0)}
}

func renderWidth(width int) int { return max(1, width) }

// RenderWriteCall ports write's renderCall.
func (t *Tools) RenderWriteCall(theme Theme, args map[string]any, rc RenderCtx, width int) []string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.renderWriteCall(theme, args, rc, width).render(width)
}

func (t *Tools) writeStatsSuffix(id string, theme Theme) string {
	if id == "" {
		return ""
	}
	t.mu.Lock()
	raw, ok := t.writeStats[id]
	t.mu.Unlock()
	if !ok {
		return ""
	}
	t.Palette.ix.resolve(theme)
	return toolResultIndent + t.Palette.ix.summarize(raw[0], raw[1])
}

func (t *Tools) renderWriteCall(theme Theme, args map[string]any, rc RenderCtx, width int) textView {
	fp := stringParam(args, "path", "file_path")
	isNew := fp == "" || !fileExists(t.resolvePath(fp))
	label := "write"
	if isNew {
		label = "create"
	}
	t.Palette.ix.resolve(theme)
	stats := t.writeStatsSuffix(rc.ToolCallID, theme)
	content, _ := args["content"].(string)
	if content != "" && !rc.ArgsComplete {
		suffix := toolResultIndent + theme.Fg("muted", "("+strconv.Itoa(strings.Count(content, "\n")+1)+" lines…)")
		if stats != "" {
			suffix += " " + strings.TrimLeftFunc(stats, jsstr.IsJSSpace)
		}
		return textView{text: t.frameHeaderText(frameOpts{label: label, filePath: fp, theme: theme, suffix: suffix, bottomPad: 1}), bg: t.headerBg()}
	}
	w := renderWidth(width)
	if content != "" && rc.ArgsComplete && isNew {
		header := t.frameHeader(frameOpts{label: label, filePath: fp, theme: theme}, w)
		return t.filePreview(header, content, Lang(fp), w)
	}
	if content != "" && rc.ArgsComplete && !isNew {
		if old, ok := readText(t.resolvePath(fp)); ok {
			if old != content {
				diff := ParseDiff(old, content, 3)
				t.Palette.ix.resolve(theme)
				suffix := " " + theme.Fg("muted", t.Palette.ix.summarize(diff.Added, diff.Removed))
				header := func(width int) string {
					return t.frameHeader(frameOpts{label: label, filePath: fp, theme: theme, suffix: suffix, bottomPad: 1}, width)
				}
				return t.diffPreview(header, diff, Lang(fp), MaxRenderLines, theme, previewFrame{previewBottomPad: 1, compactGutter: true}, w)
			}
			return textView{text: t.frameHeaderText(frameOpts{label: label, filePath: fp, theme: theme, suffix: toolResultIndent + theme.Fg("muted", "(no changes)"), bottomPad: 1}), bg: t.headerBg()}
		}
	}
	return textView{text: t.frameHeaderText(frameOpts{label: label, filePath: fp, theme: theme, suffix: stats, bottomPad: 1}), bg: t.headerBg()}
}

type resultDetails struct {
	Type          string      `json:"_type"`
	Diff          *ParsedDiff `json:"diff"`
	Language      string      `json:"language"`
	Lines         int         `json:"lines"`
	Content       string      `json:"content"`
	FilePath      string      `json:"filePath"`
	EditCount     int         `json:"editCount"`
	DiffLineCount *int        `json:"diffLineCount"`
	Result        *struct {
		Applied []AppliedChange `json:"applied"`
	} `json:"result"`
	resultRaw json.RawMessage
}

func decodeDetails(details any) resultDetails {
	var d resultDetails
	if details == nil {
		return d
	}
	data, err := json.Marshal(details)
	if err != nil {
		return d
	}
	_ = json.Unmarshal(data, &d)
	var raw struct {
		Result json.RawMessage `json:"result"`
	}
	_ = json.Unmarshal(data, &raw)
	d.resultRaw = raw.Result
	return d
}

func joinTexts(texts []*string) (string, bool) {
	if texts == nil {
		return "", false
	}
	parts := make([]string, len(texts))
	for i, s := range texts {
		if s != nil {
			parts[i] = *s
		}
	}
	return strings.Join(parts, "\n"), true
}

func (t *Tools) dimFirst(theme Theme, r ToolResultView, fallback string) textView {
	text := fallback
	if r.First != nil {
		text = *r.First
	}
	return textView{text: toolResultIndent + theme.Fg("dim", jsstr.Slice16(text, 120))}
}

// RenderWriteResult ports write's renderResult.
func (t *Tools) RenderWriteResult(theme Theme, r ToolResultView, rc RenderCtx, width int) []string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.renderWriteResult(theme, r, rc, width).render(width)
}

func (t *Tools) renderWriteResult(theme Theme, r ToolResultView, rc RenderCtx, width int) textView {
	if IsToolResultError(r.IsError, rc.IsError) {
		e, ok := joinTexts(r.Texts)
		if !ok {
			e = "Error"
		}
		return textView{text: t.errorResult("write", e, theme), bg: t.errorBg(theme)}
	}
	d := decodeDetails(r.Details)
	w := renderWidth(width)
	switch d.Type {
	case "diff":
		diff := ParsedDiff{}
		if d.Diff != nil {
			diff = *d.Diff
		}
		return t.diffPreview(nil, diff, d.Language, MaxRenderLines, theme, previewFrame{omitHeader: true, previewBottomPad: 1, compactGutter: true}, w)
	case "noChange":
		return textView{text: toolResultIndent + theme.Fg("muted", "✓ no changes")}
	case "new":
		t.Palette.resolveLocked(theme)
		header := t.bgLine(theme.Fg("success", "✓ new file ("+strconv.Itoa(d.Lines)+" lines)"), w)
		if d.Content == "" {
			return textView{text: header}
		}
		return t.filePreview(header, d.Content, Lang(d.FilePath), w)
	}
	return t.dimFirst(theme, r, "written")
}

// RenderEditCall ports edit's renderCall.
func (t *Tools) RenderEditCall(theme Theme, args map[string]any, rc RenderCtx, width int) []string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.renderEditCall(theme, args, rc).render(width)
}

func (t *Tools) renderEditCall(theme Theme, args map[string]any, rc RenderCtx) textView {
	fp := stringParam(args, "path", "file_path")
	ops := GetEditOperations(args)
	t.Palette.resolveLocked(theme)
	if rc.ArgsComplete && len(ops) > 0 {
		line := 0
		if fp != "" {
			if cur, ok := readText(t.resolvePath(fp)); ok {
				line = lineOf(cur, ops[0].OldText)
			}
		}
		loc := ""
		if line > 0 {
			loc = toolResultIndent + theme.Fg("muted", "at line "+strconv.Itoa(line))
		}
		return textView{text: t.frameHeaderText(frameOpts{label: "edit", filePath: fp, theme: theme, suffix: loc, topPad: 1, bottomPad: 1, headerLeftPad: 1}), bg: t.headerBg()}
	}
	return textView{text: t.frameHeader(frameOpts{label: "edit", filePath: fp, theme: theme, topPad: 1, bottomPad: 1, headerLeftPad: 1}, t.termW())}
}

// RenderEditResult ports edit's renderResult.
func (t *Tools) RenderEditResult(theme Theme, r ToolResultView, rc RenderCtx, width int) []string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.renderEditResult(theme, r, rc, width).render(width)
}

func (t *Tools) renderEditResult(theme Theme, r ToolResultView, rc RenderCtx, width int) textView {
	if rc.IsError {
		e, ok := joinTexts(r.Texts)
		if !ok {
			e = "Error"
		}
		return textView{text: t.errorResult("edit", e, theme), bg: t.errorBg(theme)}
	}
	d := decodeDetails(r.Details)
	w := renderWidth(width)
	frame := previewFrame{omitHeader: true, previewBottomPad: 1, compactGutter: true, bodyLeftPad: 1}
	switch {
	case d.Type == "editInfo" && d.Diff != nil:
		return t.diffPreview(nil, *d.Diff, d.Language, MaxPreviewRenderLines, theme, frame, w)
	case d.Type == "multiEditInfo":
		if d.Diff != nil {
			return t.diffPreview(nil, *d.Diff, d.Language, MaxPreviewRenderLines, theme, frame, w)
		}
		meta := strconv.Itoa(d.EditCount) + " edits"
		if d.DiffLineCount != nil {
			meta += " " + theme.Fg("muted", "("+strconv.Itoa(*d.DiffLineCount)+" diff lines)")
		}
		t.Palette.resolveLocked(theme)
		return textView{text: t.frameHeaderText(frameOpts{meta: &meta}), bg: t.headerBg()}
	}
	return t.dimFirst(theme, r, "edited")
}

// summarizeApplyPatchChanges ports summarizeApplyPatchChanges.
func (t *Tools) summarizeApplyPatchChanges(paths []string, theme Theme) string {
	if len(paths) == 0 {
		return ""
	}
	first := FormatToolHeaderPath(theme, t.ShortPath(paths[0]))
	if len(paths) == 1 {
		return first
	}
	return first + theme.Fg("muted", ", +"+strconv.Itoa(len(paths)-1)+" more")
}

// RenderApplyPatchCall ports apply_patch's renderCall.
func (t *Tools) RenderApplyPatchCall(theme Theme, args map[string]any, rc RenderCtx, width int) []string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.renderApplyPatchCall(theme, args, rc).render(width)
}

func (t *Tools) renderApplyPatchCall(theme Theme, args map[string]any, rc RenderCtx) textView {
	if args == nil {
		args = map[string]any{}
	}
	changes := ResolveApplyPatchChanges(args)
	if rc.ArgsComplete && len(changes) > 0 {
		return textView{}
	}
	suffix := toolResultIndent + theme.Fg("muted", "(waiting for changes)")
	if n := len(changes); n > 0 {
		plural := "s"
		if n == 1 {
			plural = ""
		}
		paths := make([]string, n)
		for i, c := range changes {
			paths[i] = c.Path
		}
		suffix = toolResultIndent + theme.Fg("muted", "("+strconv.Itoa(n)+" change"+plural+")") + toolResultIndent + t.summarizeApplyPatchChanges(paths, theme)
	}
	meta := theme.Fg("toolTitle", theme.Bold(FormatToolHeaderName("apply_patch"))) + suffix
	return textView{text: t.frameHeaderText(frameOpts{meta: &meta, bottomPad: 1}), bg: t.headerBg()}
}

// RenderApplyPatchResult ports apply_patch's renderResult.
func (t *Tools) RenderApplyPatchResult(theme Theme, r ToolResultView, rc RenderCtx, width int) []string {
	t.Palette.mu.Lock()
	defer t.Palette.mu.Unlock()
	return t.renderApplyPatchResult(theme, r, rc, width).render(width)
}

func (t *Tools) renderApplyPatchResult(theme Theme, r ToolResultView, rc RenderCtx, width int) textView {
	out, _ := joinTexts(r.Texts)
	if rc.IsError {
		if out == "" {
			out = "Error"
		}
		return textView{text: t.errorResult("apply_patch", out, theme), bg: t.errorBg(theme)}
	}
	if view, ok := t.applyPatchPreview(theme, decodeDetails(r.Details), renderWidth(width)); ok {
		return view
	}
	return textView{text: theme.Fg("muted", out)}
}

// applyPatchPreview ports renderApplyPatchPreview.
func (t *Tools) applyPatchPreview(theme Theme, d resultDetails, width int) (textView, bool) {
	if d.Result == nil || len(d.Result.Applied) == 0 {
		return textView{}, false
	}
	applied := d.Result.Applied
	for _, c := range applied {
		switch c.Action {
		case "add":
			if c.NewContent == nil {
				return textView{}, false
			}
		case "update", "delete":
			if c.OldContent == nil {
				return textView{}, false
			}
		default:
			return textView{}, false
		}
	}
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	title := theme.Fg("toolTitle", theme.Bold(FormatToolHeaderName("apply_patch")))
	frame := previewFrame{previewBottomPad: 1, compactGutter: true}
	if len(applied) == 1 {
		c := applied[0]
		if c.Action == "add" {
			t.Palette.resolveLocked(theme)
			content := *c.NewContent
			header := t.bgLine(theme.Fg("success", "✓ new file ("+strconv.Itoa(strings.Count(content, "\n")+1)+" lines)"), width)
			return t.filePreview(header, content, Lang(c.Path), width), true
		}
		parsed := ParseDiff(*c.OldContent, deref(c.NewContent), 3)
		meta := title + toolResultIndent + theme.Fg("muted", "(1 change)") + toolResultIndent + FormatToolHeaderPath(theme, t.ShortPath(c.Path))
		header := func(width int) string {
			return t.frameHeader(frameOpts{meta: &meta, theme: theme, bottomPad: 1}, width)
		}
		return t.diffPreview(header, parsed, Lang(c.Path), MaxPreviewRenderLines, theme, frame, width), true
	}
	merged := ParsedDiff{Lines: []DiffLine{}}
	language, mixed := "", false
	paths := make([]string, len(applied))
	for i, c := range applied {
		parsed := ParseDiff(deref(c.OldContent), deref(c.NewContent), 3)
		next := Lang(c.Path)
		if language == "" {
			language = next
		} else if language != next {
			mixed = true
		}
		merged.Added += parsed.Added
		merged.Removed += parsed.Removed
		merged.Chars += parsed.Chars
		merged.Lines = append(merged.Lines, parsed.Lines...)
		paths[i] = c.Path
	}
	if mixed {
		language = ""
	}
	t.Palette.ix.resolve(theme)
	meta := title + toolResultIndent + theme.Fg("muted", "("+strconv.Itoa(len(applied))+" changes)") + " " + t.Palette.ix.summarize(merged.Added, merged.Removed) + toolResultIndent + t.summarizeApplyPatchChanges(paths, theme)
	header := func(width int) string {
		return t.frameHeader(frameOpts{meta: &meta, theme: theme, bottomPad: 1}, width)
	}
	return t.diffPreview(header, merged, language, MaxPreviewRenderLines, theme, frame, width), true
}
