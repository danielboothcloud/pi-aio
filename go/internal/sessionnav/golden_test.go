package sessionnav

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
)

type goldenFile map[string]json.RawMessage

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func section[T any](t *testing.T, g goldenFile, key string) T {
	t.Helper()
	if len(g[key]) < 2 {
		t.Fatalf("golden section %s is missing", key)
	}
	var v T
	if err := json.Unmarshal(g[key], &v); err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return v
}

func norm(v any) string {
	b, _ := json.Marshal(v)
	var x any
	_ = json.Unmarshal(b, &x)
	b, _ = json.Marshal(x)
	return string(b)
}

func jsonEq(t *testing.T, label string, got, want any) {
	t.Helper()
	if g, w := norm(got), norm(want); g != w {
		t.Errorf("%s:\n got %s\nwant %s", label, g, w)
	}
}

type goldenKeys struct {
	ids   map[string]map[string]bool
	kitty map[string]string
	data  map[string]string
}

func (k goldenKeys) MatchesKey(data, id string) bool { return k.ids[data][id] }
func (k goldenKeys) DecodeKittyPrintable(data string) (string, bool) {
	s, ok := k.kitty[data]
	return s, ok
}

func loadKeys(t *testing.T, g goldenFile) goldenKeys {
	k := goldenKeys{ids: map[string]map[string]bool{}, kitty: map[string]string{}, data: map[string]string{}}
	for _, e := range section[[]struct {
		Name, Data string
		KeyIDs     []string `json:"keyIds"`
		Kitty      *string
		Printable  *string
	}](t, g, "keyTable") {
		k.data[e.Name] = e.Data
		k.ids[e.Data] = map[string]bool{}
		for _, id := range e.KeyIDs {
			k.ids[e.Data][id] = true
		}
		if e.Kitty != nil {
			k.kitty[e.Data] = *e.Kitty
		}
		got, ok := PrintableInput(k, e.Data)
		if ok != (e.Printable != nil) || (ok && got != *e.Printable) {
			t.Errorf("printable %s: %q %v want %v", e.Name, got, ok, e.Printable)
		}
	}
	return k
}

func TestTextMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	now := section[float64](t, g, "now")
	for _, c := range section[[]struct{ Raw, Out string }](t, g, "titles") {
		if got := CleanPromptTitle(c.Raw); got != c.Out {
			t.Errorf("title %q: %q want %q", c.Raw, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Ago         float64
		Short, Long string
	}](t, g, "ages") {
		if s, l := RelativeAge(now-c.Ago, now, time.UTC), RelativeAgeLong(now-c.Ago, now, time.UTC); s != c.Short || l != c.Long {
			t.Errorf("age %v: %q %q want %q %q", c.Ago, s, l, c.Short, c.Long)
		}
	}
	for _, c := range section[[]struct {
		Value any
		Out   any
	}](t, g, "millis") {
		got := ToMillis(c.Value)
		if want, ok := c.Out.(float64); ok {
			if got != want {
				t.Errorf("millis %v: %v want %v", c.Value, got, want)
			}
		} else if !math.IsNaN(got) {
			t.Errorf("millis %v: %v want NaN", c.Value, got)
		}
	}
	for _, c := range section[[]struct {
		Query  string
		Fields []string
		Out    bool
	}](t, g, "queries") {
		if got := MatchesQuery(c.Query, c.Fields...); got != c.Out {
			t.Errorf("query %q %q: %v", c.Query, c.Fields, got)
		}
	}
}

type goldenCheckpoint struct {
	Checkpoint
	Timestamp any `json:"timestamp"`
}

func decodeCheckpoints(t *testing.T, raw []goldenCheckpoint) []Checkpoint {
	out := make([]Checkpoint, len(raw))
	for i, c := range raw {
		out[i] = c.Checkpoint
		if f, ok := c.Timestamp.(float64); ok {
			out[i].Timestamp = f
		} else {
			out[i].Timestamp = math.NaN()
		}
	}
	return out
}

