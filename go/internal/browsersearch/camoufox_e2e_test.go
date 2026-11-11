package browsersearch

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// TestCamoufoxEndToEnd runs the real worker (uv, camoufox, the Camoufox
// browser) against pages on 127.0.0.1. It is opt-in: set
// AIO_CAMOUFOX_E2E=1. The first run downloads the Python packages and the
// Camoufox browser into their normal caches. Only this test's policy
// allows loopback; every other private range stays blocked.
func TestCamoufoxEndToEnd(t *testing.T) {
	if os.Getenv("AIO_CAMOUFOX_E2E") != "1" {
		t.Skip("set AIO_CAMOUFOX_E2E=1 to run the real Camoufox worker")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/article", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, strings.Replace(articleHTML, "</article>", `<img src="http://10.1.2.3/pixel.png"></article>`, 1))
	})
	mux.HandleFunc("/spa", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>App</title></head><body><button>Go</button><script>document.body.insertAdjacentHTML("beforeend","<h2>Rendered by script</h2>")</script></body></html>`)
	})
	mux.HandleFunc("/to-metadata", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rt := NewRuntime(LoadEnv(os.LookupEnv))
	rt.WorkerDir = t.TempDir()
	policy := DefaultBrowserPolicy().WithoutIPv4Range("127.0.0.0/8")
	rt.Policy = &policy
	rt.Stderr = os.Stderr
	defer rt.Shutdown()
	var progress []string
	ctx := WithReporter(context.Background(), Reporter{Progress: func(p Progress) {
		progress = append(progress, p.Message)
		t.Logf("progress: %s", p.Message)
	}})
	start := time.Now()
	r, done, failure, err := rt.tryCamoufox(ctx, srv.URL+"/article", "markdown")
	t.Logf("first fetch (with start) took %v", time.Since(start))
	if err != nil || !done {
		t.Fatalf("article: %q %v", failure, err)
	}
	if r.Tier != "camoufox" || r.Title == nil || *r.Title != "Release notes" || !strings.Contains(r.Content, "Version 2 adds offline search.") || !strings.HasPrefix(r.Content, "# Release notes\n\n") {
		t.Fatalf("article result %+v", r)
	}
	t.Logf("markdown: %q", r.Content[:min(120, len(r.Content))])
	worker := rt.Worker.(*CamoufoxWorker)
	pid := worker.PID()
	tree := descendants(pid)
	t.Logf("worker pid %d, %d descendants", pid, len(tree))

	start = time.Now()
	html, done, failure, err := rt.tryCamoufox(context.Background(), srv.URL+"/article", "html")
	if err != nil || !done || !strings.Contains(html.Content, "<article>") {
		t.Fatalf("html: %q %v %+v", failure, err, html)
	}
	t.Logf("warm html fetch took %v", time.Since(start))

	resp, err := rt.Worker.Fetch(context.Background(), WorkerRequest{URL: srv.URL + "/article", Format: "text", TimeoutMs: 30_000}, nil)
	if err != nil || !resp.OK || len(resp.Blocked) != 1 || resp.Blocked[0].URL != "http://10.1.2.3/pixel.png" || resp.Blocked[0].Reason != "Blocked IP: 10.1.2.3" {
		t.Fatalf("subresource block: %+v %v", resp, err)
	}

	spa, done, failure, err := rt.tryCamoufox(context.Background(), srv.URL+"/spa", "text")
	if err != nil || !done || !strings.Contains(spa.Content, "Rendered by script") {
		t.Fatalf("spa: %q %v %+v", failure, err, spa)
	}
	t.Logf("spa (%s): %q", spa.Tier, spa.Content)

	_, done, failure, err = rt.tryCamoufox(context.Background(), srv.URL+"/to-metadata", "text")
	if err != nil || done || !strings.HasPrefix(failure, "URL blocked: redirect to http://169.254.169.254/latest/meta-data/: Blocked IP: 169.254.169.254") {
		t.Fatalf("redirect: done=%v %q %v", done, failure, err)
	}
	t.Logf("redirect failure: %s", failure)
	if worker.Starts() != 1 {
		t.Fatalf("starts %d", worker.Starts())
	}

	rt.Shutdown()
	deadline := time.Now().Add(5 * time.Second)
	for _, p := range append(tree, pid) {
		for alive(p) {
			if time.Now().After(deadline) {
				t.Fatalf("process %d survived Shutdown", p)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	t.Logf("shutdown left none of the %d worker processes", len(tree)+1)

	// A hard kill (request timeout, broken output) also takes the browser,
	// which Playwright starts in its own process group.
	if _, done, failure, err := rt.tryCamoufox(context.Background(), srv.URL+"/article", "text"); err != nil || !done {
		t.Fatalf("restart: %q %v", failure, err)
	}
	if worker.Starts() != 2 {
		t.Fatalf("starts %d", worker.Starts())
	}
	worker.mu.Lock()
	proc := worker.proc
	worker.mu.Unlock()
	tree = append(descendants(proc.pid), proc.pid)
	proc.kill(fmt.Errorf("test kill"))
	deadline = time.Now().Add(5 * time.Second)
	for _, p := range tree {
		for alive(p) {
			if time.Now().After(deadline) {
				t.Fatalf("process %d survived the hard kill", p)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	t.Logf("hard kill left none of the %d worker processes", len(tree))
	fmt.Fprintln(os.Stderr, strings.Join(progress, " / "))
}
