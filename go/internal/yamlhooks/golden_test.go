package yamlhooks

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// golden.json is produced by testdata/gen-golden.ts from the TypeScript
// yaml-hooks feature, which stays the reference until the Go port replaces it.

type fsOp struct {
	Op      string `json:"op"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    *int   `json:"mode"`
	Target  string `json:"target"`
}

type golden struct {
	Constants struct {
		MaxHooksYamlBytes int  `json:"maxHooksYamlBytes"`
		Nocase            bool `json:"nocase"`
	} `json:"constants"`
	YamlValues []struct {
		Yaml  string `json:"yaml"`
		Error bool   `json:"error"`
		Value string `json:"value"`
	} `json:"yamlValues"`
	Schema []struct {
		Name      string          `json:"name"`
		FilePath  string          `json:"filePath"`
		Yaml      string          `json:"yaml"`
		Oversized bool            `json:"oversized"`
		Hooks     json.RawMessage `json:"hooks"`
		Overrides json.RawMessage `json:"overrides"`
		Errors    json.RawMessage `json:"errors"`
	} `json:"schema"`
	ReadFailure struct {
		Errors json.RawMessage `json:"errors"`
	} `json:"readFailure"`
	Overrides []struct {
		Name     string          `json:"name"`
		Base     string          `json:"base"`
		Override string          `json:"override"`
		Hooks    json.RawMessage `json:"hooks"`
		Errors   json.RawMessage `json:"errors"`
	} `json:"overrides"`
	Discoveries []struct {
		Name        string            `json:"name"`
		Fs          []fsOp            `json:"fs"`
		Env         map[string]string `json:"env"`
		Project     string            `json:"project"`
		IgnoreTrust bool              `json:"ignoreTrust"`
		Result      json.RawMessage   `json:"result"`
		Console     json.RawMessage   `json:"console"`
	} `json:"discoveries"`
	Extnames []struct {
		Path string `json:"path"`
		Code bool   `json:"code"`
	} `json:"extnames"`
	Normalize []struct {
		ProjectDir string `json:"projectDir"`
		File       string `json:"file"`
		Out        string `json:"out"`
	} `json:"normalize"`
	Globs      [][]json.RawMessage `json:"globs"`
	Conditions []struct {
		Files      []string        `json:"files"`
		Changes    []FileChange    `json:"changes"`
		Conditions []any           `json:"conditions"`
		Context    json.RawMessage `json:"context"`
		Failure    json.RawMessage `json:"failure"`
	} `json:"conditions"`
	Redactions []struct {
		Input string `json:"input"`
		Out   string `json:"out"`
	} `json:"redactions"`
	Sanitize []struct {
		Input json.RawMessage `json:"input"`
		Out   json.RawMessage `json:"out"`
	} `json:"sanitize"`
	Stdin []struct {
		MaxBytes *string         `json:"maxBytes"`
		Context  json.RawMessage `json:"context"`
		Out      struct {
			Payload   string `json:"payload"`
			Truncated bool   `json:"truncated"`
		} `json:"out"`
	} `json:"stdin"`
	Trims struct {
		Bytes []int `json:"bytes"`
		Cases []struct {
			Max int `json:"max"`
			Out int `json:"out"`
		} `json:"cases"`
		Corrupt struct {
			Bytes []int `json:"bytes"`
			Outs  []int `json:"outs"`
		} `json:"corrupt"`
	} `json:"trims"`
	Env []struct {
		Inherited [][2]string `json:"inherited"`
		Context   [][2]string `json:"context"`
		Out       [][2]string `json:"out"`
	} `json:"env"`
	MapResults []struct {
		ExitCode int    `json:"exitCode"`
		TimedOut bool   `json:"timedOut"`
		Event    string `json:"event"`
		Status   string `json:"status"`
		Blocking bool   `json:"blocking"`
	} `json:"mapResults"`
	Bash []struct {
		Name    string            `json:"name"`
		Fs      []fsOp            `json:"fs"`
		Env     map[string]string `json:"env"`
		Command string            `json:"command"`
		Event   string            `json:"event"`
		Timeout float64           `json:"timeout"`
		Project string            `json:"project"`
		Context json.RawMessage   `json:"context"`
		Result  json.RawMessage   `json:"result"`
	} `json:"bash"`
	Session struct {
		Store json.RawMessage `json:"store"`
		Scope json.RawMessage `json:"scope"`
	} `json:"session"`
	Lineage struct {
		Fs    []fsOp `json:"fs"`
		Cases []struct {
			Current string          `json:"current"`
			Header  json.RawMessage `json:"header"`
			Out     string          `json:"out"`
		} `json:"cases"`
	} `json:"lineage"`
	Runtime   []runtimeScenario `json:"runtime"`
	Scenarios []featureScenario `json:"scenarios"`
	Renders   []struct {
		Message  map[string]any `json:"message"`
		Expanded bool           `json:"expanded"`
		Width    int            `json:"width"`
		Lines    []string       `json:"lines"`
	} `json:"renders"`
}

type bashResponse struct {
	ExitCode        int    `json:"exitCode"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	OutputTruncated bool   `json:"outputTruncated"`
	StdinTruncated  bool   `json:"stdinTruncated"`
	Throw           string `json:"throw"`
}

