package browsersearch

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The fake worker is this test binary run with AIO_FAKE_CAMOUFOX_WORKER=1.
// It speaks the worker protocol. The "init" message's "mode" picks the
// start behavior; the fetched URL's path picks the answer.
func TestMain(m *testing.M) {
	if os.Getenv("AIO_FAKE_CAMOUFOX_WORKER") == "1" {
		os.Exit(fakeWorkerMain())
	}
	os.Exit(m.Run())
}

func fakeWorkerMain() int {
	out := bufio.NewWriter(os.Stdout)
	emit := func(v map[string]any) {
		data, _ := json.Marshal(v)
		out.Write(append(data, '\n'))
		out.Flush()
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<20)
	var child *exec.Cmd
	defer func() {
		_ = child // an orphan on purpose: Shutdown must find it
	}()
	for in.Scan() {
		var m map[string]any
		if json.Unmarshal(in.Bytes(), &m) != nil {
			continue
		}
		switch m["op"] {
		case "init":
			fmt.Fprintln(os.Stderr, "fake worker starting")
			switch m["mode"] {
			case "fatal":
				emit(map[string]any{"type": "fatal", "error": "Camoufox failed to start: no display"})
				return 1
			case "never":
				time.Sleep(time.Hour)
			case "badline":
				fmt.Fprintln(out, "not json")
				out.Flush()
				time.Sleep(time.Hour)
			case "exit":
				fmt.Fprintln(os.Stderr, "Traceback: ImportError: camoufox")
				return 3
			}
			emit(map[string]any{"type": "progress", "kind": "download", "message": "Downloading the Camoufox browser (first use)…"})
			emit(map[string]any{"type": "progress", "message": "Launching Camoufox…"})
			if m["mode"] == "child" {
				// A grandchild in its own process group, like the browser
				// that Playwright starts.
				child = exec.Command("sleep", "300")
				child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				_ = child.Start()
			}
			emit(map[string]any{"type": "ready", "camoufox": "fake", "browser": "0"})
		case "fetch":
			id := m["id"]
			url, _ := m["url"].(string)
			format, _ := m["format"].(string)
			path := url[strings.LastIndex(url, "/"):]
			switch path {
			case "/crash":
				return 4
			case "/hang":
				time.Sleep(time.Hour)
			case "/slow":
				time.Sleep(300 * time.Millisecond)
				emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url, "title": "Slow",
					"readability": map[string]any{"title": "Slow", "text": "Slow body", "excerpt": nil, "length": 9}, "snapshot": nil, "html": nil, "blocked": []any{}})
			case "/fail":
				emit(map[string]any{"type": "result", "id": id, "ok": false, "error": "Page.goto: NS_ERROR_UNKNOWN_HOST", "blocked": []any{}})
			case "/blocked":
				emit(map[string]any{"type": "result", "id": id, "ok": false, "error": "URL blocked: redirect to http://169.254.169.254/: Blocked IP: 169.254.169.254",
					"blocked": []any{map[string]any{"url": "http://169.254.169.254/", "reason": "Blocked IP: 169.254.169.254"}}})
			case "/snapshot":
				emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url, "title": "Snap", "readability": nil, "snapshot": "- heading \"Snap\"", "html": nil, "blocked": []any{}})
			case "/empty":
				emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url, "title": "", "readability": nil, "snapshot": "  ", "html": nil, "blocked": []any{}})
			case "/challenge":
				emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url, "title": "Just a moment...",
					"readability": map[string]any{"title": "Just a moment...", "text": "Checking your browser before accessing", "length": 30}, "snapshot": nil, "html": nil, "blocked": []any{}})
			case "/pid":
				pid := 0
				if child != nil {
					pid = child.Process.Pid
				}
				emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url, "title": "", "readability": map[string]any{"text": strconvItoa(pid)}, "blocked": []any{}})
			default:
				if format == "html" {
					emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url + "?final", "title": "Doc", "readability": nil, "snapshot": nil,
						"html": "<html><body><p>Hello</p></body></html>", "blocked": []any{}})
					continue
				}
				emit(map[string]any{"type": "result", "id": id, "ok": true, "finalUrl": url, "title": "Doc",
					"readability": map[string]any{"title": "Doc", "text": "Readable body", "excerpt": "Readable", "length": 13}, "snapshot": nil, "html": nil, "blocked": []any{}})
			}
		case "shutdown":
			return 0
		}
	}
	return 0
}

