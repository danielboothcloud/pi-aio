package statusline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	pm "github.com/danielboothcloud/pi-aio/go/internal/permissionmodes"
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

// root is the fixture placeholder; fixture files no longer exist, so loads
// are rebuilt in a temporary folder from the recorded settings below.
const root = "@@ROOT@@"

type plainTheme struct{}

func (plainTheme) Fg(_, text string) string { return text }

// endpointFromJSON parses one recorded provider config with its windows in
// JavaScript key order.
func endpointFromJSON(t *testing.T, raw json.RawMessage) EndpointConfig {
	t.Helper()
	wrapped := json.RawMessage(`{"providers":{"p":` + string(raw) + `}}`)
	parsed := parseProviderUsage(wrapped)
	if parsed == nil {
		t.Fatalf("cannot parse %s", raw)
	}
	return parsed.parsed["p"]
}

func TestConfigLoadsMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	configDir := section[string](t, g, "configDirName")
	loads := section[[]struct {
		Global, Project string
		IncludeProject  bool
		AgentDir, Cwd   string
		Config          json.RawMessage
		Windows         map[string][]UsageWindow
	}](t, g, "loads")
	settings := section[struct{ Global, Project map[string]string }](t, g, "settingsFiles")
	tmp := t.TempDir()
	for i, l := range loads {
		agentDir := strings.ReplaceAll(l.AgentDir, root, tmp)
		cwd := strings.ReplaceAll(l.Cwd, root, tmp)
		if !strings.Contains(l.AgentDir, "missing") {
			writeFixture(t, filepath.Join(agentDir, "settings.json"), settings.Global[l.Global])
			if p, ok := settings.Project[l.Project]; ok {
				writeFixture(t, filepath.Join(cwd, configDir, "settings.json"), p)
			}
		}
		got := Load(cwd, LoadOptions{ExcludeProject: !l.IncludeProject, AgentDir: agentDir, ConfigDirName: configDir})
		var want Config
		if err := json.Unmarshal(l.Config, &want); err != nil {
			t.Fatal(err)
		}
		// Windows are compared in order below; the config JSON object has none.
		gotCmp := got
		if gotCmp.ProviderUsage != nil {
			cp := *gotCmp.ProviderUsage
			cp.Providers = map[string]EndpointConfig{}
			for id, c := range got.ProviderUsage.Providers {
				c.Windows = nil
				cp.Providers[id] = c
			}
			gotCmp.ProviderUsage = &cp
			for id, c := range want.ProviderUsage.Providers {
				c.Windows = nil
				want.ProviderUsage.Providers[id] = c
			}
		}
		if !reflect.DeepEqual(gotCmp, want) {
			t.Errorf("load %d %s/%s project=%v:\n got %+v\nwant %+v", i, l.Global, l.Project, l.IncludeProject, gotCmp, want)
		}
		for id, windows := range l.Windows {
			var c EndpointConfig
			if got.ProviderUsage != nil {
				c = got.ProviderUsage.Providers[id]
			}
			if gw := Windows(c); !reflect.DeepEqual(gw, windows) && !(len(gw) == 0 && len(windows) == 0) {
				t.Errorf("load %d windows %s: %+v want %+v", i, id, gw, windows)
			}
		}
	}
}