type runtimeScenario struct {
	Name           string                  `json:"name"`
	Yaml           string                  `json:"yaml"`
	Responses      map[string]bashResponse `json:"responses"`
	Confirms       []bool                  `json:"confirms"`
	Roots          map[string]string       `json:"roots"`
	CurrentSession string                  `json:"currentSession"`
	BudgetMs       *float64                `json:"budgetMs"`
	Env            map[string]string       `json:"env"`
	Project        string                  `json:"project"`
	Steps          []struct {
		Op         string          `json:"op"`
		Tool       string          `json:"tool"`
		Session    string          `json:"session"`
		Call       string          `json:"call"`
		Args       json.RawMessage `json:"args"`
		Prompt     string          `json:"prompt"`
		Type       string          `json:"type"`
		Properties json.RawMessage `json:"properties"`
		Ms         float64         `json:"ms"`
	} `json:"steps"`
	Log []json.RawMessage `json:"log"`
}

type featureScenario struct {
	Name      string                  `json:"name"`
	Responses map[string]bashResponse `json:"responses"`
	Steps     []struct {
		Op            string             `json:"op"`
		Ops           []fsOp             `json:"ops"`
		Cwd           *string            `json:"cwd"`
		HasUI         *bool              `json:"hasUI"`
		Session       *string            `json:"session"`
		Confirms      []bool             `json:"confirms"`
		ConfirmThrows *bool              `json:"confirmThrows"`
		Set           map[string]*string `json:"set"`
		Reason        string             `json:"reason"`
		Tool          string             `json:"tool"`
		ID            string             `json:"id"`
		Input         json.RawMessage    `json:"input"`
		MessageType   string             `json:"messageType"`
		Prompt        string             `json:"prompt"`
		SystemPrompt  string             `json:"systemPrompt"`
		Name          string             `json:"name"`
		Args          string             `json:"args"`
	} `json:"steps"`
	Log       []json.RawMessage `json:"log"`
	TrustFile *string           `json:"trustFile"`
}

var (
	goldenOnce sync.Once
	goldenData golden
	goldenErr  error
)

func loadGolden(t *testing.T) *golden {
	t.Helper()
	goldenOnce.Do(func() {
		raw, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
		if err != nil {
			goldenErr = err
			return
		}
		goldenErr = json.Unmarshal(raw, &goldenData)
	})
	if goldenErr != nil {
		t.Fatal(goldenErr)
	}
	return &goldenData
}

// canon is the compact, order-kept JSON text of a golden value.
func canon(raw json.RawMessage) string { return jsstr.Stringify(raw) }

// newRoot is a symlink-free fixture root with an agent directory.
func newRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CEILING_DIRECTORIES", dir)
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(key, "PI_YAML_HOOKS_") || strings.HasPrefix(key, "OPENCODE_") {
			t.Setenv(key, "")
			os.Unsetenv(key)
		}
	}
	return dir
}

func applyFs(t *testing.T, root string, ops []fsOp) {
	t.Helper()
	for _, op := range ops {
		p := filepath.Join(root, op.Path)
		var err error
		switch op.Op {
		case "write":
			if err = os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
				err = os.WriteFile(p, []byte(strings.ReplaceAll(op.Content, "@@ROOT@@", root)), 0o644)
			}
			if err == nil && op.Mode != nil {
				err = os.Chmod(p, os.FileMode(*op.Mode))
			}
		case "rm":
			err = os.RemoveAll(p)
		case "mkdir":
			err = os.MkdirAll(p, 0o755)
		case "symlink":
			if err = os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
				err = os.Symlink(strings.ReplaceAll(op.Target, "@@ROOT@@", root), p)
			}
		case "git":
			if err = os.MkdirAll(p, 0o755); err == nil {
				err = exec.Command("git", "init", "-q", p).Run()
			}
		}
		if err != nil {
			t.Fatalf("fixture %s %s: %v", op.Op, op.Path, err)
		}
	}
}

