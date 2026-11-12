package goals

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// golden.json is produced by testdata/gen-golden.ts from the TypeScript
// goals feature, which stays the reference until the Go port replaces it.
type golden struct {
	Constants struct {
		MaxContinuations   int `json:"maxContinuations"`
		MaxRejections      int `json:"maxRejections"`
		TranscriptChars    int `json:"transcriptChars"`
		TranscriptMessages int `json:"transcriptMessages"`
	} `json:"constants"`
	Branch []json.RawMessage `json:"branch"`
	Args   []struct {
		Args    string `json:"args"`
		Command struct {
			Kind string `json:"kind"`
			Text string `json:"text"`
		} `json:"command"`
	} `json:"args"`
	Completions []struct {
		Prefix string   `json:"prefix"`
		Items  []string `json:"items"`
	} `json:"completions"`
	Reviews []struct {
		Text    string   `json:"text"`
		Verdict *Verdict `json:"verdict"`
	} `json:"reviews"`
	OneLines []struct {
		Text string `json:"text"`
		Max  int    `json:"max"`
		Out  string `json:"out"`
	} `json:"oneLines"`
	StatusCases []struct {
		Goal      json.RawMessage `json:"goal"`
		Drafting  bool            `json:"drafting"`
		Reviewing bool            `json:"reviewing"`
		Text      *string         `json:"text"`
	} `json:"statusCases"`
	Describes []struct {
		Goal json.RawMessage `json:"goal"`
		Text string          `json:"text"`
	} `json:"describes"`
	Prompts struct {
		Draft        string `json:"draft"`
		Started      string `json:"started"`
		Continuation []struct {
			Goal json.RawMessage `json:"goal"`
			Text string          `json:"text"`
		} `json:"continuation"`
		ReviewSystem string `json:"reviewSystem"`
		Review       []struct {
			Input struct {
				Goal       json.RawMessage `json:"goal"`
				Summary    string          `json:"summary"`
				Transcript string          `json:"transcript"`
				Workspace  string          `json:"workspace"`
			} `json:"input"`
			Text string `json:"text"`
		} `json:"review"`
	} `json:"prompts"`
	Latest []struct {
		Entries []json.RawMessage `json:"entries"`
		Goal    json.RawMessage   `json:"goal"`
	} `json:"latest"`
	Workspace []struct {
		Replies []execReply `json:"replies"`
		Calls   []any       `json:"calls"`
		Text    string      `json:"text"`
	} `json:"workspace"`
	Scenarios []scenario `json:"scenarios"`
}

type execReply struct {
	Stdout string  `json:"stdout"`
	Code   int     `json:"code"`
	Throw  *string `json:"throw"`
}

type reply struct {
	Text         *string
	Throw        *string
	StopReason   string
	ErrorMessage *string
	ReplyText    string
}

