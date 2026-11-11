package permissionmodes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// golden.json is produced by testdata/gen-golden.ts from the TypeScript
// permission-modes, which stays the reference until the Go port replaces it.
type golden struct {
	Safety []struct {
		Command     string `json:"command"`
		Safe        bool   `json:"safe"`
		Destructive bool   `json:"destructive"`
	} `json:"safety"`
	Todos []struct {
		Message string     `json:"message"`
		Items   []TodoItem `json:"items"`
	} `json:"todos"`
	Cleaned []struct {
		Text    string `json:"text"`
		Cleaned string `json:"cleaned"`
	} `json:"cleaned"`
	DoneTexts []struct {
		Text  string `json:"text"`
		Steps []int  `json:"steps"`
	} `json:"doneTexts"`
	Targets []struct {
		Input map[string]any `json:"input"`
		Paths []string       `json:"paths"`
	} `json:"targets"`
	Outside []struct {
		Tool    string          `json:"tool"`
		Input   map[string]any  `json:"input"`
		Outside []OutsideTarget `json:"outside"`
		Scopes  []string        `json:"scopes"`
	} `json:"outside"`
	Gate []struct {
		Mode      string         `json:"mode"`
		HasUI     bool           `json:"hasUI"`
		Answers   []*string      `json:"answers"`
		Tool      string         `json:"tool"`
		ID        string         `json:"id"`
		Input     map[string]any `json:"input"`
		Result    map[string]any `json:"result"`
		Again     map[string]any `json:"again"`
		Prompts   []string       `json:"prompts"`
		Notes     []string       `json:"notes"`
		ModeAfter string         `json:"modeAfter"`
	} `json:"gate"`
	Todo []struct {
		Params  map[string]any `json:"params"`
		Text    string         `json:"text"`
		Details struct {
			Action string     `json:"action"`
			Todos  []TodoItem `json:"todos"`
			Error  string     `json:"error"`
		} `json:"details"`
	} `json:"todo"`
	Contexts []struct {
		Provider string `json:"provider"`
		Mode     string `json:"mode"`
		Content  string `json:"content"`
	} `json:"contexts"`
}

// workspace rebuilds the generator's layout and returns its canonical root.
func workspace(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"repo/src", "outside", "repo-sibling"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "repo", "src", "a.ts"), []byte("const a = 1;\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(root, "repo", "link-out")); err != nil {
		t.Fatal(err)
	}
	return root
}

// loadGolden reads golden.json with @@ROOT@@ and @@HOME@@ expanded.
func loadGolden(t *testing.T, root string) golden {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	text := strings.NewReplacer("@@ROOT@@", root, "@@HOME@@", home).Replace(string(data))
	var g golden
	if err := json.Unmarshal([]byte(text), &g); err != nil {
		t.Fatal(err)
	}
	return g
}

type fakeUI struct {
	hasUI   bool
	answers []*string
	prompts []string
	notes   []string
}

func (f *fakeUI) HasUI() bool { return f.hasUI }

func (f *fakeUI) Select(title string, _ []string) (string, bool) {
	f.prompts = append(f.prompts, strings.SplitN(title, "\n\n", 2)[0])
	if len(f.answers) == 0 {
		return "", false
	}
	answer := f.answers[0]
	f.answers = f.answers[1:]
	if answer == nil {
		return "", false
	}
	return *answer, true
}

func (f *fakeUI) Notify(message, _ string) { f.notes = append(f.notes, message) }

func verdictJSON(v Verdict) map[string]any {
	if !v.Block {
		return nil
	}
	return map[string]any{"block": true, "reason": v.Reason}
}

func TestPureFunctionsMatchTypeScript(t *testing.T) {
	root := workspace(t)
	g := loadGolden(t, root)
	for _, c := range g.Safety {
		if IsSafeCommand(c.Command) != c.Safe || IsDestructiveCommand(c.Command) != c.Destructive {
			t.Errorf("%q: safe=%v destructive=%v, TypeScript %v %v", c.Command, IsSafeCommand(c.Command), IsDestructiveCommand(c.Command), c.Safe, c.Destructive)
		}
	}
	for _, c := range g.Todos {
		if got := ExtractTodoItems(c.Message); !reflect.DeepEqual(got, c.Items) {
			t.Errorf("%q:\n go %+v\n ts %+v", c.Message, got, c.Items)
		}
	}
	for _, c := range g.Cleaned {
		if got := CleanStepText(c.Text); got != c.Cleaned {
			t.Errorf("%q: %q, TypeScript %q", c.Text, got, c.Cleaned)
		}
	}
	for _, c := range g.DoneTexts {
		if got := ExtractDoneSteps(c.Text); !reflect.DeepEqual(got, c.Steps) {
			t.Errorf("%q: %v, TypeScript %v", c.Text, got, c.Steps)
		}
	}
	for _, c := range g.Targets {
		got := MutationTargetPaths("apply_patch", c.Input)
		if len(got) != len(c.Paths) || (len(got) > 0 && !reflect.DeepEqual(got, c.Paths)) {
			t.Errorf("%v: %q, TypeScript %q", c.Input, got, c.Paths)
		}
	}
	cwd := filepath.Join(root, "repo")
	for _, c := range g.Outside {
		got := FindOutsideTargets(c.Tool, c.Input, cwd, nil)
		if len(got) != len(c.Outside) || (len(got) > 0 && !reflect.DeepEqual(got, c.Outside)) {
			t.Errorf("%s %v:\n go %+v\n ts %+v", c.Tool, c.Input, got, c.Outside)
		}
		if scopes := ApprovalScopes(got); len(scopes) != len(c.Scopes) || (len(scopes) > 0 && !reflect.DeepEqual(scopes, c.Scopes)) {
			t.Errorf("%s %v scopes: %q, TypeScript %q", c.Tool, c.Input, scopes, c.Scopes)
		}
	}
}

