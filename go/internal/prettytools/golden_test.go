package prettytools

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/rtk"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// fakeRoot replaces @@ROOT@@ in the golden paths.
const fakeRoot = "/fixture-root"

// rgbTheme is the generator's "rgb" theme: chrome's golden SGR theme with
// 24-bit getBgAnsi colors that throws for unknown roles.
type rgbTheme struct {
	chrome.GoldenTheme
	bg map[string]string
}

func (t rgbTheme) GetBgAnsi(role string) (string, error) {
	if c, ok := t.bg[role]; ok {
		return "\x1b[48;2;" + c + "m", nil
	}
	return "", fmt.Errorf("Unknown theme color: %s", role)
}

// noBgTheme is the generator's "none" theme: fg and bold only.
type noBgTheme struct{ chrome.GoldenTheme }

func (noBgTheme) HasBg() bool { return false }

// stubHighlight is difftools/testdata/shiki-stub.mjs.
func stubHighlight(code, lang string) (string, error) {
	if lang == "python" {
		return "", fmt.Errorf("stub: no python grammar")
	}
	if lang != "typescript" {
		return code + "\n", nil
	}
	lines := strings.Split(code, "\n")
	for i, l := range lines {
		if l == "" {
			continue
		}
		color := "200;120;50"
		if strings.Contains(l, "//") {
			color = "30;30;30"
		}
		lines[i] = "\x1b[38;2;" + color + "m" + l + "\x1b[39m"
	}
	return strings.Join(lines, "\n") + "\n", nil
}

