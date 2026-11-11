package browsersearch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const articleHTML = `<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>Release notes</h1>
<p>Version 2 adds offline search. The new index is built locally and never leaves the machine, so queries stay private and fast.</p>
<p>The fetch chain now tries a local browser first and then a plain HTTP request. See the <a href="/docs/chain">chain documentation</a> for details about each tier and its limits.</p>
<p>Upgrading needs no configuration change. Existing settings keep working, and the cache is rebuilt on the first start after the upgrade.</p>
</article><footer>Copyright</footer></body></html>`

// fallbackServer serves the HTTP fallback cases. Hosts allowed.test and
// other.test (public in the stub resolver) dial this server.
type fallbackServer struct {
	*httptest.Server
	mu  sync.Mutex
	uas []string
}

func newFallbackServer(t *testing.T) *fallbackServer {
	s := &fallbackServer{}
	mux := http.NewServeMux()
	html := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, body)
		}
	}
	mux.HandleFunc("/article", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.uas = append(s.uas, r.Header.Get("User-Agent"))
		s.mu.Unlock()
		html(articleHTML)(w, r)
	})
	mux.HandleFunc("/redirect-private", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, s.URL+"/article", http.StatusFound) // http://127.0.0.1:<port>
	})
	mux.HandleFunc("/redirect-ok", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://other.test/article", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/loop", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/loop", http.StatusFound)
	})
	mux.HandleFunc("/big", html("<html><head><title>Big</title></head><body><article><p>"+strings.Repeat("All work and no play. ", 400)+"</p></article></body></html>"))
	mux.HandleFunc("/latin1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=iso-8859-1")
		w.Write([]byte("Caf\xe9 cr\xe8me"))
	})
	mux.HandleFunc("/meta-charset", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html><head><meta charset=\"windows-1252\"><title>Quotes</title></head><body><p>\x93Smart quotes\x94 and caf\xe9.</p></body></html>"))
	})
	challenge := "<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>"
	mux.HandleFunc("/challenge", html(challenge))
	mux.HandleFunc("/challenge-403", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, challenge)
	})
	mux.HandleFunc("/png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("\x89PNG\r\n\x1a\n"))
	})
	mux.HandleFunc("/plain", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "just text")
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	})
	mux.HandleFunc("/empty", html("<html><body>  </body></html>"))
	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// transport dials every host to the test server, with no proxy.
func (s *fallbackServer) transport() *http.Transport {
	addr := s.Listener.Addr().String()
	return &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}}
}

func fallbackRuntime(t *testing.T, s *fallbackServer) *Runtime {
	rt := NewRuntime(LoadEnv(func(string) (string, bool) { return "", false }))
	rt.Resolver = stubResolver{"allowed.test": {{"93.184.216.34", 4}}, "other.test": {{"93.184.216.35", 4}}}
	rt.FallbackTransport = s.transport()
	rt.HTTP = &http.Client{Transport: forbiddenTransport{t: t}} // the container
	rt.Stderr = io.Discard
	return rt
}

