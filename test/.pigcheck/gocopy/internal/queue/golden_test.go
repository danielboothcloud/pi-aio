package queue

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/ui"
	"github.com/danielboothcloud/pi-aio/go/internal/userbash"
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

func jsonEq(t *testing.T, label string, got, want any) {
	t.Helper()
	norm := func(v any) string {
		b, _ := json.Marshal(v)
		var x any
		_ = json.Unmarshal(b, &x)
		b, _ = json.Marshal(x)
		return string(b)
	}
	g, w := norm(got), norm(want)
	if string(g) != string(w) {
		t.Errorf("%s:\n got %s\nwant %s", label, g, w)
	}
}

func TestMirrorMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	var m Mirror
	for _, s := range section[[]struct {
		Op      string
		Args    []json.RawMessage
		Out     json.RawMessage
		Entries []Message
	}](t, g, "mirrorSteps") {
		str := func(i int) string {
			var v string
			_ = json.Unmarshal(s.Args[i], &v)
			return v
		}
		var out any
		switch s.Op {
		case "add":
			m.Add(str(0), str(1))
		case "entries":
			out = m.Entries()
		case "next":
			if next, ok := m.Next(); ok {
				out = next
			}
		case "removeDelivered":
			if mode := m.RemoveDelivered(str(0)); mode != "" {
				out = mode
			}
		case "remove":
			var e Message
			_ = json.Unmarshal(s.Args[0], &e)
			out = m.Remove(e)
		case "removeNext":
			if next, ok := m.RemoveNext(); ok {
				out = next
			}
		case "isEmpty":
			out = m.IsEmpty()
		case "size":
			out = m.Size()
		case "clear":
			out = m.Clear()
		}
		var want any
		_ = json.Unmarshal(s.Out, &want)
		jsonEq(t, s.Op, out, want)
		jsonEq(t, s.Op+" entries", m.Entries(), s.Entries)
	}
}

func TestControllerMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	for _, scenario := range section[[]struct {
		Name  string
		Steps []struct {
			Step struct {
				Op, Arg, Mode string
				Idle, Pending *bool
			}
			Out     any
			Calls   []any
			Entries []Message
			Busy    bool
		}
	}](t, g, "controllers") {
		idle, pending := true, false
		var calls []any
		c := NewController(Deps{
			IsIdle:               func() bool { return idle },
			HasPendingMessages:   func() bool { return pending },
			Abort:                func() { calls = append(calls, []any{"abort"}) },
			ClearEditor:          func() { calls = append(calls, []any{"clearEditor"}) },
			RestoreTextsToEditor: func(texts []string) { calls = append(calls, []any{"restore", texts}) },
			SendUserMessage:      func(text, mode string) { calls = append(calls, []any{"send", text, mode}) },
			Notify:               func(m, l string) { calls = append(calls, []any{"notify", m, l}) },
			UpdateWidget:         func() { calls = append(calls, []any{"updateWidget"}) },
		})
		for i, s := range scenario.Steps {
			if s.Step.Idle != nil {
				idle = *s.Step.Idle
			}
			if s.Step.Pending != nil {
				pending = *s.Step.Pending
			}
			calls = []any{}
			var out any
			switch s.Step.Op {
			case "queued":
				c.HandleQueuedInput(s.Step.Arg, s.Step.Mode)
			case "delivered":
				c.HandleUserMessageText(s.Step.Arg)
			case "resync":
				c.Resync()
			case "emptySubmit":
				out = c.OnEmptySubmit()
			case "agentStart":
				c.OnAgentStart()
			case "agentSettled":
				c.OnAgentSettled()
			}
			label := scenario.Name + " step " + string(rune('0'+i)) + " " + s.Step.Op
			jsonEq(t, label+" out", out, s.Out)
			jsonEq(t, label+" calls", calls, s.Calls)
			jsonEq(t, label+" entries", c.Mirror.Entries(), s.Entries)
			if c.FlowBusy() != s.Busy {
				t.Errorf("%s busy %v", label, c.FlowBusy())
			}
		}
	}
}

func TestLinesMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	sets := section[map[string][]Message](t, g, "entrySets")
	for _, c := range section[[]struct {
		Name    string
		Width   int
		MaxRows *int
		Out     []string
	}](t, g, "widgetLines") {
		max := 0
		if c.MaxRows != nil {
			max = *c.MaxRows
		}
		jsonEq(t, c.Name, BuildLines(sets[c.Name], c.Width, theme, max), c.Out)
	}
	for _, c := range section[[]struct {
		Text string
		Out  struct {
			Line      string
			Truncated bool
		}
	}](t, g, "previews") {
		line, truncated := FirstLinePreview(c.Text)
		if line != c.Out.Line || truncated != c.Out.Truncated {
			t.Errorf("preview %q: %q %v", c.Text, line, truncated)
		}
	}
	for _, c := range section[[]struct {
		Current string
		Texts   []string
		Out     *string
	}](t, g, "restores") {
		if len(c.Texts) == 0 {
			if c.Out != nil {
				t.Errorf("restore %q: TypeScript wrote with no texts", c.Current)
			}
			continue
		}
		if got := MergeRestore(c.Current, c.Texts); c.Out == nil || got != *c.Out {
			t.Errorf("restore %q %q: %q want %v", c.Current, c.Texts, got, c.Out)
		}
	}
}

func TestRegistrarMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	for _, run := range section[[]struct {
		Name    string
		Options struct {
			Framed bool
			Mode   string
		}
		Records []struct {
			Op    string
			Arg   json.RawMessage
			Log   []any
			Panel []string
		}
	}](t, g, "registrars") {
		f := NewFeature()
		SetupPanel := func() []string { return f.Panel() }
		var log []any
		mode := run.Options.Mode
		if mode == "" {
			mode = "tui"
		}
		update := func() {
			entries, show := f.WidgetUpdate(run.Options.Framed)
			if !show {
				log = append(log, []any{"setWidget", "aio-queue", nil, nil})
				return
			}
			log = append(log, []any{"setWidget", "aio-queue", BuildLines(entries, 60, theme, 0), map[string]any{"placement": "belowEditor"}})
		}
		for _, r := range run.Records {
			log = []any{}
			switch r.Op {
			case "session_start":
				if mode != "tui" {
					f.Controller = nil
					break
				}
				{
					f.Controller = NewController(Deps{
						IsIdle:               func() bool { return false },
						HasPendingMessages:   func() bool { return true },
						Abort:                func() { log = append(log, []any{"abort"}) },
						ClearEditor:          func() {},
						RestoreTextsToEditor: func([]string) {},
						SendUserMessage:      func(string, string) {},
						Notify:               func(string, string) {},
						UpdateWidget:         update,
					})
					log = append(log, []any{"setEditorComponent"})
				}
				update()
			case "input":
				var e struct{ Text, StreamingBehavior string }
				_ = json.Unmarshal(r.Arg, &e)
				if e.StreamingBehavior != "" && f.Controller != nil {
					f.Controller.HandleQueuedInput(e.Text, e.StreamingBehavior)
				}
			case "command":
				var args string
				_ = json.Unmarshal(r.Arg, &args)
				msg, level, upd := f.Command(args)
				if upd {
					update()
				}
				log = append(log, []any{"notify", msg, level})
			case "message_start":
				var e struct{ Message map[string]any }
				_ = json.Unmarshal(r.Arg, &e)
				if e.Message["role"] == "user" && f.Controller != nil {
					f.Controller.HandleUserMessageText(ExtractUserText(e.Message))
				}
			case "agent_end":
				if f.Controller != nil {
					f.Controller.Resync()
				}
			case "session_shutdown":
				f.Controller = nil
				log = append(log, []any{"setWidget", "aio-queue", nil, nil})
			}
			jsonEq(t, run.Name+" "+r.Op+" log", log, r.Log)
			jsonEq(t, run.Name+" "+r.Op+" panel", SetupPanel(), r.Panel)
		}
	}
}

// editorHost replays a recorded CustomEditor under the user-bash and queue
// editor logic.
type editorHost struct {
	t        *testing.T
	keys     map[string]map[string]bool
	text     string
	base     []struct{ Data, After string }
	bash     *userbash.Editor
	hostBase *fakeBase
}

type fakeBase struct{ h *editorHost }

func (b *fakeBase) Text() string        { return b.h.text }
func (b *fakeBase) SetText(text string) { b.h.text = text }
func (b *fakeBase) HandleInput(d string) {
	if len(b.h.base) == 0 {
		b.h.t.Fatalf("unrecorded base input %q", d)
	}
	rec := b.h.base[0]
	b.h.base = b.h.base[1:]
	if rec.Data != d {
		b.h.t.Fatalf("base input %q want %q", d, rec.Data)
	}
	b.h.text = rec.After
}