func withEnv(t *testing.T, env map[string]string) func() {
	t.Helper()
	saved := map[string]*string{}
	for k, v := range env {
		if old, ok := os.LookupEnv(k); ok {
			saved[k] = &old
		} else {
			saved[k] = nil
		}
		os.Setenv(k, v)
	}
	return func() {
		for k, v := range saved {
			if v == nil {
				os.Unsetenv(k)
			} else {
				os.Setenv(k, *v)
			}
		}
	}
}

var (
	pidPattern  = regexp.MustCompile(`pid \d+`)
	tsPattern   = regexp.MustCompile(`\\"ts\\":\\"[^"\\]*\\"`)
	aioMessages = regexp.MustCompile(`^(\[aio yaml hooks\]|hooks\.yaml must parse|Failed to read|Project hooks file exists)`)
)

func placeholders(text, root string) string {
	text = strings.ReplaceAll(text, root, "@@ROOT@@")
	text = pidPattern.ReplaceAllString(text, "pid @@PID@@")
	return tsPattern.ReplaceAllString(text, `\"ts\":\"@@TIME@@\"`)
}

// maskYAML replaces YAML parser messages (npm yaml and yaml.v3 word them
// differently) in invalid_frontmatter errors.
func maskYAML(text string) string {
	v, err := DecodeJSON([]byte(text))
	if err != nil {
		return text
	}
	var walk func(any)
	walk = func(x any) {
		switch o := x.(type) {
		case *Object:
			if code, _ := o.Get("code").(string); code == "invalid_frontmatter" {
				if msg, ok := o.Get("message").(string); ok && !aioMessages.MatchString(msg) {
					o.Set("message", "@@YAML@@")
				}
			}
			for _, k := range o.Keys {
				walk(o.Values[k])
			}
		case []any:
			for _, item := range x.([]any) {
				walk(item)
			}
		}
	}
	walk(v)
	return Stringify(v)
}

func errorsJSON(errs []ValidationError) []any {
	out := make([]any, len(errs))
	for i, e := range errs {
		o := NewObject("code", e.Code, "filePath", e.FilePath, "message", e.Message)
		if e.Path != "" {
			o.Set("path", e.Path)
		}
		out[i] = o
	}
	return out
}

func overridesJSON(list []*Override) []any {
	out := make([]any, len(list))
	for i, o := range list {
		obj := NewObject("targetId", o.TargetID, "disable", o.Disable)
		if o.Replacement != nil {
			obj.Set("replacement", o.Replacement.ToJSON())
		}
		obj.Set("source", NewObject("filePath", o.Source.FilePath, "index", float64(o.Source.Index)))
		out[i] = obj
	}
	return out
}

func expectJSON(t *testing.T, label string, want json.RawMessage, got any) {
	t.Helper()
	w := maskYAML(canon(want))
	g := maskYAML(Stringify(got))
	if w != g {
		t.Errorf("%s\n got: %s\nwant: %s", label, g, w)
	}
}