func checkpointJSON(list []Checkpoint) any {
	out := make([]map[string]any, len(list))
	for i, c := range list {
		b, _ := json.Marshal(struct {
			Checkpoint
			Timestamp any `json:"timestamp"`
		}{c, func() any {
			if math.IsNaN(c.Timestamp) {
				return "NaN"
			}
			return c.Timestamp
		}()})
		_ = json.Unmarshal(b, &out[i])
	}
	return out
}

func TestCheckpointsMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct {
		Name    string
		Roots   []TreeNode
		Leaf    *string
		Out     []goldenCheckpoint
		Options [][]RewindOption
	}](t, g, "checkpointCases") {
		leaf := ""
		if c.Leaf != nil {
			leaf = *c.Leaf
		}
		got := BuildCheckpoints(c.Roots, leaf)
		want := decodeCheckpoints(t, c.Out)
		jsonEq(t, c.Name, checkpointJSON(got), checkpointJSON(want))
		options := [][]RewindOption{}
		for _, cp := range got {
			options = append(options, RewindOptions(cp))
		}
		jsonEq(t, c.Name+" options", options, c.Options)
	}
}

type goldenSession struct {
	Path, ID, Cwd   string
	Name            string
	Created         string
	Modified        string
	MessageCount    int
	FirstMessage    string
	AllMessagesText string
}

func decodeSessions(t *testing.T, g goldenFile, root string) []Session {
	var out []Session
	for _, s := range section[[]goldenSession](t, g, "sessionList") {
		out = append(out, Session{
			Path: strings.ReplaceAll(s.Path, "@@ROOT@@", root), ID: s.ID, Cwd: s.Cwd, Name: s.Name,
			Created: ToMillis(s.Created), Modified: ToMillis(s.Modified), MessageCount: s.MessageCount,
			FirstMessage: s.FirstMessage, AllMessagesText: s.AllMessagesText,
		})
	}
	return out
}