func TestGateMatchesTypeScript(t *testing.T) {
	root := workspace(t)
	g := loadGolden(t, root)
	if len(g.Gate) < 300 {
		t.Fatalf("golden gate corpus too small: %d", len(g.Gate))
	}
	cwd := filepath.Join(root, "repo")
	for _, c := range g.Gate {
		ui := &fakeUI{hasUI: c.HasUI, answers: c.Answers}
		gate := &Gate{Mode: Mode(c.Mode)}
		first := verdictJSON(gate.Check(ui, c.Tool, c.ID, c.Input, cwd))
		again := verdictJSON(gate.Check(ui, c.Tool, c.ID, c.Input, cwd))
		name := c.Mode + " ui=" + map[bool]string{true: "yes", false: "no"}[c.HasUI] + " " + c.Tool + " " + c.ID
		if !reflect.DeepEqual(first, c.Result) || !reflect.DeepEqual(again, c.Again) {
			t.Errorf("%s %v answers=%v:\n go  %v / %v\n ts  %v / %v", name, c.Input, deref(c.Answers), first, again, c.Result, c.Again)
		}
		if !equalStrings(ui.prompts, c.Prompts) {
			t.Errorf("%s prompts:\n go %q\n ts %q", name, ui.prompts, c.Prompts)
		}
		if !equalStrings(ui.notes, c.Notes) {
			t.Errorf("%s notes:\n go %q\n ts %q", name, ui.notes, c.Notes)
		}
		if string(gate.Mode) != c.ModeAfter {
			t.Errorf("%s mode after: %s, TypeScript %s", name, gate.Mode, c.ModeAfter)
		}
	}
}

func TestTodoToolMatchesTypeScript(t *testing.T) {
	g := loadGolden(t, t.TempDir())
	var items []TodoItem
	for _, c := range g.Todo {
		req := TodoRequest{Action: c.Params["action"].(string)}
		if v, ok := c.Params["step"].(float64); ok {
			n := int(v)
			req.Step = &n
		}
		if v, ok := c.Params["position"].(float64); ok {
			n := int(v)
			req.Position = &n
		}
		if v, ok := c.Params["text"].(string); ok {
			req.Text = &v
		}
		var text, errCode string
		items, text, errCode = ApplyTodo(items, req)
		if text != c.Text || errCode != c.Details.Error || !(len(items) == 0 && len(c.Details.Todos) == 0) && !reflect.DeepEqual(items, c.Details.Todos) {
			t.Errorf("%v:\n go %q %q %+v\n ts %q %q %+v", c.Params, text, errCode, items, c.Text, c.Details.Error, c.Details.Todos)
		}
	}
}

func TestModeContextMatchesTypeScript(t *testing.T) {
	g := loadGolden(t, t.TempDir())
	for _, c := range g.Contexts {
		// TypeScript turns the Cursor bridge on in default mode before it
		// builds the context (same process). The Go extension cannot do that
		// for a Node provider cell, so the test passes the enabled value.
		got := ModeContext(Mode(c.Mode), c.Provider, "1", c.Provider == "cursor" && c.Mode == "default")
		if got != c.Content {
			t.Errorf("%s %s:\n go %q\n ts %q", c.Provider, c.Mode, got, c.Content)
		}
	}
	if !strings.Contains(ModeContext(ModeDefault, "cursor", "", false), "currently unavailable") {
		t.Error("cursor default without the bridge env must warn")
	}
}

func deref(answers []*string) []string {
	out := make([]string, len(answers))
	for i, a := range answers {
		if a == nil {
			out[i] = "<nil>"
		} else {
			out[i] = *a
		}
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}