func TestGoldenYAMLValues(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.YamlValues {
		v, err := parseYAMLDocument(c.Yaml)
		if c.Error {
			if err == nil {
				t.Errorf("%q: want a parse error, got %s", c.Yaml, Stringify(v))
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", c.Yaml, err)
			continue
		}
		if got := Stringify(v); got != c.Value {
			t.Errorf("%q: got %s want %s", c.Yaml, got, c.Value)
		}
	}
}

func TestGoldenSchema(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Schema {
		content := c.Yaml
		if c.Oversized {
			content = "hooks: []\n# " + strings.Repeat("x", 1024*1024)
		}
		parsed := LoadHooksFile(c.FilePath, func(string) (string, error) { return content, nil })
		expectJSON(t, c.Name+" hooks", c.Hooks, mapToJSON(parsed.Hooks))
		expectJSON(t, c.Name+" overrides", c.Overrides, overridesJSON(parsed.Overrides))
		expectJSON(t, c.Name+" errors", c.Errors, errorsJSON(parsed.Errors))
	}
	failed := LoadHooksFile("/tmp/unreadable.yaml", func(string) (string, error) {
		return "", nodeErr{"EACCES: permission denied, open '/tmp/unreadable.yaml'"}
	})
	expectJSON(t, "read failure", g.ReadFailure.Errors, errorsJSON(failed.Errors))
}

func TestGoldenOverrides(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Overrides {
		b := ParseHooksFile("/tmp/base.yaml", c.Base)
		o := ParseHooksFile("/tmp/override.yaml", c.Override)
		merged := NewHookMap()
		mergeHookMapsInto(merged, b.Hooks)
		mergeHookMapsInto(merged, o.Hooks)
		hooks, errs := ResolveOverrides(merged, o.Overrides)
		expectJSON(t, c.Name+" hooks", c.Hooks, mapToJSON(hooks))
		expectJSON(t, c.Name+" errors", c.Errors, errorsJSON(errs))
	}
}

func resolutionJSON(r *ProjectResolution) any {
	if r == nil {
		return nil
	}
	o := NewObject("cwd", r.Cwd, "anchorDir", r.AnchorDir, "canonicalCwd", r.CanonicalCwd, "canonicalAnchorDir", r.CanonicalAnchorDir)
	if r.WorktreeRoot != "" {
		o.Set("worktreeRoot", r.WorktreeRoot)
	}
	if r.DiscoveredProjectRoot != "" {
		o.Set("discoveredProjectRoot", r.DiscoveredProjectRoot)
	}
	o.Set("trustFilePath", r.TrustFilePath)
	if r.ProjectConfigPath != "" {
		o.Set("projectConfigPath", r.ProjectConfigPath)
	}
	o.Set("trusted", r.Trusted)
	return o
}

func sourcesJSON(list []SourceSummary) []any {
	out := []any{}
	for _, s := range list {
		out = append(out, NewObject("scope", s.Scope, "filePath", s.FilePath, "hookCount", float64(s.HookCount)))
	}
	return out
}

type consoleLog struct {
	mu      sync.Mutex
	records []any
}

func (c *consoleLog) sink(level, text string) {
	c.mu.Lock()
	c.records = append(c.records, NewObject("op", "console", "level", level, "text", text))
	c.mu.Unlock()
}

func TestGoldenDiscovery(t *testing.T) {
	g := loadGolden(t)
	root := newRoot(t)
	resetWarnings()
	paths := Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}
	for _, c := range g.Discoveries {
		ResetCaches()
		applyFs(t, root, c.Fs)
		restore := withEnv(t, c.Env)
		log := &consoleLog{}
		restoreConsole := SetConsole(log.sink)
		project := ""
		if c.Project != "" {
			project = filepath.Join(root, c.Project)
		}
		loaded := LoadDiscoveredHooks(LoadOptions{Paths: paths, ProjectDir: project, IgnoreTrust: c.IgnoreTrust})
		var resolution *ProjectResolution
		if project != "" {
			resolution = resolveProjectHookResolution(paths, project)
		}
		restoreConsole()
		restore()
		got := NewObject(
			"hooks", mapToJSON(loaded.Hooks),
			"errors", errorsJSON(loaded.Errors),
			"advisories", stringsToAny(loaded.Advisories),
			"sources", sourcesJSON(loaded.Sources),
			"files", stringsToAny(loaded.Files),
			"signature", loaded.Signature,
			"resolution", resolutionJSON(resolution),
		)
		gotText := maskYAML(placeholders(Stringify(got), root))
		if want := maskYAML(canon(c.Result)); gotText != want {
			t.Errorf("discovery %q\n got: %s\nwant: %s", c.Name, gotText, want)
		}
		consoleText := placeholders(Stringify(append([]any{}, log.records...)), root)
		if want := canon(c.Console); consoleText != want && !(want == "[]" && consoleText == "[]") {
			t.Errorf("discovery %q console\n got: %s\nwant: %s", c.Name, consoleText, want)
		}
	}
}

