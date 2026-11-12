package anthropicauth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestProfileRejectsTrailingJSON(t *testing.T) {
	lookup, err := LookupProviderAccount(context.Background(), "anthropic-2", func(string) (string, error) { return "sk-ant-oat-fake", nil }, func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{} trailing`))}, nil
	})
	if err != nil || lookup.Kind != "unavailable" || lookup.Reason != "unexpected response" {
		t.Fatalf("Response.json must reject trailing JSON: %+v/%v", lookup, err)
	}
}

// This is an HTTP integration of the pure wrapper, NOT a PiG subprocess test.
// The PiG raw built-in delegate needed to wire the wrapper is unavailable.
func TestWrapperHTTPRetryAndConcurrentLearnedFloor(t *testing.T) {
	var mu sync.Mutex
	seen := map[string][]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		var body = decode[map[string]any](t, data)
		id := r.Header.Get("x-test-request")
		if body["caller"] != "ran first" {
			t.Error("caller payload callback not composed")
		}
		system := record(body["system"].([]any)[0])["text"].(string)
		mu.Lock()
		seen[id] = append(seen[id], system)
		count := len(seen[id])
		mu.Unlock()
		if id == "learn" && count == 1 {
			required := "2.9.0"
			w.Header().Set("request-id", "retry-request")
			w.WriteHeader(400)
			fmt.Fprint(w, versionError(&required))
			return
		}
		fmt.Fprint(w, "stream result")
	}))
	defer server.Close()
	delegate := func(model, transcript map[string]any, options StreamOptions) (string, error) {
		payload := map[string]any{"model": "claude-test", "stream": true, "messages": []any{map[string]any{"role": "user", "content": transcript["text"]}}, "system": []any{map[string]any{"type": "text", "text": "generic"}}}
		shaped, err := options.OnPayload(payload, model)
		if err != nil {
			return "", err
		}
		req, err := http.NewRequestWithContext(options.Signal, "POST", server.URL, strings.NewReader(string(mustJSON(t, shaped))))
		if err != nil {
			return "", err
		}
		req.Header.Set("x-test-request", transcript["id"].(string))
		req.Header.Set("user-agent", "claude-cli/2.1.200")
		response, err := options.Fetch(req)
		if err != nil {
			return "", err
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		return string(data), err
	}
	wrapper := WrapStreamSimple[string](delegate, nil, nil)
	run := func(id string) error {
		result, err := wrapper(map[string]any{"api": "anthropic-messages", "provider": "anthropic-2"}, map[string]any{"text": "user " + id, "id": id}, StreamOptions{Values: map[string]any{"apiKey": "prefix-sk-ant-oat-fake"}, Signal: context.Background(), Fetch: server.Client().Do, OnPayload: func(p any, _ map[string]any) (any, error) { record(p)["caller"] = "ran first"; return nil, nil }})
		if err != nil {
			return err
		}
		if result != "stream result" {
			return fmt.Errorf("unexpected body %s", result)
		}
		return nil
	}
	if err := run("learn"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Go(func() {
			if err := run(fmt.Sprintf("concurrent-%d", i)); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if len(seen["learn"]) != 2 {
		t.Fatalf("expected single retry: %v", seen["learn"])
	}
	for id, headers := range seen {
		if id == "learn" {
			if !strings.Contains(headers[0], "cc_version=2.1.280.") {
				t.Fatal("did not send bundled pin first")
			}
			headers = headers[1:]
		}
		if len(headers) != 1 || headers[0] != BuildBillingHeaderValue("user "+id, "2.9.0") {
			t.Fatalf("learned floor or cross-request state lost for %s: %v", id, headers)
		}
	}
}
func TestWrapperCancellationClosesHTTPExchange(t *testing.T) {
	started := make(chan struct{})
	serverDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
			return
		}
		close(started)
		<-r.Context().Done()
		close(serverDone)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	delegate := func(model, request map[string]any, o StreamOptions) (string, error) {
		p, err := o.OnPayload(map[string]any{"model": "claude-test", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "cancel"}}}, model)
		if err != nil {
			return "", err
		}
		req, err := http.NewRequestWithContext(o.Signal, "POST", server.URL, strings.NewReader(string(mustJSON(t, p))))
		if err != nil {
			return "", err
		}
		response, err := o.Fetch(req)
		if response != nil {
			response.Body.Close()
		}
		return "", err
	}
	wrapper := WrapStreamSimple[string](delegate, nil, nil)
	finished := make(chan error, 1)
	go func() {
		_, err := wrapper(map[string]any{}, map[string]any{}, StreamOptions{Values: map[string]any{"apiKey": "sk-ant-oat-fake"}, Signal: ctx, Fetch: server.Client().Do})
		finished <- err
	}()
	<-started
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
	<-serverDone
}
func TestResponseSuccessIsNeverReadAndFailureCloses(t *testing.T) {
	success := &unreadableBody{}
	response := &http.Response{StatusCode: 200, Body: success}
	sync := NewBillingVersionSync(nil, func(*http.Request) (*http.Response, error) { return response, nil }, nil, nil)
	req, _ := http.NewRequest("POST", "https://oracle.invalid", strings.NewReader("body"))
	got, err := sync.Fetch(req)
	if err != nil || got != response || success.reads != 0 || success.closes != 0 {
		t.Fatal("touched streaming success", err)
	}
	got.Body.Close()
	sentinel := errors.New("network failure")
	sync = NewBillingVersionSync(nil, func(*http.Request) (*http.Response, error) { return nil, sentinel }, nil, nil)
	if _, err = sync.Fetch(req); !errors.Is(err, sentinel) {
		t.Fatal("lost network error", err)
	}
}

type unreadableBody struct{ reads, closes int }

func (b *unreadableBody) Read([]byte) (int, error) { b.reads++; return 0, errors.New("must not read") }
func (b *unreadableBody) Close() error             { b.closes++; return nil }

func TestExtraProvidersTrustLayeringAndNoUnregister(t *testing.T) {
	e := &ExtraProviders{}
	registered := []string{}
	register := func(name string) error { registered = append(registered, name); return nil }
	if err := e.Apply(LoadedConfig{[]string{"anthropic-2"}, []string{"global warning"}}, "global", register); err != nil {
		t.Fatal(err)
	}
	loads := 0
	loader := func(path string) LoadedConfig {
		loads++
		if path != ProjectConfigPath("/project") {
			t.Error(path)
		}
		return LoadedConfig{[]string{"anthropic-2", "anthropic-3"}, []string{"project warning"}}
	}
	if err := e.ApplyProject(false, "/project", loader, register); err != nil {
		t.Fatal(err)
	}
	if loads != 0 {
		t.Fatal("read untrusted config")
	}
	if err := e.ApplyProject(true, "/project", loader, register); err != nil {
		t.Fatal(err)
	}
	equalJSON(t, registered, []string{"anthropic-2", "anthropic-3"})
	equalJSON(t, e.ShapedProviders(), []ShapedProvider{{"anthropic-2", "global"}, {"anthropic-3", "project"}})
	equalJSON(t, e.Warnings(), []string{"global warning", "project warning"})
	if err := e.Apply(emptyConfig(), "global", register); err != nil {
		t.Fatal(err)
	}
	equalJSON(t, e.Warnings(), []string{"project warning"})
	if len(e.ShapedProviders()) != 2 {
		t.Fatal("removed shape without reload")
	}
	sentinel := errors.New("registration failed")
	if err := e.Apply(LoadedConfig{Providers: []string{"new"}}, "global", func(string) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal("registration error swallowed")
	}
	if len(e.ShapedProviders()) != 2 {
		t.Fatal("recorded a failed registration")
	}
}
func TestConfigFileReadsStayInTestScratch(t *testing.T) {
	// t.TempDir follows TMPDIR, which the documented runner places in this repo.
	path := filepath.Join(t.TempDir(), "config.json")
	equalJSON(t, LoadConfig(path), emptyConfig())
	if err := os.WriteFile(path, []byte(`{"providers":["anthropic-2",false]}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := LoadConfig(path)
	equalJSON(t, c.Providers, []string{"anthropic-2"})
	if len(c.Warnings) != 1 {
		t.Fatal(c)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if c = LoadConfig(path); len(c.Warnings) != 1 || !strings.Contains(c.Warnings[0], "could not be read") {
		t.Fatal(c)
	}
}
func TestAccountLookupGatingHeadersAndPrivacyTypes(t *testing.T) {
	for _, key := range []string{"", "api-key", "sk-ant-api03-fake"} {
		lookup, err := LookupProviderAccount(context.Background(), "anthropic-2", func(provider string) (string, error) {
			if provider != "anthropic-2" {
				t.Fatal(provider)
			}
			return key, nil
		}, func(*http.Request) (*http.Response, error) {
			t.Fatal("API key triggered profile network")
			return nil, nil
		})
		if err != nil || lookup.Kind != "not-oauth" {
			t.Fatal(lookup, err)
		}
	}
	profile := ParseProfile(map[string]any{"account": map[string]any{"email": 42}, "organization": map[string]any{"name": false, "has_extra_usage_enabled": "yes"}})
	equalJSON(t, profile, &AccountProfile{})
	for _, c := range []struct {
		status             int
		text, kind, reason string
	}{{200, `{"account":{},"organization":{}}`, "profile", ""}, {401, "denied", "unavailable", "HTTP 401"}, {200, `[]`, "unavailable", "unexpected response"}, {200, `null`, "unavailable", "unexpected response"}, {200, `broken`, "unavailable", "unexpected response"}} {
		body := &trackedBody{Reader: strings.NewReader(c.text)}
		lookup, err := LookupProviderAccount(context.Background(), "anthropic-2", func(string) (string, error) { return "sk-ant-oat-fake", nil }, func(r *http.Request) (*http.Response, error) {
			if r.URL.String() != ProfileURL || r.Header.Get("Authorization") != "Bearer sk-ant-oat-fake" || r.Header.Get("anthropic-beta") != OAuthBeta {
				t.Fatal("profile request mismatch")
			}
			if _, ok := r.Context().Deadline(); !ok {
				t.Fatal("missing profile timeout")
			}
			return &http.Response{StatusCode: c.status, Body: body}, nil
		})
		if err != nil || lookup.Kind != c.kind || lookup.Reason != c.reason || body.closes != 1 {
			t.Fatal(lookup, err, body.closes)
		}
	}
	sentinel := errors.New("credential refresh failed")
	if _, err := LookupProviderAccount(context.Background(), "anthropic", func(string) (string, error) { return "", sentinel }, nil); !errors.Is(err, sentinel) {
		t.Fatal("credential error swallowed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	lookup, err := LookupProviderAccount(ctx, "anthropic", func(string) (string, error) { return "sk-ant-oat-fake", nil }, func(r *http.Request) (*http.Response, error) { return nil, r.Context().Err() })
	if err != nil || lookup.Kind != "unavailable" || !strings.Contains(lookup.Reason, "canceled") {
		t.Fatal(lookup, err)
	}
}
func TestParallelAccountsJoinAndPreserveOrder(t *testing.T) {
	var started atomic.Int32
	gate := make(chan struct{})
	d := Diagnostics{ShapedProviders: []ShapedProvider{{"anthropic-2", "global"}, {"anthropic-3", "project"}}}
	done := make(chan *AccountsReport, 1)
	go func() {
		r, err := CollectAccounts(context.Background(), d, "x\u00a0--account", func(_ context.Context, p string) (AccountLookup, error) {
			if started.Add(1) == 3 {
				close(gate)
			}
			<-gate
			return AccountLookup{Kind: "unavailable", Reason: p}, nil
		})
		if err != nil {
			t.Error(err)
		}
		done <- r
	}()
	report := <-done
	if !report.IncludeIdentity {
		t.Fatal("missing identity opt-in")
	}
	for i, p := range []string{"anthropic", "anthropic-2", "anthropic-3"} {
		if report.Accounts[i].Provider != p || report.Accounts[i].Lookup.Reason != p {
			t.Fatal("order lost")
		}
	}
}
func TestWarningsOnceDebugDoesNotDiscloseTokenOrText(t *testing.T) {
	var mu sync.Mutex
	lines := []string{}
	observer := &Observer{DebugMode: "all", Emit: func(line string) { mu.Lock(); defer mu.Unlock(); lines = append(lines, line) }}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			ShapeSystemPrompt(PiDefaultPromptPrefix+" no sections", observer)
			ShapePayload(map[string]any{"model": "test", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "private-user-text"}}, "system": []any{}}, ClaudeCodeVersion, observer)
		})
	}
	wg.Wait()
	warnings := 0
	for _, line := range lines {
		if strings.Contains(line, "passing it through") {
			warnings++
		}
		if strings.Contains(line, "private-user-text") {
			t.Fatal("debug text leak")
		}
	}
	if warnings != 1 {
		t.Fatalf("warnings=%d", warnings)
	}
}

func TestHostVersionUpgradeClosesReplacedRequestBody(t *testing.T) {
	text := "upgrade body"
	payload := map[string]any{"model": "test", "stream": true, "messages": []any{map[string]any{"role": "user", "content": text}}, "system": []any{map[string]any{"type": "text", "text": BuildBillingHeaderValue(text, ClaudeCodeVersion)}}}
	req, _ := http.NewRequest("POST", "https://oracle.invalid", strings.NewReader(string(mustJSON(t, payload))))
	body := &trackedBody{Reader: req.Body}
	req.Body = body
	req.Header.Set("user-agent", "claude-cli/2.9.9")
	sync := NewBillingVersionSync(nil, func(r *http.Request) (*http.Response, error) {
		r.Body.Close()
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	}, nil, nil)
	sync.RecordRequest(payload)
	response, err := sync.Fetch(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if body.closes != 1 {
		t.Fatalf("replaced original request body closed %d times", body.closes)
	}
}