func TestHTTPFetchFormats(t *testing.T) {
	s := newFallbackServer(t)
	rt := fallbackRuntime(t, s)
	md, err := rt.HTTPFetch(context.Background(), "http://allowed.test/article", "markdown")
	if err != nil {
		t.Fatal(err)
	}
	if md.Tier != "http" || md.Title == nil || *md.Title != "Release notes" || md.FinalURL != nil || md.Truncated {
		t.Fatalf("markdown meta %+v", md)
	}
	if !strings.HasPrefix(md.Content, "# Release notes\n\n") || !strings.Contains(md.Content, "[chain documentation](http://allowed.test/docs/chain)") ||
		strings.Contains(md.Content, "Copyright") || strings.Contains(md.Content, "<p>") {
		t.Fatalf("markdown content:\n%s", md.Content)
	}
	if md.Chars != float64(len(md.Content)) {
		t.Fatalf("chars %v", md.Chars)
	}
	text, err := rt.HTTPFetch(context.Background(), "http://allowed.test/article", "text")
	if err != nil || !strings.HasPrefix(text.Content, "Release notes\n\n") || strings.Contains(text.Content, "[chain") || !strings.Contains(text.Content, "Version 2 adds offline search.") {
		t.Fatalf("text %q %v", text.Content, err)
	}
	raw, err := rt.HTTPFetch(context.Background(), "http://allowed.test/article", "html")
	if err != nil || raw.Content != articleHTML || raw.Format != "html" || *raw.Title != "Release notes" {
		t.Fatalf("html %+v %v", raw, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.uas) != 3 || s.uas[0] != FallbackUserAgent {
		t.Fatalf("user agents %v", s.uas)
	}
}

func TestHTTPFetchRedirects(t *testing.T) {
	s := newFallbackServer(t)
	rt := fallbackRuntime(t, s)
	r, err := rt.HTTPFetch(context.Background(), "http://allowed.test/redirect-ok", "markdown")
	if err != nil || r.FinalURL == nil || *r.FinalURL != "http://other.test/article" {
		t.Fatalf("allowed redirect %+v %v", r, err)
	}
	_, err = rt.HTTPFetch(context.Background(), "http://allowed.test/redirect-private", "markdown")
	want := fmt.Sprintf("redirect to %s/article blocked: Blocked IP: 127.0.0.1", s.URL)
	if err == nil || err.Error() != want {
		t.Fatalf("private redirect: %v, want %q", err, want)
	}
	_, err = rt.HTTPFetch(context.Background(), "http://allowed.test/loop", "markdown")
	if err == nil || err.Error() != "stopped after 10 redirects" {
		t.Fatalf("loop: %v", err)
	}
	// A test policy that forbids only other.test also stops a redirect.
	rt.Validate = func(_ context.Context, u string) Validation {
		if strings.Contains(u, "other.test") {
			return blocked("test policy")
		}
		return Validation{Valid: true}
	}
	if _, err = rt.HTTPFetch(context.Background(), "http://allowed.test/redirect-ok", "text"); err == nil || err.Error() != "redirect to http://other.test/article blocked: test policy" {
		t.Fatalf("policy redirect: %v", err)
	}
}

func TestHTTPFetchLimitsAndErrors(t *testing.T) {
	s := newFallbackServer(t)
	rt := fallbackRuntime(t, s)
	rt.Env.HTTPMaxBytes = 2000
	big, err := rt.HTTPFetch(context.Background(), "http://allowed.test/big", "text")
	if err != nil || !big.Truncated || len(big.Content) > 2100 {
		t.Fatalf("size limit %v truncated=%v len=%d", err, big.Truncated, len(big.Content))
	}
	rt.Env.HTTPMaxBytes = 0
	rt.Env.CloakMaxChars = 50
	capped, err := rt.HTTPFetch(context.Background(), "http://allowed.test/article", "text")
	if err != nil || !capped.Truncated || !strings.HasSuffix(capped.Content, "\n\n[truncated]") || capped.Chars <= 50 {
		t.Fatalf("content cap %+v %v", capped, err)
	}
	rt.Env.CloakMaxChars = 100_000

	latin, err := rt.HTTPFetch(context.Background(), "http://allowed.test/latin1", "markdown")
	if err != nil || latin.Content != "Café crème" || latin.Title != nil {
		t.Fatalf("latin1 %q %v", latin.Content, err)
	}
	quotes, err := rt.HTTPFetch(context.Background(), "http://allowed.test/meta-charset", "text")
	if err != nil || !strings.Contains(quotes.Content, "“Smart quotes” and café.") {
		t.Fatalf("meta charset %q %v", quotes.Content, err)
	}
	cases := map[string]string{
		"/challenge":     "the page is an anti-bot challenge",
		"/challenge-403": "HTTP 403 Forbidden (anti-bot challenge)",
		"/nothing-here":  "HTTP 404 Not Found",
		"/png":           "unsupported content type image/png",
		"/empty":         "the page had no readable content",
	}
	for path, want := range cases {
		if _, err := rt.HTTPFetch(context.Background(), "http://allowed.test"+path, "markdown"); err == nil || err.Error() != want {
			t.Errorf("%s: %v, want %q", path, err, want)
		}
	}
	plain, err := rt.HTTPFetch(context.Background(), "http://allowed.test/plain", "html")
	if err != nil || plain.Content != "just text" {
		t.Fatalf("plain %+v %v", plain, err)
	}
	rt.Env.HTTPTimeoutMs = 100
	if _, err := rt.HTTPFetch(context.Background(), "http://allowed.test/slow", "text"); err == nil || err.Error() != "timed out after 100ms" {
		t.Fatalf("timeout: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(30*time.Millisecond, cancel)
	rt.Env.HTTPTimeoutMs = 5000
	if _, err := rt.HTTPFetch(ctx, "http://allowed.test/slow", "text"); !errors.Is(err, ErrAborted) {
		t.Fatalf("abort: %v", err)
	}
}

// scriptedWorker is a BrowserWorker with a fixed answer.
type scriptedWorker struct {
	mu       sync.Mutex
	calls    []WorkerRequest
	resp     WorkerResponse
	err      error
	progress []Progress
}

func (w *scriptedWorker) Fetch(_ context.Context, req WorkerRequest, progress func(Progress)) (WorkerResponse, error) {
	w.mu.Lock()
	w.calls = append(w.calls, req)
	w.mu.Unlock()
	for _, p := range w.progress {
		progress(p)
	}
	return w.resp, w.err
}

func (w *scriptedWorker) Shutdown() {}

func TestFetchChain(t *testing.T) {
	s := newFallbackServer(t)
	str := func(s string) *string { return &s }

	// Camoufox succeeds: no fallback, no container.
	rt := fallbackRuntime(t, s)
	rt.Worker = &scriptedWorker{resp: WorkerResponse{OK: true, FinalURL: "http://allowed.test/article?x", Title: "Doc",
		Readability: map[string]any{"title": "Doc", "text": "Readable body", "length": 13.0}}}
	r, err := rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "markdown")
	if err != nil || r.Tier != "camoufox" || r.Content != "# Doc\n\nReadable body" || r.Warning != nil || *r.FinalURL != "http://allowed.test/article?x" {
		t.Fatalf("camoufox %+v %v", r, err)
	}
	if got := rt.Worker.(*scriptedWorker).calls[0]; got.TimeoutMs != 30_000 || got.Format != "markdown" {
		t.Fatalf("request %+v", got)
	}
	// Snapshot and HTML answers.
	rt.Worker = &scriptedWorker{resp: WorkerResponse{OK: true, Title: "Snap", Snapshot: str("- heading \"Snap\"")}}
	if r, _ := rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "text"); r.Tier != "camoufox" || r.Content != "- heading \"Snap\"" {
		t.Fatalf("snapshot %+v", r)
	}
	rt.Worker = &scriptedWorker{resp: WorkerResponse{OK: true, HTML: str("<p>Hi</p>")}}
	if r, _ := rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "html"); r.Tier != "camoufox" || r.Content != "<p>Hi</p>" {
		t.Fatalf("html %+v", r)
	}

	// Camoufox fails, a challenge, or is empty: the HTTP fallback runs.
	for name, w := range map[string]*scriptedWorker{
		"error":     {err: errors.New("uv was not found (uv); install uv or set BROWSER_SEARCH_UV")},
		"not ok":    {resp: WorkerResponse{OK: false, Error: "Page.goto: NS_ERROR_UNKNOWN_HOST"}},
		"challenge": {resp: WorkerResponse{OK: true, Readability: map[string]any{"title": "Just a moment...", "text": "Checking your browser"}}},
		"empty":     {resp: WorkerResponse{OK: true, Snapshot: str("  ")}},
	} {
		rt.Worker = w
		r, err := rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "markdown")
		if err != nil || r.Tier != "http" || r.Warning == nil || !strings.HasPrefix(r.Content, "# Release notes") {
			t.Fatalf("%s: %+v %v", name, r, err)
		}
	}
	rt.Worker = &scriptedWorker{resp: WorkerResponse{OK: false, Error: "Page.goto: NS_ERROR_UNKNOWN_HOST."}}
	r, _ = rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "markdown")
	if *r.Warning != "Camoufox failed for http://allowed.test/article: Page.goto: NS_ERROR_UNKNOWN_HOST. Used the plain HTTP fallback." {
		t.Fatalf("warning %q", *r.Warning)
	}

	// Every tier fails: the failure names each tier.
	r, err = rt.FetchSingleURL(context.Background(), "http://allowed.test/challenge", "markdown")
	if err != nil || r.Tier != "none" || *r.Error != "Camoufox failed: Page.goto: NS_ERROR_UNKNOWN_HOST. HTTP fallback failed: the page is an anti-bot challenge" {
		t.Fatalf("all fail %+v %v", r, err)
	}

	// An explicit container runs first and is named in the warning.
	rt.Env.CamofoxExplicit = true
	rt.Env.CamofoxBase = "http://127.0.0.1:1"
	rt.HTTP = &http.Client{}
	rt.Sleep = func(ctx context.Context, ms int) error { return aborted(ctx) }
	r, _ = rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "text")
	want := "Camofox container failed for http://allowed.test/article: Camofox unreachable at http://127.0.0.1:1: fetch failed. Camoufox failed: Page.goto: NS_ERROR_UNKNOWN_HOST. Used the plain HTTP fallback."
	if r.Warning == nil || *r.Warning != want {
		t.Fatalf("container warning %+v", r)
	}

	// Blocked URLs never reach a tier.
	calls := len(rt.Worker.(*scriptedWorker).calls)
	if _, err := rt.FetchSingleURL(context.Background(), "http://127.0.0.1/x", "text"); err == nil || err.Error() != "URL blocked: Blocked IP: 127.0.0.1" {
		t.Fatalf("blocked %v", err)
	}
	if len(rt.Worker.(*scriptedWorker).calls) != calls {
		t.Fatal("a blocked URL reached the worker")
	}

	// A policy block in the browser never falls back to plain HTTP.
	rt.Worker = &scriptedWorker{resp: WorkerResponse{OK: false, Error: "URL blocked: redirect to http://169.254.169.254/: Blocked IP: 169.254.169.254"}}
	r, err = rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "text")
	if err != nil || r.Tier != "none" || r.Warning != nil || !strings.HasSuffix(*r.Error, "Camoufox failed: URL blocked: redirect to http://169.254.169.254/: Blocked IP: 169.254.169.254") {
		t.Fatalf("policy block %+v %v", r, err)
	}

	// An abort in the worker stops the chain.
	rt.Worker = &scriptedWorker{err: ErrAborted}
	if _, err := rt.FetchSingleURL(context.Background(), "http://allowed.test/article", "text"); !errors.Is(err, ErrAborted) {
		t.Fatalf("abort %v", err)
	}
}