func TestGoldenPathFilter(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Extnames {
		if got := HasCodeExtension(c.Path); got != c.Code {
			t.Errorf("hasCodeExtension(%q) = %v, want %v", c.Path, got, c.Code)
		}
	}
	for _, c := range g.Normalize {
		if got := NormalizeConditionPath(c.ProjectDir, c.File); got != c.Out {
			t.Errorf("normalizeConditionPath(%q, %q) = %q, want %q", c.ProjectDir, c.File, got, c.Out)
		}
	}
	nocase := g.Constants.Nocase
	failures := 0
	for _, c := range g.Globs {
		var path, pattern string
		var want bool
		_ = json.Unmarshal(c[0], &path)
		_ = json.Unmarshal(c[1], &pattern)
		_ = json.Unmarshal(c[2], &want)
		if got := matchGlob(path, pattern, nocase); got != want {
			failures++
			if failures < 40 {
				t.Errorf("matchesGlob(%q, %q) = %v, want %v", path, pattern, got, want)
			}
		}
	}
	if failures > 0 {
		t.Errorf("%d glob mismatches", failures)
	}
	for i, c := range g.Conditions {
		var conds []Condition
		for _, raw := range c.Conditions {
			switch x := raw.(type) {
			case string:
				conds = append(conds, Condition{Legacy: x})
			case map[string]any:
				for k, v := range x {
					var patterns []string
					for _, p := range v.([]any) {
						patterns = append(patterns, p.(string))
					}
					conds = append(conds, Condition{Key: k, Patterns: patterns})
				}
			}
		}
		ctx := BuildPathMatchContext("/repo/project", c.Files, c.Changes)
		expectJSON(t, fmt.Sprintf("condition %d context", i), c.Context, NewObject("changedPaths", stringsToAny(ctx.ChangedPaths), "hasCodeFiles", ctx.HasCodeFiles))
		failure := evaluatePathConditions(conds, ctx, nocase)
		var got any
		if failure != nil {
			o := NewObject("reason", failure.Reason)
			if failure.Patterns != nil {
				o.Set("patterns", stringsToAny(failure.Patterns))
			}
			got = o
		}
		expectJSON(t, fmt.Sprintf("condition %d failure", i), c.Failure, got)
	}
}

func TestGoldenRedaction(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Redactions {
		if got := RedactSensitiveContent(c.Input); got != c.Out {
			t.Errorf("redact(%q) = %q, want %q", c.Input, got, c.Out)
		}
	}
	for i, c := range g.Sanitize {
		input, err := DecodeJSON(c.Input)
		if err != nil {
			t.Fatal(err)
		}
		expectJSON(t, fmt.Sprintf("sanitize %d", i), c.Out, SanitizeToolArgs(input.(*Object)))
	}
	if SanitizeToolArgs(nil) != nil {
		t.Error("sanitize(nil) must stay nil")
	}
}

func contextFromJSON(t *testing.T, raw json.RawMessage) BashContext {
	t.Helper()
	v, err := DecodeJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	o := v.(*Object)
	c := BashContext{}
	c.SessionID, _ = o.Get("session_id").(string)
	c.Event, _ = o.Get("event").(string)
	c.Cwd, _ = o.Get("cwd").(string)
	if s, ok := o.Get("prompt").(string); ok {
		c.Prompt = &s
	}
	if list, ok := o.Get("files").([]any); ok {
		c.HasFiles = true
		c.Files = []string{}
		for _, f := range list {
			c.Files = append(c.Files, f.(string))
		}
	}
	if list, ok := o.Get("changes").([]any); ok {
		c.HasChange = true
		for _, raw := range list {
			ch := raw.(*Object)
			fc := FileChange{}
			fc.Operation, _ = ch.Get("operation").(string)
			fc.Path, _ = ch.Get("path").(string)
			fc.FromPath, _ = ch.Get("fromPath").(string)
			fc.ToPath, _ = ch.Get("toPath").(string)
			c.Changes = append(c.Changes, fc)
		}
	}
	if s, ok := o.Get("tool_name").(string); ok {
		c.ToolName = &s
	}
	if a, ok := o.Get("tool_args").(*Object); ok {
		c.ToolArgs = a
	}
	return c
}

