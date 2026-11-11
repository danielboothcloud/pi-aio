package btw

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// golden.json is produced by testdata/gen-golden.ts from the TypeScript btw
// feature, which stays the reference until the Go port replaces it.
type golden struct {
	Constants struct {
		MaxQuestionChars    int      `json:"maxQuestionChars"`
		MaxFlowDigestChars  int      `json:"maxFlowDigestChars"`
		MaxMessagesInDigest int      `json:"maxMessagesInDigest"`
		MaxPromptBytes      int      `json:"maxPromptBytes"`
		SnapshotMaxFiles    int      `json:"snapshotMaxFiles"`
		SnapshotMaxDirs     int      `json:"snapshotMaxDirs"`
		SnapshotMaxDepth    int      `json:"snapshotMaxDepth"`
		SnapshotRootEntries int      `json:"snapshotRootEntries"`
		SnapshotTopFiles    int      `json:"snapshotTopFiles"`
		ExcludeDirs         []string `json:"excludeDirs"`
		SystemPrompt        string   `json:"systemPrompt"`
		MaxAnswerChars      int      `json:"maxAnswerChars"`
		MaxCardAnswerRows   int      `json:"maxCardAnswerRows"`
		MaxCardRows         int      `json:"maxCardRows"`
		EntryType           string   `json:"entryType"`
		WidgetKey           string   `json:"widgetKey"`
		StatusKey           string   `json:"statusKey"`
		Now                 float64  `json:"now"`
	} `json:"constants"`
	Branches map[string][]json.RawMessage `json:"branches"`
	Digests  []struct {
		Branch  string `json:"branch"`
		Options *struct {
			MaxChars        int              `json:"maxChars"`
			MaxMessages     int              `json:"maxMessages"`
			PerMessageChars *PerMessageChars `json:"perMessageChars"`
		} `json:"options"`
		Digest string `json:"digest"`
	} `json:"digests"`
	Prompts []struct {
		Input struct {
			Question        string  `json:"question"`
			FlowDigest      *string `json:"flowDigest"`
			ProjectSnapshot *string `json:"projectSnapshot"`
			MaxPromptBytes  int     `json:"maxPromptBytes"`
		} `json:"input"`
		Prompt string `json:"prompt"`
	} `json:"prompts"`
	Sanitize []struct {
		Text string `json:"text"`
		Max  int    `json:"max"`
		Out  string `json:"out"`
	} `json:"sanitize"`
	Texts []struct {
		Content any    `json:"content"`
		Out     string `json:"out"`
	} `json:"texts"`
	Outcomes []struct {
		Response     map[string]any `json:"response"`
		SystemPrompt string         `json:"systemPrompt"`
		Outcome      struct {
			Answer string `json:"answer"`
			Usage  *Usage `json:"usage"`
			Error  string `json:"error"`
		} `json:"outcome"`
	} `json:"outcomes"`
	Tokens []struct {
		Usage *Usage `json:"usage"`
		Out   string `json:"out"`
	} `json:"tokens"`
	Seconds []struct {
		Ms  float64 `json:"ms"`
		Out string  `json:"out"`
	} `json:"seconds"`
	Toasts []struct {
		Data EntryData `json:"data"`
		Out  string    `json:"out"`
	} `json:"toasts"`
	Boxes []struct {
		Data  EntryData `json:"data"`
		Width int       `json:"width"`
		Rows  []string  `json:"rows"`
	} `json:"boxes"`
	Cards []struct {
		Card  goldenCard `json:"card"`
		Width int        `json:"width"`
		Now   float64    `json:"now"`
		Rows  []string   `json:"rows"`
	} `json:"cards"`
	StatusLines []struct {
		ID  *string `json:"id"`
		Out string  `json:"out"`
	} `json:"statusLines"`
	Fixture   fixture `json:"fixture"`
	Snapshots []struct {
		Dir     string           `json:"dir"`
		Options *SnapshotOptions `json:"options"`
		Out     string           `json:"out"`
	} `json:"snapshots"`
	Scenarios []struct {
		Name    string `json:"name"`
		Options struct {
			HasUI        bool     `json:"hasUI"`
			Mode         string   `json:"mode"`
			AnswerCardMs *float64 `json:"answerCardMs"`
		} `json:"options"`
		Records []struct {
			Step struct {
				Op        string         `json:"op"`
				Args      string         `json:"args"`
				Streaming bool           `json:"streaming"`
				NoModel   bool           `json:"noModel"`
				Reply     map[string]any `json:"reply"`
			} `json:"step"`
			Log json.RawMessage `json:"log"`
		} `json:"records"`
	} `json:"scenarios"`
}

