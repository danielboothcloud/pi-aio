package subagents

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
)

// ---- golden loading ----

var goldenCache *Object

func golden(t *testing.T) *Object {
	t.Helper()
	if goldenCache != nil {
		return goldenCache
	}
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	value, err := Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	goldenCache = value.(*Object)
	return goldenCache
}

// plain is the order-free form of a value, for comparisons.
func plain(t *testing.T, v any) any {
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

// withRoot replaces @@ROOT@@ (and @@AIO@@ when aio is set) in every string.
func withRoot(t *testing.T, v any, root string) any {
	t.Helper()
	data, _ := json.Marshal(v)
	text := strings.ReplaceAll(string(data), "@@ROOT@@", root)
	out, err := Decode([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// placeholders writes root as @@ROOT@@ into the plain form of v.
func placeholders(t *testing.T, v any, root string) any {
	t.Helper()
	data, _ := json.Marshal(v)
	text := strings.ReplaceAll(string(data), root, "@@ROOT@@")
	var out any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func same(t *testing.T, label string, got, want any) {
	t.Helper()
	g, w := plain(t, got), plain(t, want)
	if !reflect.DeepEqual(g, w) {
		gj, _ := json.MarshalIndent(g, "", " ")
		wj, _ := json.MarshalIndent(w, "", " ")
		t.Errorf("%s:\n got %s\nwant %s", label, gj, wj)
	}
}

func list(v any) []any  { l, _ := v.([]any); return l }
func obj(v any) *Object { o, _ := v.(*Object); return o }
func strs(v any) []string {
	var out []string
	for _, item := range list(v) {
		out = append(out, item.(string))
	}
	return out
}

func fixtureRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := golden(t)
	for _, f := range list(g.Get("fixtureFiles")) {
		file := obj(f)
		path := filepath.Join(root, str(file, "path"))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(str(file, "content")), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The project directory ends the upward walk (mkdirSync in the generator).
	if err := os.MkdirAll(filepath.Join(root, "project", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func theme(t *testing.T) chrome.Theme {
	data, err := os.ReadFile(filepath.Join("..", "chrome", "testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		RoleCodes map[string]int `json:"roleCodes"`
	}
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return chrome.GoldenTheme{Codes: g.RoleCodes}
}

// ---- agents ----

func TestBuiltinAgentsMatchTypeScriptFiles(t *testing.T) {
	g := golden(t)
	files := BuiltinAgentFiles()
	want := obj(g.Get("builtinFiles"))
	if len(files) != len(want.Keys) {
		t.Fatalf("embedded %d agents, TypeScript has %d", len(files), len(want.Keys))
	}
	for _, name := range want.Keys {
		repo, err := os.ReadFile(filepath.Join("..", "..", "..", "subagents", "agents", name))
		if err != nil {
			t.Fatal(err)
		}
		if files[name] != want.Get(name) || files[name] != string(repo) {
			t.Errorf("embedded %s differs from subagents/agents/%s: copy it again", name, name)
		}
	}
}

func TestDiscoveryMatchesTypeScript(t *testing.T) {
	g := golden(t)
	root := fixtureRoot(t)
	agentDir := filepath.Join(root, "agent")
	for _, raw := range list(g.Get("discovery")) {
		c := obj(raw)
		cwd := strings.ReplaceAll(str(c, "cwd"), "@@ROOT@@", root)
		agents, err := DiscoverAgents(cwd, agentDir, c.Get("includeProject") == true)
		if err != nil {
			t.Fatal(err)
		}
		same(t, "discover "+str(c, "cwd"), placeholders(t, agents, root), c.Get("agents"))
	}
	for _, raw := range list(g.Get("invalid")) {
		c := obj(raw)
		_, err := DiscoverAgents(filepath.Join(root, "bad-"+str(c, "name")), agentDir, true)
		got := ""
		if err != nil {
			got = strings.ReplaceAll(err.Error(), root, "@@ROOT@@")
		}
		if got != str(c, "error") {
			t.Errorf("invalid %s:\n got %q\nwant %q", str(c, "name"), got, str(c, "error"))
		}
	}
	if _, err := FindAgent(nil, "ghost"); err == nil || err.Error() != str(g, "findError") {
		t.Errorf("findAgent empty: %v", err)
	}
	agents, _ := DiscoverAgents(filepath.Join(root, "project"), agentDir, true)
	if _, err := FindAgent(agents, "ghost"); err == nil || err.Error() != str(g, "findError2") {
		t.Errorf("findAgent: %v", err)
	}
}

// ---- extension launch ----

func TestExtensionLaunchMatchesTypeScript(t *testing.T) {
	g := golden(t)
	root := fixtureRoot(t)
	const aio = "/aio-test/go/aio"
	cursor := filepath.Join(root, "cursor", "index.ts")
	for _, raw := range list(g.Get("launchCases")) {
		c := obj(raw)
		var args []string
		for _, arg := range strs(c.Get("args")) {
			args = append(args, strings.ReplaceAll(arg, "@@AIO@@", aio))
		}
		extra := strings.ReplaceAll(str(c, "extra"), "@@ROOT@@", root)
		launch := ResolveChildExtensionLaunch(args, filepath.Join(root, "project"), str(c, "provider"),
			ExtensionEnv{AioPath: aio, Extra: extra, CursorExtension: cursor})
		var supports []bool
		for _, model := range []string{"cursor/fast", "anthropic/x", ""} {
			supports = append(supports, ChildSupportsModel(launch, model, cursor))
		}
		got := placeholders(t, map[string]any{"launch": launch, "supports": supports}, root)
		gotJSON, _ := json.Marshal(got)
		got = plainString(t, strings.ReplaceAll(string(gotJSON), aio, "@@AIO@@"))
		same(t, fmt.Sprintf("launch %q", args), got, map[string]any{"launch": c.Get("launch"), "supports": c.Get("supports")})
	}
	for _, raw := range list(g.Get("enforced")) {
		c := obj(raw)
		in := obj(c.Get("launch"))
		var paths []string
		for _, p := range strs(in.Get("paths")) {
			paths = append(paths, strings.ReplaceAll(p, "@@AIO@@", aio))
		}
		got := EnforceChildExtensions(ExtensionLaunch{NoExtensions: in.Get("noExtensions") == true, Paths: paths}, aio)
		data, _ := json.Marshal(got)
		same(t, "enforce", plainString(t, strings.ReplaceAll(string(data), aio, "@@AIO@@")), c.Get("result"))
	}
}

func plainString(t *testing.T, text string) any {
	var out any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// ---- activity ----

func TestActivityMatchesTypeScript(t *testing.T) {
	g := golden(t)
	for _, raw := range list(g.Get("durations")) {
		c := obj(raw)
		if got := FormatDuration(c.Get("ms").(float64)); got != str(c, "out") {
			t.Errorf("formatDuration(%v) = %q, want %q", c.Get("ms"), got, str(c, "out"))
		}
	}
	for _, raw := range list(g.Get("summaries")) {
		c := obj(raw)
		if got := SummarizeToolArgs(str(c, "name"), c.Get("args")); got != str(c, "out") {
			t.Errorf("summarize %s %v = %q, want %q", str(c, "name"), plain(t, c.Get("args")), got, str(c, "out"))
		}
	}
	a := NewActivity(0)
	for i, raw := range list(g.Get("activitySteps")) {
		c := obj(raw)
		significant := a.ApplyEvent(obj(c.Get("event")), c.Get("now").(float64))
		if significant != (c.Get("significant") == true) {
			t.Errorf("step %d significant = %v", i, significant)
		}
		same(t, fmt.Sprintf("activity step %d", i), a, c.Get("activity"))
	}
	for i, raw := range list(g.Get("formats")) {
		c := obj(raw)
		child := childFromSpec(t, obj(c.Get("child")), nil)
		got := FormatChildActivity(child, c.Get("now").(float64))
		same(t, fmt.Sprintf("format %d %v", i, plain(t, c.Get("child"))), map[string]any{"text": got.Text, "stale": got.Stale}, c.Get("out"))
	}
}

// ---- spec decoding ----

func numPtr(o *Object, key string) *float64 { return num(o, key) }

func activityFromSpec(t *testing.T, o *Object) *Activity {
	if o == nil {
		return nil
	}
	a := &Activity{Phase: str(o, "phase"), LastEventAt: o.Get("lastEventAt").(float64), RunningTools: []RunningTool{}}
	if v, ok := o.Get("turns").(float64); ok {
		a.Turns = int(v)
	}
	if v, ok := o.Get("toolCount").(float64); ok {
		a.ToolCount = int(v)
	}
	for _, raw := range list(o.Get("runningTools")) {
		r := obj(raw)
		a.RunningTools = append(a.RunningTools, RunningTool{ID: str(r, "id"), Name: str(r, "name"), Summary: str(r, "summary"), StartedAt: r.Get("startedAt").(float64)})
	}
	if r := obj(o.Get("retry")); r != nil {
		a.Retry = &Retry{Attempt: r.Get("attempt").(float64), MaxAttempts: r.Get("maxAttempts").(float64)}
		if e, ok := r.Get("error").(string); ok {
			a.Retry.Error = sptr(e)
		}
	}
	a.SettledAt = numPtr(o, "settledAt")
	return a
}

func childFromSpec(t *testing.T, o *Object, transcripts map[string]*Transcript) *Child {
	c := &Child{Agent: str(o, "agent"), Task: str(o, "task"), State: str(o, "state"), Model: str(o, "model"),
		Thinking: str(o, "thinking"), Error: str(o, "error"), SessionFile: str(o, "sessionFile"),
		StartedAt: numPtr(o, "startedAt"), EndedAt: numPtr(o, "endedAt"), Activity: activityFromSpec(t, obj(o.Get("activity")))}
	if v, ok := o.Get("index").(float64); ok {
		c.Index = int(v)
	}
	if v, ok := o.Get("output").(string); ok {
		c.Output = sptr(v)
	}
	if v, ok := o.Get("attempts").(float64); ok {
		c.Attempts = iptr(int(v))
	}
	if name, ok := o.Get("transcript").(string); ok {
		c.Transcript = transcripts[name]
	}
	return c
}

func runFromSpec(t *testing.T, o *Object, transcripts map[string]*Transcript) *Run {
	run := &Run{ID: str(o, "id"), State: str(o, "state"), Mode: str(o, "mode"), Context: str(o, "context"), Cwd: str(o, "cwd"),
		StartedAt: o.Get("startedAt").(float64), EndedAt: numPtr(o, "endedAt"), Error: str(o, "error")}
	for _, raw := range list(o.Get("children")) {
		run.Children = append(run.Children, childFromSpec(t, obj(raw), transcripts))
	}
	if r := obj(o.Get("resumedFrom")); r != nil {
		run.ResumedFrom = &ResumedFrom{RunID: str(r, "runId"), Index: int(r.Get("index").(float64))}
	}
	for _, raw := range list(o.Get("results")) {
		r := obj(raw)
		if r == nil {
			run.Results = append(run.Results, nil)
			continue
		}
		res := &Result{Index: int(r.Get("index").(float64)), Agent: str(r, "agent"), Task: str(r, "task"), State: str(r, "state"),
			Output: str(r, "output"), Error: str(r, "error"), Attempts: int(r.Get("attempts").(float64))}
		if v, ok := r.Get("reapedAfterSettle").(bool); ok {
			res.ReapedAfterSettle = bptr(v)
		}
		run.Results = append(run.Results, res)
	}
	return run
}

// ---- transcript ----

func entryView(e *Entry) map[string]any {
	view := map[string]any{"kind": e.Kind, "at": e.At, "rev": e.Rev}
	switch e.Kind {
	case "notice":
		view["text"], view["tone"] = e.Text, e.Tone
	case "prompt", "log":
		view["text"] = e.Text
	case "thinking", "text":
		view["text"], view["streaming"], view["clipped"] = e.Text, e.Streaming, e.Clipped
	case "tool":
		view["id"], view["name"], view["summary"], view["args"], view["output"], view["status"] = e.ID, e.Name, e.Summary, e.Args, e.Output, e.Status
		if e.DurationMs != nil {
			view["durationMs"] = *e.DurationMs
		}
	}
	return view
}

func transcriptView(t *Transcript) map[string]any {
	entries := []any{}
	for _, e := range t.Entries {
		entries = append(entries, entryView(e))
	}
	return map[string]any{"entries": entries, "dropped": t.Dropped, "chars": t.Chars, "turns": t.Turns, "revision": t.Revision}
}

func TestTranscriptMatchesTypeScript(t *testing.T) {
	g := golden(t)
	want := obj(g.Get("transcripts"))
	scripts := obj(g.Get("transcriptScripts"))
	for _, name := range scripts.Keys {
		tr := NewTranscript()
		for i, raw := range list(scripts.Get(name)) {
			tr.ApplyEvent(obj(raw), float64(1000+i*10))
		}
		same(t, "transcript "+name, transcriptView(tr), want.Get(name))
	}
	logs := NewTranscript()
	logs.AppendLog("warn: one\n", 1)
	logs.AppendLog("  \n", 2)
	logs.AppendLog("\x1b[33mwarn: two\x1b[0m\n", 3)
	logs.PushNotice("between", "warning", 4)
	logs.AppendLog(strings.Repeat("l", 5000), 5)
	logs.AppendLog("tail", 6)
	same(t, "transcript logs", transcriptView(logs), want.Get("logs"))

	count := NewTranscript()
	for i := 0; i < 620; i++ {
		count.PushNotice(fmt.Sprintf("notice %d", i), "muted", float64(i))
	}
	big := NewTranscript()
	for i := 0; i < 70; i++ {
		text := fmt.Sprintf("%d", i)
		text += strings.Repeat("b", 4000-len(text))
		big.ApplyEvent(NewObject("type", "message_end", "message", NewObject("role", "assistant", "content", []any{NewObject("type", "text", "text", text)})), float64(i))
	}
	budget := map[string]any{
		"count": map[string]any{"dropped": count.Dropped, "chars": count.Chars, "first": entryView(count.Entries[0]), "last": entryView(count.Entries[len(count.Entries)-1]), "length": len(count.Entries)},
		"chars": map[string]any{"dropped": big.Dropped, "chars": big.Chars, "length": len(big.Entries), "first": big.Entries[0].Text[:8]},
	}
	same(t, "transcript budget", budget, want.Get("budget"))

	for _, raw := range list(g.Get("clips")) {
		c := obj(raw)
		if got := ClipMiddle(str(c, "text"), int(c.Get("max").(float64))); got != str(c, "out") {
			t.Errorf("clipMiddle(%q, %v) = %q, want %q", str(c, "text"), c.Get("max"), got, str(c, "out"))
		}
	}
	for _, raw := range list(g.Get("sanitize")) {
		c := obj(raw)
		if got := SanitizeText(str(c, "text")); got != str(c, "out") {
			t.Errorf("sanitize(%q) = %q, want %q", str(c, "text"), got, str(c, "out"))
		}
	}
}

// ---- history ----

func restoredView(list []Restored) []any {
	out := []any{}
	for _, r := range list {
		var launches any
		if r.Launches != nil {
			items := []any{}
			for _, l := range r.Launches {
				if l == nil {
					items = append(items, nil)
				} else {
					items = append(items, EncodeLaunch(l))
				}
			}
			launches = items
		}
		out = append(out, map[string]any{"run": PublicRun(r.Run), "results": r.Run.Results, "stopRequested": r.Run.StopRequested, "launches": launches})
	}
	return out
}

func TestHistoryMatchesTypeScript(t *testing.T) {
	g := golden(t)
	same(t, "runsFromBranch", restoredView(RunsFromBranch(list(g.Get("historyEntries")))), g.Get("historyResult"))
	var many []any
	for i := 0; i < 55; i++ {
		child := NewObject("index", 0.0, "agent", "agent0", "task", "task 0", "state", "completed")
		run := NewObject("id", fmt.Sprintf("r%d", i), "state", "completed", "mode", "single", "context", "fresh", "cwd", "/work", "startedAt", float64(i), "children", []any{child})
		many = append(many, NewObject("type", "message", "message", NewObject("role", "toolResult", "toolName", "subagent", "details", NewObject("run", run))))
	}
	var ids []string
	for _, r := range RunsFromBranch(many) {
		ids = append(ids, r.Run.ID)
	}
	same(t, "history cap", ids, g.Get("historyCap"))
}

// ---- saved transcripts ----

func TestSavedTranscriptMatchesTypeScript(t *testing.T) {
	g := golden(t)
	now := g.Get("now").(float64)
	dir := t.TempDir()
	inputs := obj(g.Get("savedInputs"))
	files := map[string]string{}
	for _, name := range inputs.Keys {
		files[name] = str(inputs, name)
	}
	lines := []string{`{"type":"session","id":"s"}`}
	for i := 0; i < 400; i++ {
		text := fmt.Sprintf("%d", i)
		text += strings.Repeat("q", 3000-len(text))
		lines = append(lines, `{"message":{"role":"assistant","content":[{"type":"text","text":"`+text+`"}]}}`)
	}
	files["bounded"] = strings.Join(lines, "\n") + "\n"
	want := obj(g.Get("savedResults"))
	for name, content := range files {
		path := filepath.Join(dir, name+".jsonl")
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		tr := LoadSavedTranscript(path, now)
		var got any
		if tr != nil {
			if name == "bounded" {
				got = map[string]any{"length": len(tr.Entries), "dropped": tr.Dropped, "chars": tr.Chars, "last": entryView(tr.Entries[len(tr.Entries)-1]), "first": entryView(tr.Entries[0])}
			} else {
				got = transcriptView(tr)
			}
		}
		same(t, "saved "+name, got, want.Get(name))
	}
	if LoadSavedTranscript(filepath.Join(dir, "missing.jsonl"), now) != nil || LoadSavedTranscript(dir, now) != nil {
		t.Error("missing file or directory must load nothing")
	}
}

// ---- spawn specs ----

func requestFromSpec(o *Object) Request {
	r := Request{Context: str(o, "context"), Model: str(o, "model"), Thinking: str(o, "thinking"), TimeoutMs: num(o, "timeoutMs")}
	if v, ok := o.Get("agent").(string); ok {
		r.Agent = sptr(v)
	}
	if v, ok := o.Get("task").(string); ok {
		r.Task = sptr(v)
	}
	if tasks, ok := o.Get("tasks").([]any); ok {
		r.HasTasks = true
		r.Tasks = []Task{}
		for _, raw := range tasks {
			task := obj(raw)
			r.Tasks = append(r.Tasks, Task{Agent: str(task, "agent"), Task: str(task, "task"), Model: str(task, "model"), Thinking: str(task, "thinking")})
		}
	}
	if v, ok := o.Get("concurrency").(float64); ok {
		r.Concurrency = int(v)
	}
	return r
}

func agentFromSpec(o *Object) AgentConfig {
	a := AgentConfig{Name: str(o, "name"), Description: str(o, "description"), SystemPrompt: str(o, "systemPrompt"),
		SystemPromptMode: str(o, "systemPromptMode"), InheritProjectContext: o.Get("inheritProjectContext") == true,
		InheritSkills: o.Get("inheritSkills") == true, Model: str(o, "model"), Thinking: str(o, "thinking"),
		TimeoutMs: num(o, "timeoutMs"), Source: str(o, "source"), FilePath: str(o, "filePath")}
	if tools, ok := o.Get("tools").([]any); ok {
		for _, tool := range tools {
			a.Tools = append(a.Tools, tool.(string))
		}
	}
	return a
}

func parentFromSpec(o *Object) Parent {
	p := Parent{Cwd: str(o, "cwd"), Model: str(o, "model"), ModelProvider: str(o, "modelProvider"), Thinking: str(o, "thinking"),
		ParentSessionFile: str(o, "parentSessionFile")}
	if ext := obj(o.Get("extensionLaunch")); ext != nil {
		p.ExtensionLaunch = &ExtensionLaunch{NoExtensions: ext.Get("noExtensions") == true, Paths: strs(ext.Get("paths"))}
	}
	return p
}

func TestSpawnSpecsMatchTypeScript(t *testing.T) {
	g := golden(t)
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	const aio = "/aio-test/go/aio"
	deps := &Deps{RunsBaseDir: filepath.Join(root, "runs"), Binary: "pig", Env: []string{"PATH=/bin", "PIG_EXT_SOCKET=s"}, AioPath: aio}
	for i, raw := range list(g.Get("specCases")) {
		c := obj(withRoot(t, raw, root))
		in := SpawnInput{RunID: str(c, "runId"), Index: i % 2, Task: Task{Agent: str(obj(c.Get("task")), "agent"), Task: str(obj(c.Get("task")), "task"),
			Model: str(obj(c.Get("task")), "model"), Thinking: str(obj(c.Get("task")), "thinking")},
			Request: requestFromSpec(obj(c.Get("request"))), Agent: agentFromSpec(obj(c.Get("agent"))), Parent: parentFromSpec(obj(c.Get("parent"))),
			Deps: deps, ResumeSessionFile: str(c, "resumeSessionFile")}
		if v, ok := c.Get("promptOverride").(string); ok && v != "" {
			in.PromptOverride = sptr(v)
		}
		spec, err := BuildSpawnSpec(in)
		name := str(c, "name")
		if want, ok := c.Get("error").(string); ok {
			if err == nil || err.Error() != want {
				t.Errorf("spec %s: error %v, want %q", name, err, want)
			}
			continue
		}
		if err != nil {
			t.Fatalf("spec %s: %v", name, err)
		}
		env := map[string]string{}
		for k, v := range envMap(spec.Env) {
			if strings.HasPrefix(k, "AIO_SUBAGENT_") {
				env[k] = v
			}
		}
		var requested any
		if spec.RequestedSessionFile != "" {
			requested = spec.RequestedSessionFile
		}
		files := map[string]string{}
		for _, file := range []string{"system-prompt.md", "task.md"} {
			if data, err := os.ReadFile(filepath.Join(spec.SessionDir, file)); err == nil {
				files[file] = string(data)
				if info, _ := os.Stat(filepath.Join(spec.SessionDir, file)); info.Mode().Perm() != 0o600 {
					t.Errorf("spec %s: %s mode %v", name, file, info.Mode())
				}
			}
		}
		args := make([]string, len(spec.Args))
		for j, arg := range spec.Args {
			args[j] = strings.ReplaceAll(arg, aio, "@@AIO@@")
		}
		got := map[string]any{"command": spec.Command, "args": args, "cwd": spec.Cwd, "env": env, "sessionDir": spec.SessionDir, "requestedSessionFile": requested}
		wantSpec := obj(list(g.Get("specCases"))[i]).Get("spec")
		same(t, "spec "+name, placeholders(t, got, root), wantSpec)
		same(t, "spec files "+name, placeholders(t, files, root), obj(list(g.Get("specCases"))[i]).Get("files"))
		if strings.Contains(strings.Join(spec.Env, "\n"), "PIG_EXT_SOCKET") {
			t.Errorf("spec %s keeps PiG cell wiring", name)
		}
	}
	for _, raw := range list(g.Get("binaries")) {
		c := obj(raw)
		env := map[string]string{}
		e := obj(c.Get("env"))
		for _, k := range e.Keys {
			env[k] = str(e, k)
		}
		if got := ChildAgentBinary(env); got != str(c, "out") {
			t.Errorf("binary %v = %q, want %q", env, got, str(c, "out"))
		}
	}
	base := envMap(ChildBaseEnv([]string{"PATH=/bin", "PIG_EXT_SOCKET=s", "PIG_HARNESS_ARGV_FILE=f", "PIG_HOME=h", "AI_AGENT=pig"}))
	same(t, "base env", base, g.Get("baseEnv"))
}

// ---- text, widget, inspector ----

func goldenTranscripts(t *testing.T) map[string]*Transcript {
	g := golden(t)
	t0 := g.Get("t0").(float64)
	busy := NewTranscript()
	for i, raw := range list(g.Get("busyEvents")) {
		busy.ApplyEvent(obj(raw), t0+2000+float64(i)*1000)
	}
	busy.AppendLog("warn: a\nwarn: b\nwarn: c\nwarn: d\n", t0+20000)
	busy.PushNotice("attempt 2/2", "warning", t0+21000)
	dropped := NewTranscript()
	for i := 0; i < 505; i++ {
		dropped.PushNotice(fmt.Sprintf("n%d", i), "success", t0)
	}
	return map[string]*Transcript{"busy": busy, "dropped": dropped, "empty": NewTranscript()}
}

func runsFromSpecs(t *testing.T, v any, transcripts map[string]*Transcript) []*Run {
	var runs []*Run
	for _, raw := range list(v) {
		runs = append(runs, runFromSpec(t, obj(raw), transcripts))
	}
	return runs
}

func TestTextAndWidgetMatchTypeScript(t *testing.T) {
	g := golden(t)
	now := g.Get("now").(float64)
	th := theme(t)
	for i, raw := range list(g.Get("resultsRuns")) {
		run := runFromSpec(t, obj(raw), nil)
		if got := FormatRunResult(run); got != list(g.Get("runResults"))[i] {
			t.Errorf("formatRunResult %d:\n got %q\nwant %q", i, got, list(g.Get("runResults"))[i])
		}
	}
	transcripts := goldenTranscripts(t)
	runs := runsFromSpecs(t, g.Get("viewRuns"), transcripts)
	for i, run := range runs {
		if got := FormatRunProgress(run, now); got != list(g.Get("progress"))[i] {
			t.Errorf("progress %d:\n got %q\nwant %q", i, got, list(g.Get("progress"))[i])
		}
	}
	var active []*Run
	for _, run := range runs {
		if run.Active() {
			active = append(active, run)
		}
	}
	for _, raw := range list(g.Get("widgets")) {
		c := obj(raw)
		width, maxRows := int(c.Get("width").(float64)), int(c.Get("maxRows").(float64))
		source := active
		if c.Get("many") == true {
			source = runsFromSpecs(t, c.Get("runs"), transcripts)
		}
		same(t, fmt.Sprintf("widget %d/%d", width, maxRows), WidgetLines(source, width, th, maxRows, now), c.Get("lines"))
	}
	var keys []string
	for _, target := range InspectorTargets(runs) {
		keys = append(keys, target.Key)
	}
	same(t, "targets", keys, g.Get("targets"))
	var describes []string
	for _, run := range runs {
		for _, c := range run.Children {
			describes = append(describes, DescribeChild(c, now))
		}
	}
	same(t, "describes", describes, g.Get("describes"))
	for _, raw := range list(g.Get("transcriptRenders")) {
		c := obj(raw)
		child := childFromSpec(t, obj(c.Get("child")), transcripts)
		lines := RenderTranscriptLines(child, child.Transcript, int(c.Get("width").(float64)), th,
			RenderOptions{ExpandTools: c.Get("expandTools") == true, ShowThinking: c.Get("showThinking") == true, Now: now}, BodyCache{})
		same(t, fmt.Sprintf("render %s %v", str(c, "name"), c.Get("width")), lines, c.Get("lines"))
	}
}

// legacyKeys is matchesKey for the legacy sequences the golden scripts send.
var legacyKeys = map[string]string{
	"escape": "\x1b", "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D", "enter": "\r", "tab": "\t",
	"shift+tab": "\x1b[Z", "pageUp": "\x1b[5~", "pageDown": "\x1b[6~", "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+u": "\x15",
}

func TestInspectorMatchesTypeScript(t *testing.T) {
	g := golden(t)
	now := g.Get("now").(float64)
	th := theme(t)
	for _, raw := range list(g.Get("inspectors")) {
		script := obj(raw)
		transcripts := goldenTranscripts(t)
		var runs []*Run
		switch str(script, "runs") {
		case "all":
			runs = runsFromSpecs(t, g.Get("viewRuns"), transcripts)
		case "single":
			runs = runsFromSpecs(t, g.Get("soloRuns"), transcripts)
		}
		var events []string
		o := InspectorOptions{Theme: th, GetRuns: func() []*Run { return runs }, GetMaxRows: func() int { return int(script.Get("maxRows").(float64)) },
			Done: func() { events = append(events, "done") }, Now: func() float64 { return now },
			Matches: func(data, key string) bool { return legacyKeys[key] == data },
			LoadTranscript: func(file string) *Transcript {
				events = append(events, "load "+file)
				if file == "/runs/s.jsonl" {
					return transcripts["dropped"]
				}
				return nil
			}}
		if script.Get("resume") == true {
			o.ResumeChild = func(target Target) { events = append(events, "resume "+target.Key) }
		}
		if reason, ok := script.Get("unavailable").(string); ok {
			o.ResumeUnavailable = func(Target) string { return reason }
		}
		in := NewInspector(o)
		width := int(script.Get("width").(float64))
		var frames []any
		for _, rawKey := range strs(script.Get("keys")) {
			if rawKey != "" {
				data := rawKey
				if rawKey == "space" {
					data = " "
				} else if seq, ok := legacyKeys[rawKey]; ok {
					data = seq
				}
				in.HandleInput(data)
			}
			var selected any
			if in.SelectedKey != "" {
				selected = in.SelectedKey
			}
			frames = append(frames, map[string]any{"key": rawKey, "view": in.View, "selected": selected, "lines": in.Render(width)})
		}
		same(t, "inspector "+str(script, "name"), frames, script.Get("frames"))
		same(t, "inspector events "+str(script, "name"), append([]string{}, events...), script.Get("events"))
	}
}

// ---- runner scenarios ----

func scenarioView(run *Run) map[string]any {
	children := []any{}
	for _, c := range run.Children {
		entries := []any{}
		if c.Transcript != nil {
			for _, e := range c.Transcript.Entries {
				var text, tone any
				if e.Kind != "tool" {
					text = e.Text
				}
				if e.Kind == "notice" {
					tone = e.Tone
				}
				entries = append(entries, map[string]any{"kind": e.Kind, "text": text, "tone": tone})
			}
		}
		nilIfEmpty := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}
		var output, attempts, reaped any
		if c.Output != nil {
			output = *c.Output
		}
		if c.Attempts != nil {
			attempts = *c.Attempts
		}
		if c.ReapedAfterSettle != nil {
			reaped = *c.ReapedAfterSettle
		}
		children = append(children, map[string]any{"index": c.Index, "agent": c.Agent, "state": c.State, "output": output,
			"error": nilIfEmpty(c.Error), "model": nilIfEmpty(c.Model), "thinking": nilIfEmpty(c.Thinking), "attempts": attempts,
			"sessionFile": nilIfEmpty(c.SessionFile), "reapedAfterSettle": reaped, "transcript": entries})
	}
	results := []any{}
	for _, r := range run.Results {
		if r == nil {
			results = append(results, nil)
			continue
		}
		var errText, model, reaped any
		if r.Error != "" {
			errText = r.Error
		}
		if r.Model != "" {
			model = r.Model
		}
		if r.ReapedAfterSettle != nil {
			reaped = *r.ReapedAfterSettle
		}
		results = append(results, map[string]any{"index": r.Index, "state": r.State, "output": r.Output, "error": errText,
			"exitCode": r.ExitCode, "usage": r.Usage, "attempts": r.Attempts, "model": model, "reapedAfterSettle": reaped})
	}
	var runErr any
	if run.Error != "" {
		runErr = run.Error
	}
	return map[string]any{"state": run.State, "mode": run.Mode, "context": run.Context, "error": runErr,
		"children": children, "results": results, "text": FormatRunResult(run)}
}

func TestRunnerScenariosMatchTypeScript(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed: runner scenarios need the fixture child")
	}
	fixture, _ := filepath.Abs(filepath.Join("..", "..", "..", "subagents", "test-fixture-child.mjs"))
	g := golden(t)
	agent := agentFromSpec(obj(g.Get("scenarioAgent")))
	for _, raw := range list(g.Get("scenarios")) {
		scenario := obj(raw)
		name := str(scenario, "name")
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			root := fixtureRoot(t)
			input := obj(withRoot(t, scenario.Get("input"), root))
			deps := &Deps{Binary: node, ArgsPrefix: []string{fixture}, RunsBaseDir: filepath.Join(root, "scenario-runs"),
				RetryBackoffMs: fptr(0), TerminationGraceMs: fptr(200), SettleExitGraceMs: fptr(300)}
			if d := obj(input.Get("deps")); d != nil {
				deps.Binary = str(d, "piBinary")
				deps.ArgsPrefix = nil
			}
			reg := NewRegistry()
			run, err := reg.Execute(RunInput{Request: requestFromSpec(obj(input.Get("request"))), Agents: []AgentConfig{agent},
				Parent: parentFromSpec(obj(input.Get("parent"))), Deps: deps}, nil)
			gotErr := ""
			if err != nil {
				gotErr = err.Error()
			}
			if gotErr != str(scenario, "error") {
				t.Fatalf("error %q, want %q", gotErr, str(scenario, "error"))
			}
			var got any
			if run != nil {
				reg.Mu.Lock()
				view := scenarioView(run)
				reg.Mu.Unlock()
				data, _ := json.Marshal(view)
				text := strings.ReplaceAll(strings.ReplaceAll(string(data), run.ID, "@@RUN@@"), root, "@@ROOT@@")
				got = plainString(t, text)
			}
			same(t, "scenario "+name, got, scenario.Get("run"))
		})
	}
}