func TestGoldenExecutorHelpers(t *testing.T) {
	g := loadGolden(t)
	for i, c := range g.Stdin {
		env := map[string]string{}
		if c.MaxBytes != nil {
			env["PI_YAML_HOOKS_MAX_STDIN_BYTES"] = *c.MaxBytes
		}
		restore := withEnv(t, env)
		payload, truncated := SerializeContextForStdin(contextFromJSON(t, c.Context))
		restore()
		if payload != c.Out.Payload || truncated != c.Out.Truncated {
			t.Errorf("stdin %d: got %v %s\nwant %v %s", i, truncated, payload, c.Out.Truncated, c.Out.Payload)
		}
	}
	data := make([]byte, len(g.Trims.Bytes))
	for i, b := range g.Trims.Bytes {
		data[i] = byte(b)
	}
	for _, c := range g.Trims.Cases {
		if got := TrimToUTF8Boundary(data, c.Max); got != c.Out {
			t.Errorf("trim(%d) = %d, want %d", c.Max, got, c.Out)
		}
	}
	corrupt := make([]byte, len(g.Trims.Corrupt.Bytes))
	for i, b := range g.Trims.Corrupt.Bytes {
		corrupt[i] = byte(b)
	}
	for i, want := range g.Trims.Corrupt.Outs {
		if got := TrimToUTF8Boundary(corrupt, i+1); got != want {
			t.Errorf("corrupt trim(%d) = %d, want %d", i+1, got, want)
		}
	}
	for i, c := range g.Env {
		var inherited, context []EnvPair
		for _, p := range c.Inherited {
			inherited = append(inherited, EnvPair{p[0], p[1]})
		}
		for _, p := range c.Context {
			context = append(context, EnvPair{p[0], p[1]})
		}
		got := BuildBashEnvironment(inherited, context)
		var pairs [][2]string
		for _, p := range got {
			pairs = append(pairs, [2]string{p.Key, p.Value})
		}
		if fmt.Sprint(pairs) != fmt.Sprint(c.Out) {
			t.Errorf("env %d: got %v want %v", i, pairs, c.Out)
		}
	}
	for _, c := range g.MapResults {
		r := MapProcessResult(BashResult{ExitCode: c.ExitCode, TimedOut: c.TimedOut}, c.Event)
		if r.Status != c.Status || r.Blocking != c.Blocking {
			t.Errorf("map %+v: got %s %v", c, r.Status, r.Blocking)
		}
	}
}

func TestGoldenBash(t *testing.T) {
	g := loadGolden(t)
	root := newRoot(t)
	applyFs(t, root, []fsOp{{Op: "mkdir", Path: "b1"}})
	ResetCaches()
	for _, c := range g.Bash {
		applyFs(t, root, c.Fs)
		project := c.Project
		if !strings.HasPrefix(project, "/") {
			project = filepath.Join(root, c.Project)
		}
		ctx := BashContext{SessionID: "sess-1", Event: c.Event, Cwd: project}
		if len(c.Context) > 0 {
			extra := contextFromJSON(t, c.Context)
			ctx.Prompt, ctx.Files, ctx.HasFiles = extra.Prompt, extra.Files, extra.HasFiles
			ctx.Changes, ctx.HasChange, ctx.ToolName, ctx.ToolArgs = extra.Changes, extra.HasChange, extra.ToolName, extra.ToolArgs
		}
		restore := withEnv(t, c.Env)
		r, err := ExecuteBashHook(BashRequest{Command: c.Command, Timeout: c.Timeout, ProjectDir: project, Context: ctx})
		restore()
		if err != nil {
			t.Fatal(err)
		}
		var signal any
		if r.Signal != "" {
			signal = r.Signal
		}
		got := NewObject("stdout", r.Stdout, "stderr", r.Stderr, "exitCode", float64(r.ExitCode), "signal", signal,
			"timedOut", r.TimedOut, "outputTruncated", r.OutputTruncated, "stdinTruncated", r.StdinTruncated,
			"status", r.Status, "blocking", r.Blocking)
		if gotText, want := placeholders(Stringify(got), root), canon(c.Result); gotText != want {
			t.Errorf("bash %q\n got: %s\nwant: %s", c.Name, gotText, want)
		}
	}
}