func strconvItoa(n int) string { return fmt.Sprint(n) }

func fakeOptions(mode string, startup time.Duration) func() WorkerOptions {
	return func() WorkerOptions {
		return WorkerOptions{
			Command: func() (*exec.Cmd, map[string]any, error) {
				cmd := exec.Command(os.Args[0], "-test.run=^$")
				cmd.Env = append(os.Environ(), "AIO_FAKE_CAMOUFOX_WORKER=1")
				return cmd, map[string]any{"mode": mode, "readabilityPath": "/unused"}, nil
			},
			StartupTimeout: startup,
			RequestGrace:   200 * time.Millisecond,
			StopGrace:      time.Second,
		}
	}
}

func alive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d is still alive", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func fetchURL(w *CamoufoxWorker, url string) (WorkerResponse, error) {
	return w.Fetch(context.Background(), WorkerRequest{URL: url, Format: "markdown", TimeoutMs: 1000}, nil)
}

func TestWorkerLazyStartAndReuse(t *testing.T) {
	w := NewCamoufoxWorker(fakeOptions("", 5*time.Second))
	defer w.Shutdown()
	if w.Starts() != 0 || w.PID() != 0 {
		t.Fatal("the worker started before the first fetch")
	}
	var mu sync.Mutex
	var progress []Progress
	r, err := w.Fetch(context.Background(), WorkerRequest{URL: "https://8.8.8.8/a", Format: "markdown", TimeoutMs: 1000}, func(p Progress) {
		mu.Lock()
		progress = append(progress, p)
		mu.Unlock()
	})
	if err != nil || !r.OK || r.Readability["text"] != "Readable body" || r.ID != 1 {
		t.Fatalf("first fetch: %+v %v", r, err)
	}
	mu.Lock()
	if len(progress) != 3 || progress[0].Message != "Starting the local Camoufox browser…" || !progress[1].Download || progress[2].Download {
		t.Fatalf("progress %+v", progress)
	}
	mu.Unlock()
	pid := w.PID()
	r, err = fetchURL(w, "https://8.8.8.8/blocked")
	if err != nil || r.OK || r.Error != "URL blocked: redirect to http://169.254.169.254/: Blocked IP: 169.254.169.254" || len(r.Blocked) != 1 || r.Blocked[0].Reason != "Blocked IP: 169.254.169.254" {
		t.Fatalf("failure answer: %+v %v", r, err)
	}
	r, err = w.Fetch(context.Background(), WorkerRequest{URL: "https://8.8.8.8/b", Format: "html", TimeoutMs: 1000}, nil)
	if err != nil || r.HTML == nil || *r.HTML == "" || r.ID != 3 {
		t.Fatalf("second fetch: %+v %v", r, err)
	}
	if w.Starts() != 1 || w.PID() != pid {
		t.Fatalf("the worker was not reused: starts %d", w.Starts())
	}
}

func TestWorkerCrashRestarts(t *testing.T) {
	w := NewCamoufoxWorker(fakeOptions("", 5*time.Second))
	defer w.Shutdown()
	if _, err := fetchURL(w, "https://8.8.8.8/a"); err != nil {
		t.Fatal(err)
	}
	first := w.PID()
	_, err := fetchURL(w, "https://8.8.8.8/crash")
	if err == nil || !strings.Contains(err.Error(), "Camoufox worker exited (exit 4)") || !strings.Contains(err.Error(), "fake worker starting") {
		t.Fatalf("crash error: %v", err)
	}
	waitDead(t, first)
	if r, err := fetchURL(w, "https://8.8.8.8/again"); err != nil || !r.OK {
		t.Fatalf("after crash: %+v %v", r, err)
	}
	if w.Starts() != 2 || w.PID() == first {
		t.Fatalf("starts %d", w.Starts())
	}
}