func (r *reply) UnmarshalJSON(data []byte) error {
	var text string
	if json.Unmarshal(data, &text) == nil {
		r.Text = &text
		return nil
	}
	var obj struct {
		Throw        *string `json:"throw"`
		StopReason   string  `json:"stopReason"`
		ErrorMessage *string `json:"errorMessage"`
		Text         string  `json:"text"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	r.Throw, r.StopReason, r.ErrorMessage, r.ReplyText = obj.Throw, obj.StopReason, obj.ErrorMessage, obj.Text
	return nil
}

type step struct {
	Op                string            `json:"op"`
	Args              string            `json:"args"`
	Name              string            `json:"name"`
	Params            map[string]any    `json:"params"`
	Outcome           string            `json:"outcome"`
	Entries           []json.RawMessage `json:"entries"`
	Aborted           bool              `json:"aborted"`
	Value             json.RawMessage   `json:"value"`
	AbortDuringReview bool              `json:"abortDuringReview"`
	DuringReview      *step             `json:"duringReview"`
}

type scenario struct {
	Name    string `json:"name"`
	Options struct {
		HasUI      *bool             `json:"hasUI"`
		Idle       *bool             `json:"idle"`
		Model      *bool             `json:"model"`
		Confirms   []bool            `json:"confirms"`
		Replies    []reply           `json:"replies"`
		Exec       []execReply       `json:"exec"`
		SendThrows *string           `json:"sendThrows"`
		Entries    []json.RawMessage `json:"entries"`
		Branch     []json.RawMessage `json:"branch"`
	} `json:"options"`
	Records []struct {
		Step   json.RawMessage `json:"step"`
		Result json.RawMessage `json:"result"`
		Log    json.RawMessage `json:"log"`
	} `json:"records"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	data, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func decodeGoalJSON(t *testing.T, raw json.RawMessage) *Goal {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return decodeGoal(v)
}

var (
	idPattern   = regexp.MustCompile(`\bg-[0-9a-z]{6,}\b`)
	timePattern = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`)
)

// normalized marshals v, applies the generator's placeholders, and decodes it.
func normalized(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	text := timePattern.ReplaceAllString(idPattern.ReplaceAllString(string(data), "g-@@ID@@"), "@@TIME@@")
	var out any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func decoded(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestGoldenPure(t *testing.T) {
	g := loadGolden(t)
	if g.Constants.MaxContinuations != MaxContinuations || g.Constants.MaxRejections != MaxRejections ||
		g.Constants.TranscriptChars != ReviewTranscriptChars || g.Constants.TranscriptMessages != ReviewTranscriptMessages {
		t.Fatalf("constants drifted: %+v", g.Constants)
	}
	for _, c := range g.Args {
		if got := ParseArgs(c.Args); got.Kind != c.Command.Kind || got.Text != c.Command.Text {
			t.Errorf("ParseArgs(%q) = %+v, want %+v", c.Args, got, c.Command)
		}
	}
	for _, c := range g.Completions {
		var names []string
		for _, sub := range Completions(c.Prefix) {
			names = append(names, sub.Name)
		}
		if strings.Join(names, ",") != strings.Join(c.Items, ",") {
			t.Errorf("Completions(%q) = %v, want %v", c.Prefix, names, c.Items)
		}
	}
	for _, c := range g.Reviews {
		if got := ParseReview(c.Text); !reflect.DeepEqual(got, c.Verdict) {
			t.Errorf("ParseReview(%q) = %+v, want %+v", c.Text, got, c.Verdict)
		}
	}
	for _, c := range g.OneLines {
		if got := OneLine(c.Text, c.Max); got != c.Out {
			t.Errorf("OneLine(%q, %d) = %q, want %q", c.Text, c.Max, got, c.Out)
		}
	}
	for _, c := range g.StatusCases {
		text, tone := StatusText(decodeGoalJSON(t, c.Goal), c.Drafting, c.Reviewing)
		var want string
		if c.Text != nil {
			want = *c.Text
		}
		if text != want {
			t.Errorf("StatusText(%s, %v, %v) = %q, want %q", c.Goal, c.Drafting, c.Reviewing, text, want)
		}
		if goal := decodeGoalJSON(t, c.Goal); (goal != nil && goal.Status == Paused) != (tone == "warning") {
			t.Errorf("StatusText tone %q for %s", tone, c.Goal)
		}
	}
	for _, c := range g.Describes {
		if got := DescribeGoal(*decodeGoalJSON(t, c.Goal)); got != c.Text {
			t.Errorf("DescribeGoal(%s) = %q, want %q", c.Goal, got, c.Text)
		}
	}
	if got := DraftPrompt("make it faster"); got != g.Prompts.Draft {
		t.Errorf("DraftPrompt = %q", got)
	}
	if got := ReviewSystemPrompt; got != g.Prompts.ReviewSystem {
		t.Errorf("ReviewSystemPrompt = %q", got)
	}
	for _, c := range g.Prompts.Continuation {
		if got := ContinuationPrompt(*decodeGoalJSON(t, c.Goal)); got != c.Text {
			t.Errorf("ContinuationPrompt(%s) = %q, want %q", c.Goal, got, c.Text)
		}
	}
	for _, c := range g.Prompts.Review {
		in := c.Input
		if got := ReviewPrompt(*decodeGoalJSON(t, in.Goal), in.Summary, in.Transcript, in.Workspace); got != c.Text {
			t.Errorf("ReviewPrompt = %q, want %q", got, c.Text)
		}
	}
	for _, c := range g.Latest {
		data, _ := json.Marshal(LatestGoal(c.Entries))
		got := decoded(t, data)
		if want := decoded(t, c.Goal); !reflect.DeepEqual(got, want) {
			t.Errorf("LatestGoal(%s) = %v, want %v", c.Entries, got, want)
		}
	}
	for _, c := range g.Workspace {
		queue := append([]execReply{}, c.Replies...)
		var calls []any
		text := WorkspaceSummary(func(command string, args []string) (string, int, error) {
			calls = append(calls, map[string]any{"command": command, "args": args, "timeout": GitTimeoutMs})
			r := execReply{}
			if len(queue) > 0 {
				r, queue = queue[0], queue[1:]
			}
			if r.Throw != nil {
				return "", 0, errors.New(*r.Throw)
			}
			return r.Stdout, r.Code, nil
		})
		if text != c.Text {
			t.Errorf("WorkspaceSummary = %q, want %q", text, c.Text)
		}
		if got, want := normalized(t, calls), normalized(t, c.Calls); !reflect.DeepEqual(got, want) {
			t.Errorf("WorkspaceSummary calls = %v, want %v", got, want)
		}
	}
}

// fakeHost records every host effect as the generator's harness does.
type fakeHost struct {
	t          *testing.T
	m          *Machine
	hasUI      bool
	idle       bool
	model      bool
	confirms   []bool
	replies    []reply
	exec       []execReply
	sendThrows *string
	entries    []json.RawMessage
	branch     []json.RawMessage
	log        []any
	during     func()
	aborted    bool
}

func (h *fakeHost) HasUI() bool { return h.hasUI }
func (h *fakeHost) Notify(message, level string) {
	h.log = append(h.log, map[string]any{"op": "notify", "text": message, "level": level})
}
func (h *fakeHost) SetStatus(text, tone string) {
	var value any
	if text != "" {
		value = "[" + tone + "]" + text
	}
	h.log = append(h.log, map[string]any{"op": "status", "key": StatusKey, "text": value})
}
func (h *fakeHost) Persist(goal *Goal) error {
	data := map[string]any{"goal": goal}
	h.log = append(h.log, map[string]any{"op": "append", "customType": StateEntry, "data": data})
	raw, err := json.Marshal(map[string]any{"type": "custom", "customType": StateEntry, "data": data})
	if err != nil {
		return err
	}
	h.entries = append(h.entries, raw)
	return nil
}
func (h *fakeHost) Send(content string, display bool, details MessageDetails) error {
	h.log = append(h.log, map[string]any{
		"op":      "send",
		"message": map[string]any{"customType": MessageType, "content": content, "display": display, "details": details},
		"options": map[string]any{"triggerTurn": true, "deliverAs": "followUp"},
	})
	if h.sendThrows != nil {
		return errors.New(*h.sendThrows)
	}
	return nil
}
func (h *fakeHost) Confirm(title, body string) bool {
	h.log = append(h.log, map[string]any{"op": "confirm", "title": title, "body": body})
	if len(h.confirms) == 0 {
		return true
	}
	answer := h.confirms[0]
	h.confirms = h.confirms[1:]
	return answer
}
func (h *fakeHost) IsIdle() bool { return h.idle }
func (h *fakeHost) Mode() string { return "tui" }
func (h *fakeHost) SessionID() string {
	return "s"
}
func (h *fakeHost) Emit(event string, payload map[string]any) {
	h.log = append(h.log, map[string]any{"op": "event", "name": event, "payload": payload})
}

// promptIDs is withAgentPrompt's module-level counter: the generator runs
// every scenario in one process, so ids continue across scenarios.
var promptIDs int

func (h *fakeHost) NextPromptID() int {
	promptIDs++
	return promptIDs
}
func (h *fakeHost) Abort() { h.log = append(h.log, map[string]any{"op": "abort"}) }
func (h *fakeHost) Branch() []json.RawMessage {
	return h.branch
}
func (h *fakeHost) HasModel() bool { return h.model }
func (h *fakeHost) Complete(systemPrompt, prompt string) (map[string]any, error) {
	h.log = append(h.log, map[string]any{"op": "complete", "systemPrompt": systemPrompt, "prompt": prompt})
	if h.during != nil {
		action := h.during
		h.during = nil
		action()
	}
	r := reply{}
	approved := "APPROVED"
	r.Text = &approved
	if len(h.replies) > 0 {
		r, h.replies = h.replies[0], h.replies[1:]
	}
	if r.Text != nil {
		return map[string]any{"stopReason": "stop", "content": []any{map[string]any{"type": "text", "text": *r.Text}}}, nil
	}
	if r.Throw != nil {
		return nil, errors.New(*r.Throw)
	}
	response := map[string]any{"stopReason": r.StopReason, "content": []any{}}
	if r.ErrorMessage != nil {
		response["errorMessage"] = *r.ErrorMessage
	}
	if r.ReplyText != "" {
		response["content"] = []any{map[string]any{"type": "text", "text": r.ReplyText}}
	}
	return response, nil
}
func (h *fakeHost) Exec(command string, args []string) (string, int, error) {
	h.log = append(h.log, map[string]any{"op": "exec", "command": command, "args": args, "timeout": GitTimeoutMs})
	r := execReply{}
	if len(h.exec) > 0 {
		r, h.exec = h.exec[0], h.exec[1:]
	}
	if r.Throw != nil {
		return "", 0, errors.New(*r.Throw)
	}
	return r.Stdout, r.Code, nil
}

// run executes one step and returns its result (nil for no result).
func (h *fakeHost) run(s step) any {
	switch s.Op {
	case "start":
		if s.Entries != nil {
			h.entries = append([]json.RawMessage{}, s.Entries...)
		}
		h.m.SessionStart(h, h.entries)
	case "goal":
		_ = h.m.Command(h, s.Args)
	case "tool":
		h.aborted = false
		if s.AbortDuringReview {
			h.during = func() { h.aborted = true }
		}
		if s.DuringReview != nil {
			inner := *s.DuringReview
			h.during = func() {
				saved := h.log
				h.log = nil
				result := h.run(inner)
				innerLog := h.log
				if innerLog == nil {
					innerLog = []any{}
				}
				h.log = append(saved, map[string]any{"op": "during", "step": inner.raw(h.t), "result": result, "log": innerLog})
			}
		}
		defer func() { h.during = nil }()
		str := func(key string) string { v, _ := s.Params[key].(string); return v }
		var text string
		var err error
		switch s.Name {
		case "goal_propose":
			text, err = h.m.Propose(h, str("objective"), str("doneWhen"))
		case "goal_done":
			text, err = h.m.Done(h, str("summary"), func() bool { return h.aborted }, func(update string) {
				h.log = append(h.log, map[string]any{"op": "update", "text": update})
			})
		case "goal_blocked":
			text, err = h.m.Blocked(h, str("reason"))
		}
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return map[string]any{"text": text}
	case "settle":
		entries := []any{}
		for _, raw := range s.Entries {
			var v any
			_ = json.Unmarshal(raw, &v)
			entries = append(entries, v)
		}
		result := h.m.BeforeSettle(h, s.Outcome, entries)
		if !result.Handled {
			return nil
		}
		out := map[string]any{"entries": result.Entries}
		if result.Continue {
			out["continue"] = true
		}
		return out
	case "settled":
		h.m.Settled(h, s.Aborted)
	case "idle":
		_ = json.Unmarshal(s.Value, &h.idle)
	case "sendThrows":
		h.sendThrows = nil
		if len(s.Value) > 0 {
			var v string
			_ = json.Unmarshal(s.Value, &v)
			h.sendThrows = &v
		}
	case "shutdown":
		h.m.Shutdown(h)
	}
	return nil
}

// raw re-encodes a step for the "during" log entry.
func (s step) raw(t *testing.T) any {
	t.Helper()
	out := map[string]any{"op": s.Op}
	if s.Op == "goal" {
		out["args"] = s.Args
	}
	return out
}

func TestGoldenScenarios(t *testing.T) {
	t.Setenv("AIO_SUBAGENT_CHILD", "") // the generator runs as a parent session
	g := loadGolden(t)
	clock := func() time.Time { return time.Date(2025, 5, 6, 7, 8, 9, 0, time.UTC) }
	steps := 0
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			o := sc.Options
			flag := func(p *bool, fallback bool) bool {
				if p == nil {
					return fallback
				}
				return *p
			}
			h := &fakeHost{
				t: t, m: NewMachine(clock),
				hasUI: flag(o.HasUI, true), idle: flag(o.Idle, true), model: flag(o.Model, true),
				confirms: o.Confirms, replies: o.Replies, exec: o.Exec, sendThrows: o.SendThrows,
				entries: o.Entries, branch: o.Branch,
			}
			if h.branch == nil {
				h.branch = g.Branch
			}
			for i, record := range sc.Records {
				var s step
				if err := json.Unmarshal(record.Step, &s); err != nil {
					t.Fatal(err)
				}
				h.log = nil
				result := h.run(s)
				log := h.log
				if log == nil {
					log = []any{}
				}
				if got, want := normalized(t, result), decoded(t, record.Result); !reflect.DeepEqual(got, want) {
					t.Errorf("step %d %s result:\n got %v\nwant %v", i, record.Step, got, want)
				}
				if got, want := normalized(t, log), decoded(t, record.Log); !reflect.DeepEqual(got, want) {
					gotJSON, _ := json.Marshal(got)
					wantJSON, _ := json.Marshal(want)
					t.Errorf("step %d %s log:\n got %s\nwant %s", i, record.Step, gotJSON, wantJSON)
				}
				steps++
			}
		})
	}
	if steps == 0 {
		t.Fatal("no scenario steps")
	}
}

// Digest bounds the review relies on.
func TestReviewDigestUsesReviewBudget(t *testing.T) {
	var branch []json.RawMessage
	for i := 0; i < 80; i++ {
		raw, _ := json.Marshal(map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": "message"}})
		branch = append(branch, raw)
	}
	var prompt string
	out := ReviewGoal(ReviewInput{
		Goal: NewGoal("o", "d", time.Unix(0, 0)), Branch: branch, HasModel: true,
		Complete: func(_, p string) (map[string]any, error) {
			prompt = p
			return map[string]any{"stopReason": "stop", "content": []any{map[string]any{"type": "text", "text": "APPROVED"}}}, nil
		},
		Exec: func(string, []string) (string, int, error) { return "", 0, nil },
	})
	if out.Verdict == nil || !out.Verdict.Approved {
		t.Fatalf("outcome = %+v", out)
	}
	if !strings.Contains(prompt, "…[20 messages trimmed]") || strings.Count(prompt, "USER: message") != ReviewTranscriptMessages {
		t.Fatalf("review digest did not keep %d messages:\n%s", ReviewTranscriptMessages, prompt)
	}
}

type taggedTheme struct{}

func (taggedTheme) Fg(role, text string) string { return "<" + role + ">" + text + "</>" }
func (taggedTheme) Bold(text string) string     { return "*" + text + "*" }
func (taggedTheme) Bg(_, text string) string    { return text }

// The draft card matches the real goals/index.ts message renderer.
func TestDraftCardMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		DraftCards []struct {
			Text  string   `json:"text"`
			Width int      `json:"width"`
			Rows  []string `json:"rows"`
		} `json:"draftCards"`
		OtherKind any `json:"otherKind"`
	}
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.DraftCards) == 0 || g.OtherKind != nil {
		t.Fatalf("draft cards: %d, other kind %v", len(g.DraftCards), g.OtherKind)
	}
	for _, c := range g.DraftCards {
		if got := DraftCard(taggedTheme{}, c.Text, c.Width); !reflect.DeepEqual(got, c.Rows) {
			t.Errorf("%q at %d:\n go %q\n ts %q", c.Text, c.Width, got, c.Rows)
		}
	}
}
