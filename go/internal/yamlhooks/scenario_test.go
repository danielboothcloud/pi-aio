package yamlhooks

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// recorder collects ordered records for one scenario.
type recorder struct {
	mu      sync.Mutex
	records []any
}

func (r *recorder) add(v any) {
	r.mu.Lock()
	r.records = append(r.records, v)
	r.mu.Unlock()
}

func (r *recorder) console(level, text string) {
	r.add(NewObject("op", "console", "level", level, "text", text))
}

// mockBash is the generator's bashMock: it records the request with its
// stdin payload and answers from the scripted responses.
func mockBash(responses map[string]bashResponse, log, asyncLog *recorder, asyncCommands map[string]bool) ExecuteBashFunc {
	return func(req BashRequest) (BashResult, error) {
		stdin, _ := SerializeContextForStdin(req.Context)
		entry := NewObject("op", "bash", "command", req.Command, "timeout", req.Timeout, "projectDir", req.ProjectDir, "stdin", stdin)
		if asyncCommands[req.Command] {
			asyncLog.add(entry)
		} else {
			log.add(entry)
		}
		resp := responses[req.Command]
		if resp.Throw != "" {
			return BashResult{}, errors.New(resp.Throw)
		}
		return MapProcessResult(BashResult{
			Command: req.Command, Stdout: resp.Stdout, Stderr: resp.Stderr, DurationMs: 1,
			ExitCode: resp.ExitCode, OutputTruncated: resp.OutputTruncated, StdinTruncated: resp.StdinTruncated,
		}, req.Context.Event), nil
	}
}

type mockAdapter struct {
	log      *recorder
	roots    map[string]string
	current  string
	confirms []bool
	mu       sync.Mutex
}

func (m *mockAdapter) Abort(id string) { m.log.add(NewObject("op", "abort", "session", id)) }
func (m *mockAdapter) RootSessionID(id string) string {
	return m.roots[id]
}

func (m *mockAdapter) SendPrompt(id, text string) (Delivery, error) {
	m.log.add(NewObject("op", "sendPrompt", "session", id, "text", text))
	if id == m.current {
		return Delivery{Status: "accepted"}, nil
	}
	return Delivery{Status: "degraded", Reason: "current_session_only", Details: NewObject("requestedSessionId", id)}, nil
}

func (m *mockAdapter) Notify(text, level string) (Delivery, error) {
	m.log.add(NewObject("op", "notify", "text", text, "level", level))
	return Delivery{Status: "accepted"}, nil
}

func (m *mockAdapter) Confirm(title *string, message string, timeout *float64) bool {
	o := NewObject("op", "confirm")
	if title != nil {
		o.Set("title", *title)
	}
	o.Set("message", message)
	if timeout != nil {
		o.Set("timeout", *timeout)
	}
	m.log.add(o)
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.confirms) == 0 {
		return false
	}
	answer := m.confirms[0]
	m.confirms = m.confirms[1:]
	return answer
}

func (m *mockAdapter) SetStatus(hookID, text string) (Delivery, error) {
	m.log.add(NewObject("op", "setStatus", "hookId", hookID, "text", text))
	return Delivery{Status: "accepted"}, nil
}

var asyncCommandSet = map[string]bool{"upload": true, "upload-2": true, "grouped": true, "async-throw": true, "never": true}

func decodeObject(t *testing.T, raw json.RawMessage) *Object {
	t.Helper()
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	v, err := DecodeJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	o, _ := v.(*Object)
	return o
}

func compareLogs(t *testing.T, name, root string, want []json.RawMessage, got []any) {
	t.Helper()
	w := make([]string, len(want))
	for i, r := range want {
		w[i] = maskYAML(canon(r))
	}
	g := make([]string, len(got))
	for i, r := range got {
		g[i] = maskYAML(placeholders(Stringify(r), root))
	}
	normalizePromptIDs(w)
	normalizePromptIDs(g)
	for i := 0; i < len(w) || i < len(g); i++ {
		var a, b string
		if i < len(g) {
			a = g[i]
		}
		if i < len(w) {
			b = w[i]
		}
		if a != b {
			t.Errorf("%s record %d\n got: %s\nwant: %s", name, i, a, b)
			return
		}
	}
}