func TestWorkerShutdownKillsTree(t *testing.T) {
	w := NewCamoufoxWorker(fakeOptions("child", 5*time.Second))
	r, err := fetchURL(w, "https://8.8.8.8/pid")
	if err != nil {
		t.Fatal(err)
	}
	var child int
	fmt.Sscan(fmt.Sprint(r.Readability["text"]), &child)
	worker := w.PID()
	if !alive(child) || !alive(worker) {
		t.Fatalf("worker %d child %d not running", worker, child)
	}
	w.Shutdown()
	waitDead(t, worker)
	waitDead(t, child)
	if w.PID() != 0 {
		t.Fatal("Shutdown kept the process")
	}
	// A later fetch starts a new worker.
	if _, err := fetchURL(w, "https://8.8.8.8/a"); err != nil {
		t.Fatal(err)
	}
	w.Shutdown()
	if w.Starts() != 2 {
		t.Fatalf("starts %d", w.Starts())
	}
}

func TestWorkerStartupFailures(t *testing.T) {
	cases := map[string]string{
		"never":   "Camoufox worker did not start within 300ms",
		"fatal":   "Camoufox failed to start: no display",
		"exit":    "Camoufox worker exited (exit 3): fake worker starting | Traceback: ImportError: camoufox",
		"badline": "Camoufox worker sent an invalid line: invalid character 'o' in literal null (expecting 'u')",
	}
	for mode, want := range cases {
		w := NewCamoufoxWorker(fakeOptions(mode, 300*time.Millisecond))
		start := time.Now()
		_, err := fetchURL(w, "https://8.8.8.8/a")
		if err == nil || err.Error() != want {
			t.Errorf("%s: got %v, want %q", mode, err, want)
		}
		if time.Since(start) > 3*time.Second {
			t.Errorf("%s took %v", mode, time.Since(start))
		}
		pid := w.PID()
		w.Shutdown()
		if pid != 0 {
			waitDead(t, pid)
		}
	}
	// The next call after a failed start tries again.
	w := NewCamoufoxWorker(fakeOptions("fatal", time.Second))
	_, _ = fetchURL(w, "https://8.8.8.8/a")
	_, _ = fetchURL(w, "https://8.8.8.8/a")
	if w.Starts() != 2 {
		t.Errorf("failed start was not retried: starts %d", w.Starts())
	}
	w.Shutdown()
}

func TestWorkerCommandError(t *testing.T) {
	rt := NewRuntime(LoadEnv(func(k string) (string, bool) {
		if k == "BROWSER_SEARCH_UV" {
			return "/nonexistent/aio-uv", true
		}
		return "", false
	}))
	rt.WorkerDir = t.TempDir()
	_, err := rt.Worker.Fetch(context.Background(), WorkerRequest{URL: "https://8.8.8.8/a", Format: "text", TimeoutMs: 1000}, nil)
	if err == nil || err.Error() != "uv was not found (/nonexistent/aio-uv); install uv or set BROWSER_SEARCH_UV" {
		t.Fatalf("got %v", err)
	}
}

func TestWorkerRequestTimeoutKills(t *testing.T) {
	w := NewCamoufoxWorker(fakeOptions("", 5*time.Second))
	defer w.Shutdown()
	if _, err := fetchURL(w, "https://8.8.8.8/a"); err != nil {
		t.Fatal(err)
	}
	pid := w.PID()
	_, err := w.Fetch(context.Background(), WorkerRequest{URL: "https://8.8.8.8/hang", Format: "text", TimeoutMs: 100}, nil)
	if err == nil || err.Error() != "Camoufox did not answer within 300ms; the worker was stopped" {
		t.Fatalf("got %v", err)
	}
	waitDead(t, pid)
	if _, err := fetchURL(w, "https://8.8.8.8/a"); err != nil || w.Starts() != 2 {
		t.Fatalf("restart: %v starts %d", err, w.Starts())
	}
}

