package askuserquestion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/rpivconfig"
)

type goldenFile map[string]json.RawMessage

var cachedGolden goldenFile

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	if cachedGolden != nil {
		return cachedGolden
	}
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	cachedGolden = g
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

// jsonValue normalizes a Go value to its decoded JSON form.
func jsonValue(t *testing.T, v any) any {
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

func rawValue(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var out any
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func sameJSON(t *testing.T, got any, want json.RawMessage) bool {
	t.Helper()
	return reflect.DeepEqual(jsonValue(t, got), rawValue(t, want))
}

// goldenKeys is the key table the generator recorded with pi-tui's
// default keybindings.
type goldenKeys struct {
	bindings map[string]map[string]bool
	keyIDs   map[string]map[string]bool
	kitty    map[string]string
	byName   map[string]string
}

func loadKeys(t *testing.T, g goldenFile) *goldenKeys {
	t.Helper()
	k := &goldenKeys{bindings: map[string]map[string]bool{}, keyIDs: map[string]map[string]bool{}, kitty: map[string]string{}, byName: map[string]string{}}
	for _, e := range section[[]struct {
		Name     string   `json:"name"`
		Data     string   `json:"data"`
		Bindings []string `json:"bindings"`
		KeyIDs   []string `json:"keyIds"`
		Kitty    *string  `json:"kitty"`
	}](t, g, "keyTable") {
		k.byName[e.Name] = e.Data
		k.bindings[e.Data] = map[string]bool{}
		for _, b := range e.Bindings {
			k.bindings[e.Data][b] = true
		}
		k.keyIDs[e.Data] = map[string]bool{}
		for _, id := range e.KeyIDs {
			k.keyIDs[e.Data][id] = true
		}
		if e.Kitty != nil {
			k.kitty[e.Data] = *e.Kitty
		}
	}
	return k
}

func (k *goldenKeys) Matches(data, binding string) bool { return k.bindings[data][binding] }
func (k *goldenKeys) MatchesKey(data, keyID string) bool {
	m, ok := k.keyIDs[data]
	if !ok && keyID != "" {
		// Only recorded sequences are sent.
		return false
	}
	return m[keyID]
}
func (k *goldenKeys) DecodeKittyPrintable(data string) (string, bool) {
	s, ok := k.kitty[data]
	return s, ok
}

func goldenTheme(t *testing.T, g goldenFile) chrome.GoldenTheme {
	return chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
}

func mdTheme(codes map[string]int) copywidget.MarkdownTheme {
	fg := func(role string) func(string) string {
		return func(s string) string { return "\x1b[" + strconv.Itoa(codes[role]) + "m" + s + "\x1b[39m" }
	}
	return copywidget.MarkdownTheme{
		Heading: fg("mdHeading"), Link: fg("mdLink"), LinkURL: fg("mdLinkUrl"), Code: fg("mdCode"),
		CodeBlock: fg("mdCodeBlock"), CodeBlockBorder: fg("mdCodeBlockBorder"), Quote: fg("mdQuote"),
		QuoteBorder: fg("mdQuoteBorder"), Hr: fg("mdHr"), ListBullet: fg("mdListBullet"),
		Bold:          func(s string) string { return "\x1b[1m" + s + "\x1b[22m" },
		Italic:        func(s string) string { return "\x1b[3m" + s + "\x1b[23m" },
		Underline:     func(s string) string { return "\x1b[4m" + s + "\x1b[24m" },
		Strikethrough: func(s string) string { return "\x1b[9m" + s + "\x1b[29m" },
		HighlightCode: func(code, lang string) []string {
			lines := strings.Split(code, "\n")
			for i, l := range lines {
				if lang == "ts" {
					lines[i] = "\x1b[38;2;200;120;50m" + l + "\x1b[39m"
				} else {
					lines[i] = fg("mdCodeBlock")(l)
				}
			}
			return lines
		},
	}
}

func decodeParamsJSON(t *testing.T, raw json.RawMessage) Params {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return DecodeParams(m)
}

// serState is the generator's ser(state).
func serState(s State) map[string]any {
	answers := []any{}
	for _, k := range sortedKeys(s.Answers) {
		answers = append(answers, []any{k, s.Answers[k]})
	}
	checked := []int{}
	for _, k := range sortedKeys(s.MultiSelectChecked) {
		if s.MultiSelectChecked[k] {
			checked = append(checked, k)
		}
	}
	notes := []any{}
	for _, k := range sortedKeys(s.NotesByTab) {
		notes = append(notes, []any{k, s.NotesByTab[k]})
	}
	return map[string]any{
		"currentTab": s.CurrentTab, "optionIndex": s.OptionIndex, "inputMode": s.InputMode, "notesVisible": s.NotesVisible,
		"answers": answers, "multiSelectChecked": checked, "notesByTab": notes,
		"focusedOptionHasPreview": s.FocusedOptionHasPreview, "submitChoiceIndex": s.SubmitChoiceIndex,
		"notesDraft": s.NotesDraft, "collapsed": s.Collapsed,
	}
}

// parseState is the inverse of ser(state).
func parseState(t *testing.T, raw json.RawMessage) State {
	t.Helper()
	var v struct {
		CurrentTab              int                 `json:"currentTab"`
		OptionIndex             int                 `json:"optionIndex"`
		InputMode               bool                `json:"inputMode"`
		NotesVisible            bool                `json:"notesVisible"`
		Answers                 [][]json.RawMessage `json:"answers"`
		MultiSelectChecked      []int               `json:"multiSelectChecked"`
		NotesByTab              [][]json.RawMessage `json:"notesByTab"`
		FocusedOptionHasPreview bool                `json:"focusedOptionHasPreview"`
		SubmitChoiceIndex       int                 `json:"submitChoiceIndex"`
		NotesDraft              string              `json:"notesDraft"`
		Collapsed               bool                `json:"collapsed"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	s := State{
		CurrentTab: v.CurrentTab, OptionIndex: v.OptionIndex, InputMode: v.InputMode, NotesVisible: v.NotesVisible,
		Answers: map[int]Answer{}, MultiSelectChecked: map[int]bool{}, NotesByTab: map[int]string{},
		FocusedOptionHasPreview: v.FocusedOptionHasPreview, SubmitChoiceIndex: v.SubmitChoiceIndex, NotesDraft: v.NotesDraft, Collapsed: v.Collapsed,
	}
	for _, e := range v.Answers {
		var k int
		var a Answer
		_ = json.Unmarshal(e[0], &k)
		_ = json.Unmarshal(e[1], &a)
		s.Answers[k] = a
	}
	for _, k := range v.MultiSelectChecked {
		s.MultiSelectChecked[k] = true
	}
	for _, e := range v.NotesByTab {
		var k int
		var n string
		_ = json.Unmarshal(e[0], &k)
		_ = json.Unmarshal(e[1], &n)
		s.NotesByTab[k] = n
	}
	return s
}

// actionJSON writes an action as the TypeScript union member.
func actionJSON(a Action) map[string]any {
	out := map[string]any{"kind": a.Kind}
	switch a.Kind {
	case ActNav, ActSubmitNav:
		out["nextIndex"] = a.NextIndex
	case ActTabSwitch:
		out["nextTab"] = a.NextTab
	case ActToggle:
		out["index"] = a.Index
	case ActConfirm:
		out["answer"] = a.Answer
		if a.AutoAdvanceTab != nil {
			out["autoAdvanceTab"] = *a.AutoAdvanceTab
		}
	case ActMultiConfirm:
		out["selected"] = a.Selected
		if a.AutoAdvanceTab != nil {
			out["autoAdvanceTab"] = *a.AutoAdvanceTab
		}
	case ActNotesForward:
		out["data"] = a.Data
	}
	return out
}

func parseAction(t *testing.T, raw json.RawMessage) Action {
	t.Helper()
	var v struct {
		Kind           string   `json:"kind"`
		NextIndex      int      `json:"nextIndex"`
		NextTab        int      `json:"nextTab"`
		Index          int      `json:"index"`
		Answer         *Answer  `json:"answer"`
		AutoAdvanceTab *int     `json:"autoAdvanceTab"`
		Selected       []string `json:"selected"`
		Data           string   `json:"data"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return Action{Kind: v.Kind, NextIndex: v.NextIndex, NextTab: v.NextTab, Index: v.Index, Answer: v.Answer, AutoAdvanceTab: v.AutoAdvanceTab, Selected: v.Selected, Data: v.Data}
}

func effectsJSON(effects []Effect) []any {
	out := []any{}
	for _, e := range effects {
		m := map[string]any{"kind": e.Kind}
		switch e.Kind {
		case EffSetInputBuffer, EffSetNotesValue:
			m["value"] = e.Value
		case EffSetNotesFocused:
			m["focused"] = e.Focused
		case EffForwardNotesKeystroke:
			m["data"] = e.Data
		case EffSetOverlayHidden:
			m["hidden"] = e.Hidden
		case EffDone:
			m["result"] = e.Result
		}
		out = append(out, m)
	}
	return out
}

func inputJSON(in *Input) map[string]any {
	return map[string]any{"value": in.Value(), "cursor": jsstr.Len16(in.Value()[:in.Cursor()])}
}

func toolResultJSON(r ToolResult) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": r.Text}}, "details": r.Details}
}

func TestPureHelpersMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct{ Input, Out string }](t, g, "sanitizeTexts") {
		if got := SanitizeText(c.Input); got != c.Out {
			t.Errorf("sanitizeText(%q) = %q want %q", c.Input, got, c.Out)
		}
	}
	for _, c := range section[[]struct{ Input, Out json.RawMessage }](t, g, "sanitizeCases") {
		got := SanitizeQuestionnaire(decodeParamsJSON(t, c.Input))
		want := decodeParamsJSON(t, c.Out)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("sanitizeQuestionnaire: %+v want %+v", got, want)
		}
	}
	for _, c := range section[[]struct{ Input, Out json.RawMessage }](t, g, "validateCases") {
		got := ValidateQuestionnaire(SanitizeQuestionnaire(decodeParamsJSON(t, c.Input)))
		if !sameJSON(t, got, c.Out) {
			t.Errorf("validate %s = %+v want %s", c.Input, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Answer  Answer
		Segment string
	}](t, g, "answerCases") {
		if got := BuildAnswerSegment(c.Answer); got != c.Segment {
			t.Errorf("segment = %q want %q", got, c.Segment)
		}
	}
	params := decodeParamsJSON(t, g["responseParams"])
	for _, c := range section[[]struct {
		Result *Result
		Out    json.RawMessage
	}](t, g, "responseCases") {
		if got := toolResultJSON(BuildQuestionnaireResponse(c.Result, params)); !sameJSON(t, got, c.Out) {
			t.Errorf("response(%+v) = %v want %s", c.Result, jsonValue(t, got), c.Out)
		}
	}
	for _, c := range section[[]struct {
		Question json.RawMessage
		Items    json.RawMessage
	}](t, g, "itemsCases") {
		p := decodeParamsJSON(t, json.RawMessage(`{"questions":[`+string(c.Question)+`]}`))
		if got := BuildItemsForQuestion(p.Questions[0]); !sameJSON(t, got, c.Items) {
			t.Errorf("items = %v want %s", jsonValue(t, got), c.Items)
		}
	}
	for _, c := range section[[]struct {
		Config map[string]any
		Out    *string
		Error  *string
	}](t, g, "collapseCases") {
		got, ok := ResolveCollapseKey(Config(c.Config))
		switch {
		case c.Error != nil:
			if ok || *c.Error != CollapseKeyTypeError {
				t.Errorf("collapse %v: want error %q", c.Config, *c.Error)
			}
		case !ok || got != *c.Out:
			t.Errorf("collapse %v = %q want %q", c.Config, got, *c.Out)
		}
	}
	if want := section[[]string](t, g, "reservedLabels"); !reflect.DeepEqual(ReservedLabels, want) {
		t.Errorf("reserved labels %v want %v", ReservedLabels, want)
	}
}

func TestLayoutAndBoxMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	var lc struct {
		Decide []struct {
			T, P int
			Out  string
		}
		Adaptive []struct{ W, Out int }
		Donation []struct {
			Name   string
			W, Out int
		}
		Columns []struct {
			P, A int
			Out  struct{ LeftWidth, RightWidth, Gap int }
		}
		Body []struct {
			P   int
			M   string
			A   int
			Out struct{ OptionsWidth, PreviewWidth int }
		}
		Source []struct {
			Name   string
			I, Out int
		}
	}
	if err := json.Unmarshal(g["layoutCases"], &lc); err != nil {
		t.Fatal(err)
	}
	qs := map[string]Params{}
	for name, raw := range section[map[string]json.RawMessage](t, g, "questionnaires") {
		qs[name] = decodeParamsJSON(t, raw)
	}
	for _, c := range lc.Decide {
		if got := DecideLayout(c.T, c.P); got != c.Out {
			t.Errorf("decideLayout(%d,%d)=%s want %s", c.T, c.P, got, c.Out)
		}
	}
	items := BuildItemsForQuestion(qs["preview"].Questions[0])
	for _, c := range lc.Adaptive {
		if got := AdaptiveLeftWidth(items, len(items), c.W); got != c.Out {
			t.Errorf("adaptiveLeftWidth(%d)=%d want %d", c.W, got, c.Out)
		}
	}
	for _, c := range lc.Donation {
		p := qs[c.Name]
		var ibt [][]Item
		for _, q := range p.Questions {
			ibt = append(ibt, BuildItemsForQuestion(q))
		}
		if got := CrossTabLeftWidthWithDonation(ibt, p.Questions, c.W); got != c.Out {
			t.Errorf("donation %s %d = %d want %d", c.Name, c.W, got, c.Out)
		}
	}
	for _, c := range lc.Columns {
		l, r, gap := ColumnWidths(c.P, c.A)
		if l != c.Out.LeftWidth || r != c.Out.RightWidth || gap != c.Out.Gap {
			t.Errorf("columnWidths(%d,%d)=%d,%d,%d want %+v", c.P, c.A, l, r, gap, c.Out)
		}
	}
	for _, c := range lc.Body {
		o, p := BodyWidths(c.P, c.M, c.A)
		if o != c.Out.OptionsWidth || p != c.Out.PreviewWidth {
			t.Errorf("bodyWidths(%d,%s,%d)=%d,%d want %+v", c.P, c.M, c.A, o, p, c.Out)
		}
	}
	for _, c := range lc.Source {
		if got := PreviewSourceWidth(qs[c.Name].Questions[c.I]); got != c.Out {
			t.Errorf("previewSourceWidth %s %d = %d want %d", c.Name, c.I, got, c.Out)
		}
	}
	var bc struct {
		Strip   []string
		Borders []struct {
			Lines         []string
			Width, Hidden int
			Out           []string
		}
		Dims []struct {
			Lines []string
			Max   int
			Out   struct{ InnerWidth, BoxWidth int }
		}
	}
	if err := json.Unmarshal(g["boxCases"], &bc); err != nil {
		t.Fatal(err)
	}
	fence := []string{"```ts", "\x1b[90m```\x1b[39m", "code", "  ```", "\x1b]8;;http://x\x07```", "``"}
	if got := StripFenceMarkers(fence); !reflect.DeepEqual(got, bc.Strip) {
		t.Errorf("stripFenceMarkers=%q want %q", got, bc.Strip)
	}
	for _, c := range bc.Borders {
		lines := c.Lines
		if lines == nil {
			lines = []string{}
		}
		got := RenderBorderedBox(lines, c.Width, func(s string) string { return "<" + s + ">" }, c.Hidden)
		if !reflect.DeepEqual(got, c.Out) {
			t.Errorf("renderBorderedBox(%q,%d,%d)=%q want %q", c.Lines, c.Width, c.Hidden, got, c.Out)
		}
	}
	for _, c := range bc.Dims {
		iw, bw := ComputeBoxDimensions(c.Lines, c.Max)
		if iw != c.Out.InnerWidth || bw != c.Out.BoxWidth {
			t.Errorf("computeBoxDimensions(%q,%d)=%d,%d want %+v", c.Lines, c.Max, iw, bw, c.Out)
		}
	}
}

