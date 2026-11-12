package recipes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// commandsGolden is the part of golden.json that gen-golden-commands.ts
// writes from the real registerRecipes handlers.
type commandsGolden struct {
	Suggest []struct {
		Cwd  string `json:"cwd"`
		Name string `json:"name"`
	} `json:"suggest"`
	InitArgs []struct {
		Arg    string `json:"arg"`
		Result struct {
			Name  string  `json:"name"`
			From  *string `json:"from"`
			Error string  `json:"error"`
		} `json:"result"`
	} `json:"initArgs"`
	Scaffolds []struct {
		Name     string  `json:"name"`
		Seed     Seed    `json:"seed"`
		Template *string `json:"template"`
		Text     string  `json:"text"`
	} `json:"scaffolds"`
	Inits []struct {
		Case struct {
			Name      string    `json:"name"`
			Dir       string    `json:"dir"`
			Args      string    `json:"args"`
			Templates string    `json:"templates"`
			HasUI     *bool     `json:"hasUI"`
			Selects   []*string `json:"selects"`
			Inputs    []*string `json:"inputs"`
			Model     *bool     `json:"model"`
			Thinking  string    `json:"thinking"`
			Setup     string    `json:"setup"`
		} `json:"case"`
		Notes   []note          `json:"notes"`
		Dialogs json.RawMessage `json:"dialogs"`
		Text    *string         `json:"text"`
		Trust   *string         `json:"trust"`
	} `json:"inits"`
	Statuses []struct {
		Case struct {
			Name      string            `json:"name"`
			Recipe    string            `json:"recipe"`
			Source    string            `json:"source"`
			Argv      []string          `json:"argv"`
			Env       map[string]string `json:"env"`
			Model     json.RawMessage   `json:"model"`
			Scoped    []modelRef        `json:"scoped"`
			Thinking  string            `json:"thinking"`
			Providers json.RawMessage   `json:"providers"`
			Access    bool              `json:"access"`
			Commands  *[]registration   `json:"commands"`
			Tools     *[]registration   `json:"tools"`
			Active    *[]string         `json:"active"`
		} `json:"case"`
		Expected *string         `json:"expected"`
		Report   json.RawMessage `json:"report"`
		Full     string          `json:"full"`
		Summary  string          `json:"summary"`
		JSON     string          `json:"json"`
		Rows     []struct {
			Width    int      `json:"width"`
			Expanded bool     `json:"expanded"`
			Rows     []string `json:"rows"`
		} `json:"rows"`
	} `json:"statuses"`
	StatusCommands []struct {
		Mode    string            `json:"mode"`
		Command string            `json:"command"`
		Args    string            `json:"args"`
		Entries []json.RawMessage `json:"entries"`
		Notes   []note            `json:"notes"`
		Stderr  []string          `json:"stderr"`
	} `json:"statusCommands"`
	ReservedRuns []struct {
		Args    string   `json:"args"`
		Notes   []note   `json:"notes"`
		Entries []string `json:"entries"`
	} `json:"reservedRuns"`
	TrustRuns []struct {
		Case struct {
			Name    string `json:"name"`
			HasUI   bool   `json:"hasUI"`
			Select  string `json:"select"`
			Reason  string `json:"reason"`
			Content string `json:"content"`
		} `json:"case"`
		Dialogs []struct {
			Title   string   `json:"title"`
			Options []string `json:"options"`
		} `json:"dialogs"`
		Notes   []note            `json:"notes"`
		Stderr  []string          `json:"stderr"`
		Trust   string            `json:"trust"`
		Active  *string           `json:"active"`
		Entries []json.RawMessage `json:"entries"`
	} `json:"trustRuns"`
	NoApprove []struct {
		Argv  []string `json:"argv"`
		Trust string   `json:"trust"`
	} `json:"noApprove"`
	Launches []struct {
		Env       string     `json:"env"`
		Argv      []string   `json:"argv"`
		Directory *string    `json:"directory"`
		Continued *Continued `json:"continued"`
		Action    string     `json:"action"`
		Reason    *string    `json:"reason"`
		Name      *string    `json:"name"`
		Note      *string    `json:"note"`
	} `json:"launches"`
}

type note struct {
	Message string `json:"message"`
	Type    string `json:"type"`
}

type modelRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
	API      string `json:"api"`
}