func TestFallbackNotices(t *testing.T) {
	s := newFallbackServer(t)
	rt := fallbackRuntime(t, s)
	worker := &scriptedWorker{
		resp:     WorkerResponse{OK: false, Error: "Camoufox failed to start: no display"},
		progress: []Progress{{Message: "Downloading the Camoufox browser (first use)…", Download: true}, {Message: "Launching Camoufox…"}},
	}
	rt.Worker = worker
	type notice struct{ message, level string }
	var notices []notice
	ctx := WithReporter(context.Background(), Reporter{Notify: func(m, l string) { notices = append(notices, notice{m, l}) }})
	hit := SearchResult{URL: "http://allowed.test/article", Title: "Hit"}
	tools := map[string]Tool{}
	rt.Register(Dependencies{Provider: "searxng", Search: func(context.Context, string, SearchOptions) (SearchOutcome, error) {
		return SearchOutcome{ResultCount: 1, Results: []SearchResult{hit}}, nil
	}}, func(tool Tool) { tools[tool.Spec.Name] = tool })

	var updates []Update
	res, err := tools["web_search"].Execute(ctx, map[string]any{"queries": []any{"a", "b"}, "includeContent": true}, func(u Update) { updates = append(updates, u) })
	if err != nil {
		t.Fatal(err)
	}
	warning := "Camoufox failed for http://allowed.test/article: Camoufox failed to start: no display. Used the plain HTTP fallback."
	if len(notices) != 2 || notices[0] != (notice{"Downloading the Camoufox browser (first use)…", "info"}) || notices[1] != (notice{warning, "warning"}) {
		t.Fatalf("notices %+v", notices)
	}
	if strings.Count(res.Text, "> Warning: "+warning) != 2 {
		t.Fatalf("text:\n%s", res.Text)
	}
	q := res.Details["queries"].([]any)[0].(map[string]any)
	if fmt.Sprint(q["warnings"]) != "["+warning+"]" {
		t.Fatalf("details %v", q)
	}
	camoufoxUpdates := 0
	for _, u := range updates {
		if strings.HasPrefix(u.Text, "Camoufox: ") {
			camoufoxUpdates++
		}
	}
	if camoufoxUpdates != 4 {
		t.Fatalf("updates %+v", updates)
	}

	// fetch_content: one notice per URL, the warning in text and details.
	notices = nil
	res, err = tools["fetch_content"].Execute(ctx, map[string]any{"url": "http://allowed.test/article"}, nil)
	if err != nil || !strings.HasPrefix(res.Text, "> Warning: "+warning+"\n\n## Release notes\n\n# Release notes") || res.Details["warning"] != warning || res.Details["tier"] != "http" {
		t.Fatalf("fetch_content %q %v %v", res.Text, res.Details, err)
	}
	if len(notices) != 2 {
		t.Fatalf("notices %+v", notices)
	}
	notices = nil
	res, _ = tools["fetch_content"].Execute(ctx, map[string]any{"urls": []any{"http://allowed.test/article", "http://other.test/article"}}, nil)
	if len(notices) != 3 || !strings.Contains(res.Text, "## Release notes\n\n> Warning: Camoufox failed for http://other.test/article") {
		t.Fatalf("many: %+v\n%s", notices, res.Text)
	}

	// Without a reporter the notice goes to stderr.
	var stderr strings.Builder
	rt.Stderr = &stderr
	worker.progress = nil
	if _, err := tools["fetch_content"].Execute(context.Background(), map[string]any{"url": "http://allowed.test/article"}, nil); err != nil {
		t.Fatal(err)
	}
	if stderr.String() != "[browser-search] "+warning+"\n" {
		t.Fatalf("stderr %q", stderr.String())
	}
	if got := fmt.Sprint(updates[0].Text); got != "Searching SearXNG (1/2): a" {
		t.Fatalf("first update %q", got)
	}
}