func TestInputMatchesPiTui(t *testing.T) {
	g := loadGolden(t)
	keys := loadKeys(t, g)
	for _, c := range section[[]struct {
		Keys  []string
		Steps []struct {
			Key     string
			Value   string
			Cursor  int
			Focused bool
			Renders [][]string
		}
	}](t, g, "inputCases") {
		in := NewInput(keys)
		for i, step := range c.Steps {
			in.HandleInput(keys.byName[step.Key])
			in.SetFocused(step.Focused)
			if got := inputJSON(in); got["value"] != step.Value || got["cursor"] != step.Cursor {
				t.Errorf("%v step %d (%s): %v want value %q cursor %d", c.Keys, i, step.Key, got, step.Value, step.Cursor)
				break
			}
			for j, w := range []int{1, 2, 3, 12, 40} {
				if got := in.Render(w); !reflect.DeepEqual(got, step.Renders[j]) {
					t.Errorf("%v step %d render(%d) = %q want %q", c.Keys, i, w, got, step.Renders[j])
				}
			}
		}
	}
}

func TestReduceMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	qs := decodeParamsJSON(t, section[map[string]json.RawMessage](t, g, "questionnaires")["tabs"])
	ctx := ApplyContext{Questions: qs.Questions}
	for _, q := range qs.Questions {
		ctx.ItemsByTab = append(ctx.ItemsByTab, BuildItemsForQuestion(q))
	}
	for i, c := range section[[]struct {
		State, Action json.RawMessage
		Out           struct {
			State, Effects json.RawMessage
		}
	}](t, g, "reduceCases") {
		s, effects := Reduce(parseState(t, c.State), parseAction(t, c.Action), ctx)
		if !sameJSON(t, serState(s), c.Out.State) {
			t.Errorf("reduce %d %s: state %v want %s", i, c.Action, jsonValue(t, serState(s)), c.Out.State)
		}
		if !sameJSON(t, effectsJSON(effects), c.Out.Effects) {
			t.Errorf("reduce %d %s: effects %v want %s", i, c.Action, jsonValue(t, effectsJSON(effects)), c.Out.Effects)
		}
	}
}