func writeFixture(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	var data []byte
	if s, ok := value.(string); ok {
		data = []byte(s)
	} else {
		var err error
		if data, err = json.MarshalIndent(value, "", "  "); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRendersMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	codes := section[map[string]int](t, g, "roleCodes")
	themes := map[string]Theme{"ansi": chrome.GoldenTheme{Codes: codes}, "plain": plainTheme{}}
	statusSets := section[map[string][][2]string](t, g, "statusSets")
	usages := section[map[string][]ProviderUsage](t, g, "providerUsages")
	inputs := section[map[string]struct {
		Config         Config
		Cwd            string
		Model          *Model
		Mode           string
		GitBranch      *string
		ContextPercent int
		Statuses       string
		UsageStats     UsageStats
		ProviderUsage  string
	}](t, g, "renderInputs")
	now := section[float64](t, g, "now")
	home := section[string](t, g, "home")
	for _, c := range section[[]struct {
		Name, Theme string
		Width       int
		Out         []string
	}](t, g, "renders") {
		in := inputs[c.Name]
		var statuses []Status
		for _, kv := range statusSets[in.Statuses] {
			statuses = append(statuses, Status{kv[0], kv[1]})
		}
		meta := pm.ModeMetadata(pm.Mode(in.Mode))
		branch := ""
		if in.GitBranch != nil {
			branch = *in.GitBranch
		}
		got := Render(RenderInput{
			Width: c.Width, Theme: themes[c.Theme], Config: in.Config, Cwd: in.Cwd, Model: in.Model,
			Mode: ModeMeta{meta.Icon, meta.Label, meta.Role}, GitBranch: branch, ContextPercent: in.ContextPercent,
			Statuses: statuses, Usage: in.UsageStats, ProviderUsage: usages[in.ProviderUsage], Home: home, Now: now,
		})
		if !reflect.DeepEqual(got, c.Out) {
			t.Errorf("render %s/%s w%d:\n got %q\nwant %q", c.Name, c.Theme, c.Width, got, c.Out)
		}
	}
}

func TestStatsMatchTypeScript(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct {
		Usage *struct{ Tokens, ContextWindow *float64 }
		Out   int
	}](t, g, "contextPercents") {
		var tokens, window *float64
		if c.Usage != nil {
			tokens, window = c.Usage.Tokens, c.Usage.ContextWindow
		}
		if got := ContextPercent(tokens, window); got != c.Out {
			t.Errorf("context %+v: %d want %d", c.Usage, got, c.Out)
		}
	}
	stats := section[struct {
		Branch []map[string]any
		Out    UsageStats
	}](t, g, "usageStats")
	if got := ComputeUsageStats(stats.Branch); got != stats.Out {
		t.Errorf("usage stats %+v want %+v", got, stats.Out)
	}
	for _, c := range section[[]struct {
		Mode  string
		Stats struct {
			Input, Output, Cost, ElapsedSec, TPS float64
			ContextPercent                       int
		}
		Out *string
	}](t, g, "working") {
		got, ok := FormatWorkingMessage(c.Mode, WorkingStats{UsageStats: UsageStats{c.Stats.Input, c.Stats.Output, c.Stats.Cost}, ContextPercent: c.Stats.ContextPercent, ElapsedSec: c.Stats.ElapsedSec, TPS: c.Stats.TPS})
		if ok != (c.Out != nil) || (ok && got != *c.Out) {
			t.Errorf("working %s: %q want %v", c.Mode, got, c.Out)
		}
	}
}

func TestProviderUsageMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	var payload any
	if err := json.Unmarshal(g["payload"], &payload); err != nil {
		t.Fatal(err)
	}
	for _, c := range section[[]struct {
		Mapping UsageMapping
		Label   *string
		Out     *ProviderUsage
	}](t, g, "mapped") {
		label := ""
		if c.Label != nil {
			label = *c.Label
		}
		if got := MapProviderUsage("prov", label, c.Mapping, payload); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("map %+v: %s want %s", c.Mapping, js(got), js(c.Out))
		}
	}
	env := map[string]string{"UL_TOKEN": "tok", "UL_EMPTY": ""}
	getenv := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	for _, c := range section[[]struct {
		Value string
		Out   *string
	}](t, g, "templates") {
		got, ok := ResolveEnvironmentTemplate(c.Value, getenv)
		if ok != (c.Out != nil) || (ok && got != *c.Out) {
			t.Errorf("template %q: %q %v want %v", c.Value, got, ok, c.Out)
		}
	}
	tmp := t.TempDir()
	writeFixture(t, filepath.Join(tmp, "auth", "auth.json"), map[string]any{"anthropic": map[string]any{"type": "oauth", "access": "acc-123"}, "key": map[string]any{"type": "api_key", "key": "k"}, "blank": map[string]any{"type": "oauth", "access": "   "}, "num": map[string]any{"type": "oauth", "access": 5}})
	writeFixture(t, filepath.Join(tmp, "badauth", "auth.json"), "[oops")
	for _, c := range section[[]struct {
		Account, Dir string
		Out          *string
	}](t, g, "tokens") {
		want := ""
		if c.Out != nil {
			want = *c.Out
		}
		if got := ReadPiOAuthToken(c.Account, strings.ReplaceAll(c.Dir, root, tmp)); got != want {
			t.Errorf("token %s %s: %q want %q", c.Account, c.Dir, got, want)
		}
	}
	for _, c := range section[[]struct {
		Name, Provider string
		Config         json.RawMessage
		Reply          struct {
			Status *int
			Body   json.RawMessage
			Raw    *string
			Throws *string
		}
		Token    *string
		Requests []struct {
			URL, Method string
			Headers     map[string]string
		}
		Out   []ProviderUsage
		Error *string
	}](t, g, "fetches") {
		var requests []struct {
			URL, Method string
			Headers     map[string]string
		}
		deps := FetchDeps{
			Getenv: getenv,
			ResolveToken: func(string) string {
				if c.Token == nil {
					return ""
				}
				return *c.Token
			},
			Request: func(_ context.Context, method, url string, headers map[string]string) (Response, error) {
				requests = append(requests, struct {
					URL, Method string
					Headers     map[string]string
				}{url, method, headers})
				if c.Reply.Throws != nil {
					return Response{}, errors.New(*c.Reply.Throws)
				}
				status := 200
				if c.Reply.Status != nil {
					status = *c.Reply.Status
				}
				body := []byte(c.Reply.Body)
				if c.Reply.Raw != nil {
					body = []byte(*c.Reply.Raw)
				}
				return Response{Status: status, Body: body}, nil
			},
		}
		got, err := FetchProviderUsage(context.Background(), c.Provider, endpointFromJSON(t, c.Config), 1000, deps)
		switch {
		case c.Error != nil && err == nil:
			t.Errorf("fetch %s: no error, want %q", c.Name, *c.Error)
		case c.Error == nil && err != nil:
			t.Errorf("fetch %s: error %v", c.Name, err)
		case c.Error != nil && c.Name != "bad json" && err.Error() != *c.Error:
			t.Errorf("fetch %s: error %q want %q", c.Name, err, *c.Error)
		}
		if !reflect.DeepEqual(got, c.Out) && !(len(got) == 0 && len(c.Out) == 0) {
			t.Errorf("fetch %s: %s want %s", c.Name, js(got), js(c.Out))
		}
		if !reflect.DeepEqual(requests, c.Requests) && !(len(requests) == 0 && len(c.Requests) == 0) {
			t.Errorf("fetch %s requests: %+v want %+v", c.Name, requests, c.Requests)
		}
	}
	now := section[float64](t, g, "now")
	for _, c := range section[[]struct {
		Usage ProviderUsage
		Out   string
	}](t, g, "formats") {
		if got := FormatProviderUsage(c.Usage, now); got != c.Out {
			t.Errorf("format %+v: %q want %q", c.Usage, got, c.Out)
		}
	}
	for _, c := range section[[]struct {
		Usages []ProviderUsage
		Out    *struct{ Text, Role string }
	}](t, g, "lines") {
		text, role, ok := UsageLine(c.Usages, now)
		if ok != (c.Out != nil) || (ok && (text != c.Out.Text || role != c.Out.Role)) {
			t.Errorf("line %d usages: %q %q want %+v", len(c.Usages), text, role, c.Out)
		}
	}
}

func js(v any) string {
	b, _ := json.Marshal(v)
	return fmt.Sprint(string(b))
}
