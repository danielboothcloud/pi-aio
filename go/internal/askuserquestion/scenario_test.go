package askuserquestion

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

var sgr = regexp.MustCompile("\x1b\\[[0-9;]*m|\x1b_pi:[^\x07]*\x07")

// sameWords reports that two renders hold the same words in the same
// order: they differ only where a long line wraps.
func sameWords(a, b []string) bool {
	words := func(lines []string) string {
		return strings.Join(strings.Fields(sgr.ReplaceAllString(strings.Join(lines, " "), "")), " ")
	}
	return words(a) == words(b)
}

type renderStats struct {
	exact, wrapOnly, failed int
}

func (r *renderStats) compare(t *testing.T, label string, got, want []string) {
	t.Helper()
	switch {
	case reflect.DeepEqual(got, want):
		r.exact++
	case len(got) == len(want) && sameWords(got, want):
		r.wrapOnly++
	default:
		r.failed++
		if r.failed <= 8 {
			t.Errorf("%s:\n got %q\nwant %q", label, got, want)
		}
	}
}

func TestSessionScenariosMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	keys := loadKeys(t, g)
	theme := goldenTheme(t, g)
	md := mdTheme(section[map[string]int](t, g, "mdCodes"))
	qs := section[map[string]json.RawMessage](t, g, "questionnaires")
	stats := &renderStats{}
	for _, c := range section[[]struct {
		Name          string
		Questionnaire string
		Keys          []string
		Sizes         [][2]int
		CollapseKey   string
		Frames        []struct {
			Key     *string
			Action  json.RawMessage
			State   json.RawMessage
			Input   json.RawMessage
			Notes   json.RawMessage
			Done    json.RawMessage
			Hidden  []bool
			Renders [][]string
		}
		RequestRenders int
	}](t, g, "scenarioCases") {
		params := decodeParamsJSON(t, qs[c.Questionnaire])
		var itemsByTab [][]Item
		for _, q := range params.Questions {
			itemsByTab = append(itemsByTab, BuildItemsForQuestion(q))
		}
		cols, rows := c.Sizes[0][0], c.Sizes[0][1]
		var done *Result
		hidden := []bool{}
		renders := 0
		collapseKey := c.CollapseKey
		if collapseKey == "" {
			collapseKey = DefaultCollapseKey
		}
		s := NewSession(SessionConfig{
			Theme: theme, Markdown: md, Keys: keys, Params: params, ItemsByTab: itemsByTab,
			Columns: func() int { return cols }, Rows: func() int { return rows },
			RequestRender: func() { renders++ }, Done: func(r Result) { done = &r }, CollapseKey: collapseKey,
		})
		s.SetOverlayHidden(func(h bool) { hidden = append(hidden, h) })
		for fi, f := range c.Frames {
			label := c.Name + " frame " + itoaT(fi)
			if f.Key != nil {
				data := keys.byName[*f.Key]
				action := s.LastAction(data)
				if !sameJSON(t, actionJSON(action), f.Action) {
					t.Errorf("%s (%s): action %v want %s", label, *f.Key, jsonValue(t, actionJSON(action)), f.Action)
				}
				s.HandleInput(data)
				label += " (" + *f.Key + ")"
			}
			if !sameJSON(t, serState(s.State()), f.State) {
				t.Errorf("%s: state %v want %s", label, jsonValue(t, serState(s.State())), f.State)
			}
			if !sameJSON(t, inputJSON(s.b.inlineInput), f.Input) || !sameJSON(t, inputJSON(s.b.notesInput), f.Notes) {
				t.Errorf("%s: inputs %v %v want %s %s", label, inputJSON(s.b.inlineInput), inputJSON(s.b.notesInput), f.Input, f.Notes)
			}
			if !sameJSON(t, done, f.Done) {
				t.Errorf("%s: done %v want %s", label, jsonValue(t, done), f.Done)
			}
			if !reflect.DeepEqual(hidden, f.Hidden) {
				t.Errorf("%s: hidden %v want %v", label, hidden, f.Hidden)
			}
			for si, size := range c.Sizes {
				cols, rows = size[0], size[1]
				got := s.Render(cols)
				for _, line := range got {
					if w := tuiwidth.VisibleWidth(line); w > cols && !strings.Contains(line, tuiwidth.CursorMarker) {
						t.Errorf("%s: line wider than %d: %q", label, cols, line)
					}
				}
				stats.compare(t, label+" size "+itoaT(size[0])+"x"+itoaT(size[1])+" #"+itoaT(si), got, f.Renders[si])
			}
		}
		if renders != c.RequestRenders {
			t.Errorf("%s: %d requestRender calls want %d", c.Name, renders, c.RequestRenders)
		}
	}
	t.Logf("scenario renders: %d exact, %d wrap-only, %d failed", stats.exact, stats.wrapOnly, stats.failed)
	if stats.failed > 0 {
		t.Errorf("%d render failures", stats.failed)
	}
	if stats.wrapOnly != expectedScenarioWrapDiffs {
		t.Errorf("%d wrap-only differences, want %d", stats.wrapOnly, expectedScenarioWrapDiffs)
	}
}

