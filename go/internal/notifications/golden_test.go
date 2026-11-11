package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type golden struct {
	Clean []struct {
		Text   string
		Max    int
		Result string
	}
	Normalized []struct {
		Value  any
		Result Settings
	}
	Defaults     Settings
	BackendCases []struct {
		Name, Platform        string
		Env                   map[string]string
		Fails                 []string
		NameBefore, NameAfter string
		Focused               bool
		Calls                 [][]string
		Writes                []string
	} `json:"backendCases"`
	Scenarios map[string][]map[string]any
	Results   map[string]struct {
		Sends   []Notification
		Notices [][2]string
		Saved   []Settings
	}
}

func load(t *testing.T) golden {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestPureMatchesTypeScript(t *testing.T) {
	g := load(t)
	for _, c := range g.Clean {
		if got := CleanText(c.Text, c.Max); got != c.Result {
			t.Errorf("CleanText(%q, %d) = %q, TypeScript %q", c.Text, c.Max, got, c.Result)
		}
	}
	if !reflect.DeepEqual(Defaults(), g.Defaults) {
		t.Errorf("defaults %+v, TypeScript %+v", Defaults(), g.Defaults)
	}
	for _, c := range g.Normalized {
		if got := Normalize(c.Value); !reflect.DeepEqual(got, c.Result) {
			t.Errorf("Normalize(%v) = %+v, TypeScript %+v", c.Value, got, c.Result)
		}
	}
}

func TestBackendMatchesTypeScript(t *testing.T) {
	g := load(t)
	for _, c := range g.BackendCases {
		var calls [][]string
		var writes []string
		run := func(_ context.Context, bin string, args []string) (string, error) {
			calls = append(calls, append([]string{bin}, args...))
			for _, f := range c.Fails {
				if f == bin {
					return "", errors.New("no")
				}
			}
			if bin == "osascript" {
				return "com.mitchellh.ghostty\n", nil
			}
			return "", nil
		}
		b := NewBackend(c.Platform, c.Env, run, func(s string) { writes = append(writes, s) })
		nameBefore := b.Name()
		focused := b.Focused(context.Background())
		for _, sound := range []string{"Glass", "off"} {
			b.Send(context.Background(), Notification{Title: "Pi · T;x", Body: "body\x1b[1m!", Subtitle: "sub", Group: "g", Sound: sound}, func() bool { return true })
		}
		if nameBefore != c.NameBefore || b.Name() != c.NameAfter || focused != c.Focused ||
			!sameList(calls, c.Calls) || !sameList(writes, c.Writes) {
			t.Errorf("%s:\n go %q %q %v %q %q\n ts %q %q %v %q %q", c.Name, nameBefore, b.Name(), focused, calls, writes,
				c.NameBefore, c.NameAfter, c.Focused, c.Calls, c.Writes)
		}
	}
}

// sameList treats nil and empty slices as equal.
func sameList[T any](a, b []T) bool {
	return (len(a) == 0 && len(b) == 0) || reflect.DeepEqual(a, b)
}

func num(v any) float64 { f, _ := v.(float64); return f }

// replay runs one scenario against the engine with synchronous delivery.
func replay(steps []map[string]any) (sends []Notification, notices [][2]string, saved []Settings) {
	e := NewEngine(Defaults())
	focused := false
	mode := "tui"
	deliver := func(d Delivery, ok bool) string {
		if !ok || !e.Valid(d) {
			return "skipped"
		}
		n := e.Notification(d, "My session")
		if e.FocusSkip(d) && focused {
			return "skipped"
		}
		if !e.Valid(d) {
			return "skipped"
		}
		sends = append(sends, n)
		return "dispatched"
	}
	for _, step := range steps {
		switch step["op"] {
		case "start":
			raw, _ := json.Marshal(step["settings"])
			var partial map[string]any
			_ = json.Unmarshal(raw, &partial)
			merged := map[string]any{"categories": map[string]any{}}
			if partial != nil {
				for k, v := range partial {
					merged[k] = v
				}
			}
			cats, _ := merged["categories"].(map[string]any)
			full := map[string]any{"core": true, "goal": true, "background": true, "critical": true}
			for k, v := range cats {
				full[k] = v
			}
			merged["categories"] = full
			settings := Normalize(merged)
			focused = step["focused"] == true
			mode = "tui"
			if m, ok := step["mode"].(string); ok {
				mode = m
			}
			e.SessionStart("s1", mode == "tui", settings)
		case "agentStart":
			e.AgentStart(num(step["t"]))
		case "messageEnd":
			e.MessageEnd(step["stop"].(string), step["text"].(string))
		case "settled":
			deliver(e.Settled(step["aborted"] == true, num(step["t"])))
		case "shutdown":
			e.SessionShutdown()
		case "prompt":
			raw, _ := json.Marshal(step["p"])
			var p Prompt
			_ = json.Unmarshal(raw, &p)
			p.SessionID = "s1"
			if step["otherSession"] == true {
				p.SessionID = "s2"
			}
			if d, ok := e.PromptSignal(p); ok && e.PromptStillOwned(d.Prompt) {
				deliver(d, true)
			}
		case "goal":
			e.GoalActivity("s1", step["active"] == true, step["quietSettle"] == true)
		case "signal":
			raw, _ := json.Marshal(step["s"])
			var s Signal
			_ = json.Unmarshal(raw, &s)
			s.SessionID = "s1"
			if step["otherSession"] == true {
				s.SessionID = "s2"
			}
			deliver(e.NotificationSignal(s))
		case "command":
			out := e.HandleCommand(step["args"].(string), mode, "fake", func(s Settings) error { saved = append(saved, s); return nil })
			for _, n := range out.Notices {
				notices = append(notices, [2]string{n.Text, n.Level})
			}
			if out.Test != nil {
				if n, ok := TestOutcomeNotice(deliver(*out.Test, true), "fake"); ok {
					notices = append(notices, [2]string{n.Text, n.Level})
				}
			}
		}
	}
	return sends, notices, saved
}

func TestScenariosMatchTypeScript(t *testing.T) {
	g := load(t)
	if len(g.Scenarios) < 14 {
		t.Fatalf("scenarios: %d", len(g.Scenarios))
	}
	for name, steps := range g.Scenarios {
		want := g.Results[name]
		sends, notices, saved := replay(steps)
		if len(sends) != len(want.Sends) || (len(sends) > 0 && !reflect.DeepEqual(sends, want.Sends)) {
			t.Errorf("%s sends:\n go %+v\n ts %+v", name, sends, want.Sends)
		}
		if len(notices) != len(want.Notices) || (len(notices) > 0 && !reflect.DeepEqual(notices, want.Notices)) {
			t.Errorf("%s notices:\n go %q\n ts %q", name, notices, want.Notices)
		}
		if len(saved) != len(want.Saved) || (len(saved) > 0 && !reflect.DeepEqual(saved, want.Saved)) {
			t.Errorf("%s saved:\n go %+v\n ts %+v", name, saved, want.Saved)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	s := Defaults()
	s.Categories["goal"] = false
	s.MinSeconds = 2.5
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	want := "{\n\t\"enabled\": true,\n\t\"focusSkip\": true,\n\t\"minSeconds\": 2.5,\n\t\"sound\": \"Glass\",\n\t\"preview\": false,\n\t\"categories\": {\n\t\t\"core\": true,\n\t\t\"goal\": false,\n\t\t\"background\": true,\n\t\t\"critical\": true\n\t}\n}\n"
	if string(data) != want {
		t.Errorf("file = %q", data)
	}
	if got := Load(path); !reflect.DeepEqual(got, s) {
		t.Errorf("load = %+v", got)
	}
}
