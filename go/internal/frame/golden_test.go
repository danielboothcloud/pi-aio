package frame

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
)

type goldenFile map[string]json.RawMessage

func loadGolden(t *testing.T) (goldenFile, string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g, string(data)
}

func section[T any](t *testing.T, g goldenFile, key string) T {
	t.Helper()
	var v T
	if len(g[key]) < 3 {
		t.Fatalf("golden section %s is missing or empty", key)
	}
	if err := json.Unmarshal(g[key], &v); err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return v
}

// ansiTheme is the generator's ANSI theme (bold, italic, underline).
type ansiTheme struct{ chrome.GoldenTheme }

func (ansiTheme) Italic(text string) string    { return "\x1b[3m" + text + "\x1b[23m" }
func (ansiTheme) Underline(text string) string { return "\x1b[4m" + text + "\x1b[24m" }

type plainTheme struct{}

func (plainTheme) Fg(_, text string) string { return text }

const fixtureHome = "@@ROOT@@/home"

func themesFor(t *testing.T, g goldenFile) map[string]Theme {
	codes := section[map[string]int](t, g, "roleCodes")
	return map[string]Theme{"ansi": ansiTheme{chrome.GoldenTheme{Codes: codes}}, "plain": plainTheme{}}
}

func eqLines(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s:\n got %q\nwant %q", label, got, want)
	}
}