// expectedScenarioWrapDiffs is the number of scenario renders where PiG's Go
// wrap port (tuiwidth) places a line break or style code differently from
// pi-tui 1.2.0; the words match.
const expectedScenarioWrapDiffs = 0

func itoaT(n int) string { return strconv.Itoa(n) }

// fakeHandle is the generator's overlay handle.
type fakeHandle struct {
	hidden, focused bool
	calls           *[]bool
}

func (h *fakeHandle) IsHidden() bool  { return h.hidden }
func (h *fakeHandle) IsFocused() bool { return h.focused }
func (h *fakeHandle) SetHidden(v bool) {
	h.hidden = v
	*h.calls = append(*h.calls, v)
}

type execFrame struct {
	Key      *string  `json:"key"`
	Consumed bool     `json:"consumed"`
	Routed   bool     `json:"routed"`
	Hidden   bool     `json:"hidden"`
	Lines    []string `json:"lines"`
}

// fakeHost is the generator's mock ctx for execute.
type fakeHost struct {
	fakeDialogs
	t             *testing.T
	keys          *goldenKeys
	theme         chrome.Theme
	md            copywidget.MarkdownTheme
	hasUI         bool
	mode          string
	dialogs       bool
	terminalInput bool
	customUndef   bool
	unfocused     bool
	sendKeys      []string
	overlayFirst  bool
	cols, rows    int
	promptID      *int

	mu          sync.Mutex
	emitted     []map[string]any
	notifies    []map[string]any
	customCalls int
	listeners   []*func(string) bool
	listenerLog []string
	frames      []execFrame
	hiddenCalls []bool
}

func (h *fakeHost) HasUI() bool       { return h.hasUI }
func (h *fakeHost) Mode() string      { return h.mode }
func (h *fakeHost) HasDialogUI() bool { return h.dialogs }
func (h *fakeHost) EmitEvent(channel string, payload any) {
	h.emitted = append(h.emitted, map[string]any{"channel": channel, "data": jsonValue(h.t, payload)})
}
func (h *fakeHost) SessionID() string { return "session-1" }
func (h *fakeHost) NextPromptID() int {
	*h.promptID++
	return *h.promptID
}
func (h *fakeHost) Notify(message, level string) {
	h.notifies = append(h.notifies, map[string]any{"message": message, "level": level})
}
func (h *fakeHost) Theme() Theme                       { return h.theme }
func (h *fakeHost) Markdown() copywidget.MarkdownTheme { return h.md }
func (h *fakeHost) Keys() Keys                         { return h.keys }
func (h *fakeHost) Columns() int                       { return h.cols }
func (h *fakeHost) Rows() int                          { return h.rows }