type goldenCard struct {
	Phase      string  `json:"phase"`
	Question   string  `json:"question"`
	Model      string  `json:"model"`
	StartedAt  float64 `json:"startedAt"`
	Answer     string  `json:"answer"`
	AnsweredAt float64 `json:"answeredAt"`
	DismissAt  float64 `json:"dismissAt"`
}

func (c goldenCard) card() Card {
	return Card{Pending: c.Phase == "pending", Question: c.Question, Model: c.Model, StartedAt: c.StartedAt,
		Answer: c.Answer, AnsweredAt: c.AnsweredAt, DismissAt: c.DismissAt}
}

type fixture struct {
	Files []struct {
		Path string `json:"path"`
		Size int    `json:"size"`
	} `json:"files"`
	Dirs     []string `json:"dirs"`
	Symlinks []struct {
		Path   string `json:"path"`
		Target string `json:"target"`
	} `json:"symlinks"`
}

func (f fixture) build(t *testing.T, dir string) {
	t.Helper()
	for _, file := range f.Files {
		full := filepath.Join(dir, file.Path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(strings.Repeat("x", file.Size)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, sub := range f.Dirs {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, link := range f.Symlinks {
		if err := os.Symlink(filepath.Join(dir, link.Target), filepath.Join(dir, link.Path)); err != nil {
			t.Fatal(err)
		}
	}
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

// plainLayout follows pi-tui for the text these tests render: printable
// text without tabs, wide CJK and emoji, and SGR codes that end in "m".
type plainLayout struct{}

func runeWidth(r rune) int {
	switch {
	case r >= 0x1F300 && r <= 0x1FAFF, r >= 0x2E80 && r <= 0x9FFF, r >= 0xAC00 && r <= 0xD7A3, r >= 0xFF00 && r <= 0xFF60:
		return 2
	}
	return 1
}

func (plainLayout) Width(text string) int {
	w := 0
	for _, r := range StripTerminalSequences(text) {
		w += runeWidth(r)
	}
	return w
}

func (l plainLayout) Truncate(text string, width int, ellipsis string) string {
	if width <= 0 {
		return ""
	}
	if text == "" {
		return ""
	}
	ew := l.Width(ellipsis)
	if l.Width(text) <= width {
		return text
	}
	if ew >= width {
		return "\x1b[0m" + ellipsis + "\x1b[0m"
	}
	target := width - ew
	var b strings.Builder
	kept := 0
	for _, r := range text {
		if kept+runeWidth(r) > target {
			break
		}
		b.WriteRune(r)
		kept += runeWidth(r)
	}
	if ellipsis == "" {
		return b.String() + "\x1b[0m"
	}
	return b.String() + "\x1b[0m" + ellipsis + "\x1b[0m"
}

func (l plainLayout) Wrap(text string, width int) []string {
	if text == "" {
		return []string{""}
	}
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n") {
		out = append(out, l.wrapLine(line, width)...)
	}
	return out
}

func (l plainLayout) wrapLine(line string, width int) []string {
	if line == "" || l.Width(line) <= width {
		return []string{line}
	}
	var tokens []string
	var current strings.Builder
	space := false
	for i, r := range line {
		s := r == ' '
		if i > 0 && s != space {
			tokens = append(tokens, current.String())
			current.Reset()
		}
		space = s
		current.WriteRune(r)
	}
	tokens = append(tokens, current.String())
	var wrapped []string
	cur, curW := "", 0
	for _, token := range tokens {
		tw := l.Width(token)
		blank := strings.TrimSpace(token) == ""
		if tw > width && !blank {
			if cur != "" {
				wrapped = append(wrapped, cur)
			}
			cur, curW = "", 0
			for _, r := range token {
				if curW+runeWidth(r) > width {
					wrapped = append(wrapped, cur)
					cur, curW = "", 0
				}
				cur += string(r)
				curW += runeWidth(r)
			}
			continue
		}
		if curW+tw > width && curW > 0 {
			wrapped = append(wrapped, strings.TrimRight(cur, " "))
			if blank {
				cur, curW = "", 0
			} else {
				cur, curW = token, tw
			}
			continue
		}
		cur += token
		curW += tw
	}
	if cur != "" {
		wrapped = append(wrapped, cur)
	}
	for i := range wrapped {
		wrapped[i] = strings.TrimRight(wrapped[i], " ")
	}
	if len(wrapped) == 0 {
		return []string{""}
	}
	return wrapped
}

func TestGoldenConstants(t *testing.T) {
	c := loadGolden(t).Constants
	if c.MaxQuestionChars != MaxQuestionChars || c.MaxFlowDigestChars != MaxFlowDigestChars || c.MaxMessagesInDigest != MaxMessagesInDigest ||
		c.MaxPromptBytes != MaxPromptBytes || c.SnapshotMaxFiles != SnapshotMaxFiles || c.SnapshotMaxDirs != SnapshotMaxDirs ||
		c.SnapshotMaxDepth != SnapshotMaxDepth || c.SnapshotRootEntries != SnapshotRootEntries || c.SnapshotTopFiles != SnapshotTopFiles ||
		c.MaxAnswerChars != MaxAnswerChars || c.MaxCardAnswerRows != MaxCardAnswerRows || c.MaxCardRows != MaxCardRows ||
		c.EntryType != EntryType || c.WidgetKey != WidgetKey || c.StatusKey != StatusKey {
		t.Fatalf("constants drifted: %+v", c)
	}
	if c.SystemPrompt != SystemPrompt {
		t.Errorf("SystemPrompt = %q", SystemPrompt)
	}
	if len(c.ExcludeDirs) != len(SnapshotExcludeDirs) {
		t.Errorf("exclude dirs = %v", c.ExcludeDirs)
	}
	for _, dir := range c.ExcludeDirs {
		if !SnapshotExcludeDirs[dir] {
			t.Errorf("missing exclude dir %q", dir)
		}
	}
}

func TestGoldenDigests(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Digests {
		options := FlowDigestOptions{}
		if c.Options != nil {
			options.MaxChars, options.MaxMessages = c.Options.MaxChars, c.Options.MaxMessages
			if p := c.Options.PerMessageChars; p != nil {
				options.Caps = p
			}
		}
		if got := BuildFlowDigest(g.Branches[c.Branch], options); got != c.Digest {
			t.Errorf("digest %s %+v:\n got %q\nwant %q", c.Branch, c.Options, got, c.Digest)
		}
	}
}

// PerMessageChars decodes the TypeScript field names.
func (p *PerMessageChars) UnmarshalJSON(data []byte) error {
	var raw struct{ User, Assistant, ToolResult, ToolCall int }
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*p = PerMessageChars{User: raw.User, Assistant: raw.Assistant, ToolResult: raw.ToolResult, ToolCall: raw.ToolCall}
	return nil
}

func TestGoldenPrompts(t *testing.T) {
	for i, c := range loadGolden(t).Prompts {
		in := PromptInput{Question: c.Input.Question, MaxPromptBytes: c.Input.MaxPromptBytes}
		if c.Input.FlowDigest != nil {
			in.FlowDigest = *c.Input.FlowDigest
		}
		if c.Input.ProjectSnapshot != nil {
			in.ProjectSnapshot = *c.Input.ProjectSnapshot
		}
		got := BuildPrompt(in)
		if got != c.Prompt {
			t.Errorf("prompt %d: got %d units, want %d\n got tail %q\nwant tail %q", i, Len16(got), Len16(c.Prompt), tail(got), tail(c.Prompt))
		}
		limit := MaxPromptBytes
		if in.MaxPromptBytes > 0 {
			limit = in.MaxPromptBytes
		}
		if strings.HasSuffix(got, "…[truncated to fit the budget]") && len(strings.TrimSuffix(got, "\n…[truncated to fit the budget]")) > limit-64 {
			t.Errorf("prompt %d body exceeds the byte cap", i)
		}
	}
}

func tail(s string) string {
	if len(s) > 80 {
		return s[len(s)-80:]
	}
	return s
}

func TestGoldenEngine(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Sanitize {
		if got := SanitizeForTerminal(c.Text, c.Max); got != c.Out {
			t.Errorf("SanitizeForTerminal(%q, %d) = %q, want %q", c.Text, c.Max, got, c.Out)
		}
	}
	for _, c := range g.Texts {
		if got := TextFromContent(c.Content); got != c.Out {
			t.Errorf("TextFromContent(%v) = %q, want %q", c.Content, got, c.Out)
		}
	}
	for _, c := range g.Outcomes {
		var seen string
		got := RunSideQuestion("P", func(system, prompt string) (map[string]any, error) {
			seen = system
			if message, ok := c.Response["throw"].(string); ok {
				return nil, errors.New(message)
			}
			return c.Response, nil
		}, nil)
		if seen != c.SystemPrompt {
			t.Errorf("system prompt = %q", seen)
		}
		want := c.Outcome
		if got.Answer != want.Answer || got.Error != want.Error || !reflect.DeepEqual(got.Usage, want.Usage) {
			t.Errorf("RunSideQuestion(%v) = %+v (usage %+v), want %+v (usage %+v)", c.Response, got, got.Usage, want, want.Usage)
		}
	}
}

func TestGoldenDisplay(t *testing.T) {
	g := loadGolden(t)
	l := plainLayout{}
	for _, c := range g.Tokens {
		if got := FormatTokens(c.Usage); got != c.Out {
			t.Errorf("FormatTokens(%+v) = %q, want %q", c.Usage, got, c.Out)
		}
	}
	for _, c := range g.Seconds {
		if got := FormatSeconds(c.Ms); got != c.Out {
			t.Errorf("FormatSeconds(%v) = %q, want %q", c.Ms, got, c.Out)
		}
	}
	for _, c := range g.Toasts {
		if got := ToastText(l, c.Data); got != c.Out {
			t.Errorf("ToastText = %q, want %q", got, c.Out)
		}
	}
	for _, c := range g.Boxes {
		if got := BoxRows(l, c.Data, c.Width); !equalRows(got, c.Rows) {
			t.Errorf("BoxRows width %d:\n got %q\nwant %q", c.Width, got, c.Rows)
		}
	}
	for _, c := range g.Cards {
		got := CardRows(l, c.Card.card(), c.Width, c.Now)
		if !equalRows(got, c.Rows) {
			t.Errorf("CardRows %s width %d:\n got %q\nwant %q", c.Card.Phase, c.Width, got, c.Rows)
		}
		if len(got) > MaxCardRows {
			t.Errorf("card has %d rows", len(got))
		}
		for _, row := range got {
			if l.Width(row) > c.Width {
				t.Errorf("row %q is wider than %d", row, c.Width)
			}
		}
	}
	for _, c := range g.StatusLines {
		id := ""
		if c.ID != nil {
			id = *c.ID
		}
		if got := StatusAskingLine(id); got != c.Out {
			t.Errorf("StatusAskingLine(%q) = %q", id, got)
		}
	}
}

func equalRows(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}

func TestGoldenSnapshots(t *testing.T) {
	g := loadGolden(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g.Fixture.build(t, filepath.Join(root, "ws"))
	if err := os.Mkdir(filepath.Join(root, "blank"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Snapshots {
		options := SnapshotOptions{}
		if c.Options != nil {
			options = *c.Options
		}
		got := strings.ReplaceAll(BuildProjectSnapshot(filepath.Join(root, c.Dir), options), root, "@@ROOT@@")
		if got != c.Out {
			t.Errorf("snapshot %s %+v:\n got %s\nwant %s", c.Dir, c.Options, got, c.Out)
		}
	}
}

// SnapshotOptions decodes the TypeScript field names.
func (o *SnapshotOptions) UnmarshalJSON(data []byte) error {
	var raw struct{ MaxFiles, MaxDirs, MaxDepth, RootEntries, TopFiles int }
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*o = SnapshotOptions(raw)
	return nil
}

// recordingHost records what the generator's harness records.
type recordingHost struct {
	l     Layout
	hasUI bool
	mode  string
	now   float64
	log   []any
}

func (h *recordingHost) HasUI() bool { return h.hasUI }
func (h *recordingHost) IsTUI() bool { return h.mode == "tui" }
func (h *recordingHost) Notify(message, level string) {
	h.log = append(h.log, map[string]any{"op": "notify", "text": message, "level": level})
}
func (h *recordingHost) SetStatus(text string) {
	var value any
	if text != "" {
		value = text
	}
	h.log = append(h.log, map[string]any{"op": "status", "key": StatusKey, "text": value})
}
func (h *recordingHost) ShowCard(card Card) {
	h.log = append(h.log, map[string]any{"op": "widget", "key": WidgetKey, "rows": CardRows(h.l, card, 50, h.now), "options": map[string]any{"placement": "aboveEditor"}})
}
func (h *recordingHost) ClearCard() {
	h.log = append(h.log, map[string]any{"op": "widget", "key": WidgetKey, "rows": nil, "options": nil})
}
func (h *recordingHost) StartCardTimer(float64) {}
func (h *recordingHost) StopCardTimer()         {}
func (h *recordingHost) AppendEntry(data EntryData) error {
	h.log = append(h.log, map[string]any{"op": "append", "customType": EntryType, "data": data})
	return nil
}
func (h *recordingHost) Now() float64 { return h.now }

func TestGoldenCommandScenarios(t *testing.T) {
	g := loadGolden(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g.Fixture.build(t, filepath.Join(root, "ws"))
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			cardMs := float64(-1)
			if sc.Options.AnswerCardMs != nil {
				cardMs = *sc.Options.AnswerCardMs
			}
			runner := NewRunner(plainLayout{}, cardMs)
			h := &recordingHost{l: plainLayout{}, hasUI: sc.Options.HasUI, mode: sc.Options.Mode, now: g.Constants.Now}
			reply := map[string]any{"stopReason": "stop", "content": []any{map[string]any{"type": "text", "text": "default answer"}}}
			for i, record := range sc.Records {
				h.log = nil
				s := record.Step
				switch s.Op {
				case "btw":
					if s.Reply != nil {
						reply = s.Reply
					}
					model := "anthropic/claude-x"
					if s.NoModel {
						model = ""
					}
					if run := runner.Command(h, s.Args, model, s.Streaming); run != nil {
						current := reply
						runner.Ask(h, run, AskInput{
							Branch: func() []json.RawMessage { return g.Branches["base"] },
							Cwd:    filepath.Join(root, "ws"),
							Complete: func(system, prompt string) (map[string]any, error) {
								h.log = append(h.log, map[string]any{"op": "complete", "systemPrompt": system, "prompt": prompt})
								if message, ok := current["throw"].(string); ok {
									return nil, errors.New(message)
								}
								return current, nil
							},
						})
					}
				case "shutdown":
					runner.Shutdown(h)
				}
				data, err := json.Marshal(h.log)
				if err != nil {
					t.Fatal(err)
				}
				var got, want any
				_ = json.Unmarshal([]byte(strings.ReplaceAll(string(data), root, "@@ROOT@@")), &got)
				_ = json.Unmarshal(record.Log, &want)
				if want == nil {
					want = []any{}
				}
				if got == nil {
					got = []any{}
				}
				if !reflect.DeepEqual(got, want) {
					gotJSON, _ := json.Marshal(got)
					t.Errorf("step %d (%s %q):\n got %s\nwant %s", i, s.Op, Slice16(s.Args, 20), gotJSON, record.Log)
				}
			}
		})
	}
}