type registration struct {
	Name       string `json:"name"`
	Source     string `json:"source"`
	SourceInfo *struct {
		Path   string `json:"path"`
		Source string `json:"source"`
	} `json:"sourceInfo"`
}

func loadCommands(t *testing.T, root string) commandsGolden {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g commandsGolden
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(data), "@@ROOT@@", root)), &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestInitHelpersMatchTypeScript(t *testing.T) {
	root, _ := setup(t)
	g := loadCommands(t, root)
	for _, c := range g.Suggest {
		if got := SuggestName(c.Cwd); got != c.Name {
			t.Errorf("SuggestName(%q) = %q, TypeScript %q", c.Cwd, got, c.Name)
		}
	}
	for _, c := range g.InitArgs {
		got := ParseInitArgs(c.Arg)
		from := ""
		if c.Result.From != nil {
			from = *c.Result.From
		}
		if got.Name != c.Result.Name || got.From != from || got.Error != c.Result.Error {
			t.Errorf("ParseInitArgs(%q) = %+v, TypeScript %+v", c.Arg, got, c.Result)
		}
	}
	t.Setenv(FileEnv, filepath.Join(root, "templates", FileName))
	templates := Load(Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}, "", false, false).Recipes
	for _, c := range g.Scaffolds {
		var template *Definition
		name := "blank"
		if c.Template != nil {
			template, name = templates[*c.Template], *c.Template
			if template == nil {
				t.Fatalf("template %q not loaded", *c.Template)
			}
		}
		if got := Scaffold(c.Name, c.Seed, template); got != c.Text {
			t.Errorf("Scaffold(%q, %+v, %s):\n go %s\n ts %s", c.Name, c.Seed, name, got, c.Text)
		}
	}
}

// initHost replays a scenario's dialog answers and records what TypeScript records.
type initHost struct {
	cwd      string
	hasUI    bool
	selects  []*string
	inputs   []*string
	model    string
	thinking string
	notes    []note
	dialogs  []map[string]any
}

func (h *initHost) Cwd() string { return h.cwd }
func (h *initHost) HasUI() bool { return h.hasUI }
func (h *initHost) Select(title string, options []string) (string, bool) {
	h.dialogs = append(h.dialogs, map[string]any{"op": "select", "title": title, "options": options})
	if len(h.selects) == 0 {
		return "", false
	}
	answer := h.selects[0]
	h.selects = h.selects[1:]
	if answer == nil {
		return "", false
	}
	return *answer, true
}
func (h *initHost) Input(title, placeholder string) (string, bool) {
	h.dialogs = append(h.dialogs, map[string]any{"op": "input", "title": title, "placeholder": placeholder})
	if len(h.inputs) == 0 {
		return "", false
	}
	answer := h.inputs[0]
	h.inputs = h.inputs[1:]
	if answer == nil {
		return "", false
	}
	return *answer, true
}
func (h *initHost) Notify(message, level string) { h.notes = append(h.notes, note{message, level}) }
func (h *initHost) Model() string                { return h.model }
func (h *initHost) ThinkingLevel() string        { return h.thinking }
func (h *initHost) Refresh()                     {}

func sameJSON(t *testing.T, got any, want json.RawMessage) bool {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	_ = json.Unmarshal(data, &a)
	_ = json.Unmarshal(want, &b)
	if a == nil {
		a = []any{}
	}
	if b == nil {
		b = []any{}
	}
	return reflect.DeepEqual(a, b)
}