func TestGoldenSessionState(t *testing.T) {
	g := loadGolden(t)
	now := int64(1_000_000)
	store := NewSessionState(func() time.Time { return time.UnixMilli(now) })
	var out []any
	consume := func(id string) any {
		session, args, ok := store.ConsumePendingToolCall(id)
		if !ok {
			return nil
		}
		return NewObject("sessionID", session, "toolArgs", args)
	}
	store.SetPendingToolCall("c1", "s1", NewObject("command", "npm test"))
	out = append(out, []any{"count", float64(store.PendingToolCallCount())})
	out = append(out, []any{"consume", consume("c1")})
	out = append(out, []any{"consume again", consume("c1")})
	store.SetPendingToolCall("c2", "s1", NewObject("a", 1.0))
	now += 4 * 60_000
	store.SetPendingToolCall("c3", "s2", NewObject("b", 2.0))
	now += 2 * 60_000
	store.SetPendingToolCall("c4", "s1", NewObject())
	out = append(out, []any{"after ttl", float64(store.PendingToolCallCount()), consume("c2"), consume("c3")})
	store.SetPendingToolCall("c5", "s9", NewObject())
	store.DeleteSession("s9")
	out = append(out, []any{"deleted pending", consume("c5"), store.IsDeleted("s9"), store.IsDeleted("s1")})
	changes := []FileChange{{Operation: "modify", Path: "src/index.ts"}, {Operation: "rename", FromPath: "a", ToPath: "b"}, {Operation: "modify", Path: "src/index.ts"}}
	store.AddFileChanges("s1", changes)
	out = append(out, []any{"changes", changesToAny(store.GetFileChanges("s1")), stringsToAny(store.GetModifiedPaths("s1"))})
	store.BeginIdleDispatch("s1", store.GetFileChanges("s1"))
	store.AddFileChanges("s1", []FileChange{{Operation: "modify", Path: "src/late.ts"}, {Operation: "rename", FromPath: "a", ToPath: "b"}})
	store.ConsumeFileChanges("s1", []FileChange{{Operation: "modify", Path: "src/index.ts"}, {Operation: "rename", FromPath: "a", ToPath: "b"}})
	out = append(out, []any{"after idle", changesToAny(store.GetFileChanges("s1")), stringsToAny(store.GetModifiedPaths("s1")), changesToAny(store.GetFileChanges("none"))})
	store.DeleteSession("s1")
	store.RememberSession("s1", nil)
	out = append(out, []any{"remembered", store.IsDeleted("s1")})
	expectJSON(t, "session store", g.Session.Store, out)

	scope := NewSessionState(nil)
	root := "root"
	none := ""
	scope.RememberSession("child", &root)
	scope.RememberSession("root", &none)
	parents := map[string]string{"grandchild": "child", "loop-a": "loop-b", "loop-b": "loop-a"}
	resolve := func(id string) string { return parents[id] }
	var scopes []any
	for _, c := range [][2]string{{"root", "all"}, {"root", "main"}, {"root", "child"}, {"child", "main"}, {"child", "child"}, {"grandchild", "child"}, {"loop-a", "main"}} {
		scopes = append(scopes, []any{c[0], c[1], scope.EvaluateScope(c[0], c[1], resolve)})
	}
	scopes = append(scopes, []any{"root of grandchild", scope.GetRootSessionID("grandchild", func(string) string { return "" })})
	expectJSON(t, "scope", g.Session.Scope, scopes)
}

func TestGoldenLineage(t *testing.T) {
	g := loadGolden(t)
	root := newRoot(t)
	applyFs(t, root, g.Lineage.Fs)
	ResetCaches()
	for i, c := range g.Lineage.Cases {
		var header *SessionHeader
		if string(c.Header) != "null" {
			var h struct {
				ID            string `json:"id"`
				ParentSession string `json:"parentSession"`
			}
			if err := json.Unmarshal([]byte(strings.ReplaceAll(string(c.Header), "@@ROOT@@", root)), &h); err != nil {
				t.Fatal(err)
			}
			header = &SessionHeader{ID: h.ID, ParentSession: h.ParentSession}
		}
		if got := GetRootSessionID(c.Current, header); got != c.Out {
			t.Errorf("lineage %d: got %q want %q", i, got, c.Out)
		}
	}
}

func TestGoldenRenders(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: map[string]int{"accent": 36, "success": 32, "warning": 33, "error": 31, "muted": 90, "dim": 2, "text": 39}}
	for i, c := range g.Renders {
		details, _ := c.Message["details"].(map[string]any)
		got := RenderDiagnostics(theme, DiagnosticsContent(c.Message["content"]), details, c.Expanded, c.Width)
		if strings.Join(got, "\n") != strings.Join(c.Lines, "\n") || len(got) != len(c.Lines) {
			t.Errorf("render %d (width %d, expanded %v):\n got: %q\nwant: %q", i, c.Width, c.Expanded, got, c.Lines)
		}
	}
}

// sortedCalls sorts recorded async bash calls by command, as the generator does.
func sortedCalls(list []any) []any {
	out := append([]any{}, list...)
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].(*Object).Get("command").(string) < out[j].(*Object).Get("command").(string)
	})
	return out
}