func (h *fakeHost) OnTerminalInput(handler func(string) bool) (func(), bool) {
	if !h.terminalInput {
		return nil, false
	}
	p := &handler
	h.listeners = append(h.listeners, p)
	h.listenerLog = append(h.listenerLog, "subscribe")
	return func() {
		for i, l := range h.listeners {
			if l == p {
				h.listeners = append(h.listeners[:i], h.listeners[i+1:]...)
				break
			}
		}
		h.listenerLog = append(h.listenerLog, "unsubscribe")
	}, true
}

func (h *fakeHost) ShowOverlay(o *Overlay, onHandle func(OverlayHandle)) error {
	h.customCalls++
	if h.customUndef {
		return nil
	}
	handle := &fakeHandle{focused: !h.unfocused, calls: &h.hiddenCalls}
	onHandle(handle)
	h.frames = append(h.frames, execFrame{Lines: o.Render(h.cols)})
	for _, name := range h.sendKeys {
		data := h.keys.byName[name]
		consumed := false
		if h.overlayFirst && !handle.hidden {
			finished := o.HandleInput(data)
			key := name
			h.frames = append(h.frames, execFrame{Key: &key, Routed: true, Hidden: handle.hidden, Lines: o.Render(h.cols)})
			if finished {
				break
			}
			continue
		}
		for _, l := range append([]*func(string) bool{}, h.listeners...) {
			if (*l)(data) {
				consumed = true
				break
			}
		}
		routed := false
		finished := false
		if !consumed && !handle.hidden && handle.focused {
			finished = o.HandleInput(data)
			routed = true
		}
		key := name
		h.frames = append(h.frames, execFrame{Key: &key, Consumed: consumed, Routed: routed, Hidden: handle.hidden, Lines: o.Render(h.cols)})
		if _, done, _ := o.Result(); done || finished {
			break
		}
		handle.focused = true
	}
	return nil
}

func TestExecuteMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	keys := loadKeys(t, g)
	theme := goldenTheme(t, g)
	md := mdTheme(section[map[string]int](t, g, "mdCodes"))
	promptID := 0
	stats := &renderStats{}
	for _, c := range section[[]struct {
		Name            string
		Params          json.RawMessage
		HasUI           bool
		Mode            string
		Dialogs         bool
		TerminalInput   bool
		CustomUndefined bool
		Unfocused       bool
		Config          map[string]any
		Keys            []string
		Replies         []struct {
			Value json.RawMessage `json:"value"`
			Undef bool            `json:"undef"`
		}
		Size        [2]int
		Result      json.RawMessage
		Error       *string
		Emitted     json.RawMessage
		Notifies    json.RawMessage
		CustomCalls []struct {
			Overlay        bool
			OverlayOptions json.RawMessage
			HasOnHandle    bool
		}
		DialogCalls json.RawMessage
		ListenerLog []string
		Frames      []execFrame
		HiddenCalls []bool
	}](t, g, "execCases") {
		h := &fakeHost{
			fakeDialogs: fakeDialogs{replies: c.Replies}, t: t, keys: keys, theme: theme, md: md,
			hasUI: c.HasUI, mode: c.Mode, dialogs: c.Dialogs, terminalInput: c.TerminalInput, customUndef: c.CustomUndefined,
			unfocused: c.Unfocused, sendKeys: c.Keys, cols: c.Size[0], rows: c.Size[1], promptID: &promptID,
			emitted: []map[string]any{}, notifies: []map[string]any{}, listenerLog: []string{}, hiddenCalls: []bool{},
		}
		var raw map[string]any
		_ = json.Unmarshal(c.Params, &raw)
		result, err := Execute(h, DecodeParams(raw), Config(c.Config))
		if c.Error != nil {
			if err == nil || err.Error() != *c.Error {
				t.Errorf("%s: error %v want %q", c.Name, err, *c.Error)
			}
		} else if err != nil {
			t.Errorf("%s: unexpected error %v", c.Name, err)
		} else if !sameJSON(t, toolResultJSON(result), c.Result) {
			t.Errorf("%s: result %v want %s", c.Name, jsonValue(t, toolResultJSON(result)), c.Result)
		}
		if !sameJSON(t, h.emitted, c.Emitted) {
			t.Errorf("%s: emitted %v want %s", c.Name, jsonValue(t, h.emitted), c.Emitted)
		}
		if !sameJSON(t, h.notifies, c.Notifies) {
			t.Errorf("%s: notifies %v want %s", c.Name, h.notifies, c.Notifies)
		}
		calls := h.fakeDialogs.calls
		if calls == nil {
			calls = []map[string]any{}
		}
		if !sameJSON(t, calls, c.DialogCalls) {
			t.Errorf("%s: dialog calls %v want %s", c.Name, jsonValue(t, calls), c.DialogCalls)
		}
		if h.customCalls != len(c.CustomCalls) {
			t.Errorf("%s: %d custom calls want %d", c.Name, h.customCalls, len(c.CustomCalls))
		}
		for _, cc := range c.CustomCalls {
			if !cc.Overlay || !cc.HasOnHandle || !sameJSON(t, OverlayOptionsJSON(), cc.OverlayOptions) {
				t.Errorf("%s: overlay options %s want %v", c.Name, cc.OverlayOptions, OverlayOptionsJSON())
			}
		}
		if !reflect.DeepEqual(h.listenerLog, c.ListenerLog) {
			t.Errorf("%s: listener log %v want %v", c.Name, h.listenerLog, c.ListenerLog)
		}
		if !reflect.DeepEqual(h.hiddenCalls, c.HiddenCalls) {
			t.Errorf("%s: hidden calls %v want %v", c.Name, h.hiddenCalls, c.HiddenCalls)
		}
		if len(h.frames) != len(c.Frames) {
			t.Errorf("%s: %d frames want %d", c.Name, len(h.frames), len(c.Frames))
			continue
		}
		for i, f := range h.frames {
			w := c.Frames[i]
			if (f.Key == nil) != (w.Key == nil) || (f.Key != nil && *f.Key != *w.Key) || f.Consumed != w.Consumed || f.Routed != w.Routed || f.Hidden != w.Hidden {
				t.Errorf("%s frame %d: %+v want %+v", c.Name, i, f, w)
			}
			stats.compare(t, c.Name+" frame "+itoaT(i), f.Lines, w.Lines)
		}
	}
	t.Logf("execute renders: %d exact, %d wrap-only, %d failed", stats.exact, stats.wrapOnly, stats.failed)
	if stats.failed > 0 || stats.wrapOnly != expectedExecWrapDiffs {
		t.Errorf("execute renders: %d failed, %d wrap-only (want %d)", stats.failed, stats.wrapOnly, expectedExecWrapDiffs)
	}
}

const expectedExecWrapDiffs = 0

// PiG sends a key to the focused overlay before the terminal-input
// listeners: the first collapse key hides the overlay through routeKey, and
// the one-time notice still appears.
func TestCollapseNoticeWhenOverlayGetsKeysFirst(t *testing.T) {
	g := loadGolden(t)
	keys := loadKeys(t, g)
	promptID := 0
	qs := section[map[string]json.RawMessage](t, g, "questionnaires")
	h := &fakeHost{
		t: t, keys: keys, theme: goldenTheme(t, g), md: mdTheme(section[map[string]int](t, g, "mdCodes")),
		hasUI: true, dialogs: true, terminalInput: true, overlayFirst: true, cols: 80, rows: 24, promptID: &promptID,
		sendKeys: []string{"collapse", "x", "collapse", "collapse", "collapse", "down", "enter"},
	}
	result, err := Execute(h, decodeParamsJSON(t, qs["single"]), Config{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(h.hiddenCalls, []bool{true, false, true, false}) {
		t.Errorf("hidden calls %v", h.hiddenCalls)
	}
	want := []map[string]any{{"message": "ask_user_question hidden — press ctrl+] to reopen", "level": "info"}}
	if !reflect.DeepEqual(h.notifies, want) {
		t.Errorf("notifies %v", h.notifies)
	}
	if !strings.Contains(result.Text, `="SQLite"`) {
		t.Errorf("result %q", result.Text)
	}
}