type goldenFile map[string]json.RawMessage

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.ReplaceAll(string(data), "@@ROOT@@", fakeRoot))
	var g goldenFile
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func section[T any](t *testing.T, g goldenFile, name string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(g[name], &v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

type themes struct {
	rgb  Theme
	sgr  Theme
	none Theme
}

func goldenThemes(t *testing.T, g goldenFile) themes {
	codes := section[map[string]int](t, g, "roleCodes")
	base := chrome.GoldenTheme{Codes: codes}
	return themes{
		rgb:  rgbTheme{GoldenTheme: base, bg: section[map[string]string](t, g, "bgRgb")},
		sgr:  base,
		none: noBgTheme{base},
	}
}

func (th themes) named(name string) Theme {
	switch name {
	case "rgb":
		return th.rgb
	case "sgr":
		return th.sgr
	}
	return th.none
}

func newTestPretty() *Pretty {
	p := NewPretty(func(string) string { return "" })
	p.Highlight = stubHighlight
	p.TermWidth = func() int { return 104 }
	return p
}

// norm decodes JSON-encodable values to compare them structurally.
func norm(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBackgroundsAndConfig(t *testing.T) {
	g := loadGolden(t)
	th := goldenThemes(t, g)
	steps := section[[]struct {
		Config      *string
		Theme       string
		Base, Error string
	}](t, g, "bgSteps")
	bg := NewBackgrounds()
	for i, s := range steps {
		dir := filepath.Join(t.TempDir(), fmt.Sprint(i))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if s.Config != nil {
			if err := os.WriteFile(filepath.Join(dir, "aio-pretty.json"), []byte(*s.Config), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		bg.Resolve(th.named(s.Theme), dir)
		base, errBg := bg.Get()
		if base != s.Base || errBg != s.Error {
			t.Errorf("bg step %d (%v %s): got %q %q want %q %q", i, s.Config, s.Theme, base, errBg, s.Base, s.Error)
		}
	}
	p := newTestPretty()
	for _, c := range section[[]struct{ Path, Out string }](t, g, "icons") {
		if got := p.FileIcon(c.Path); got != c.Out {
			t.Errorf("fileIcon(%q) = %q want %q", c.Path, got, c.Out)
		}
	}
	if got := p.DirIcon(); got != section[string](t, g, "dirIcon") {
		t.Errorf("dirIcon = %q", got)
	}
	for _, c := range section[[]struct {
		Path string
		Out  *string
	}](t, g, "langs") {
		want := ""
		if c.Out != nil {
			want = *c.Out
		}
		if got := DetectLang(c.Path); got != want {
			t.Errorf("detectLang(%q) = %q want %q", c.Path, got, want)
		}
	}
}

func TestRenderHelpers(t *testing.T) {
	g := loadGolden(t)
	th := goldenThemes(t, g)
	p := newTestPretty()
	p.BG.Resolve(th.rgb, "")
	base, _ := p.BG.Get()
	for _, c := range section[[]struct {
		Params string
		Out    bool
	}](t, g, "contrast") {
		if got := IsLowContrastShikiFg(c.Params); got != c.Out {
			t.Errorf("isLowContrast(%q) = %v", c.Params, got)
		}
	}
	for _, c := range section[[]struct{ Input, Out string }](t, g, "box") {
		if got := PreserveBoxBackground(c.Input); got != c.Out {
			t.Errorf("preserveBoxBackground(%q) = %q want %q", c.Input, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Text  string
		Width *int
		Bg    *string
		Out   string
	}](t, g, "fills") {
		bg, width := base, 0
		if c.Bg != nil {
			bg = *c.Bg
		}
		if c.Width != nil {
			width = *c.Width
		}
		if got := FillToolBackground(c.Text, bg, width); got != c.Out {
			t.Errorf("fill(%q, %v, %v) = %q want %q", c.Text, c.Bg, c.Width, got, c.Out)
		}
	}
	for _, c := range section[[]struct{ Cwd, Home, P, Out string }](t, g, "shortPaths") {
		if got := ShortPath(c.Cwd, c.Home, c.P); got != c.Out {
			t.Errorf("shortPath(%q) = %q want %q", c.P, got, c.Out)
		}
	}
	number := func(raw json.RawMessage) (float64, bool) {
		var v any
		_ = json.Unmarshal(raw, &v)
		switch x := v.(type) {
		case float64:
			return x, true
		case string:
			switch x {
			case "NaN":
				return math.NaN(), true
			case "Infinity":
				return math.Inf(1), true
			}
		}
		return 0, false
	}
	for _, c := range section[[]struct {
		Ms  json.RawMessage
		Out string
	}](t, g, "elapsed") {
		if got := FormatElapsedMs(number(c.Ms)); got != c.Out {
			t.Errorf("formatElapsedMs(%s) = %q want %q", c.Ms, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		N   json.RawMessage
		Out string
	}](t, g, "chars") {
		if got := FormatCharCount(number(c.N)); got != c.Out {
			t.Errorf("formatCharCount(%s) = %q want %q", c.N, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Text     string
		Fallback *int
		Out      *int
	}](t, g, "exitCodes") {
		got := InferBashExitCode(c.Text, c.Fallback)
		if !reflect.DeepEqual(got, c.Out) {
			t.Errorf("inferBashExitCode(%q, %v) = %v want %v", c.Text, c.Fallback, got, c.Out)
		}
	}
	for _, c := range section[[]struct{ Text, Out string }](t, g, "strips") {
		if got := StripBashExitStatusLine(c.Text); got != c.Out {
			t.Errorf("strip(%q) = %q want %q", c.Text, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Text string
		Out  []string
	}](t, g, "compacts") {
		if got := CompactErrorLines(c.Text); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("compact(%q) = %q want %q", c.Text, got, c.Out)
		}
	}
	for _, c := range section[[]struct{ Text, Out string }](t, g, "trees") {
		if got := p.RenderTree(c.Text); got != c.Out {
			t.Errorf("renderTree(%q) = %q want %q", c.Text, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Text  string
		Theme bool
		Out   string
	}](t, g, "findRenders") {
		var theme Theme
		if c.Theme {
			theme = th.rgb
		}
		if got := RenderFindResults(c.Text, theme); got != c.Out {
			t.Errorf("renderFindResults(%q, %v) = %q want %q", c.Text, c.Theme, got, c.Out)
		}
	}
	for _, c := range section[[]struct{ Text, Pattern, Out string }](t, g, "grepRenders") {
		if got := RenderGrepResults(c.Text, c.Pattern); got != c.Out {
			t.Errorf("renderGrepResults(%q, %q) = %q want %q", c.Text, c.Pattern, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Content, Path string
		MaxLines      int
		Width         int
		Out           string
	}](t, g, "fileContents") {
		if got := p.RenderFileContent(c.Content, c.Path, c.MaxLines, c.Width); got != c.Out {
			t.Errorf("renderFileContent(%q, %q) = %q want %q", c.Content, c.Path, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Details       map[string]any
		Out, Duration string
	}](t, g, "metrics") {
		if got := RenderToolMetrics(c.Details); got != c.Out {
			t.Errorf("renderToolMetrics(%v) = %q want %q", c.Details, got, c.Out)
		}
		if got := RenderToolDuration(c.Details); got != c.Duration {
			t.Errorf("renderToolDuration(%v) = %q want %q", c.Details, got, c.Duration)
		}
	}
}

func TestGuardsGlobsAndRouting(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct {
		Command string
		Gnu     *string
		Misuse  *RgReplaceMisuse
		Message *string
	}](t, g, "guards") {
		gnu := ""
		if c.Gnu != nil {
			gnu = *c.Gnu
		}
		if got := FindGnuGrepInvocation(c.Command); got != gnu {
			t.Errorf("findGnuGrep(%q) = %q want %q", c.Command, got, gnu)
		}
		if got := FindRgReplaceMisuse(c.Command); !reflect.DeepEqual(got, c.Misuse) {
			t.Errorf("findRgReplaceMisuse(%q) = %v want %v", c.Command, got, c.Misuse)
		}
		message := ""
		if c.Message != nil {
			message = *c.Message
		}
		if got := GrepGuardMessage(c.Command); got != message {
			t.Errorf("grepGuardMessage(%q) = %q want %q", c.Command, got, message)
		}
	}
	for _, c := range section[[]struct {
		Pattern, Normalized string
		Likely              bool
	}](t, g, "globs") {
		if got := NormalizeFindGlobPattern(c.Pattern); got != c.Normalized {
			t.Errorf("normalizeFindGlob(%q) = %q want %q", c.Pattern, got, c.Normalized)
		}
		if got := IsLikelyGlobPattern(c.Pattern); got != c.Likely {
			t.Errorf("isLikelyGlob(%q) = %v", c.Pattern, got)
		}
	}
	for _, c := range section[[]struct {
		Text               string
		MaxLines, MaxBytes *int
		Out                string
	}](t, g, "truncations") {
		lines, bytes := 0, 0
		if c.MaxLines != nil {
			lines = *c.MaxLines
		}
		if c.MaxBytes != nil {
			bytes = *c.MaxBytes
		}
		if got := rtk.TruncateOutput(c.Text, lines, bytes); got != c.Out {
			t.Errorf("truncateRtkOutput(%.40q) = %.80q want %.80q", c.Text, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Text  string
		Limit int
		Out   string
	}](t, g, "limits") {
		if got := rtk.LimitLines(c.Text, c.Limit); got != c.Out {
			t.Errorf("limitRtkLines(%q, %d) = %q want %q", c.Text, c.Limit, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Result   rtk.ExecResult
		Accepted []int
		Error    *string
	}](t, g, "requires") {
		err := rtk.RequireSuccess("grep", c.Result, c.Accepted)
		switch {
		case c.Error == nil && err != nil:
			t.Errorf("requireRtkSuccess(%+v) = %v", c.Result, err)
		case c.Error != nil && (err == nil || err.Error() != *c.Error):
			t.Errorf("requireRtkSuccess(%+v) = %v want %q", c.Result, err, *c.Error)
		}
	}
}

type mockFinder struct {
	mode     string
	searches []any
}

func (f *mockFinder) FileSearch(query string, pageSize int) ([]FileItem, bool, error) {
	f.searches = append(f.searches, map[string]any{"query": query, "options": map[string]any{"pageSize": float64(pageSize)}})
	switch f.mode {
	case "throw":
		return nil, false, fmt.Errorf("boom")
	case "fail":
		return nil, false, nil
	case "empty":
		return nil, true, nil
	}
	return []FileItem{
		{RelativePath: "src/app.ts", FileName: "app.ts"},
		{RelativePath: "docs/my notes.md", FileName: "my notes.md"},
		{RelativePath: `q/"quoted" file.txt`, FileName: `"quoted" file.txt`},
		{RelativePath: "top.json", FileName: "top.json"},
	}, true, nil
}

func TestAutocompleteAndLifecycle(t *testing.T) {
	g := loadGolden(t)
	for i, c := range section[[]struct {
		Lines       []string
		Line, Col   int
		Finder      string
		Suggestions struct {
			Items  []AutocompleteItem
			Prefix string
		}
		Delegated bool
		Searches  []any
	}](t, g, "acCases") {
		f := &mockFinder{mode: c.Finder, searches: []any{}}
		var finder Finder = f
		if c.Finder == "none" {
			finder = nil
		}
		items, prefix, delegate := FffSuggestions(c.Lines, c.Line, c.Col, finder)
		if delegate != c.Delegated {
			t.Errorf("ac %d: delegate %v want %v", i, delegate, c.Delegated)
			continue
		}
		if !delegate && (prefix != c.Suggestions.Prefix || !reflect.DeepEqual(items, c.Suggestions.Items)) {
			t.Errorf("ac %d: got %q %+v want %q %+v", i, prefix, items, c.Suggestions.Prefix, c.Suggestions.Items)
		}
		if !reflect.DeepEqual(norm(t, f.searches), norm(t, c.Searches)) {
			t.Errorf("ac %d: searches %v want %v", i, f.searches, c.Searches)
		}
	}
	for _, r := range section[[]struct {
		Disabled *string
		Tools    []struct {
			Name, Label, Description string
			PromptSnippet            *string
			PromptGuidelines         []string
			RenderShell              string
		}
		Commands  []struct{ Name, Description string }
		Shortcuts []struct{ Key, Description string }
		Events    []string
	}](t, g, "registrations") {
		env := func(name string) string {
			if name == "PRETTY_DISABLE_TOOLS" && r.Disabled != nil {
				return *r.Disabled
			}
			return ""
		}
		names := EnabledTools(env)
		if len(names) != len(r.Tools) {
			t.Errorf("disabled %v: tools %v", r.Disabled, names)
			continue
		}
		sdkDescriptions := map[string]string{
			"read": "Read the contents of a file.", "bash": "Execute a bash command in the current working directory.",
			"ls": "List directory contents.", "find": "Search for files by glob pattern.", "grep": "Search file contents for a pattern.",
		}
		for i, want := range r.Tools {
			meta := ToolMeta(names[i], sdkDescriptions[names[i]])
			snippet := ""
			if want.PromptSnippet != nil {
				snippet = *want.PromptSnippet
			}
			if names[i] != want.Name || meta.Label != want.Label || meta.Description != want.Description || meta.PromptSnippet != snippet ||
				!reflect.DeepEqual(meta.PromptGuidelines, want.PromptGuidelines) || want.RenderShell != "self" {
				t.Errorf("tool %d: %s %+v want %+v", i, names[i], meta, want)
			}
		}
		wantCommands := []struct{ Name, Description string }{{"fff-health", FFFHealthDescription}, {"fff-rescan", FFFRescanDescription}}
		if !reflect.DeepEqual(r.Commands, wantCommands) {
			t.Errorf("commands %+v", r.Commands)
		}
		if len(r.Shortcuts) != 1 || r.Shortcuts[0].Key != ExpandShortcut || r.Shortcuts[0].Description != ExpandShortcutSummary {
			t.Errorf("shortcuts %+v", r.Shortcuts)
		}
		if !reflect.DeepEqual(r.Events, []string{"session_start", "session_shutdown"}) {
			t.Errorf("events %v", r.Events)
		}
	}
	for _, c := range section[[]struct {
		Mode, Step string
		Calls      []map[string]any
	}](t, g, "lifecycle") {
		var got []map[string]any
		for _, call := range Lifecycle(c.Step, c.Mode) {
			if call.Fn == "notify" {
				got = append(got, map[string]any{"fn": "notify", "message": call.Message, "level": call.Level})
			} else {
				got = append(got, map[string]any{"fn": call.Fn, "value": call.Value})
			}
		}
		if len(got) == 0 && len(c.Calls) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.Calls) {
			t.Errorf("lifecycle %s/%s: %v want %v", c.Mode, c.Step, got, c.Calls)
		}
	}
}

type scriptStep struct {
	Result map[string]any
	Throw  *string
}

func toContent(t *testing.T, raw any) []Content {
	var out []Content
	data, _ := json.Marshal(raw)
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestToolExecute(t *testing.T) {
	g := loadGolden(t)
	work := section[string](t, g, "work")
	for _, c := range section[[]struct {
		Tool, Label string
		Params      map[string]any
		Exec, Sdk   []scriptStep
		Env         map[string]string
		Out         map[string]any
	}](t, g, "execCases") {
		var execCalls, sdkCalls []any
		execScript, sdkScript := c.Exec, c.Sdk
		tools := &Tools{Pretty: newTestPretty(), Cwd: work, Home: fakeRoot + "/home", Host: Host{
			Getenv: func(name string) string { return c.Env[name] },
			NowMs:  func() float64 { return 0 },
			Exec: func(command string, args []string, cwd string) (rtk.ExecResult, error) {
				execCalls = append(execCalls, map[string]any{"command": command, "args": args, "cwd": cwd})
				if len(execScript) == 0 {
					return rtk.ExecResult{}, fmt.Errorf("spawn rtk ENOENT")
				}
				step := execScript[0]
				execScript = execScript[1:]
				if step.Throw != nil {
					return rtk.ExecResult{}, fmt.Errorf("%s", *step.Throw)
				}
				r := rtk.ExecResult{}
				r.Stdout, _ = step.Result["stdout"].(string)
				r.Stderr, _ = step.Result["stderr"].(string)
				code, _ := step.Result["code"].(float64)
				r.Code = int(code)
				r.Killed, _ = step.Result["killed"].(bool)
				return r, nil
			},
			Builtin: func(tool string, params map[string]any) (Result, error) {
				sdkCalls = append(sdkCalls, map[string]any{"tool": tool, "params": norm(t, params)})
				step := scriptStep{Result: map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}, "details": map[string]any{}}}
				if len(sdkScript) > 0 {
					step = sdkScript[0]
					sdkScript = sdkScript[1:]
				}
				if step.Throw != nil {
					return Result{}, fmt.Errorf("%s", *step.Throw)
				}
				details, _ := step.Result["details"].(map[string]any)
				isError, _ := step.Result["isError"].(bool)
				return Result{Content: toContent(t, step.Result["content"]), Details: details, IsError: isError}, nil
			},
		}}
		got := map[string]any{}
		result, err := tools.Execute(c.Tool, c.Params, work)
		if err != nil {
			got["error"] = err.Error()
		} else {
			details := map[string]any{}
			for k, v := range result.Details {
				details[k] = v
			}
			if _, ok := details[ElapsedKey].(float64); ok {
				details[ElapsedKey] = "ELAPSED"
			}
			content := result.Content
			if content == nil {
				content = []Content{}
			}
			got["content"] = norm(t, content)
			got["isError"] = result.IsError
			got["details"] = norm(t, details)
		}
		if execCalls == nil {
			execCalls = []any{}
		}
		got["execCalls"] = norm(t, execCalls)
		var sdkWant []any
		for _, s := range c.Out["sdkCalls"].([]any) {
			call := s.(map[string]any)
			sdkWant = append(sdkWant, map[string]any{"tool": call["tool"], "params": call["params"]})
		}
		want := map[string]any{}
		for k, v := range c.Out {
			if k != "sdkCalls" {
				want[k] = v
			}
		}
		if !reflect.DeepEqual(norm(t, got), norm(t, want)) || !reflect.DeepEqual(norm(t, sdkCalls), norm(t, sdkWant)) {
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(want)
			t.Errorf("execute %s/%s:\n got %s %v\nwant %s %v", c.Tool, c.Label, gj, sdkCalls, wj, sdkWant)
		}
	}
}

// overflows reports a text row wider than width.
func overflows(text string, width int) bool {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\t", "   "), "\n") {
		if tuiwidth.VisibleWidth(line) > width {
			return true
		}
	}
	return false
}

func TestToolRenders(t *testing.T) {
	g := loadGolden(t)
	th := goldenThemes(t, g)
	work := section[string](t, g, "work")
	home := section[string](t, g, "home")
	tools := &Tools{Pretty: newTestPretty(), Cwd: work, Home: home}
	empty := t.TempDir()
	tools.ConfigDir = func() string { return empty }
	failures := 0
	for i, c := range section[[]struct {
		Tool, Phase, Label string
		Args               map[string]any
		Result             struct {
			Content []Content
			Details map[string]any
		}
		Ctx   RenderCtx
		Width int
		Out   []string
		Text  string
	}](t, g, "renderCases") {
		var text string
		if c.Phase == "call" {
			text = tools.CallText(c.Tool, th.rgb, c.Args, c.Ctx)
		} else {
			text = tools.ResultText(c.Tool, th.rgb, RenderView{Content: c.Result.Content, Details: c.Result.Details}, c.Ctx, c.Width)
		}
		if text != c.Text {
			failures++
			if failures <= 15 {
				t.Errorf("render %d %s/%s/%s %+v width %d text:\n got %q\nwant %q", i, c.Tool, c.Phase, c.Label, c.Ctx, c.Width, text, c.Text)
			}
			continue
		}
		if overflows(text, c.Width) {
			// A row wider than the card is wrapped by pi-tui's Text. pi-tui
			// 1.2.0 and PiG's Go wrap port (tuiwidth) split a long run of
			// spaces differently; the text above already matched.
			continue
		}
		got := TextRender(text, c.Width)
		if !reflect.DeepEqual(got, c.Out) && !(len(got) == 0 && len(c.Out) == 0) {
			failures++
			if failures <= 15 {
				t.Errorf("render %d %s/%s/%s %+v width %d:\n got %q\nwant %q", i, c.Tool, c.Phase, c.Label, c.Ctx, c.Width, got, c.Out)
			}
		}
	}
	if failures > 15 {
		t.Errorf("%d render failures", failures)
	}
}