// normalizePromptIDs replaces agent-prompt ids (a process-wide counter in
// both languages) with their order of first appearance.
func normalizePromptIDs(records []string) {
	ids := map[float64]int{}
	for i, text := range records {
		v, err := DecodeJSON([]byte(text))
		if err != nil {
			continue
		}
		o, ok := v.(*Object)
		if !ok || o.Get("op") != "emit" {
			continue
		}
		data, ok := o.Get("data").(*Object)
		if !ok {
			continue
		}
		if id, ok := data.Get("id").(float64); ok {
			if _, seen := ids[id]; !seen {
				ids[id] = len(ids) + 1
			}
			data.Set("id", float64(ids[id]))
			records[i] = Stringify(o)
		}
	}
}

func TestGoldenRuntimeScenarios(t *testing.T) {
	g := loadGolden(t)
	root := newRoot(t)
	paths := Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}
	fakeNow := 1_700_000_000_000.0
	for _, s := range g.Runtime {
		ResetCaches()
		applyFs(t, root, []fsOp{{Op: "write", Path: "agent/hook/hooks.yaml", Content: s.Yaml}, {Op: "mkdir", Path: s.Project}})
		restore := withEnv(t, s.Env)
		log, asyncLog := &recorder{}, &recorder{}
		restoreConsole := SetConsole(log.console)
		current := s.CurrentSession
		if current == "" {
			current = "s1"
		}
		adapter := &mockAdapter{log: log, roots: s.Roots, current: current, confirms: append([]bool{}, s.Confirms...)}
		rt := NewRuntime(RuntimeOptions{
			Paths: paths, ProjectDir: filepath.Join(root, s.Project), Host: adapter,
			SynchronousBashBudgetMs: s.BudgetMs, Now: func() float64 { return fakeNow },
			ExecuteBash: mockBash(s.Responses, log, asyncLog, asyncCommandSet),
		})
		record := func(err error, value any) {
			if err != nil {
				log.add(NewObject("op", "error", "message", err.Error()))
				return
			}
			log.add(NewObject("op", "result", "value", value))
		}
		for _, step := range s.Steps {
			switch step.Op {
			case "before":
				record(rt.ToolExecuteBefore(step.Tool, step.Session, step.Call, decodeObject(t, step.Args)), "ok")
			case "after":
				record(rt.ToolExecuteAfter(step.Tool, step.Session, step.Call, decodeObject(t, step.Args)), "ok")
			case "prompt":
				contexts, err := rt.UserPromptSubmit(step.Session, step.Prompt)
				record(err, NewObject("additionalContext", stringsToAny(contexts)))
			case "event":
				props := decodeObject(t, step.Properties)
				var err error
				switch step.Type {
				case "session.created", "session.deleted":
					info, _ := props.Get("info").(*Object)
					id, _ := info.Get("id").(string)
					if step.Type == "session.created" {
						err = rt.SessionCreated(id)
					} else {
						err = rt.SessionDeleted(id)
					}
				case "session.idle":
					id, _ := props.Get("sessionID").(string)
					err = rt.SessionIdle(id)
				default:
					rt.discover()
				}
				record(err, "ok")
			case "flush":
				rt.WaitAsync()
				asyncLog.mu.Lock()
				calls := sortedCalls(asyncLog.records)
				asyncLog.mu.Unlock()
				log.add(NewObject("op", "async", "calls", calls))
			case "advance":
				fakeNow += step.Ms
				record(rt.ToolExecuteBefore("bash", "s1", "late", NewObject()), "ok")
			}
		}
		restoreConsole()
		restore()
		compareLogs(t, "runtime "+s.Name, root, s.Log, log.records)
	}
}

// fakeHost is the generator's fake pi + ctx for one scenario.
type fakeHost struct {
	log           *recorder
	cwd           string
	hasUI         bool
	session       string
	confirms      []bool
	confirmThrows bool
}