func TestStyleAndFormat(t *testing.T) {
	g, _ := loadGolden(t)
	themes := themesFor(t, g)
	for _, c := range section[[]struct{ Theme, Spec, Out string }](t, g, "styles") {
		if got := RenderThemeStyle(themes[c.Theme], c.Spec, "txt"); got != c.Out {
			t.Errorf("style %s %q: got %q want %q", c.Theme, c.Spec, got, c.Out)
		}
	}
	for _, c := range section[[]struct{ Text, Out string }](t, g, "bashLabels") {
		if got := BashModeLabel(c.Text); got != c.Out {
			t.Errorf("bash %q: %q want %q", c.Text, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Value float64
		Out   string
	}](t, g, "counts") {
		if got := FormatCount(c.Value); got != c.Out {
			t.Errorf("count %v: %q want %q", c.Value, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Ms  float64
		Out string
	}](t, g, "durations") {
		if got := FormatElapsedDuration(c.Ms); got != c.Out {
			t.Errorf("duration %v: %q want %q", c.Ms, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Percent    any
		Thresholds ContextThresholds
		Out        string
	}](t, g, "tiers") {
		var p *float64
		switch v := c.Percent.(type) {
		case float64:
			p = &v
		case string:
			nan := math.NaN()
			p = &nan
		}
		if got := ContextColorTier(p, c.Thresholds); got != c.Out {
			t.Errorf("tier %v: %q want %q", c.Percent, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Percent float64
		Width   int
		ASCII   bool
		Out     string
	}](t, g, "gauges") {
		if got := BuildContextGauge(c.Percent, c.Width, c.ASCII); got != c.Out {
			t.Errorf("gauge %v: %q want %q", c, got, c.Out)
		}
	}
	for i, c := range section[[]struct {
		Entries []map[string]any
		Totals  UsageTotals
		Cost    string
	}](t, g, "usageCases") {
		got := ComputeUsageTotals(c.Entries)
		if got != c.Totals || BuildCostLabel(got) != c.Cost {
			t.Errorf("usage %d: %+v %q want %+v %q", i, got, BuildCostLabel(got), c.Totals, c.Cost)
		}
	}
	for _, c := range section[[]struct{ Cwd, Mode, ProjectRoot, Out string }](t, g, "cwdLabels") {
		if got := FormatCwdLabel(c.Cwd, c.Mode, c.ProjectRoot, fixtureHome); got != c.Out {
			t.Errorf("cwd %+v: %q want %q", c, got, c.Out)
		}
	}
}

func styleFor(t *testing.T, g goldenFile, variant string) Style {
	variants := section[map[string]map[string]any](t, g, "styleVariants")
	s := DefaultStyle
	raw, _ := json.Marshal(variants[variant])
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRendersMatchTypeScript(t *testing.T) {
	g, _ := loadGolden(t)
	themes := themesFor(t, g)
	if def := section[Style](t, g, "defaultStyle"); def != DefaultStyle {
		t.Fatalf("default style %+v want %+v", DefaultStyle, def)
	}
	metadatas := section[map[string]Metadata](t, g, "metadatas")
	renders := section[[]struct {
		Metadata, Style, InputText, Theme string
		EditorLines, PanelLines           []string
		Viewport                          *Viewport
		Width                             int
		Out                               []string
	}](t, g, "renders")
	for _, c := range renders {
		got := RenderMinimalistFrame(RenderInput{
			Width: c.Width, EditorLines: c.EditorLines, PanelLines: c.PanelLines, Viewport: c.Viewport,
			InputText: c.InputText, Metadata: metadatas[c.Metadata], Theme: themes[c.Theme], Style: styleFor(t, g, c.Style), Home: fixtureHome,
		})
		eqLines(t, fmt.Sprintf("render %s/%s/%q w%d", c.Metadata, c.Style, c.InputText, c.Width), got, c.Out)
	}
	for _, c := range section[[]struct {
		Line, Direction string
		Out             *struct{ Count string }
	}](t, g, "borderRules") {
		count, ok := ParseBaseBorderRule(c.Line, c.Direction == "above")
		if ok != (c.Out != nil) || (ok && count != c.Out.Count) {
			t.Errorf("rule %q %s: %q %v want %+v", c.Line, c.Direction, count, ok, c.Out)
		}
	}
}

// recordedBase replays a scripted base editor's recorded renders.
type recordedBase struct {
	spec struct {
		Lines        []string
		PaddingX     int
		Autocomplete []string
		Text         *string
		Unframed     bool
	}
	renders, unframed map[int][]string
}

func (b *recordedBase) Render(width int) []string {
	out, ok := b.renders[width]
	if !ok {
		panic(fmt.Sprintf("no recorded render at %d", width))
	}
	return out
}
func (b *recordedBase) HasUnframed() bool { return b.spec.Unframed }
func (b *recordedBase) RenderUnframed(width int) []string {
	out, ok := b.unframed[width]
	if !ok {
		panic(fmt.Sprintf("no recorded unframed render at %d", width))
	}
	return out
}
func (b *recordedBase) Text() string {
	if b.spec.Text != nil {
		return *b.spec.Text
	}
	return strings.Join(b.spec.Lines, "\n")
}
func (b *recordedBase) ShowingAutocomplete() bool { return b.spec.Autocomplete != nil }
func (b *recordedBase) PaddingX() int             { return b.spec.PaddingX }

func TestEditorMatchesTypeScript(t *testing.T) {
	g, _ := loadGolden(t)
	themes := themesFor(t, g)
	ResetForTest()
	SetMetadataContributor("mode", func() Contribution { return Contribution{Mode: &Pill{"▶", "Auto", "accent"}} })
	defer ResetForTest()
	meta := Metadata{Cwd: "/repo/app", Branch: "main", ModelLabel: "m1", ThinkingLevel: "medium", ContextPercent: ptr(12.0), SessionName: "s"}
	cases := section[[]struct {
		Spec       json.RawMessage
		PanelLines []string
		Width      int
		Calls      []struct {
			Op    string
			Width int
			Out   []string
		}
		FrameChrome []bool
		Out         []string
	}](t, g, "editors")
	for _, c := range cases {
		base := &recordedBase{renders: map[int][]string{}, unframed: map[int][]string{}}
		if err := json.Unmarshal(c.Spec, &base.spec); err != nil {
			t.Fatal(err)
		}
		for _, call := range c.Calls {
			if call.Op == "render" {
				base.renders[call.Width] = call.Out
			} else {
				base.unframed[call.Width] = call.Out
			}
		}
		panel := c.PanelLines
		got := RenderEditor(base, c.Width, EditorOptions{
			Theme: themes["ansi"], Style: DefaultStyle, Home: fixtureHome,
			GetMetadata:   func() Metadata { return meta },
			GetPanelLines: func() []string { return panel },
		})
		eqLines(t, fmt.Sprintf("editor %s panel%d w%d", c.Spec, len(c.PanelLines), c.Width), got, c.Out)
	}
}

func ptr[T any](v T) *T { return &v }

func TestProtocolMatchesTypeScript(t *testing.T) {
	g, _ := loadGolden(t)
	steps := section[[]struct {
		Op     string
		Merged Contribution
		Panel  []string
	}](t, g, "protocolSteps")
	ResetForTest()
	defer ResetForTest()
	run := []func(){
		func() {
			SetMetadataContributor("mode", func() Contribution { return Contribution{Mode: &Pill{"●", "Default", "muted"}} })
		},
		func() {
			SetMetadataContributor("quota", func() Contribution { return Contribution{Quota: &Tinted{"q", "muted"}} })
		},
		func() { SetMetadataContributor("bad", func() Contribution { panic("broken") }) },
		func() {
			SetMetadataContributor("override", func() Contribution { return Contribution{Mode: &Pill{"▶", "Auto", "accent"}} })
		},
		func() {
			SetMetadataContributor("mode", func() Contribution { return Contribution{Mode: &Pill{"?", "Ask", "accent"}} })
		},
		func() { SetMetadataContributor("override", nil) },
		func() { SetQueuePanelLinesProvider(func() []string { return []string{"row"} }) },
		func() { SetQueuePanelLinesProvider(func() []string { panic("x") }) },
		func() {
			for _, k := range []string{"mode", "quota", "bad"} {
				SetMetadataContributor(k, nil)
			}
			SetQueuePanelLinesProvider(nil)
		},
	}
	if len(run) != len(steps) {
		t.Fatalf("%d steps, golden has %d", len(run), len(steps))
	}
	for i, step := range steps {
		run[i]()
		if got := ContributedMetadata(); !reflect.DeepEqual(got, step.Merged) {
			t.Errorf("%s: %+v want %+v", step.Op, got, step.Merged)
		}
		if got := QueuePanelLines(); len(got)+len(step.Panel) > 0 && !reflect.DeepEqual(got, step.Panel) {
			t.Errorf("%s panel: %q want %q", step.Op, got, step.Panel)
		}
	}
	if Probe() != (Capability{}) {
		t.Error("probe before SetSupported")
	}
	SetSupported(true)
	SetActive(true)
	if Probe() != (Capability{Supported: true, Active: true, Version: 1}) {
		t.Errorf("probe %+v", Probe())
	}
}

func TestGitMatchesTypeScript(t *testing.T) {
	g, _ := loadGolden(t)
	for _, c := range section[[]struct {
		Stdout string
		Out    GitStatus
	}](t, g, "gitParses") {
		if got := ParseGitStatus(c.Stdout); got != c.Out {
			t.Errorf("parse %q: %+v want %+v", c.Stdout, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Name     string
		Commands []struct {
			Args           []string
			OK             bool
			Stdout, Stderr string
		}
		Out GitReadResult
	}](t, g, "gitReads") {
		run := func(cwd string, args ...string) (string, string, error) {
			for _, cmd := range c.Commands {
				if reflect.DeepEqual(cmd.Args, args) {
					if cmd.OK {
						return cmd.Stdout, "", nil
					}
					return cmd.Stdout, "Command failed: git " + strings.Join(args, " ") + "\n" + cmd.Stderr, errors.New("exit")
				}
			}
			t.Fatalf("unexpected git %v", args)
			return "", "", nil
		}
		if got := ReadGitStatus("dir", run); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("read %s: %+v want %+v", c.Name, got, c.Out)
		}
	}
}

func TestCodexMatchesTypeScript(t *testing.T) {
	g, _ := loadGolden(t)
	for _, c := range section[[]struct {
		Value any
		Out   *CodexQuota
	}](t, g, "codexParses") {
		if got := ParseCodexQuota(c.Value); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("parse %v: %+v want %+v", c.Value, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Quota *CodexQuota
		Text  string
		Role  *string
	}](t, g, "codexTexts") {
		if got := CodexQuotaText(c.Quota); got != c.Text {
			t.Errorf("text %+v: %q want %q", c.Quota, got, c.Text)
		}
		if c.Quota != nil && CodexQuotaRole(*c.Quota) != *c.Role {
			t.Errorf("role %+v: %q want %q", c.Quota, CodexQuotaRole(*c.Quota), *c.Role)
		}
	}
	for _, c := range section[[]struct {
		URL string
		Out bool
	}](t, g, "codexUrls") {
		got := HasNativeCodexRoute(&CodexModel{"openai-codex", "openai-codex-responses", c.URL}, &CodexProvider{"openai-codex", c.URL})
		if got != c.Out {
			t.Errorf("url %q: %v want %v", c.URL, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Name     string
		Model    *CodexModel
		Provider *CodexProvider
		Out      bool
	}](t, g, "routeCases") {
		if got := HasNativeCodexRoute(c.Model, c.Provider); got != c.Out {
			t.Errorf("route %s: %v want %v", c.Name, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Value *string
		Next  float64
	}](t, g, "retryDelays") {
		v := ""
		if c.Value != nil {
			v = *c.Value
		}
		if got := CodexRetryDelay(v, nowMs, ParseHTTPDate); got != c.Next {
			t.Errorf("retry %q: %v want %v", v, got, c.Next)
		}
	}
	for _, c := range section[[]struct {
		Token   string
		Headers map[string]string
	}](t, g, "accountIds") {
		if got, want := CodexAccountID(c.Token), c.Headers["ChatGPT-Account-Id"]; got != want {
			t.Errorf("account %q: %q want %q", c.Token, got, want)
		}
	}
	for _, c := range section[[]collectorCase](t, g, "collectors") {
		runCollectorCase(t, c)
	}
}

const nowMs = 1_700_000_000_000

type fetchStep struct {
	Status     *int
	Body       json.RawMessage
	RawBody    *string
	RetryAfter *string
	Throws     *string
}

type collectorCase struct {
	Name    string
	Options struct {
		Token       json.RawMessage
		TokenThrows bool
		Route       *bool
		Fetches     []fetchStep
		Advance     []float64 `json:"advanceBefore"`
	}
	Requests []struct {
		URL     string
		Headers map[string]string
	}
	Steps []struct {
		Op      string
		Advance float64
		Get     *CodexQuota
		Next    *float64
	}
	Changed int
}

func runCollectorCase(t *testing.T, c collectorCase) {
	t.Helper()
	clock := float64(nowMs)
	route := c.Options.Route == nil || *c.Options.Route
	token := "h." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct_123-AB"}}`)) + ".s"
	switch string(c.Options.Token) {
	case "":
	case "null":
		token = ""
	default:
		if err := json.Unmarshal(c.Options.Token, &token); err != nil {
			t.Fatal(err)
		}
	}
	changed := 0
	var requests []struct {
		URL     string
		Headers map[string]string
	}
	fetchIndex := 0
	var pending []func()
	collector := NewCodexCollector(CodexDeps{
		Route: func() bool { return route },
		Token: func(context.Context) (string, error) {
			if c.Options.TokenThrows {
				return "", errors.New("auth failed")
			}
			return token, nil
		},
		Fetch: func(_ context.Context, url string, headers map[string]string) (CodexResponse, error) {
			step := fetchStep{}
			if fetchIndex < len(c.Options.Fetches) {
				step = c.Options.Fetches[fetchIndex]
			} else {
				s := 500
				step.Status = &s
			}
			fetchIndex++
			requests = append(requests, struct {
				URL     string
				Headers map[string]string
			}{url, headers})
			if step.Throws != nil {
				return CodexResponse{}, errors.New(*step.Throws)
			}
			status := 200
			if step.Status != nil {
				status = *step.Status
			}
			body := []byte(step.Body)
			if step.RawBody != nil {
				body = []byte(*step.RawBody)
			}
			retry := ""
			if step.RetryAfter != nil {
				retry = *step.RetryAfter
			}
			return CodexResponse{Status: status, RetryAfter: retry, Body: body}, nil
		},
		Changed: func() { changed++ },
		Now:     func() float64 { return clock },
		After:   func(float64, func()) func() { return func() {} },
		Go:      func(fn func()) { pending = append(pending, fn) },
	})
	drain := func() {
		for len(pending) > 0 {
			fn := pending[0]
			pending = pending[1:]
			fn()
		}
	}
	check := func(i int, get *CodexQuota, next *float64) {
		want := c.Steps[i]
		if !reflect.DeepEqual(get, want.Get) {
			t.Errorf("%s step %d (%s): get %+v want %+v", c.Name, i, want.Op, get, want.Get)
		}
		if want.Next != nil && next != nil && *next != *want.Next {
			t.Errorf("%s step %d (%s): next %v want %v", c.Name, i, want.Op, *next, *want.Next)
		}
	}
	collector.Reconcile()
	drain()
	next := collector.NextRefresh() - clock
	check(0, collector.Get(), &next)
	step := 1
	for i := 1; i < len(c.Options.Fetches); i++ {
		advance := 60_000.0
		if i < len(c.Options.Advance) {
			advance = c.Options.Advance[i]
		}
		clock += advance
		collector.refresh()
		next := collector.NextRefresh() - clock
		check(step, collector.Get(), &next)
		step++
	}
	clock += 120_000
	check(step, collector.Get(), nil)
	route = false
	check(step+1, collector.Get(), nil)
	collector.Stop()
	if len(requests) != len(c.Requests) {
		t.Errorf("%s: %d requests want %d", c.Name, len(requests), len(c.Requests))
	} else {
		for i := range requests {
			if requests[i].URL != c.Requests[i].URL || !reflect.DeepEqual(requests[i].Headers, c.Requests[i].Headers) {
				t.Errorf("%s request %d: %+v want %+v", c.Name, i, requests[i], c.Requests[i])
			}
		}
	}
	if changed != c.Changed {
		t.Errorf("%s: changed %d want %d", c.Name, changed, c.Changed)
	}
}

func TestRegistrarMatchesTypeScript(t *testing.T) {
	g, _ := loadGolden(t)
	themes := themesFor(t, g)
	ResetForTest()
	defer ResetForTest()
	steps := section[[]struct {
		Op     string
		Clock  float64
		Probe  Capability
		Render []string
	}](t, g, "registrar")
	usage := section[[]struct {
		Entries []map[string]any
	}](t, g, "usageCases")[0].Entries
	host := HostSnapshot{Cwd: fixtureHome + "/projects/app", ModelID: "m1", ThinkingLevel: "high", ContextPercent: ptr(25.0), SessionName: "named session", Entries: usage}
	var s Session
	installed, shut := false, false
	SetSupported(true)
	base := &recordedBase{renders: map[int][]string{}, unframed: map[int][]string{}}
	base.spec.Lines = []string{"draft text"}
	base.spec.PaddingX = 1
	base.renders[68] = []string{strings.Repeat("─", 68), " draft text" + strings.Repeat(" ", 56) + " ", strings.Repeat("─", 68)}
	render := func(now float64) []string {
		if !installed {
			return nil
		}
		meta := func() Metadata {
			if shut {
				return Metadata{}
			}
			return s.Metadata(host, now, nil)
		}
		return RenderEditor(base, 72, EditorOptions{Theme: themes["ansi"], Style: DefaultStyle, Home: fixtureHome, GetMetadata: meta})
	}
	ops := map[string]func(){
		"registered": func() {},
		"session_start": func() {
			s.Reset()
			s.SetGit(GitStatus{Branch: "main", Dirty: true, Ahead: 1})
			installed = true
			SetActive(true)
		},
		"agent running 65s": func() {
			s.AgentStart(nowMs + 1000)
		},
		"thinking off, 80%": func() { host.ThinkingLevel = "off"; host.ContextPercent = ptr(80.0) },
		"agent_end":         func() { s.AgentEnd() },
		"idle later":        func() {},
		"no model":          func() { host.ModelID = ""; host.SessionName = ""; host.ContextPercent = nil },
		"shutdown":          func() { s.Reset(); SetActive(false); shut = true },
	}
	for _, step := range steps {
		op, ok := ops[step.Op]
		if !ok {
			t.Fatalf("unknown step %q", step.Op)
		}
		op()
		if got := Probe(); got != step.Probe {
			t.Errorf("%s probe %+v want %+v", step.Op, got, step.Probe)
		}
		eqLines(t, step.Op, render(nowMs+step.Clock), step.Render)
	}
}