func TestInitMatchesTypeScript(t *testing.T) {
	root, _ := setup(t)
	g := loadCommands(t, root)
	store := filepath.Join(root, "agent", TrustFileName)
	paths := Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}
	for _, c := range g.Inits {
		cwd := filepath.Join(root, "init", c.Case.Dir)
		if err := os.MkdirAll(cwd, 0o755); err != nil {
			t.Fatal(err)
		}
		switch c.Case.Setup {
		case "existing":
			_ = os.WriteFile(filepath.Join(cwd, ".pi-recipe"), []byte("{}"), 0o644)
		case "existing-json":
			_ = os.WriteFile(filepath.Join(cwd, ".pi-recipe.json"), []byte("{}"), 0o644)
		case "directory":
			_ = os.Mkdir(filepath.Join(cwd, ".pi-recipe"), 0o755)
		}
		templates := filepath.Join(root, "templates", FileName)
		switch c.Case.Templates {
		case "notemplates":
			templates = filepath.Join(root, "notemplates", FileName)
		case "missing":
			templates = filepath.Join(root, "missing", FileName)
		}
		t.Setenv(FileEnv, templates)
		h := &initHost{cwd: cwd, hasUI: c.Case.HasUI == nil || *c.Case.HasUI, selects: c.Case.Selects, inputs: c.Case.Inputs,
			model: "anthropic/claude-x", thinking: "high"}
		if c.Case.Model != nil && !*c.Case.Model {
			h.model = ""
		}
		if c.Case.Thinking != "" {
			h.thinking = c.Case.Thinking
		}
		Init(h, paths, store, strings.TrimPrefix(c.Case.Args, "init"))
		if !reflect.DeepEqual(h.notes, c.Notes) && !(len(h.notes) == 0 && len(c.Notes) == 0) {
			t.Errorf("%s notes:\n go %q\n ts %q", c.Case.Name, h.notes, c.Notes)
		}
		if !sameJSON(t, h.dialogs, c.Dialogs) {
			got, _ := json.Marshal(h.dialogs)
			t.Errorf("%s dialogs:\n go %s\n ts %s", c.Case.Name, got, c.Dialogs)
		}
		file := filepath.Join(cwd, ".pi-recipe")
		var text *string
		if c.Case.Setup == "" {
			if data, err := os.ReadFile(file); err == nil {
				s := string(data)
				text = &s
			}
		}
		if (text == nil) != (c.Text == nil) || (text != nil && *text != *c.Text) {
			t.Errorf("%s file:\n go %v\n ts %v", c.Case.Name, deref(text), deref(c.Text))
		}
		if text != nil && c.Trust != nil {
			if got := FileTrust(file, store); got != *c.Trust {
				t.Errorf("%s trust %s, TypeScript %s", c.Case.Name, got, *c.Trust)
			}
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

type taggedTheme struct{}

func (taggedTheme) Fg(role, text string) string { return "<" + role + ">" + text + "</>" }
func (taggedTheme) Bold(text string) string     { return text }
func (taggedTheme) Bg(_, text string) string    { return text }

func TestStatusMatchesTypeScript(t *testing.T) {
	root, _ := setup(t)
	g := loadCommands(t, root)
	t.Setenv(FileEnv, filepath.Join(root, "templates", FileName))
	defs := Load(Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}, "", false, false).Recipes
	for _, c := range g.Statuses {
		in := StatusInput{CapturedAt: "@@TIME@@", Argv: c.Case.Argv, Env: c.Case.Env, Thinking: "medium",
			Model: "anthropic/claude-x", API: "anthropic-messages"}
		if c.Case.Recipe != "" {
			active := *defs[c.Case.Recipe]
			active.BaseDir = "/recipes/home"
			in.ActiveName, in.Active, in.Selection = c.Case.Recipe, &active, c.Case.Source
		}
		if c.Expected != nil {
			in.ExpectedModel = *c.Expected
		}
		switch string(c.Case.Model) {
		case "":
		case "null":
			in.Model, in.API = "", ""
		default:
			var m modelRef
			_ = json.Unmarshal(c.Case.Model, &m)
			in.Model, in.API = m.Provider+"/"+m.ID, m.API
		}
		for _, m := range c.Case.Scoped {
			in.Scoped = append(in.Scoped, m.Provider+"/"+m.ID)
		}
		if c.Case.Thinking != "" {
			in.Thinking = c.Case.Thinking
		}
		switch string(c.Case.Providers) {
		case "null":
		case "":
			in.Providers = &[]string{"anthropic", "openai"}
		default:
			var list []string
			_ = json.Unmarshal(c.Case.Providers, &list)
			in.Providers = &list
		}
		if c.Case.Access {
			mode, style := "plan", "concise"
			in.PermissionMode, in.Style = &mode, &style
		}
		commands := []registration{
			{Name: "recipe", Source: "extension", SourceInfo: &struct {
				Path   string `json:"path"`
				Source string `json:"source"`
			}{"/ext/aio/index.ts", "local"}},
			{Name: "skill:x", Source: "skill", SourceInfo: &struct {
				Path   string `json:"path"`
				Source string `json:"source"`
			}{"/skills/x", "local"}},
		}
		if c.Case.Commands != nil {
			commands = *c.Case.Commands
		}
		for _, r := range commands {
			reg := Registration{Name: r.Name, Extension: r.Source == "extension"}
			if r.SourceInfo != nil {
				reg.Path, reg.Source = r.SourceInfo.Path, r.SourceInfo.Source
			}
			in.Commands = append(in.Commands, reg)
		}
		tools := []registration{
			{Name: "read", SourceInfo: &struct {
				Path   string `json:"path"`
				Source string `json:"source"`
			}{"builtin:read", "builtin"}},
			{Name: "subagent", SourceInfo: &struct {
				Path   string `json:"path"`
				Source string `json:"source"`
			}{"/ext/aio/index.ts", "local"}},
		}
		if c.Case.Tools != nil {
			tools = *c.Case.Tools
		}
		for _, r := range tools {
			reg := Registration{Name: r.Name}
			if r.SourceInfo != nil {
				reg.Path, reg.Source = r.SourceInfo.Path, r.SourceInfo.Source
			}
			in.Tools = append(in.Tools, reg)
		}
		in.ActiveTools = []string{"read", "subagent"}
		if c.Case.Active != nil {
			in.ActiveTools = *c.Case.Active
		}
		report := BuildStatus(in)
		if !sameJSON(t, report, c.Report) {
			got, _ := json.Marshal(report)
			t.Errorf("%s report:\n go %s\n ts %s", c.Case.Name, got, c.Report)
			continue
		}
		if got := FormatStatus(report, true); got != c.Full {
			t.Errorf("%s full:\n go %q\n ts %q", c.Case.Name, got, c.Full)
		}
		if got := FormatStatus(report, false); got != c.Summary {
			t.Errorf("%s summary:\n go %q\n ts %q", c.Case.Name, got, c.Summary)
		}
		if got := StatusJSON(report, "  "); got != c.JSON {
			t.Errorf("%s json:\n go %s\n ts %s", c.Case.Name, got, c.JSON)
		}
		for _, r := range c.Rows {
			if got := StatusRows(report, taggedTheme{}, r.Width, r.Expanded); !reflect.DeepEqual(got, r.Rows) {
				t.Errorf("%s rows width %d expanded %v:\n go %q\n ts %q", c.Case.Name, r.Width, r.Expanded, got, r.Rows)
			}
		}
	}
}

type statusHost struct {
	mode    string
	entries []map[string]any
	notes   []note
	stderr  []string
}

func (h *statusHost) Mode() string { return h.mode }
func (h *statusHost) AppendEntry(customType string, data any) {
	h.entries = append(h.entries, map[string]any{"customType": customType, "data": data})
}
func (h *statusHost) Notify(message, level string) { h.notes = append(h.notes, note{message, level}) }
func (h *statusHost) Stderr(text string)           { h.stderr = append(h.stderr, text) }

// TestStatusCommandsMatchTypeScript replays the command surfaces: the report
// itself is the "off" snapshot of the harness, so the entry, the notice,
// and the stderr text must match in every mode.
func TestStatusCommandsMatchTypeScript(t *testing.T) {
	root, _ := setup(t)
	g := loadCommands(t, root)
	in := StatusInput{CapturedAt: "@@TIME@@", Model: "anthropic/claude-x", API: "anthropic-messages", Thinking: "high",
		ActiveTools: []string{"read", "subagent"}, Providers: &[]string{"anthropic", "openai"},
		Commands: []Registration{{Name: "recipe", Extension: true, Path: "/ext/aio/index.ts", Source: "local"}, {Name: "skill:x", Path: "/skills/x", Source: "local"}},
		Tools:    []Registration{{Name: "read", Path: "builtin:read", Source: "builtin"}, {Name: "subagent", Path: "/ext/aio/index.ts", Source: "local"}},
	}
	report := BuildStatus(in)
	for _, c := range g.StatusCommands {
		h := &statusHost{mode: c.Mode}
		value := strings.TrimSpace(c.Args)
		switch {
		case c.Command == "recipe-status" && value != "" && value != "--json":
			h.Notify(StatusUsage, "error")
		case c.Command == "recipe-status":
			ShowStatus(h, report, value == "--json")
		default:
			ShowStatus(h, report, strings.HasSuffix(value, "--json"))
		}
		name := c.Mode + " /" + c.Command + " " + c.Args
		if len(h.entries) != len(c.Entries) || (len(h.entries) > 0 && !sameJSON(t, h.entries[0], c.Entries[0])) {
			got, _ := json.Marshal(h.entries)
			t.Errorf("%s entries:\n go %s\n ts %s", name, got, c.Entries)
		}
		if !(len(h.notes) == 0 && len(c.Notes) == 0) && !reflect.DeepEqual(h.notes, c.Notes) {
			t.Errorf("%s notes:\n go %q\n ts %q", name, h.notes, c.Notes)
		}
		if !(len(h.stderr) == 0 && len(c.Stderr) == 0) && !reflect.DeepEqual(h.stderr, c.Stderr) {
			t.Errorf("%s stderr:\n go %q\n ts %q", name, h.stderr, c.Stderr)
		}
	}
	// A recipe literally named a subcommand keeps switching (go/aio checks
	// the recipe set first); the golden shows TypeScript does the same.
	for _, r := range g.ReservedRuns {
		if strings.HasPrefix(r.Args, "status --json") {
			continue
		}
		want, _ := ActivationText(r.Args, nil, nil)
		if len(r.Notes) != 1 || r.Notes[0].Message != want || len(r.Entries) != 1 || r.Entries[0] != StateEntry {
			t.Errorf("reserved %q: %+v", r.Args, r)
		}
	}
}

type trustHost struct {
	hasUI   bool
	answer  string
	dialogs []map[string]any
	stderr  []string
}

func (h *trustHost) HasUI() bool { return h.hasUI }
func (h *trustHost) Select(title string, options []string) (string, bool) {
	h.dialogs = append(h.dialogs, map[string]any{"title": title, "options": options})
	return h.answer, h.answer != ""
}
func (h *trustHost) Stderr(text string) { h.stderr = append(h.stderr, text) }

func TestTrustQuestionMatchesTypeScript(t *testing.T) {
	root, _ := setup(t)
	g := loadCommands(t, root)
	store := filepath.Join(root, "agent", "trust-question.json")
	paths := Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}
	t.Setenv(FileEnv, filepath.Join(root, "notemplates", FileName))
	directoryText := `{"defaultRecipe":"dir","recipes":{"dir":{"description":"d"},"other":{"model":"x/y"}}}`
	for _, c := range g.TrustRuns {
		cwd := filepath.Join(root, "trustq-go", strings.ReplaceAll(c.Case.Name, " ", "-"))
		_ = os.MkdirAll(cwd, 0o755)
		file := filepath.Join(cwd, ".pi-recipe")
		content := directoryText
		if c.Case.Content != "" {
			content = c.Case.Content
		}
		_ = os.WriteFile(file, []byte(content), 0o644)
		h := &trustHost{hasUI: c.Case.HasUI, answer: c.Case.Select}
		var notes []note
		active := ""
		if c.Case.Reason == "" || c.Case.Reason == "startup" {
			choice, err := AskDirectoryTrust(h, file, store)
			if err != nil {
				t.Fatal(err)
			}
			if choice == "trust" {
				loaded := Load(paths, cwd, false, FileTrust(file, store) == Trusted)
				def, text := DirectoryDefault(loaded, "", filepath.Base(file))
				if def != nil {
					active = def.Name
					text, level := ActivationText(def.Name, nil, nil)
					notes = append(notes, note{text, level})
				} else {
					notes = append(notes, note{text, "info"})
				}
			}
		}
		// The golden's paths are under trustq/, this run's under trustq-go/.
		golden := func(s string) string { return strings.ReplaceAll(s, "trustq-go", "trustq") }
		if len(h.dialogs) != len(c.Dialogs) {
			t.Errorf("%s dialogs: %d, TypeScript %d", c.Case.Name, len(h.dialogs), len(c.Dialogs))
		} else if len(h.dialogs) == 1 {
			if golden(h.dialogs[0]["title"].(string)) != c.Dialogs[0].Title || !reflect.DeepEqual(h.dialogs[0]["options"], c.Dialogs[0].Options) {
				t.Errorf("%s dialog:\n go %q\n ts %q", c.Case.Name, h.dialogs[0], c.Dialogs[0])
			}
		}
		for i := range h.stderr {
			h.stderr[i] = golden(h.stderr[i])
		}
		if !(len(h.stderr) == 0 && len(c.Stderr) == 0) && !reflect.DeepEqual(h.stderr, c.Stderr) {
			t.Errorf("%s stderr:\n go %q\n ts %q", c.Case.Name, h.stderr, c.Stderr)
		}
		if !(len(notes) == 0 && len(c.Notes) == 0) && !reflect.DeepEqual(notes, c.Notes) {
			t.Errorf("%s notes:\n go %q\n ts %q", c.Case.Name, notes, c.Notes)
		}
		if got := FileTrust(file, store); got != c.Trust {
			t.Errorf("%s trust %s, TypeScript %s", c.Case.Name, got, c.Trust)
		}
		if (c.Active == nil) != (active == "") || (c.Active != nil && *c.Active != active) {
			t.Errorf("%s active %q, TypeScript %v", c.Case.Name, active, deref(c.Active))
		}
	}
}