func (h *fakeHost) Cwd() string       { return h.cwd }
func (h *fakeHost) HasUI() bool       { return h.hasUI }
func (h *fakeHost) SessionID() string { return h.session }
func (h *fakeHost) SessionHeader() *SessionHeader {
	return &SessionHeader{ID: h.session}
}
func (h *fakeHost) Notify(text, level string) {
	h.log.add(NewObject("op", "notify", "text", text, "level", level))
}
func (h *fakeHost) Confirm(title, message string) (bool, error) {
	h.log.add(NewObject("op", "confirm", "title", title, "message", message))
	if h.confirmThrows {
		return false, errors.New("dialog closed")
	}
	if len(h.confirms) == 0 {
		return false, nil
	}
	answer := h.confirms[0]
	h.confirms = h.confirms[1:]
	return answer, nil
}
func (h *fakeHost) SetStatus(key string, text *string) {
	var v any
	if text != nil {
		v = *text
	}
	h.log.add(NewObject("op", "setStatus", "key", key, "text", v))
}
func (h *fakeHost) SendUserMessage(text, deliverAs string) error {
	h.log.add(NewObject("op", "sendUserMessage", "text", text, "options", NewObject("deliverAs", deliverAs)))
	return nil
}
func (h *fakeHost) SendDiagnostics(content string, details *Object) error {
	h.log.add(NewObject("op", "sendMessage", "message", NewObject(
		"customType", DiagnosticsMessageType, "content", content, "display", true, "details", details), "options", nil))
	return nil
}
func (h *fakeHost) EmitAgentPrompt(data *Object) {
	h.log.add(NewObject("op", "emit", "channel", "aio:notification:agent-prompt", "data", data))
}
func (h *fakeHost) Reload() error {
	h.log.add(NewObject("op", "reload"))
	return nil
}

func TestGoldenFeatureScenarios(t *testing.T) {
	g := loadGolden(t)
	root := newRoot(t)
	paths := Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"}
	for _, s := range g.Scenarios {
		ResetCaches()
		log, asyncLog := &recorder{}, &recorder{}
		restoreConsole := SetConsole(log.console)
		f := New(Options{Paths: paths, ExecuteBash: mockBash(s.Responses, log, asyncLog, map[string]bool{})})
		h := &fakeHost{log: log, cwd: root, hasUI: true, session: "s"}
		var envRestores []func()
		for _, step := range s.Steps {
			log.add(NewObject("op", "step", "step", step.Op))
			switch step.Op {
			case "fs":
				applyFs(t, root, step.Ops)
			case "ctx":
				if step.Cwd != nil {
					h.cwd = filepath.Join(root, *step.Cwd)
				}
				if step.HasUI != nil {
					h.hasUI = *step.HasUI
				}
				if step.Session != nil {
					h.session = *step.Session
				}
				if step.Confirms != nil {
					h.confirms = append([]bool{}, step.Confirms...)
				}
				if step.ConfirmThrows != nil {
					h.confirmThrows = *step.ConfirmThrows
				}
			case "env":
				for k, v := range step.Set {
					if v == nil {
						envRestores = append(envRestores, withEnv(t, map[string]string{k: ""}))
						unsetEnv(k)
					} else {
						envRestores = append(envRestores, withEnv(t, map[string]string{k: *v}))
					}
				}
			case "reset":
				ResetCaches()
			case "session_start":
				f.SessionStart(h, step.Reason)
			case "before_switch", "shutdown":
				f.SessionEnd(h, step.Reason)
			case "tool_call":
				var value any
				if reason, blocked := f.ToolCall(h, step.Tool, step.ID, decodeObject(t, step.Input)); blocked {
					value = NewObject("block", true, "reason", reason)
				}
				log.add(NewObject("op", "result", "value", value))
			case "tool_result":
				f.ToolResult(h, step.Tool, step.ID, decodeObject(t, step.Input))
				log.add(NewObject("op", "result", "value", nil))
			case "before_agent_start":
				var value any
				if next, ok := f.BeforeAgentStart(h, step.MessageType, step.Prompt, step.SystemPrompt); ok {
					value = NewObject("systemPrompt", next)
				}
				log.add(NewObject("op", "result", "value", value))
			case "command":
				if err := f.Command(h, step.Name, step.Args); err != nil {
					log.add(NewObject("op", "error", "message", err.Error()))
				}
			case "flush":
				f.WaitAsync()
			}
		}
		for i := len(envRestores) - 1; i >= 0; i-- {
			envRestores[i]()
		}
		restoreConsole()
		compareLogs(t, "scenario "+s.Name, root, s.Log, log.records)
		trust, _ := readFileString(filepath.Join(root, "agent", "trusted-projects.json"))
		want := ""
		if s.TrustFile != nil {
			want = *s.TrustFile
		}
		if got := strings.ReplaceAll(trust, root, "@@ROOT@@"); got != want {
			t.Errorf("scenario %q trust file\n got: %q\nwant: %q", s.Name, got, want)
		}
	}
}

func unsetEnv(k string) { _ = osUnsetenv(k) }

func readFileString(p string) (string, error) {
	data, err := osReadFile(p)
	return string(data), err
}