// fakeDialogs replays scripted dialog replies.
type fakeDialogs struct {
	replies []struct {
		Value json.RawMessage `json:"value"`
		Undef bool            `json:"undef"`
	}
	next  int
	calls []map[string]any
}

func (f *fakeDialogs) reply() (any, bool) {
	if f.next >= len(f.replies) {
		f.next++
		return nil, false
	}
	r := f.replies[f.next]
	f.next++
	if r.Undef || len(r.Value) == 0 {
		return nil, false
	}
	var v any
	_ = json.Unmarshal(r.Value, &v)
	return v, true
}

func (f *fakeDialogs) Select(title string, options []string) (any, bool) {
	f.calls = append(f.calls, map[string]any{"fn": "select", "title": title, "options": options})
	return f.reply()
}

func (f *fakeDialogs) Input(title, placeholder string) (any, bool) {
	f.calls = append(f.calls, map[string]any{"fn": "input", "title": title, "placeholder": placeholder})
	return f.reply()
}

func TestRPCFallbackMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	qs := section[map[string]json.RawMessage](t, g, "questionnaires")
	for i, c := range section[[]struct {
		Questionnaire string
		Replies       []struct {
			Value json.RawMessage `json:"value"`
			Undef bool            `json:"undef"`
		}
		Calls  json.RawMessage
		Result json.RawMessage
	}](t, g, "rpcCases") {
		d := &fakeDialogs{replies: c.Replies}
		result := RunRPCQuestionnaire(d, decodeParamsJSON(t, qs[c.Questionnaire]))
		if !sameJSON(t, result, c.Result) {
			t.Errorf("rpc %d %s: result %v want %s", i, c.Questionnaire, jsonValue(t, result), c.Result)
		}
		if !sameJSON(t, d.calls, c.Calls) {
			t.Errorf("rpc %d %s: calls %v want %s", i, c.Questionnaire, jsonValue(t, d.calls), c.Calls)
		}
	}
}

func TestRegistrationAndReconcileMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct {
		Config map[string]any
		Meta   struct {
			Name, Label, Description, PromptSnippet, ExecutionMode string
			PromptGuidelines                                       []string
			Parameters                                             json.RawMessage
		}
	}](t, g, "registrationCases") {
		snippet, guidelines := Guidance(Config(c.Config))
		if c.Meta.Name != ToolName || c.Meta.Label != ToolLabel || c.Meta.Description != ToolDescription || c.Meta.ExecutionMode != ExecutionMode {
			t.Errorf("tool metadata differs: %q %q %q", c.Meta.Name, c.Meta.Label, c.Meta.ExecutionMode)
		}
		if c.Meta.Description != ToolDescription {
			t.Errorf("description:\n%s\nwant\n%s", ToolDescription, c.Meta.Description)
		}
		if snippet != c.Meta.PromptSnippet || !reflect.DeepEqual(guidelines, c.Meta.PromptGuidelines) {
			t.Errorf("guidance %v: %q %q want %q %q", c.Config, snippet, guidelines, c.Meta.PromptSnippet, c.Meta.PromptGuidelines)
		}
		if !sameJSON(t, Schema(), c.Meta.Parameters) {
			t.Errorf("schema differs:\n%v\nwant %s", jsonValue(t, Schema()), c.Meta.Parameters)
		}
	}
	for _, c := range section[[]struct {
		HasUI    bool
		Active   []string
		Out      []string
		SetCalls int
	}](t, g, "reconcileCases") {
		got, changed := ReconcileActiveTools(c.HasUI, c.Active)
		if !reflect.DeepEqual(got, c.Out) || changed != (c.SetCalls > 0) {
			t.Errorf("reconcile(%v,%v)=%v,%v want %v,%d", c.HasUI, c.Active, got, changed, c.Out, c.SetCalls)
		}
	}
}

// LoadConfig reads the same file the generator wrote.
func TestLoadConfigReadsNamespace(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config", ConfigName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"collapseKey":"Alt+O"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	c := LoadConfig(rpivconfig.Env{Home: home, Getenv: func(string) string { return "" }}, nil)
	if key, ok := ResolveCollapseKey(c); !ok || key != "alt+o" {
		t.Fatalf("collapse key %q %v", key, ok)
	}
}