func TestWorkerAbortKeepsBrowser(t *testing.T) {
	w := NewCamoufoxWorker(fakeOptions("", 5*time.Second))
	defer w.Shutdown()
	if _, err := fetchURL(w, "https://8.8.8.8/a"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if _, err := w.Fetch(ctx, WorkerRequest{URL: "https://8.8.8.8/slow", Format: "text", TimeoutMs: 1000}, nil); !errors.Is(err, ErrAborted) {
		t.Fatalf("got %v", err)
	}
	// The next request waits for the abandoned one, then runs on the same
	// worker.
	r, err := fetchURL(w, "https://8.8.8.8/b")
	if err != nil || !r.OK || w.Starts() != 1 {
		t.Fatalf("after abort: %+v %v starts %d", r, err, w.Starts())
	}
	// A cancelled wait for the start leaves the start running.
	w2 := NewCamoufoxWorker(fakeOptions("", 5*time.Second))
	defer w2.Shutdown()
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if _, err := w2.Fetch(ctx2, WorkerRequest{URL: "https://8.8.8.8/a", Format: "text", TimeoutMs: 1000}, nil); !errors.Is(err, ErrAborted) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestWorkerFiles(t *testing.T) {
	dir := t.TempDir()
	worker, rd, err := workerFiles(dir, "READABILITY")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(worker)
	if string(data) != WorkerSource || !strings.Contains(WorkerSource, `dependencies = ["camoufox==0.5.9"]`) {
		t.Fatal("worker file differs from the embedded source")
	}
	data, _ = os.ReadFile(rd)
	if string(data) != "READABILITY" {
		t.Fatal("readability file")
	}
	// Rewriting the same files is a no-op; a changed file is replaced.
	_ = os.WriteFile(rd, []byte("stale"), 0o644)
	if _, _, err := workerFiles(dir, "READABILITY"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(rd)
	if string(data) != "READABILITY" {
		t.Fatal("stale readability file kept")
	}
}

func TestWorkerOptionsCommand(t *testing.T) {
	dir := t.TempDir()
	fakeUV := dir + "/uv"
	_ = os.WriteFile(fakeUV, []byte("#!/bin/sh\nexit 0\n"), 0o755)
	env := LoadEnv(func(k string) (string, bool) {
		v, ok := map[string]string{
			"BROWSER_SEARCH_UV": fakeUV, "BROWSER_SEARCH_PYTHON": "/opt/py3.12", "BROWSER_SEARCH_CAMOUFOX_HEADLESS": "false",
			"BROWSER_SEARCH_CAMOUFOX_PROXY": "http://127.0.0.1:3128", "BROWSER_SEARCH_CAMOUFOX_STARTUP_TIMEOUT_MS": "90000",
		}[k]
		return v, ok
	})
	rt := NewRuntime(env)
	rt.WorkerDir = dir + "/w"
	opts := rt.workerOptions()
	if opts.StartupTimeout != 90*time.Second {
		t.Fatalf("startup %v", opts.StartupTimeout)
	}
	cmd, init, err := opts.Command()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{fakeUV, "run", "--no-config", "--python", "/opt/py3.12", "--script", dir + "/w/camoufox_worker.py"}
	if strings.Join(cmd.Args, " ") != strings.Join(want, " ") {
		t.Fatalf("args %v", cmd.Args)
	}
	data, _ := json.Marshal(init)
	if !strings.Contains(string(data), `"headless":false`) || !strings.Contains(string(data), `"proxy":{"server":"http://127.0.0.1:3128"}`) ||
		!strings.Contains(string(data), `"readabilityPath":"`+dir+`/w/Readability.js"`) || !strings.Contains(string(data), `"127.0.0.0/8"`) {
		t.Fatalf("init %s", data)
	}
}

func TestLoadEnvGoOnly(t *testing.T) {
	e := LoadEnv(func(string) (string, bool) { return "", false })
	if e.CamofoxExplicit || !e.CamoufoxHeadless || e.CamoufoxStartupTimeoutMs != 1_800_000 || e.CamoufoxPageTimeoutMs != 30_000 ||
		e.HTTPTimeoutMs != 20_000 || e.HTTPMaxBytes != 5<<20 || e.UvBinary != "" || e.CamofoxBase != "http://localhost:9377" {
		t.Fatalf("defaults %+v", e)
	}
	for env, explicit := range map[string]bool{"http://cf:1": true, "  ": false} {
		e := LoadEnv(func(k string) (string, bool) {
			if k == "BROWSER_SEARCH_CAMOFOX_BASE" {
				return env, true
			}
			return "", false
		})
		if e.CamofoxExplicit != explicit {
			t.Errorf("%q: explicit %v", env, e.CamofoxExplicit)
		}
	}
	e = LoadEnv(func(k string) (string, bool) {
		if k == "CAMOFOX_BASE" {
			return "http://legacy:1", true
		}
		return "", false
	})
	if !e.CamofoxExplicit {
		t.Error("CAMOFOX_BASE is explicit")
	}
}
