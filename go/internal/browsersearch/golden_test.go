package browsersearch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ---------------------------------------------------------------------------
// Golden loading and placeholders
// ---------------------------------------------------------------------------

type goldenFile map[string]json.RawMessage

type env struct {
	t      *testing.T
	golden goldenFile
	root   string
	port   string
	server *scriptServer
	repo   string
}

var (
	envOnce sync.Once
	shared  *env
)

func setup(t *testing.T) *env {
	t.Helper()
	root := t.TempDir()
	srv := newScriptServer()
	t.Cleanup(srv.Close)
	repo, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	e := &env{t: t, root: root, server: srv, repo: repo}
	e.port = srv.port
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	text = strings.ReplaceAll(text, "@@PORT@@", e.port)
	text = strings.ReplaceAll(text, "@@ROOT@@", root)
	text = strings.ReplaceAll(text, "@@REPO@@", repo)
	if err := json.Unmarshal([]byte(text), &e.golden); err != nil {
		t.Fatal(err)
	}
	return e
}

func section[T any](t *testing.T, g goldenFile, name string) T {
	t.Helper()
	var v T
	raw, ok := g[name]
	if !ok {
		t.Fatalf("golden.json has no %s", name)
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

// jsonEqual compares got (marshalled) with the golden JSON value.
func jsonEqual(t *testing.T, label string, got any, want json.RawMessage) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("%s: marshal: %v", label, err)
	}
	var g, w any
	_ = json.Unmarshal(data, &g)
	_ = json.Unmarshal(want, &w)
	if !reflect.DeepEqual(g, w) {
		t.Errorf("%s:\n got %s\nwant %s", label, data, want)
	}
}

func (e *env) lookup() LookupEnv {
	m := section[map[string]string](e.t, e.golden, "env")
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

type stubResolver map[string][]Address

func (s stubResolver) Lookup(_ context.Context, host string) ([]Address, error) {
	rows, ok := s[host]
	if !ok {
		return nil, fmt.Errorf("getaddrinfo ENOTFOUND %s", host)
	}
	return rows, nil
}

func (e *env) runtime(sleeps *[]int) *Runtime {
	lookup := e.lookup()
	rt := NewRuntime(LoadEnv(lookup))
	rt.Getenv = lookup
	rt.Resolver = section[stubResolver](e.t, e.golden, "dnsTable")
	now := section[int64](e.t, e.golden, "now")
	rt.Now = func() time.Time { return time.UnixMilli(now) }
	rt.Sleep = func(ctx context.Context, ms int) error {
		*sleeps = append(*sleeps, ms)
		return aborted(ctx)
	}
	rt.Stderr = io.Discard
	// The golden cases stop at the Camofox container (TypeScript's next
	// tier, CloakBrowser, is not in the Go port). The Go-only tiers must
	// never run here: they fail the test and never reach a network.
	rt.Worker = &forbiddenWorker{t: e.t}
	rt.FallbackTransport = forbiddenTransport{t: e.t}
	return rt
}

type forbiddenWorker struct{ t *testing.T }

func (w *forbiddenWorker) Fetch(_ context.Context, req WorkerRequest, _ func(Progress)) (WorkerResponse, error) {
	w.t.Errorf("golden case reached the Camoufox worker for %s", req.URL)
	return WorkerResponse{}, fmt.Errorf("worker disabled")
}

func (w *forbiddenWorker) Shutdown() {}

type forbiddenTransport struct{ t *testing.T }

func (f forbiddenTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	f.t.Errorf("golden case reached the HTTP fallback for %s", req.URL)
	return nil, fmt.Errorf("network disabled")
}

// ---------------------------------------------------------------------------
// Scripted local server (the generator's createServer)
// ---------------------------------------------------------------------------

type reply struct {
	Status      int    `json:"status"`
	Body        string `json:"body"`
	DelayMs     int    `json:"delayMs"`
	ContentType string `json:"contentType"`
}

type logged struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type scriptServer struct {
	*httptest.Server
	port    string
	mu      sync.Mutex
	queue   []reply
	log     []logged
	escaped string
}

func newScriptServer() *scriptServer {
	s := &scriptServer{}
	quoted := jsstr.QuoteJS(ReadabilitySource)
	s.escaped = quoted[1 : len(quoted)-1]
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	s.port = s.Server.URL[strings.LastIndex(s.Server.URL, ":")+1:]
	return s
}

func (s *scriptServer) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	headers := map[string]string{}
	for _, name := range []string{"content-type", "x-api-key", "authorization"} {
		if v := r.Header.Get(name); v != "" {
			headers[name] = v
		}
	}
	s.mu.Lock()
	s.log = append(s.log, logged{r.Method, r.RequestURI, headers, strings.ReplaceAll(string(body), s.escaped, "@@READABILITY@@")})
	rep := reply{Status: 404, Body: `{"error":"unscripted"}`}
	if len(s.queue) > 0 {
		rep, s.queue = s.queue[0], s.queue[1:]
	}
	s.mu.Unlock()
	if rep.DelayMs > 0 {
		time.Sleep(time.Duration(rep.DelayMs) * time.Millisecond)
	}
	ct := rep.ContentType
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("content-type", ct)
	status := rep.Status
	if status == 0 {
		status = 200
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, rep.Body)
}