func (h *editorHost) Matches(data, binding string) bool { return h.keys[data][binding] }
func (h *editorHost) Text() string                      { return h.text }
func (h *editorHost) ExpandedText() string              { return h.text }
func (h *editorHost) ShowingAutocomplete() bool         { return false }
func (h *editorHost) SubmitDisabled() bool              { return false }
func (h *editorHost) BackslashBeforeCursor() bool       { return strings.HasSuffix(h.text, "\\") }
func (h *editorHost) ClearText()                        { h.bash.SetText("") }
func (h *editorHost) Super(data string)                 { h.bash.HandleInput(data) }

func TestEditorMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	keys := map[string]map[string]bool{}
	byName := map[string]string{}
	for _, k := range section[[]struct {
		Name, Data string
		Bindings   []string
	}](t, g, "keyTable") {
		byName[k.Name] = k.Data
		keys[k.Data] = map[string]bool{}
		for _, b := range k.Bindings {
			keys[k.Data][b] = true
		}
	}
	defer ui.SetEditorIntercepts(nil)
	for _, script := range section[[]struct {
		Name           string
		WithIntercepts bool
		Records        []struct {
			Step struct {
				Key     string
				SetText *string
				Claim   map[string]json.RawMessage
			}
			Before   string
			Base     []struct{ Data, After string }
			Events   []any
			Statuses []any
			Text     string
		}
	}](t, g, "editors") {
		claims := struct {
			escape, action, emptySubmit bool
			submit                      []string
		}{escape: true, action: true, submit: []string{"/resume"}}
		var events, statuses []any
		h := &editorHost{t: t, keys: keys}
		h.hostBase = &fakeBase{h}
		h.bash = &userbash.Editor{
			Base: h.hostBase,
			Status: func(text string) {
				if text == "" {
					statuses = append(statuses, []any{"user-bash", nil})
				} else {
					statuses = append(statuses, []any{"user-bash", text})
				}
			},
			Theme: func() userbash.Theme { return theme },
		}
		if script.WithIntercepts {
			ui.SetEditorIntercepts(&ui.Intercepts{
				Escape: func() bool { events = append(events, []any{"escape"}); return claims.escape },
				Submit: func(text string) bool {
					events = append(events, []any{"submit", text})
					for _, s := range claims.submit {
						if s == text {
							return true
						}
					}
					return false
				},
				Action: func(a string) bool { events = append(events, []any{"action", a}); return claims.action },
			})
		} else {
			ui.SetEditorIntercepts(nil)
		}
		for i, r := range script.Records {
			for k, v := range r.Step.Claim {
				switch k {
				case "escape":
					_ = json.Unmarshal(v, &claims.escape)
				case "action":
					_ = json.Unmarshal(v, &claims.action)
				case "emptySubmit":
					_ = json.Unmarshal(v, &claims.emptySubmit)
				case "submit":
					_ = json.Unmarshal(v, &claims.submit)
				}
			}
			events, statuses = []any{}, []any{}
			h.base = r.Base
			if h.text != r.Before {
				t.Fatalf("%s step %d: text %q before, want %q", script.Name, i, h.text, r.Before)
			}
			if r.Step.SetText != nil {
				h.bash.SetText(*r.Step.SetText)
			}
			if r.Step.Key != "" {
				HandleInput(h, byName[r.Step.Key], func() bool {
					events = append(events, []any{"emptySubmit"})
					return claims.emptySubmit
				})
			}
			// The host's own handlers (pi's submit and escape) run in the
			// host, not here.
			var want []any
			for _, e := range r.Events {
				if name, _ := e.([]any)[0].(string); !strings.HasPrefix(name, "pi") {
					want = append(want, e)
				}
			}
			label := script.Name + " step " + string(rune('a'+i))
			jsonEq(t, label+" events", events, append([]any{}, want...))
			jsonEq(t, label+" statuses", statuses, r.Statuses)
			if h.text != r.Text {
				t.Errorf("%s text %q want %q", label, h.text, r.Text)
			}
		}
	}
}

func TestBashRendersMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	border := func(s string) string { return s }
	for _, c := range section[[]struct {
		Text                string
		FrameChrome         bool
		Width               int
		Base, Out, Unframed []string
	}](t, g, "bashRenders") {
		got := userbash.RenderWithChrome(c.Base, c.Text, c.Width, c.FrameChrome, theme, border)
		jsonEq(t, "render "+c.Text, got, c.Out)
		jsonEq(t, "unframed "+c.Text, userbash.RenderWithChrome(c.Base, c.Text, c.Width, false, theme, border), c.Unframed)
	}
}