func writeSessionFiles(t *testing.T, g goldenFile) string {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range section[map[string]string](t, g, "files") {
		if err := os.WriteFile(filepath.Join(root, "sessions", name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestSessionsMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	now := section[float64](t, g, "now")
	root := writeSessionFiles(t, g)
	list := decodeSessions(t, g, "@@ROOT@@")
	for _, c := range section[[]struct {
		MinutesAgo float64
		Out        string
	}](t, g, "groups") {
		if got := GroupFor(now-c.MinutesAgo*60_000, now, time.UTC); got != c.Out {
			t.Errorf("group %v: %q want %q", c.MinutesAgo, got, c.Out)
		}
	}
	titles := section[[]struct{ Path, Out string }](t, g, "titlesS")
	for i, s := range list {
		if got := SessionTitle(s); got != titles[i].Out {
			t.Errorf("session title %s: %q want %q", s.Path, got, titles[i].Out)
		}
	}
	for _, c := range section[[]struct {
		Query string
		Out   []string
	}](t, g, "filters") {
		paths := []string{}
		for _, s := range FilterSessions(list, c.Query) {
			paths = append(paths, s.Path)
		}
		jsonEq(t, "filter "+c.Query, paths, c.Out)
	}
	var grouped []map[string]any
	for _, gr := range GroupSessions(list, now, time.UTC) {
		var paths []string
		for _, s := range gr.Sessions {
			paths = append(paths, s.Path)
		}
		grouped = append(grouped, map[string]any{"group": gr.Group, "paths": paths})
	}
	jsonEq(t, "grouped", grouped, section[any](t, g, "grouped"))
	for _, c := range section[[]struct {
		Name     string
		MaxBytes *int64
		Out      *LastExchange
		Error    bool
	}](t, g, "tails") {
		max := int64(256 * 1024)
		if c.MaxBytes != nil {
			max = *c.MaxBytes
		}
		got, err := ReadLastExchange(filepath.Join(root, "sessions", c.Name), max)
		if (err != nil) != c.Error {
			t.Errorf("tail %s: error %v", c.Name, err)
			continue
		}
		if !c.Error {
			jsonEq(t, "tail "+c.Name, got, c.Out)
		}
	}
}

func TestLayoutMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	for _, c := range section[[]struct {
		Width    int
		Title    string
		Sections []struct {
			Label string
			Lines []string
		}
		Out []string
	}](t, g, "frames") {
		var sections []FrameSection
		for _, s := range c.Sections {
			sections = append(sections, FrameSection{s.Label, s.Lines})
		}
		jsonEq(t, "frame", RenderFrame(theme, c.Width, c.Title, sections), c.Out)
	}
	for _, c := range section[[]struct {
		Left, Right string
		Width       int
		Out         string
	}](t, g, "splits") {
		if got := SplitRow(c.Left, c.Right, c.Width); got != c.Out {
			t.Errorf("split %q %q %d: %q want %q", c.Left, c.Right, c.Width, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Text            string
		Width, MaxLines int
		Out             []string
	}](t, g, "wraps") {
		jsonEq(t, "wrap "+c.Text, WrapLimited(c.Text, c.Width, c.MaxLines), c.Out)
	}
	for _, c := range section[[]struct {
		Total, Selected, Size int
		Out                   struct{ Start, End int }
	}](t, g, "windows") {
		if s, e := VisibleWindow(c.Total, c.Selected, c.Size); s != c.Out.Start || e != c.Out.End {
			t.Errorf("window %+v: %d %d", c, s, e)
		}
	}
}

func TestRewindPickerMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	keys := loadKeys(t, g)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	now := section[float64](t, g, "now")
	trees := map[string]struct {
		Roots []TreeNode
		Leaf  *string
	}{}
	for _, c := range section[[]struct {
		Name  string
		Roots []TreeNode
		Leaf  *string
	}](t, g, "checkpointCases") {
		trees[c.Name] = struct {
			Roots []TreeNode
			Leaf  *string
		}{c.Roots, c.Leaf}
	}
	for _, script := range section[[]struct {
		Name, Tree string
		Rows       int
		Widths     []int
		Frames     []struct {
			Key         *string
			View, Query string
			Selected    *string
			Done        json.RawMessage
			Renders     [][]string
		}
	}](t, g, "rewinds") {
		tree := trees[script.Tree]
		leaf := ""
		if tree.Leaf != nil {
			leaf = *tree.Leaf
		}
		var done any = "open"
		p := NewRewindPicker(RewindPickerOptions{
			Theme: theme, Keys: keys, Checkpoints: BuildCheckpoints(tree.Roots, leaf), MaxRows: func() int { return script.Rows },
			Done: func(r *RewindResult) {
				if r == nil {
					done = nil
				} else {
					done = r
				}
			},
			RequestRender: func() {}, Now: func() float64 { return now }, Location: time.UTC,
		})
		for i, f := range script.Frames {
			if f.Key != nil {
				p.HandleInput(keys.data[*f.Key])
			}
			label := script.Name + " frame " + string(rune('a'+i))
			sel := ""
			if c, ok := p.Selected(); ok {
				sel = c.ID
			}
			wantSel := ""
			if f.Selected != nil {
				wantSel = *f.Selected
			}
			if p.View != f.View || p.Query != f.Query || sel != wantSel {
				t.Errorf("%s: view %q query %q sel %q want %q %q %q", label, p.View, p.Query, sel, f.View, f.Query, wantSel)
			}
			var wantDone any
			_ = json.Unmarshal(f.Done, &wantDone)
			if d, ok := wantDone.(map[string]any); ok {
				r, _ := done.(*RewindResult)
				if r == nil || r.Action != d["action"] || r.Checkpoint.ID != d["checkpoint"].(map[string]any)["id"] {
					t.Errorf("%s: done %+v want %v", label, done, wantDone)
				}
			} else if norm(done) != norm(wantDone) {
				t.Errorf("%s: done %v want %v", label, done, wantDone)
			}
			for j, w := range script.Widths {
				jsonEq(t, label+" w"+string(rune('0'+j)), p.Render(w), f.Renders[j])
			}
		}
	}
}

func TestResumePickerMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	keys := loadKeys(t, g)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	now := section[float64](t, g, "now")
	root := writeSessionFiles(t, g)
	list := decodeSessions(t, g, root)
	fix := func(s string) string { return strings.ReplaceAll(s, "@@ROOT@@", root) }
	for _, script := range section[[]struct {
		Name        string
		Rows        int
		Widths      []int
		Cwd         string
		Current     *string
		Fail        *string
		PreviewFail bool
		Loads       []string
		Frames      []struct {
			Key          *string
			Scope, Query string
			Selected     *string
			Done         any
			Early        [][]string
			Renders      [][]string
		}
	}](t, g, "resumes") {
		var queue []func()
		var loads []string
		var done any = "open"
		current := ""
		if script.Current != nil {
			current = fix(*script.Current)
		}
		p := NewResumePicker(ResumePickerOptions{
			Theme: theme, Keys: keys, Cwd: script.Cwd, CurrentPath: current, HomeDir: "/work",
			LoadSessions: func(scope string) ([]Session, error) {
				loads = append(loads, scope)
				if script.Fail != nil && *script.Fail == scope {
					return nil, errString("disk on fire")
				}
				if scope == "all" {
					return list, nil
				}
				var out []Session
				for _, s := range list {
					if s.Cwd == "/work/app" {
						out = append(out, s)
					}
				}
				return out, nil
			},
			LoadPreview: func(path string) (LastExchange, error) {
				if script.PreviewFail {
					return LastExchange{}, errString("x")
				}
				return ReadLastExchange(path, 256*1024)
			},
			MaxRows: func() int { return script.Rows },
			Done: func(path string) {
				if path == "" {
					done = nil
				} else {
					done = path
				}
			},
			RequestRender: func() {}, Now: func() float64 { return now }, Location: time.UTC,
			Go: func(fn func()) { queue = append(queue, fn) },
		})
		flush := func() {
			for len(queue) > 0 {
				fn := queue[0]
				queue = queue[1:]
				fn()
			}
		}
		for i, f := range script.Frames {
			if f.Key != nil {
				p.HandleInput(keys.data[*f.Key])
			}
			label := script.Name + " frame " + string(rune('a'+i))
			var early [][]string
			for _, w := range script.Widths {
				early = append(early, p.Render(w))
			}
			flush()
			jsonEq(t, label+" early", fixAll(early, root), fixAll(f.Early, root))
			sel := ""
			if s, ok := p.Selected(); ok {
				sel = s.Path
			}
			wantSel := ""
			if f.Selected != nil {
				wantSel = fix(*f.Selected)
			}
			if p.Scope != f.Scope || p.Query != f.Query || sel != wantSel {
				t.Errorf("%s: scope %q query %q sel %q want %q %q %q", label, p.Scope, p.Query, sel, f.Scope, f.Query, wantSel)
			}
			wantDone := f.Done
			if s, ok := wantDone.(string); ok && s != "open" {
				wantDone = fix(s)
			}
			if norm(done) != norm(wantDone) {
				t.Errorf("%s: done %v want %v", label, done, wantDone)
			}
			var renders [][]string
			for _, w := range script.Widths {
				renders = append(renders, p.Render(w))
			}
			jsonEq(t, label+" renders", fixAll(renders, root), fixAll(f.Renders, root))
		}
		jsonEq(t, script.Name+" loads", loads, script.Loads)
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func fixAll(renders [][]string, root string) [][]string {
	out := make([][]string, len(renders))
	for i, r := range renders {
		for _, line := range r {
			out[i] = append(out[i], strings.ReplaceAll(line, root, "@@ROOT@@"))
		}
	}
	return out
}

func TestSettingsMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	configDir := section[string](t, g, "configDirName")
	tmp := t.TempDir()
	agentDir := filepath.Join(tmp, "agent")
	for _, c := range section[[]struct {
		Name            string
		Global, Project *string
		Cwd             string
		Trusted         bool
		Out             string
	}](t, g, "escapeSettings") {
		cwd := strings.ReplaceAll(c.Cwd, "@@ROOT@@", tmp)
		_ = os.MkdirAll(filepath.Join(cwd, configDir), 0o755)
		_ = os.MkdirAll(agentDir, 0o755)
		_ = os.Remove(filepath.Join(agentDir, "settings.json"))
		if c.Global != nil {
			_ = os.WriteFile(filepath.Join(agentDir, "settings.json"), []byte(*c.Global), 0o644)
		}
		if c.Project != nil {
			_ = os.WriteFile(filepath.Join(cwd, configDir, "settings.json"), []byte(*c.Project), 0o644)
		}
		if got := ReadDoubleEscapeAction(agentDir, cwd, configDir, c.Trusted); got != c.Out {
			t.Errorf("settings %s trusted=%v: %q want %q", c.Name, c.Trusted, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Args []string
		Out  bool
	}](t, g, "launches") {
		if got := LaunchSelectsSession(c.Args); got != c.Out {
			t.Errorf("launch %q: %v", c.Args, got)
		}
	}
	for _, c := range section[[]struct{ Rows, Out int }](t, g, "pickerRows") {
		if got := MaxPickerRows(c.Rows); got != c.Out {
			t.Errorf("rows %d: %d want %d", c.Rows, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Action string
		Calls  [][]any
	}](t, g, "applied") {
		call := ApplyRewind(RewindResult{Checkpoint{ID: "u2", EndID: "a2"}, c.Action})
		var got [][]any
		if call.Notice != "" {
			got = append(got, []any{"notify", call.Notice, "info"})
		}
		if call.Op == "fork" {
			got = append(got, []any{"fork", call.TargetID, map[string]any{"position": "before"}})
		} else {
			got = append(got, []any{"navigateTree", call.TargetID, map[string]any{"summarize": call.Summarize}})
		}
		jsonEq(t, "apply "+c.Action, got, c.Calls)
	}
}

func TestRegistrarMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	now := section[float64](t, g, "now")
	for _, run := range section[[]struct {
		Name    string
		Options struct {
			Mode   string
			Flag   bool
			Argv   []string
			Reason string
		}
		Records []struct {
			Step struct {
				Op            string
				At            *float64
				Idle, Pending *bool
				Arg           string
			}
			Out any
			Log []any
		}
	}](t, g, "registrars") {
		mode := run.Options.Mode
		if mode == "" {
			mode = "tui"
		}
		reason := run.Options.Reason
		if reason == "" {
			reason = "startup"
		}
		idle, pending, clock := true, false, now
		var esc EscapeState
		installed, shown := false, false
		var log []any
		send := func(cmd string) {
			log = append(log, []any{"send", "/" + cmd, map[string]any{"expandPromptTemplates": true}})
		}
		for i, r := range run.Records {
			if r.Step.Idle != nil {
				idle = *r.Step.Idle
			}
			if r.Step.Pending != nil {
				pending = *r.Step.Pending
			}
			if r.Step.At != nil {
				clock = now + *r.Step.At
			}
			log = []any{}
			var out any
			switch r.Step.Op {
			case "session_start":
				esc.Reset()
				if mode == "tui" {
					esc.DoubleEscape = "tree"
					installed = true
					if OpensStartupPicker(reason, shown, run.Options.Flag, run.Options.Argv) {
						shown = true
						send(SessionsCommand)
					}
				}
			case "session_shutdown":
				installed = false
			case "escape":
				if installed {
					consumed := esc.OnEscape(mode == "tui", idle, pending, clock)
					if consumed {
						send(RewindCommand)
					}
					out = consumed
				}
			case "submit":
				if installed {
					out = IsResumeText(r.Step.Arg)
					if out == true {
						send(SessionsCommand)
					}
				}
			case "action":
				if installed {
					out = r.Step.Arg == "app.session.resume"
					if out == true {
						send(SessionsCommand)
					}
				}
			case "command":
				if r.Step.Arg == RewindCommand {
					if msg, level, ok := RewindGuard(mode == "tui", idle, 0); !ok {
						log = append(log, []any{"notify", msg, level})
					}
				} else if msg, level, ok := SessionsGuard(mode == "tui"); !ok {
					log = append(log, []any{"notify", msg, level})
				} else {
					log = append(log, []any{"custom"})
				}
			}
			label := run.Name + " step " + string(rune('a'+i)) + " " + r.Step.Op
			if norm(out) != norm(r.Out) {
				t.Errorf("%s: out %v want %v", label, out, r.Out)
			}
			var want []any
			for _, e := range r.Log {
				if e.([]any)[0] != "flag" {
					want = append(want, e)
				}
			}
			jsonEq(t, label+" log", log, append([]any{}, want...))
		}
	}
}