// scriptedCase is the shared part of every scripted golden case.
type scriptedCase struct {
	Name     string          `json:"name"`
	Replies  []reply         `json:"replies"`
	Out      json.RawMessage `json:"out"`
	Error    *struct{ Name, Message string }
	Requests json.RawMessage `json:"requests"`
	Sleeps   []int           `json:"sleeps"`
	Unused   int             `json:"unused"`
}

// run replays c.Replies around fn and compares the result, the requests,
// the sleeps, and the unused reply count.
func (e *env) run(t *testing.T, c scriptedCase, sleeps *[]int, fn func() (any, error)) {
	t.Helper()
	s := e.server
	s.mu.Lock()
	s.queue = append([]reply{}, c.Replies...)
	s.log = nil
	s.mu.Unlock()
	*sleeps = []int{}
	got, err := fn()
	time.Sleep(20 * time.Millisecond)
	if c.Error != nil {
		if err == nil {
			t.Errorf("%s: got no error, want %q", c.Name, c.Error.Message)
		} else if err.Error() != c.Error.Message {
			t.Errorf("%s: error\n got %q\nwant %q", c.Name, err.Error(), c.Error.Message)
		}
	} else if err != nil {
		t.Errorf("%s: unexpected error %v", c.Name, err)
	} else {
		jsonEqual(t, c.Name+" out", got, c.Out)
	}
	s.mu.Lock()
	log, unused := s.log, len(s.queue)
	s.mu.Unlock()
	if log == nil {
		log = []logged{}
	}
	jsonEqual(t, c.Name+" requests", log, c.Requests)
	if !reflect.DeepEqual(*sleeps, c.Sleeps) {
		t.Errorf("%s: sleeps %v, want %v", c.Name, *sleeps, c.Sleeps)
	}
	if unused != c.Unused {
		t.Errorf("%s: unused replies %d, want %d", c.Name, unused, c.Unused)
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestReadabilityEmbed(t *testing.T) {
	e := setup(t)
	want := section[struct {
		Sha256 string
		Length int
	}](t, e.golden, "readability")
	sum := sha256.Sum256([]byte(ReadabilitySource))
	if hex.EncodeToString(sum[:]) != want.Sha256 || jsstr.Len16(ReadabilitySource) != want.Length {
		t.Fatalf("embedded Readability.js differs from @mozilla/readability")
	}
}

func TestEnv(t *testing.T) {
	e := setup(t)
	cases := section[[]struct {
		Env map[string]string
		Out json.RawMessage
	}](t, e.golden, "envCases")
	for i, c := range cases {
		got := LoadEnv(func(k string) (string, bool) { v, ok := c.Env[k]; return v, ok })
		jsonEqual(t, fmt.Sprintf("env %d", i), got, c.Out)
	}
	jsonEqual(t, "main env", LoadEnv(e.lookup()), e.golden["mainEnv"])
}

func TestResolveConfig(t *testing.T) {
	e := setup(t)
	cases := section[[]struct {
		Global, Project map[string]any
		Out             json.RawMessage
	}](t, e.golden, "resolveCases")
	for i, c := range cases {
		jsonEqual(t, fmt.Sprintf("resolve %d", i), ResolveConfig(c.Global, c.Project), c.Out)
	}
}

func TestLoadConfig(t *testing.T) {
	e := setup(t)
	cases := section[[]struct {
		Folder          string
		Global, Project *string
		Trusted         bool
		Out             json.RawMessage
		Stderr          []string
	}](t, e.golden, "loadCases")
	for _, c := range cases {
		dir := filepath.Join(e.root, "load", c.Folder)
		cwd, agent := filepath.Join(dir, "work"), filepath.Join(dir, "agent")
		_ = os.MkdirAll(filepath.Join(cwd, ".pi"), 0o755)
		_ = os.MkdirAll(agent, 0o755)
		if c.Global != nil {
			_ = os.WriteFile(filepath.Join(agent, "settings.json"), []byte(*c.Global), 0o644)
		}
		if c.Project != nil {
			_ = os.WriteFile(filepath.Join(cwd, ".pi", "settings.json"), []byte(*c.Project), 0o644)
		}
		var stderr strings.Builder
		got := LoadConfig(agent, ".pi", cwd, c.Trusted, &stderr)
		label := fmt.Sprintf("load %s trusted=%v", c.Folder, c.Trusted)
		jsonEqual(t, label, got, c.Out)
		if want := strings.Join(c.Stderr, ""); stderr.String() != want {
			t.Errorf("%s stderr\n got %q\nwant %q", label, stderr.String(), want)
		}
	}
}

func TestURLValidation(t *testing.T) {
	e := setup(t)
	cases := section[[]struct {
		URL string
		Out json.RawMessage
	}](t, e.golden, "urlCases")
	for _, c := range cases {
		jsonEqual(t, "validateUrl "+c.URL, ValidateURL(c.URL), c.Out)
	}
	resolver := section[stubResolver](t, e.golden, "dnsTable")
	dns := section[[]struct {
		URL string
		Out json.RawMessage
	}](t, e.golden, "dnsCases")
	for _, c := range dns {
		jsonEqual(t, "validateUrlWithDns "+c.URL, ValidateURLWithDNS(context.Background(), resolver, c.URL), c.Out)
	}
}

func TestChallenges(t *testing.T) {
	e := setup(t)
	cases := section[[]struct {
		State ChallengeState
		Out   json.RawMessage
	}](t, e.golden, "challengeCases")
	for i, c := range cases {
		jsonEqual(t, fmt.Sprintf("detect %d", i), DetectChallenge(c.State), c.Out)
	}
	likely := section[[]struct {
		URL     string
		Title   *string
		Content string
		Out     bool
	}](t, e.golden, "likelyCases")
	for i, c := range likely {
		if got := IsLikelyChallengeContent(c.URL, c.Title, c.Content); got != c.Out {
			t.Errorf("likely %d: got %v want %v", i, got, c.Out)
		}
	}
}

func TestSearxng(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	cases := section[[]struct {
		scriptedCase
		Query string
		Opts  SearchOptions
	}](t, e.golden, "searxngCases")
	for _, c := range cases {
		e.run(t, c.scriptedCase, &sleeps, func() (any, error) {
			return rt.SearxngSearch(context.Background(), c.Query, c.Opts)
		})
	}
}

func TestExa(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	cases := section[[]struct {
		scriptedCase
		Query  string
		Opts   SearchOptions
		Config ExaConfig
	}](t, e.golden, "exaCases")
	for _, c := range cases {
		e.run(t, c.scriptedCase, &sleeps, func() (any, error) {
			return rt.ExaSearch(context.Background(), c.Query, c.Opts, c.Config)
		})
	}
}

func TestCamofox(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	cases := section[[]struct {
		scriptedCase
		Op         string
		URLs       []string
		Expression string
	}](t, e.golden, "camofoxCases")
	for _, c := range cases {
		e.run(t, c.scriptedCase, &sleeps, func() (any, error) {
			switch c.Op {
			case "health":
				return rt.CamofoxHealth(context.Background())
			case "evaluate":
				return rt.CamofoxEvaluateURL(context.Background(), c.URLs[0], c.Expression)
			}
			return rt.CamofoxReadability(context.Background(), c.URLs)
		})
	}
}

func TestFetchSingleURL(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	cases := section[[]struct {
		scriptedCase
		URL, Format string
	}](t, e.golden, "fetchCases")
	for _, c := range cases {
		e.run(t, c.scriptedCase, &sleeps, func() (any, error) {
			return rt.FetchSingleURL(context.Background(), c.URL, c.Format)
		})
	}
}

type toolMeta struct {
	Name             string          `json:"name"`
	Label            string          `json:"label"`
	Description      string          `json:"description"`
	PromptSnippet    string          `json:"promptSnippet"`
	PromptGuidelines []string        `json:"promptGuidelines"`
	Parameters       json.RawMessage `json:"parameters"`
}

func TestRegistrations(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	regs := section[[]struct {
		Provider string
		Order    []string
		Tools    []toolMeta
	}](t, e.golden, "registrations")
	for _, r := range regs {
		var order []string
		var tools []Tool
		rt.Register(Dependencies{Provider: r.Provider, Search: func(context.Context, string, SearchOptions) (SearchOutcome, error) { return SearchOutcome{}, nil }}, func(tool Tool) {
			order = append(order, tool.Spec.Name)
			tools = append(tools, tool)
		})
		if !reflect.DeepEqual(order, r.Order) {
			t.Errorf("%s order %v want %v", r.Provider, order, r.Order)
		}
		for i, tool := range tools {
			s := tool.Spec
			w := r.Tools[i]
			if s.Name != w.Name || s.Label != w.Label || s.Description != w.Description || s.PromptSnippet != w.PromptSnippet || !reflect.DeepEqual(s.PromptGuidelines, w.PromptGuidelines) {
				t.Errorf("%s %s metadata differs", r.Provider, s.Name)
			}
			jsonEqual(t, r.Provider+" "+s.Name+" parameters", s.Parameters, w.Parameters)
		}
	}

	deps := section[[]struct {
		Name string
		Deps struct {
			Config   *map[string]any
			Search   bool
			Provider string
		}
		Order        []string
		SessionStart bool
		Description  *string
	}](t, e.golden, "dependencyCases")
	for _, c := range deps {
		d := Dependencies{Provider: c.Deps.Provider}
		if c.Deps.Config != nil {
			cfg := ResolveConfig(map[string]any{"aio": map[string]any{"browserSearch": *c.Deps.Config}}, nil)
			d.Config = &cfg
		}
		if c.Deps.Search {
			d.Search = func(context.Context, string, SearchOptions) (SearchOutcome, error) { return SearchOutcome{}, nil }
		}
		var order []string
		desc := ""
		reg := rt.Register(d, func(tool Tool) {
			order = append(order, tool.Spec.Name)
			if tool.Spec.Name == "web_search" {
				desc = tool.Spec.Description
			}
		})
		if !reflect.DeepEqual(order, c.Order) || (reg.Start != nil) != c.SessionStart || (c.Description != nil && desc != *c.Description) {
			t.Errorf("%s: order %v start %v", c.Name, order, reg.Start != nil)
		}
	}

	sessions := section[[]struct {
		Name            string
		Global, Project map[string]any
		Trusted         bool
		Starts          int
		Before, After   []string
		Description     *string
	}](t, e.golden, "sessionCases")
	for _, c := range sessions {
		dir := filepath.Join(e.root, "session", c.Name)
		agent, cwd := filepath.Join(dir, "agent"), filepath.Join(dir, "work")
		_ = os.MkdirAll(agent, 0o755)
		_ = os.MkdirAll(filepath.Join(cwd, ".pi"), 0o755)
		if c.Global != nil {
			data, _ := json.Marshal(c.Global)
			_ = os.WriteFile(filepath.Join(agent, "settings.json"), data, 0o644)
		}
		if c.Project != nil {
			data, _ := json.Marshal(c.Project)
			_ = os.WriteFile(filepath.Join(cwd, ".pi", "settings.json"), data, 0o644)
		}
		var order []string
		desc := ""
		reg := rt.Register(Dependencies{LoadConfig: func(cwd string, trusted bool) ProviderConfig {
			return LoadConfig(agent, ".pi", cwd, trusted, io.Discard)
		}}, func(tool Tool) {
			order = append(order, tool.Spec.Name)
			if tool.Spec.Name == "web_search" {
				desc = tool.Spec.Description
			}
		})
		before := append([]string{}, order...)
		starts := c.Starts
		if starts == 0 {
			starts = 1
		}
		for i := 0; i < starts; i++ {
			reg.Start(cwd, c.Trusted)
		}
		if !reflect.DeepEqual(before, c.Before) || !reflect.DeepEqual(order, c.After) {
			t.Errorf("%s: before %v after %v, want %v %v", c.Name, before, order, c.Before, c.After)
		}
		if c.Description != nil && desc != *c.Description {
			t.Errorf("%s: description %q", c.Name, desc)
		}
	}
}

type scriptedThrow struct {
	Throw *string `json:"throw"`
}

func TestToolExecutes(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	cases := section[[]struct {
		scriptedCase
		Tool     string
		Provider string
		Params   map[string]any
		Search   map[string]json.RawMessage
		Fetch    map[string]json.RawMessage
		Real     *struct{ Config map[string]any }
		Updates  []struct {
			Content []struct{ Text string }
			Details json.RawMessage
		}
		SearchCalls json.RawMessage
		FetchCalls  json.RawMessage
	}](t, e.golden, "execCases")
	for _, c := range cases {
		var searchCalls, fetchCalls []any
		var deps Dependencies
		if c.Real != nil {
			cfg := ResolveConfig(map[string]any{"aio": map[string]any{"browserSearch": c.Real.Config}}, nil)
			deps.Config = &cfg
			deps.Provider = c.Provider
		} else {
			deps.Provider = c.Provider
			if deps.Provider == "" {
				deps.Provider = "searxng"
			}
			deps.Search = func(_ context.Context, query string, opts SearchOptions) (SearchOutcome, error) {
				searchCalls = append(searchCalls, map[string]any{"query": query, "options": opts})
				raw, ok := c.Search[query]
				if !ok {
					return SearchOutcome{}, fmt.Errorf("no scripted search for %s", query)
				}
				var th scriptedThrow
				_ = json.Unmarshal(raw, &th)
				if th.Throw != nil {
					return SearchOutcome{}, fmt.Errorf("%s", *th.Throw)
				}
				var out SearchOutcome
				err := json.Unmarshal(raw, &out)
				return out, err
			}
			deps.FetchURL = func(_ context.Context, url, format string) (FetchResult, error) {
				fetchCalls = append(fetchCalls, map[string]any{"url": url, "format": format})
				raw, ok := c.Fetch[url]
				if !ok {
					return FetchResult{}, fmt.Errorf("no scripted fetch for %s", url)
				}
				var th scriptedThrow
				_ = json.Unmarshal(raw, &th)
				if th.Throw != nil {
					return FetchResult{}, fmt.Errorf("%s", *th.Throw)
				}
				var out FetchResult
				err := json.Unmarshal(raw, &out)
				return out, err
			}
		}
		tools := map[string]Tool{}
		rt.Register(deps, func(tool Tool) { tools[tool.Spec.Name] = tool })
		tool, ok := tools[c.Tool]
		if !ok {
			t.Errorf("%s: %s not registered", c.Name, c.Tool)
			continue
		}
		var updates []Update
		e.run(t, c.scriptedCase, &sleeps, func() (any, error) {
			r, err := tool.Execute(context.Background(), c.Params, func(u Update) { updates = append(updates, u) })
			return map[string]any{"text": r.Text, "details": r.Details}, err
		})
		if len(updates) != len(c.Updates) {
			t.Errorf("%s: %d updates, want %d", c.Name, len(updates), len(c.Updates))
		} else {
			for i, u := range updates {
				// Go names its own tier chain in the fetch progress.
				want := strings.ReplaceAll(c.Updates[i].Content[0].Text, "via Camofox → CloakBrowser…", "via "+rt.chainLabel()+"…")
				if u.Text != want {
					t.Errorf("%s update %d: %q want %q", c.Name, i, u.Text, want)
				}
				jsonEqual(t, fmt.Sprintf("%s update %d details", c.Name, i), u.Details, c.Updates[i].Details)
			}
		}
		if searchCalls == nil {
			searchCalls = []any{}
		}
		if fetchCalls == nil {
			fetchCalls = []any{}
		}
		jsonEqual(t, c.Name+" searchCalls", searchCalls, c.SearchCalls)
		jsonEqual(t, c.Name+" fetchCalls", fetchCalls, c.FetchCalls)
	}
}

func TestCancellation(t *testing.T) {
	e := setup(t)
	var sleeps []int
	rt := e.runtime(&sleeps)
	e.server.mu.Lock()
	e.server.queue = []reply{{Body: "{}", DelayMs: 300}}
	e.server.mu.Unlock()
	rt.Env.SearxngTimeoutMs = 5_000
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	if _, err := rt.SearxngSearch(ctx, "slow", SearchOptions{}); err != ErrAborted {
		t.Fatalf("searxng: got %v, want abort", err)
	}
	// A cancelled fetch never contacts a backend.
	calls := 0
	tool := rt.FetchContentTool(func(context.Context, string, string) (FetchResult, error) { calls++; return FetchResult{}, nil })
	if _, err := tool.Execute(ctx, map[string]any{"url": "https://8.8.8.8/a"}, nil); err != ErrAborted || calls != 0 {
		t.Fatalf("fetch_content: %v calls=%d", err, calls)
	}
}

func TestV8JSONErrors(t *testing.T) {
	cases := map[string]string{
		"":                           "Unexpected end of JSON input",
		"[1,2":                       "Expected ',' or ']' after array element in JSON at position 4 (line 1 column 5)",
		"{not json":                  "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
		"not-json":                   `Unexpected token 'o', "not-json" is not valid JSON`,
		"axxxxxxxxxxxxxxxxxxxxxxxxx": `Unexpected token 'a', "axxxxxxxxx"... is not valid JSON`,
		`{"a":1 x`:                   "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)",
		`{"a" 1}`:                    "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
		`{"a":1,}`:                   "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
		"-a":                         "No number after minus sign in JSON at position 1 (line 1 column 2)",
		"1.":                         "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
		`"abc`:                       "Unterminated string in JSON at position 4 (line 1 column 5)",
		"1 2":                        "Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
		"{\"a\":1}\n\nx":             "Unexpected non-whitespace character after JSON at position 9 (line 3 column 1)",
		"nu":                         "Unexpected end of JSON input",
		"[,]":                        `Unexpected token ',', "[,]" is not valid JSON`,
		"01":                         "Unexpected number in JSON at position 1 (line 1 column 2)",
		"[object Object]":            `"[object Object]" is not valid JSON`,
	}
	for in, want := range cases {
		if got := v8JSONError(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}
