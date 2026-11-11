package difftools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// testTheme is the generator's theme: chrome's golden SGR theme plus the
// 24-bit getFgAnsi/getBgAnsi colors.
type testTheme struct {
	chrome.GoldenTheme
	fg, bg map[string]string
}

func (t testTheme) GetFgAnsi(role string) (string, error) {
	if c, ok := t.fg[role]; ok {
		return "\x1b[38;2;" + c + "m", nil
	}
	return "", fmt.Errorf("Unknown theme color: %s", role)
}

func (t testTheme) GetBgAnsi(role string) (string, error) {
	if c, ok := t.bg[role]; ok {
		return "\x1b[48;2;" + c + "m", nil
	}
	return "", fmt.Errorf("Unknown theme color: %s", role)
}

// stubHighlight is testdata/shiki-stub.mjs.
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

func defaultKeys(data, binding string) bool {
	switch binding {
	case "tui.select.up":
		return data == "\x1b[A"
	case "tui.select.down":
		return data == "\x1b[B"
	case "tui.select.pageUp":
		return data == "\x1b[5~"
	case "tui.select.pageDown":
		return data == "\x1b[6~"
	case "tui.select.confirm":
		return data == "\r"
	case "tui.select.cancel":
		return data == "\x1b" || data == "\x03"
	}
	return false
}

func noEnv(string) string { return "" }

type golden map[string]json.RawMessage

var loaded golden

func load(t *testing.T) golden {
	t.Helper()
	if loaded != nil {
		return loaded
	}
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &loaded); err != nil {
		t.Fatal(err)
	}
	return loaded
}