func TestLaunchDecisionsMatchTypeScript(t *testing.T) {
	root, base := setup(t)
	store := filepath.Join(root, "agent", TrustFileName)
	if err := os.WriteFile(store, []byte(base.TrustStore), 0o600); err != nil {
		t.Fatal(err)
	}
	g := loadCommands(t, root)
	pigEnv := map[string]string{"AI_AGENT": "pig", PigHarnessEnv: "/bin/pig"}
	with := func(extra map[string]string) map[string]string {
		out := map[string]string{}
		for k, v := range pigEnv {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	envs := map[string]map[string]string{
		"pig": pigEnv, "launcher": with(map[string]string{PigLauncherEnv: "1"}), "stage": with(map[string]string{StageEnv: "1"}),
		"child": with(map[string]string{SubagentChildEnv: "1"}), "pi": {"AI_AGENT": "pi", PigHarnessEnv: "/bin/pig"},
		"blank binary": {"AI_AGENT": "pig", PigHarnessEnv: "  "},
	}
	def := func(name string, c Config) *Definition {
		return &Definition{Name: name, Source: "global", BaseDir: root, Config: c}
	}
	recipes := map[string]*Definition{
		"plain": def("plain", Config{Model: "a/b"}), "scoped": def("scoped", Config{Models: []string{"openai/*"}}),
		"exts": def("exts", Config{Extensions: []string{"npm:x", "./y.ts"}}), "both": def("both", Config{Extensions: []string{"bare"}, Models: []string{"m"}}),
		"aioOnly": def("aioOnly", Config{Extensions: []string{"aio"}}),
	}
	if len(g.Launches) < 500 {
		t.Fatalf("launch corpus too small: %d", len(g.Launches))
	}
	for _, c := range g.Launches {
		in := LaunchInput{Argv: c.Argv, Env: envs[c.Env], Recipes: recipes, Continued: c.Continued}
		if c.Directory != nil {
			in.DirectoryRecipe = *c.Directory
		}
		got := DecideLaunch(in)
		want := LaunchDecision{Action: c.Action}
		if c.Reason != nil {
			want.Reason = *c.Reason
		}
		if c.Name != nil {
			want.Name = *c.Name
		}
		if c.Note != nil {
			want.Note = *c.Note
		}
		if got != want {
			t.Errorf("%s %q dir=%v cont=%v:\n go %+v\n ts %+v", c.Env, c.Argv, deref(c.Directory), c.Continued, got, want)
		}
	}
	for _, c := range g.NoApprove {
		if got := FileTrustForLaunch(filepath.Join(root, "project", ".pi-recipe"), store, c.Argv); got != c.Trust {
			t.Errorf("--no-approve %q: %s, TypeScript %s", c.Argv, got, c.Trust)
		}
	}
}

func TestContinuedSession(t *testing.T) {
	cases := map[string]bool{
		"": false, "-c": true, "--session x": true, "--session-id i": true, "-c --recipe x": false, "-c --no-session": false,
		"-c -r": false, "-c --fork f": false, "install -c": false, "-c --help": false,
	}
	for argv, want := range cases {
		if got := ContinuedSession(strings.Fields(argv), map[string]string{}); got != want {
			t.Errorf("ContinuedSession(%q) = %v, want %v", argv, got, want)
		}
	}
	if ContinuedSession([]string{"-c"}, map[string]string{StageEnv: "1"}) {
		t.Error("a staged launch never continues a recipe")
	}
}