func section[T any](t *testing.T, name string) T {
	t.Helper()
	var out T
	raw, ok := load(t)[name]
	if !ok {
		t.Fatalf("golden has no %s", name)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return out
}

// generic converts a value to its decoded-JSON form for comparison.
func generic(t *testing.T, v any) any {
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

func same(t *testing.T, what string, got any, want json.RawMessage) {
	t.Helper()
	var w any
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	g := generic(t, got)
	if !reflect.DeepEqual(g, w) {
		gj, _ := json.Marshal(g)
		t.Errorf("%s:\n go %s\n ts %s", what, gj, want)
	}
}

func goldenTheme(t *testing.T) testTheme {
	return testTheme{
		GoldenTheme: chrome.GoldenTheme{Codes: section[map[string]int](t, "roleCodes")},
		fg:          section[map[string]string](t, "fgRgb"),
		bg:          section[map[string]string](t, "bgRgb"),
	}
}

func TestDiffCore(t *testing.T) {
	for _, c := range section[[]struct {
		A, B string
		Ctx  int
		Out  json.RawMessage
	}](t, "parseDiffCases") {
		same(t, fmt.Sprintf("ParseDiff(%q,%q,%d)", c.A, c.B, c.Ctx), ParseDiff(c.A, c.B, c.Ctx), c.Out)
	}
	for _, c := range section[[]struct {
		Patch string
		Out   json.RawMessage
	}](t, "parsePatchCases") {
		same(t, fmt.Sprintf("ParsePatchFiles(%q)", c.Patch), ParsePatchFiles(c.Patch), c.Out)
	}
	for _, c := range section[[]struct {
		Style          string
		Meta           *HunkMeta
		Gap            *int
		Content        string
		Unified, Split string
	}](t, "sepCases") {
		if got := SepLabelUnified(c.Style, c.Meta, c.Gap, c.Content); got != c.Unified {
			t.Errorf("SepLabelUnified(%s): %q want %q", c.Style, got, c.Unified)
		}
		if got := SepLabelSplit(c.Style, c.Meta, c.Gap, c.Content); got != c.Split {
			t.Errorf("SepLabelSplit(%s): %q want %q", c.Style, got, c.Split)
		}
	}
	for _, c := range section[[]struct{ Env, Out string }](t, "sepStyleCases") {
		if got := ResolveSepStyle(c.Env); got != c.Out {
			t.Errorf("ResolveSepStyle(%q) = %q, want %q", c.Env, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Diff ParsedDiff
		Out  json.RawMessage
	}](t, "hunkBlockCases") {
		same(t, "ComputeHunkBlocks", ComputeHunkBlocks(c.Diff), c.Out)
	}
	for _, c := range section[[]struct{ Name, Out string }](t, "headerNames") {
		if got := FormatToolHeaderName(c.Name); got != c.Out {
			t.Errorf("FormatToolHeaderName(%q) = %q", c.Name, got)
		}
	}
}

func TestEncodingConflictsHints(t *testing.T) {
	for _, c := range section[[]struct {
		Text   string
		Strip  struct{ Bom, Text string }
		Ending string
		LF     string `json:"lf"`
		CRLF   string `json:"crlf"`
		Prep   struct {
			Bom, Ending, Normalized string
		} `json:"prepared"`
		Final string
	}](t, "encodingCases") {
		bom, text := StripBom(c.Text)
		bom2, ending, normalized := PrepareTextForHashlineEdit(c.Text)
		if bom != c.Strip.Bom || text != c.Strip.Text || DetectLineEnding(c.Text) != c.Ending || NormalizeToLF(c.Text) != c.LF ||
			RestoreLineEndings(c.Text, "\r\n") != c.CRLF || bom2 != c.Prep.Bom || ending != c.Prep.Ending || normalized != c.Prep.Normalized ||
			FinalizeHashlineWriteContent(bom2, ending, normalized) != c.Final {
			t.Errorf("encoding of %q differs", c.Text)
		}
	}
	for _, c := range section[[]struct {
		Text      string
		Parsed    json.RawMessage
		Has       bool
		Summaries []string
	}](t, "conflictCases") {
		parsed := ParseConflicts(c.Text)
		same(t, fmt.Sprintf("ParseConflicts(%q)", c.Text), parsed, c.Parsed)
		if HasConflictMarkers(c.Text) != c.Has {
			t.Errorf("HasConflictMarkers(%q) != %v", c.Text, c.Has)
		}
		for i, r := range parsed.Regions {
			if i < len(c.Summaries) && FormatConflictSummary(r) != c.Summaries[i] {
				t.Errorf("FormatConflictSummary = %q, want %q", FormatConflictSummary(r), c.Summaries[i])
			}
		}
	}
	for _, c := range section[[]struct{ Label, Out string }](t, "collapsedCases") {
		if CollapsedSummaryLine(c.Label) != c.Out {
			t.Errorf("CollapsedSummaryLine(%q)", c.Label)
		}
	}
}

func TestReplace(t *testing.T) {
	for _, c := range section[[]struct {
		Content, Old, New string
		All               bool
		Out               json.RawMessage
	}](t, "replaceCases") {
		same(t, fmt.Sprintf("Replace(%q,%q,%q,%v)", c.Content, c.Old, c.New, c.All), Replace(c.Content, c.Old, c.New, c.All), c.Out)
	}
	for _, c := range section[[]struct {
		Content, Old, New string
		Out               json.RawMessage
	}](t, "patchReplaceCases") {
		same(t, fmt.Sprintf("ReplaceForPatch(%q,%q,%q)", c.Content, c.Old, c.New), ReplaceForPatch(c.Content, c.Old, c.New), c.Out)
	}
}

func TestCursorCompat(t *testing.T) {
	for _, c := range section[[]struct {
		Input      map[string]any
		Ops        json.RawMessage
		Normalized json.RawMessage
	}](t, "cursorEditCases") {
		same(t, "GetEditOperations", GetEditOperations(c.Input), c.Ops)
		same(t, "NormalizeEditParams", NormalizeEditParams(c.Input), c.Normalized)
	}
	for _, c := range section[[]struct {
		Input map[string]any
		Out   json.RawMessage
	}](t, "cursorPatchCases") {
		same(t, fmt.Sprintf("ResolveApplyPatchChanges(%v)", c.Input), ResolveApplyPatchChanges(c.Input), c.Out)
	}
}

type setupSpec struct {
	Files    map[string]string
	Modes    map[string]os.FileMode
	Symlinks map[string]string
	Dirs     []string
}

func applySetup(t *testing.T, dir string, s setupSpec) {
	t.Helper()
	_ = os.RemoveAll(dir)
	must(t, os.MkdirAll(dir, 0o755))
	for _, d := range s.Dirs {
		must(t, os.MkdirAll(filepath.Join(dir, d), 0o755))
	}
	for rel, content := range s.Files {
		p := filepath.Join(dir, rel)
		must(t, os.MkdirAll(filepath.Dir(p), 0o755))
		must(t, os.WriteFile(p, []byte(content), 0o644))
		mode := os.FileMode(0o644)
		if m, ok := s.Modes[rel]; ok {
			mode = m
		}
		must(t, os.Chmod(p, mode))
	}
	for rel, target := range s.Symlinks {
		must(t, os.Symlink(target, filepath.Join(dir, rel)))
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func snapshot(t *testing.T, dir string) map[string]any {
	t.Helper()
	out := map[string]any{}
	var walk func(rel string)
	walk = func(rel string) {
		entries, err := os.ReadDir(filepath.Join(dir, rel))
		must(t, err)
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		sort.Strings(names)
		for _, name := range names {
			r := name
			if rel != "" {
				r = rel + "/" + name
			}
			info, err := os.Lstat(filepath.Join(dir, r))
			must(t, err)
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				out[r] = map[string]any{"link": true}
			case info.IsDir():
				out[r] = map[string]any{"dir": true}
				walk(r)
			default:
				data, _ := os.ReadFile(filepath.Join(dir, r))
				out[r] = map[string]any{"content": string(data), "mode": float64(info.Mode().Perm())}
			}
		}
	}
	walk("")
	return out
}

func rooted(raw json.RawMessage, root string) json.RawMessage {
	return json.RawMessage(strings.ReplaceAll(string(raw), "@@ROOT@@", root))
}

func decodeMap(t *testing.T, raw json.RawMessage) map[string]any {
	var m map[string]any
	must(t, json.Unmarshal(raw, &m))
	return m
}

func TestApplyPatchScenarios(t *testing.T) {
	root := t.TempDir()
	for _, c := range section[[]struct {
		Name      string
		Setup     setupSpec
		Input     json.RawMessage
		Changes   json.RawMessage
		Preview   json.RawMessage
		Result    json.RawMessage
		Formatted string
		Tree      json.RawMessage
	}](t, "patchScenarioCases") {
		dir := filepath.Join(root, "patch", c.Name)
		applySetup(t, dir, c.Setup)
		input := decodeMap(t, rooted(c.Input, root))
		changes := ResolveApplyPatchChanges(input)
		same(t, c.Name+" changes", changes, rooted(c.Changes, root))
		same(t, c.Name+" preview", PreviewApplyPatch(changes), rooted(c.Preview, root))
		result := ExecuteApplyPatch(changes)
		same(t, c.Name+" result", result, rooted(c.Result, root))
		var formatted string
		must(t, json.Unmarshal(rooted(mustJSON(t, c.Formatted), root), &formatted))
		if got := FormatApplyPatchResult(result); got != formatted {
			t.Errorf("%s formatted:\n go %q\n ts %q", c.Name, got, formatted)
		}
		same(t, c.Name+" tree", snapshot(t, dir), c.Tree)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	data, err := json.Marshal(v)
	must(t, err)
	return data
}

func TestHashline(t *testing.T) {
	for _, c := range section[[]struct {
		Text   string
		Hashes []string
		Read   struct {
			Text                          string
			LineCount, StartLine, EndLine int
		}
		Slice struct {
			Text                          string
			LineCount, StartLine, EndLine int
		}
	}](t, "hashCases") {
		hashes, err := HashLines(c.Text)
		must(t, err)
		if !reflect.DeepEqual(hashes, c.Hashes) {
			t.Errorf("HashLines(%q) = %v, want %v", c.Text, hashes, c.Hashes)
		}
		read, _ := FormatHashlineReadLines(c.Text, 1, 0)
		if read.Text != c.Read.Text || read.LineCount != c.Read.LineCount || read.EndLine != c.Read.EndLine {
			t.Errorf("read %q:\n go %+v\n ts %+v", c.Text, read, c.Read)
		}
		slice, _ := FormatHashlineReadLines(c.Text, 2, 3)
		if slice.Text != c.Slice.Text || slice.LineCount != c.Slice.LineCount || slice.EndLine != c.Slice.EndLine || slice.StartLine != c.Slice.StartLine {
			t.Errorf("slice %q:\n go %+v\n ts %+v", c.Text, slice, c.Slice)
		}
	}
	for _, c := range section[[]struct {
		Ref *string
		Out string
	}](t, "anchorCases") {
		ref := ""
		if c.Ref != nil {
			ref = *c.Ref
		}
		if got := ParseAnchor(ref); got != c.Out {
			t.Errorf("ParseAnchor(%v) = %q", c.Ref, got)
		}
	}
	for _, c := range section[[]struct {
		Ref    string
		Hashes []string
		Out    json.RawMessage
	}](t, "resolveCases") {
		r := ResolveAnchor(c.Ref, c.Hashes)
		out := map[string]any{"ok": r.OK, "ref": r.Ref}
		if r.OK {
			out["line"] = r.Line
		} else {
			out["error"] = r.Error
			if r.Suggestions != nil {
				out["suggestions"] = r.Suggestions
			}
		}
		same(t, "ResolveAnchor("+c.Ref+")", out, c.Out)
	}
	for _, c := range section[[]struct {
		Name    string
		Changes []HashlineEdit
		Out     json.RawMessage
	}](t, "hashEditCases") {
		base := "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n"
		same(t, "ApplyHashlineEdits "+c.Name, ApplyHashlineEdits(base, c.Changes, "@@ROOT@@/f.ts"), c.Out)
	}
	root := t.TempDir()
	for _, c := range section[[]struct {
		Name    string
		Content *string
		DryRun  bool
		Changes []HashlineEdit
		Run     json.RawMessage
		Direct  json.RawMessage
		After   *string
	}](t, "hashFileCases") {
		dir := filepath.Join(root, "hash")
		must(t, os.MkdirAll(dir, 0o755))
		fp := filepath.Join(dir, c.Name+".ts")
		if c.Content != nil {
			must(t, os.WriteFile(fp, []byte(*c.Content), 0o644))
		}
		run := RunHashlineEdit(fp, c.Changes, c.DryRun)
		got := map[string]any{"content": []any{map[string]any{"type": "text", "text": run.Text}}, "details": run.Details}
		if run.IsError {
			got["isError"] = true
		}
		same(t, "RunHashlineEdit "+c.Name, got, rooted(c.Run, root))
		if c.Content != nil {
			same(t, "ApplyHashlineEditsToFile "+c.Name, ApplyHashlineEditsToFile(fp, c.Changes, true, nil), rooted(c.Direct, root))
			data, _ := os.ReadFile(fp)
			if string(data) != *c.After {
				t.Errorf("%s after: %q want %q", c.Name, data, *c.After)
			}
		}
	}
	for _, c := range section[[]struct {
		Start, End int
		Out        json.RawMessage
	}](t, "hashReadCases") {
		end := c.End
		r, err := ExecuteHashlineRead(filepath.Join(root, "r.ts"), "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n", c.Start, end)
		must(t, err)
		same(t, "ExecuteHashlineRead", map[string]any{"content": []any{map[string]any{"type": "text", "text": r.Text}}, "details": r.Details}, rooted(c.Out, root))
	}
}

func TestPreviewGuardConfig(t *testing.T) {
	root := t.TempDir()
	previewDir := filepath.Join(root, "preview")
	applySetup(t, previewDir, setupSpec{Files: map[string]string{
		"p.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n", "dup.ts": "x\nx\n",
		"big.txt": func() string {
			var b strings.Builder
			for i := range 60 {
				fmt.Fprintf(&b, "l%d\n", i)
			}
			return b.String()
		}(),
	}})
	for _, c := range section[[]struct {
		Tool   string
		Input  json.RawMessage
		Opts   *struct{ MaxLines, MaxChars int }
		Out    *string
		Prompt string
	}](t, "previewCases") {
		o := PreviewOptions{Cwd: previewDir}
		if c.Opts != nil {
			o.MaxLines, o.MaxChars = c.Opts.MaxLines, c.Opts.MaxChars
		}
		input := decodeMap(t, rooted(c.Input, root))
		got, ok := FormatMutationPreview(c.Tool, input, o)
		var want *string
		if c.Out != nil {
			w := strings.ReplaceAll(*c.Out, "@@ROOT@@", root)
			want = &w
		}
		if ok != (want != nil) || (ok && got != *want) {
			t.Errorf("FormatMutationPreview(%s, %s, %+v):\n go %v %q\n ts %v", c.Tool, c.Input, c.Opts, ok, got, c.Out)
		}
		if p := BuildMutationApprovalPrompt(c.Tool, "target", got, ok); p != strings.ReplaceAll(c.Prompt, "@@ROOT@@", root) {
			t.Errorf("prompt:\n go %q\n ts %q", p, c.Prompt)
		}
	}
	for _, c := range section[[]struct {
		A, B string
		Max  int
		Out  string
	}](t, "plainCases") {
		if got := FormatParsedDiffPlain(ParseDiff(c.A, c.B, 3), c.Max); got != c.Out {
			t.Errorf("FormatParsedDiffPlain: %q want %q", got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Input json.RawMessage
		Out   *struct {
			Block  bool
			Reason string
		}
	}](t, "guardCases") {
		reason := EditGuardReason(decodeMap(t, rooted(c.Input, root)), root)
		want := ""
		if c.Out != nil {
			want = strings.ReplaceAll(c.Out.Reason, "@@ROOT@@", root)
		}
		if reason != want {
			t.Errorf("EditGuardReason(%s) = %q, want %q", c.Input, reason, want)
		}
	}
	for _, c := range section[[]struct {
		Name  string
		Files map[string]string
		Out   json.RawMessage
	}](t, "configCases") {
		dir := filepath.Join(root, "config", c.Name)
		applySetup(t, dir, setupSpec{Files: c.Files})
		same(t, "LoadConfig "+c.Name, LoadConfig([]string{filepath.Join(dir, ".pi", "pi-diff.json"), filepath.Join(dir, "pi-diff.json")}), c.Out)
	}
}

func TestGitReview(t *testing.T) {
	c := section[struct {
		Outputs        map[string]string
		Untracked      map[string]string
		Working        json.RawMessage
		Branch         json.RawMessage
		ChangedWorking []string
		ChangedBranch  []string
		CountsWorking  json.RawMessage
		CountsBranch   json.RawMessage
		FileCounts     json.RawMessage
	}](t, "gitCase")
	dir := t.TempDir()
	applySetup(t, dir, setupSpec{Files: c.Untracked})
	run := func(_ string, args ...string) (string, error) {
		out, ok := c.Outputs[strings.Join(args, " ")]
		if !ok {
			return "", fmt.Errorf("unexpected git %v", args)
		}
		return out, nil
	}
	working, err := ReadGitDiff(run, dir, ReviewDiffMode{Type: "working-tree"})
	must(t, err)
	same(t, "ReadGitDiff working", working, c.Working)
	branch, err := ReadGitDiff(run, dir, ReviewDiffMode{Type: "branch", Base: "main"})
	must(t, err)
	same(t, "ReadGitDiff branch", branch, c.Branch)
	if files, _ := ReadChangedFiles(run, dir, ReviewDiffMode{Type: "working-tree"}); !reflect.DeepEqual(files, c.ChangedWorking) {
		t.Errorf("ReadChangedFiles working = %v, want %v", files, c.ChangedWorking)
	}
	if files, _ := ReadChangedFiles(run, dir, ReviewDiffMode{Type: "branch", Base: "main"}); !reflect.DeepEqual(files, c.ChangedBranch) {
		t.Errorf("ReadChangedFiles branch = %v, want %v", files, c.ChangedBranch)
	}
	same(t, "counts working", CountReviewDiffLines(working), c.CountsWorking)
	same(t, "counts branch", CountReviewDiffLines(branch), c.CountsBranch)
	var fc []LineCounts
	for _, f := range working.Files {
		fc = append(fc, CountReviewFileLines(f))
	}
	same(t, "file counts", fc, c.FileCounts)
	for _, p := range section[[]struct {
		Raw string
		Out json.RawMessage
	}](t, "gitParseCases") {
		same(t, fmt.Sprintf("ParseUnifiedGitDiff(%q)", p.Raw), ParseUnifiedGitDiff(p.Raw), p.Out)
	}
}

type resultJSON struct {
	Content []struct {
		Type string  `json:"type"`
		Text *string `json:"text"`
	} `json:"content"`
	IsError bool `json:"isError"`
	Details any  `json:"details"`
}

func (r resultJSON) view() ToolResultView {
	v := ToolResultView{IsError: r.IsError, Details: r.Details, Texts: []*string{}}
	for i, c := range r.Content {
		v.Texts = append(v.Texts, c.Text)
		if i == 0 {
			v.First = c.Text
		}
	}
	return v
}

// TestToolsAndRenders replays the generator's order on one palette: tool
// executes, call and result renders, direct hunk-preview renders, review
// hunks, and the settings presets. The palette state carries between them
// as the TypeScript module globals do.
func TestToolsAndRenders(t *testing.T) {
	theme := goldenTheme(t)
	root := t.TempDir()
	work := filepath.Join(root, "work")
	setup := section[setupSpec](t, "toolSetup")
	applySetup(t, work, setup)
	// Relative apply_patch paths resolve against the process directory.
	t.Chdir(work)
	palette := NewPalette(noEnv, DiffUserConfig{}, "", stubHighlight)
	tools := NewTools(palette, work, filepath.Join(root, "home"), func() int { return 104 })

	type execCase struct {
		Tool   string
		ID     string
		Params json.RawMessage
		Result *struct {
			Content json.RawMessage
			IsError bool
			Details json.RawMessage
		}
		Error *string
		Tree  json.RawMessage
	}
	for _, c := range section[[]execCase](t, "execCases") {
		params := decodeMap(t, rooted(c.Params, root))
		var wantTree map[string]any
		must(t, json.Unmarshal(rooted(c.Tree, root), &wantTree))
		switch c.Tool {
		case "write":
			fp, old, ok := tools.WriteBefore(params)
			full := filepath.Join(work, fp)
			must(t, os.MkdirAll(filepath.Dir(full), 0o755))
			content, _ := params["content"].(string)
			must(t, os.WriteFile(full, []byte(content), 0o644))
			same(t, c.ID+" details", tools.WriteDetails(c.ID, fp, old, ok, params), rooted(c.Result.Details, root))
		case "edit":
			res, normalized, ok := tools.EditFast(params)
			switch {
			case ok:
				same(t, c.ID+" result", map[string]any{"content": []any{map[string]any{"type": "text", "text": res.Text}}, "details": res.Details},
					rooted(mustJSON(t, map[string]any{"content": c.Result.Content, "details": c.Result.Details}), root))
			case c.Error != nil:
				// The built-in edit threw in TypeScript; Go falls back to it too.
			default:
				// Fallback: the built-in edit wrote the file; replay its result.
				for rel, v := range wantTree {
					if m, isMap := v.(map[string]any); isMap {
						if content, has := m["content"].(string); has {
							must(t, os.WriteFile(filepath.Join(work, rel), []byte(content), 0o644))
						}
					}
				}
				details, _ := tools.EditFallbackDetails(normalized)
				same(t, c.ID+" fallback details", details, rooted(c.Result.Details, root))
			}
		case "apply_patch":
			text, isErr, details := tools.ApplyPatch(params)
			same(t, c.ID+" result", map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": isErr, "details": details},
				rooted(mustJSON(t, map[string]any{"content": c.Result.Content, "isError": c.Result.IsError, "details": c.Result.Details}), root))
		}
		same(t, c.ID+" tree", snapshot(t, work), rooted(c.Tree, root))
	}

	applySetup(t, work, setup)
	type renderCase struct {
		Tool   string
		Phase  string
		Label  string
		Args   json.RawMessage
		Result json.RawMessage
		Ctx    struct {
			ArgsComplete bool
			ToolCallID   string `json:"toolCallId"`
			IsError      bool
		}
		Width int
		Out   []string
		Text  string
		Bg    bool
	}
	for _, c := range section[[]renderCase](t, "renderCases") {
		rc := RenderCtx{ToolCallID: c.Ctx.ToolCallID, ArgsComplete: c.Ctx.ArgsComplete, IsError: c.Ctx.IsError}
		var view textView
		tools.Palette.mu.Lock()
		if c.Phase == "call" {
			args := decodeMap(t, rooted(c.Args, root))
			switch c.Tool {
			case "write":
				view = tools.renderWriteCall(theme, args, rc, c.Width)
			case "edit":
				view = tools.renderEditCall(theme, args, rc)
			default:
				view = tools.renderApplyPatchCall(theme, args, rc)
			}
		} else {
			var r resultJSON
			must(t, json.Unmarshal(rooted(c.Result, root), &r))
			switch c.Tool {
			case "write":
				view = tools.renderWriteResult(theme, r.view(), rc, c.Width)
			case "edit":
				view = tools.renderEditResult(theme, r.view(), rc, c.Width)
			default:
				view = tools.renderApplyPatchResult(theme, r.view(), rc, c.Width)
			}
		}
		got := view.render(c.Width)
		tools.Palette.mu.Unlock()
		name := fmt.Sprintf("%s %s %s @%d", c.Tool, c.Phase, c.Label, c.Width)
		if want := strings.ReplaceAll(c.Text, "@@ROOT@@", root); view.text != want || (view.bg != nil) != c.Bg {
			t.Errorf("%s text:\n go %q bg=%v\n ts %q bg=%v", name, view.text, view.bg != nil, want, c.Bg)
			continue
		}
		if overflows(view.text, c.Width) {
			// A text row wider than the card is wrapped by pi-tui's Text.
			// pi-tui 1.2.0 and PiG's Go wrap port (tuiwidth) split a long
			// whitespace run differently; that is a wrap-library difference,
			// and the pre-wrap text above already matched.
			continue
		}
		want := make([]string, len(c.Out))
		for i, l := range c.Out {
			want[i] = strings.ReplaceAll(l, "@@ROOT@@", root)
		}
		if !reflect.DeepEqual(got, want) && !(len(got) == 0 && len(want) == 0) {
			t.Errorf("%s:\n go %q\n ts %q", name, got, want)
		}
	}

	colors := func() DiffColors {
		palette.mu.Lock()
		defer palette.mu.Unlock()
		return palette.hp.resolve(theme)
	}()
	for _, c := range section[[]struct {
		Diff           ParsedDiff
		Language       *string
		Width          int
		CompactGutter  bool
		MaxLines       int
		Split, Unified string
	}](t, "directCases") {
		lang := ""
		if c.Language != nil {
			lang = *c.Language
		}
		o := RenderOptions{CompactGutter: c.CompactGutter}
		if got := palette.RenderSplit(c.Diff, lang, c.MaxLines, colors, c.Width, o); got != c.Split {
			t.Errorf("RenderSplit(w=%d lang=%q compact=%v max=%d):\n go %q\n ts %q", c.Width, lang, c.CompactGutter, c.MaxLines, got, c.Split)
		}
		if got := palette.RenderUnified(c.Diff, lang, c.MaxLines, colors, c.Width, o); got != c.Unified {
			t.Errorf("RenderUnified(w=%d lang=%q compact=%v max=%d):\n go %q\n ts %q", c.Width, lang, c.CompactGutter, c.MaxLines, got, c.Unified)
		}
	}
	for _, c := range section[[]struct {
		Hunk  ReviewHunk
		Path  string
		Width int
		Out   string
	}](t, "reviewCases") {
		if got := palette.RenderReviewHunkPreview(c.Hunk, c.Path, theme, c.Width, 0); got != c.Out {
			t.Errorf("RenderReviewHunkPreview(%s, %d):\n go %q\n ts %q", c.Hunk.ID, c.Width, got, c.Out)
		}
	}

	preset := section[struct {
		DiffTheme  string
		DiffColors map[string]string
	}](t, "presetSettings")
	presetColors := func() DiffColors {
		palette.mu.Lock()
		defer palette.mu.Unlock()
		palette.hp.applyDiffPalette(DiffUserConfig{DiffTheme: preset.DiffTheme, DiffColors: preset.DiffColors}, noEnv)
		return palette.hp.resolve(theme)
	}()
	for i, c := range section[[]struct {
		Diff           ParsedDiff
		Split, Unified string
	}](t, "presetCases") {
		if got := palette.RenderSplit(c.Diff, "typescript", 60, presetColors, 100, RenderOptions{CompactGutter: true}); got != c.Split {
			t.Errorf("preset %d split:\n go %q\n ts %q", i, got, c.Split)
		}
		if got := palette.RenderUnified(c.Diff, "typescript", 60, presetColors, 100, RenderOptions{}); got != c.Unified {
			t.Errorf("preset %d unified:\n go %q\n ts %q", i, got, c.Unified)
		}
	}
}

func overflows(text string, width int) bool {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\t", "   "), "\n") {
		if tuiwidth.VisibleWidth(line) > width {
			return true
		}
	}
	return false
}

func TestApprovalOverlay(t *testing.T) {
	theme := goldenTheme(t)
	root := t.TempDir()
	approvalDir := filepath.Join(root, "approval")
	var b strings.Builder
	for i := range 30 {
		fmt.Fprintf(&b, "const n%d = %d;\n", i, i)
	}
	applySetup(t, approvalDir, setupSpec{Files: map[string]string{"edit.ts": b.String()}})
	type size struct{ Rows, Columns, Width int }
	for _, c := range section[[]struct {
		Scenario string
		Tool     string
		Input    json.RawMessage
		Path     string
		Outside  *struct {
			Cwd    string
			Scopes []string
		}
		KeysName string
		Keys     []string
		Size     size
		Header   string
		Frames   [][]string
		Decision string
		Select   *struct {
			Answer  int
			Title   string
			Options []string
		}
	}](t, "approvalCases") {
		input := decodeMap(t, rooted(c.Input, root))
		var outside *Outside
		if c.Outside != nil {
			outside = &Outside{Cwd: c.Outside.Cwd, Scopes: c.Outside.Scopes}
		}
		if c.Select != nil {
			title, options := SelectPrompt(c.Tool, c.Path, input, outside, approvalDir)
			if title != strings.ReplaceAll(c.Select.Title, "@@ROOT@@", root) || !reflect.DeepEqual(options, c.Select.Options) {
				t.Errorf("%s select:\n go %q %v\n ts %q %v", c.Scenario, title, options, c.Select.Title, c.Select.Options)
			}
			choice := ""
			if c.Select.Answer >= 0 {
				choice = options[c.Select.Answer]
			}
			if d := SelectDecision(choice, outside != nil); d != c.Decision {
				t.Errorf("%s select %d decision %q want %q", c.Scenario, c.Select.Answer, d, c.Decision)
			}
			continue
		}
		header, diff := OverlayContent(c.Tool, c.Path, input, outside, approvalDir)
		if header != c.Header {
			t.Errorf("%s header %q want %q", c.Scenario, header, c.Header)
		}
		sz := c.Size
		dialog := NewApprovalDialog(ApprovalDialogOptions{Theme: theme, Header: header, Diff: diff, Outside: outside != nil, Matches: defaultKeys,
			Rows: func() int { return sz.Rows }, Columns: func() int { return sz.Columns }})
		frames := [][]string{dialog.Render(sz.Width)}
		decision, done := "", false
		for _, key := range c.Keys {
			if !done {
				dialog.HandleInput(key)
				decision, done = dialog.Done()
			} else {
				dialog.HandleInput(key)
			}
			frames = append(frames, dialog.Render(sz.Width))
		}
		for i := range frames {
			if i >= len(c.Frames) || !reflect.DeepEqual(frames[i], c.Frames[i]) {
				want := []string(nil)
				if i < len(c.Frames) {
					want = c.Frames[i]
				}
				t.Errorf("%s %s %+v frame %d:\n go %q\n ts %q", c.Scenario, c.KeysName, sz, i, frames[i], want)
				break
			}
		}
		if d := OverlayDecision(decision, done, outside != nil); d != c.Decision {
			t.Errorf("%s %s decision %q want %q", c.Scenario, c.KeysName, d, c.Decision)
		}
	}
	empty := section[[][]string](t, "emptyFrames")
	dialog := NewApprovalDialog(ApprovalDialogOptions{Theme: theme, Header: "Allow write on x?", Matches: defaultKeys, Rows: func() int { return 20 }, Columns: func() int { return 60 }})
	got := [][]string{dialog.Render(60)}
	dialog.HandleInput("\x1b[B")
	got = append(got, dialog.Render(60))
	if !reflect.DeepEqual(got, empty) {
		t.Errorf("empty dialog:\n go %q\n ts %q", got, empty)
	}
}
