package browsersearch

// Local Camoufox worker client (Go-only; TypeScript uses the Camofox
// container and the CloakBrowser Node worker instead).
//
// Go starts worker/camoufox_worker.py lazily on the first browser fetch with
// `uv run --script` (the file carries PEP 723 metadata, so uv builds its
// environment with camoufox and Playwright; no repository virtual
// environment is needed). One worker process lives per extension and keeps
// its browser warm. Requests and answers are line-delimited JSON over the
// worker's stdin and stdout (see the protocol in camoufox_worker.py).
//
// Lifecycle:
//   - Start: on demand. The start (uv install on first use, the Camoufox
//     browser download on first use, the launch) is bounded by the startup
//     timeout, not by the per-URL timeout. It runs on its own: a cancelled
//     tool call stops waiting, but the start goes on for the next call.
//   - Requests: one at a time. Each has the page timeout plus a grace
//     period; when that passes, Go kills the worker. A cancelled call leaves
//     the request to finish in the background (the browser stays warm).
//   - Crash: a worker that exits fails its pending request; the next call
//     starts a new one.
//   - Stop: Shutdown (session_shutdown) sends "shutdown", closes stdin, and
//     kills the process tree when it does not exit in time. When the Go
//     extension itself exits, the worker sees end-of-file on stdin and
//     closes its browser.

import (
	"bufio"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// WorkerSource is worker/camoufox_worker.py. Go writes it to a cache folder
// at run time, so a PiG install from git needs no extra files.
//
//go:embed worker/camoufox_worker.py
var WorkerSource string

// workerProtocol is the protocol version of the "init" message.
const workerProtocol = 1

// maxWorkerLine bounds one protocol line from the worker.
const maxWorkerLine = 64 << 20

// WorkerRequest is one fetch for the worker.
type WorkerRequest struct {
	URL       string
	Format    string
	TimeoutMs int
}

// BlockedRequest is a browser request that the worker's policy refused.
type BlockedRequest struct {
	URL    string `json:"url"`
	Reason string `json:"reason"`
}

// WorkerResponse is the worker's "result" message.
type WorkerResponse struct {
	ID          int              `json:"id"`
	OK          bool             `json:"ok"`
	Error       string           `json:"error"`
	FinalURL    string           `json:"finalUrl"`
	Title       string           `json:"title"`
	Readability map[string]any   `json:"readability"`
	Snapshot    *string          `json:"snapshot"`
	HTML        *string          `json:"html"`
	Blocked     []BlockedRequest `json:"blocked"`
}

// workerMessage is any line from the worker.
type workerMessage struct {
	Type    string `json:"type"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Error   string `json:"error"`
	WorkerResponse
}

// Progress is a worker progress message. Download is true for the
// first-use browser download.
type Progress struct {
	Message  string
	Download bool
}

// BrowserWorker is the local browser tier (the Camoufox worker, or a test
// fake).
type BrowserWorker interface {
	Fetch(ctx context.Context, req WorkerRequest, progress func(Progress)) (WorkerResponse, error)
	Shutdown()
}

// WorkerOptions configure a CamoufoxWorker.
type WorkerOptions struct {
	// Command builds the worker command and the "init" message fields
	// (without "op" and "protocol"). The command must not set Stdin,
	// Stdout, Stderr, or SysProcAttr.
	Command func() (*exec.Cmd, map[string]any, error)
	// StartupTimeout bounds the start until "ready".
	StartupTimeout time.Duration
	// RequestGrace is added to each request's TimeoutMs before Go kills
	// the worker.
	RequestGrace time.Duration
	// StopGrace is how long Shutdown waits for a clean exit.
	StopGrace time.Duration
	// Debug, when set, receives the worker's stderr lines.
	Debug io.Writer
}

// CamoufoxWorker owns at most one worker process.
type CamoufoxWorker struct {
	opts func() WorkerOptions

	mu     sync.Mutex
	proc   *workerProc
	sem    chan struct{}
	nextID int
	starts int
}

// NewCamoufoxWorker returns a worker that reads its options at each start.
func NewCamoufoxWorker(opts func() WorkerOptions) *CamoufoxWorker {
	return &CamoufoxWorker{opts: opts, sem: make(chan struct{}, 1)}
}

// Starts reports how many worker processes were started (tests).
func (w *CamoufoxWorker) Starts() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.starts
}

// PID returns the running worker's process id, or 0.
func (w *CamoufoxWorker) PID() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.proc == nil {
		return 0
	}
	return w.proc.pid
}

type workerProc struct {
	cmd     *exec.Cmd
	pid     int
	stdin   *os.File
	writeMu sync.Mutex

	ready     chan struct{}
	readyOnce sync.Once
	done      chan struct{}

	mu        sync.Mutex
	readyErr  error
	exitErr   error
	pending   map[int]chan WorkerResponse
	listeners map[int]func(Progress)
	nextL     int
	stderr    []byte
	killed    bool
}

func (p *workerProc) markReady(err error) {
	p.readyOnce.Do(func() {
		p.mu.Lock()
		p.readyErr = err
		p.mu.Unlock()
		close(p.ready)
	})
}

func (p *workerProc) startError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.readyErr
}

func (p *workerProc) exitError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exitErr != nil {
		return p.exitErr
	}
	return errors.New("Camoufox worker exited")
}

func (p *workerProc) alive() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *workerProc) addListener(fn func(Progress)) func() {
	if fn == nil {
		return func() {}
	}
	p.mu.Lock()
	p.nextL++
	id := p.nextL
	p.listeners[id] = fn
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		delete(p.listeners, id)
		p.mu.Unlock()
	}
}

func (p *workerProc) progress(pr Progress) {
	p.mu.Lock()
	fns := make([]func(Progress), 0, len(p.listeners))
	for _, fn := range p.listeners {
		fns = append(fns, fn)
	}
	p.mu.Unlock()
	for _, fn := range fns {
		fn(pr)
	}
}

func (p *workerProc) send(message map[string]any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err = p.stdin.Write(append(data, '\n'))
	return err
}

func (p *workerProc) stderrTail() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return lastLines(string(p.stderr), 6)
}

// lastLines returns the last n non-empty lines of text.
func lastLines(text string, n int) string {
	var lines []string
	for _, l := range strings.Split(text, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// signalTree signals the worker's process group and every descendant in
// the ps snapshot. Playwright starts the browser in its own process group,
// so the group signal alone would miss it.
func (p *workerProc) signalTree(sig syscall.Signal, tree []int) {
	_ = syscall.Kill(-p.pid, sig)
	for _, pid := range tree {
		if pid > 1 && pid != os.Getpid() {
			_ = syscall.Kill(pid, sig)
		}
	}
	_ = p.cmd.Process.Signal(sig)
}

// descendants lists the process tree below pid from `ps`. It returns nil
// when ps fails.
func descendants(pid int) []int {
	out, err := exec.Command("ps", "-A", "-o", "pid=", "-o", "ppid=").Output()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		c, err1 := strconv.Atoi(f[0])
		pp, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil {
			children[pp] = append(children[pp], c)
		}
	}
	var tree []int
	queue := []int{pid}
	seen := map[int]bool{pid: true}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		for _, c := range children[next] {
			if !seen[c] {
				seen[c] = true
				tree = append(tree, c)
				queue = append(queue, c)
			}
		}
	}
	return tree
}

// kill stops the process tree at once.
func (p *workerProc) kill(reason error) {
	p.mu.Lock()
	if p.killed {
		p.mu.Unlock()
		return
	}
	p.killed = true
	if reason != nil && p.exitErr == nil {
		p.exitErr = reason
	}
	p.mu.Unlock()
	p.signalTree(syscall.SIGKILL, descendants(p.pid))
	p.stdin.Close()
	p.markReady(p.exitError())
}

// stop asks the worker to exit, then kills what is left after grace.
func (p *workerProc) stop(grace time.Duration) {
	tree := descendants(p.pid)
	_ = p.send(map[string]any{"op": "shutdown"})
	p.stdin.Close()
	select {
	case <-p.done:
	case <-time.After(grace):
		p.signalTree(syscall.SIGTERM, tree)
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
		}
	}
	// The browser can outlive a worker that was killed or did not close
	// it; nothing of the tree may stay.
	p.signalTree(syscall.SIGKILL, tree)
	p.mu.Lock()
	p.killed = true
	p.mu.Unlock()
}

func (w *CamoufoxWorker) start(opts WorkerOptions) (*workerProc, error) {
	if opts.Command == nil {
		return nil, errors.New("no worker command")
	}
	cmd, initFields, err := opts.Command()
	if err != nil {
		return nil, err
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		stdoutR.Close()
		stdoutW.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW} {
			f.Close()
		}
		return nil, errors.New("could not start the Camoufox worker: " + spawnError(cmd.Path, err))
	}
	stdinR.Close()
	stdoutW.Close()
	stderrW.Close()
	p := &workerProc{
		cmd: cmd, pid: cmd.Process.Pid, stdin: stdinW,
		ready: make(chan struct{}), done: make(chan struct{}),
		pending: map[int]chan WorkerResponse{}, listeners: map[int]func(Progress){},
	}

	go func() {
		buf := make([]byte, 8192)
		var partial []byte
		for {
			n, err := stderrR.Read(buf)
			if n > 0 {
				p.mu.Lock()
				p.stderr = append(p.stderr, buf[:n]...)
				if len(p.stderr) > 16384 {
					p.stderr = p.stderr[len(p.stderr)-16384:]
				}
				p.mu.Unlock()
				if opts.Debug != nil {
					partial = append(partial, buf[:n]...)
					for {
						i := strings.IndexByte(string(partial), '\n')
						if i < 0 {
							break
						}
						fmt.Fprintf(opts.Debug, "[camoufox] %s\n", partial[:i])
						partial = partial[i+1:]
					}
				}
			}
			if err != nil {
				stderrR.Close()
				return
			}
		}
	}()

	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		defer stdoutR.Close()
		scanner := bufio.NewScanner(stdoutR)
		scanner.Buffer(make([]byte, 64*1024), maxWorkerLine)
		for scanner.Scan() {
			var m workerMessage
			if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
				p.kill(fmt.Errorf("Camoufox worker sent an invalid line: %s", err))
				return
			}
			switch m.Type {
			case "progress":
				p.progress(Progress{Message: m.Message, Download: m.Kind == "download"})
			case "ready":
				p.markReady(nil)
			case "fatal":
				p.mu.Lock()
				if p.exitErr == nil {
					p.exitErr = errors.New(m.Error)
				}
				p.mu.Unlock()
				p.markReady(errors.New(m.Error))
			case "result":
				// workerMessage.Error shadows the embedded field.
				m.WorkerResponse.Error = m.Error
				p.mu.Lock()
				ch := p.pending[m.ID]
				delete(p.pending, m.ID)
				p.mu.Unlock()
				if ch != nil {
					ch <- m.WorkerResponse
				}
			}
		}
		if err := scanner.Err(); err != nil {
			p.kill(fmt.Errorf("Camoufox worker output failed: %s", err))
		}
	}()

	go func() {
		state, _ := cmd.Process.Wait()
		select {
		case <-stdoutDone:
		case <-time.After(500 * time.Millisecond):
			stdoutR.Close()
		}
		p.mu.Lock()
		if p.exitErr == nil {
			p.exitErr = fmt.Errorf("Camoufox worker exited (%s)", exitReason(state))
			if tail := lastLines(string(p.stderr), 6); tail != "" {
				p.exitErr = fmt.Errorf("Camoufox worker exited (%s): %s", exitReason(state), tail)
			}
		}
		p.mu.Unlock()
		p.markReady(p.exitError())
		close(p.done)
		p.stdin.Close()
	}()

	init := map[string]any{"op": "init", "protocol": workerProtocol}
	for k, v := range initFields {
		init[k] = v
	}
	if err := p.send(init); err != nil {
		p.kill(fmt.Errorf("could not send init to the Camoufox worker: %s", err))
	}
	startup := opts.StartupTimeout
	if startup <= 0 {
		startup = 30 * time.Minute
	}
	go func() {
		t := time.NewTimer(startup)
		defer t.Stop()
		select {
		case <-p.ready:
		case <-p.done:
		case <-t.C:
			p.kill(fmt.Errorf("Camoufox worker did not start within %s", startup))
		}
	}()
	return p, nil
}

func exitReason(state *os.ProcessState) string {
	if state == nil {
		return "exit unknown"
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return signalName(ws.Signal())
	}
	return "exit " + strconv.Itoa(state.ExitCode())
}

// ensure returns the live process, starting one when needed.
func (w *CamoufoxWorker) ensure(progress func(Progress)) (*workerProc, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if p := w.proc; p != nil {
		failed := false
		select {
		case <-p.ready:
			failed = p.startError() != nil
		default:
		}
		if p.alive() && !failed {
			return p, nil
		}
		if p.alive() {
			go p.kill(nil)
		}
		w.proc = nil
	}
	if progress != nil {
		progress(Progress{Message: "Starting the local Camoufox browser…"})
	}
	p, err := w.start(w.opts())
	if err != nil {
		return nil, err
	}
	w.proc = p
	w.starts++
	return p, nil
}

// Fetch runs one request on the worker, starting it when needed.
func (w *CamoufoxWorker) Fetch(ctx context.Context, req WorkerRequest, progress func(Progress)) (WorkerResponse, error) {
	select {
	case w.sem <- struct{}{}:
	case <-ctx.Done():
		return WorkerResponse{}, ErrAborted
	}
	release := true
	defer func() {
		if release {
			<-w.sem
		}
	}()
	p, err := w.ensure(progress)
	if err != nil {
		return WorkerResponse{}, err
	}
	remove := p.addListener(progress)
	defer remove()
	select {
	case <-p.ready:
	case <-ctx.Done():
		return WorkerResponse{}, ErrAborted
	}
	if err := p.startError(); err != nil {
		return WorkerResponse{}, err
	}
	if !p.alive() {
		return WorkerResponse{}, p.exitError()
	}
	opts := w.opts()
	w.mu.Lock()
	w.nextID++
	id := w.nextID
	w.mu.Unlock()
	ch := make(chan WorkerResponse, 1)
	p.mu.Lock()
	p.pending[id] = ch
	p.mu.Unlock()
	if err := p.send(map[string]any{"op": "fetch", "id": id, "url": req.URL, "format": req.Format, "timeoutMs": req.TimeoutMs}); err != nil {
		p.kill(fmt.Errorf("could not write to the Camoufox worker: %s", err))
		return WorkerResponse{}, p.exitError()
	}
	grace := opts.RequestGrace
	if grace <= 0 {
		grace = 20 * time.Second
	}
	deadline := time.Duration(req.TimeoutMs)*time.Millisecond + grace
	timer := time.NewTimer(deadline)
	timedOut := fmt.Errorf("Camoufox did not answer within %s; the worker was stopped", deadline)
	select {
	case r := <-ch:
		timer.Stop()
		return r, nil
	case <-p.done:
		timer.Stop()
		return WorkerResponse{}, p.exitError()
	case <-timer.C:
		p.kill(timedOut)
		return WorkerResponse{}, timedOut
	case <-ctx.Done():
		// Let the request finish in the background: the browser stays
		// warm, and the next request waits for it.
		release = false
		go func() {
			defer timer.Stop()
			select {
			case <-ch:
			case <-p.done:
			case <-timer.C:
				p.kill(timedOut)
			}
			<-w.sem
		}()
		return WorkerResponse{}, ErrAborted
	}
}

// Shutdown stops the worker process tree. The next Fetch starts a new one.
func (w *CamoufoxWorker) Shutdown() {
	w.mu.Lock()
	p := w.proc
	w.proc = nil
	w.mu.Unlock()
	if p == nil {
		return
	}
	grace := w.opts().StopGrace
	if grace <= 0 {
		grace = 5 * time.Second
	}
	p.stop(grace)
}

// workerFiles writes the embedded worker and Readability.js to dir (or a
// content-addressed folder in the user cache) and returns their paths.
func workerFiles(dir, readability string) (worker, readabilityPath string, err error) {
	if dir == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			return "", "", fmt.Errorf("no user cache folder for the Camoufox worker: %s", err)
		}
		sum := sha256.Sum256([]byte(WorkerSource + "\x00" + readability))
		dir = filepath.Join(base, "aio", "browser-search", "camoufox-worker-"+hex.EncodeToString(sum[:6]))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	worker = filepath.Join(dir, "camoufox_worker.py")
	readabilityPath = filepath.Join(dir, "Readability.js")
	for path, content := range map[string]string{worker: WorkerSource, readabilityPath: readability} {
		if existing, err := os.ReadFile(path); err == nil && string(existing) == content {
			continue
		}
		tmp, err := os.CreateTemp(dir, ".tmp-*")
		if err != nil {
			return "", "", err
		}
		_, werr := tmp.WriteString(content)
		cerr := tmp.Close()
		if werr != nil || cerr != nil {
			os.Remove(tmp.Name())
			return "", "", errors.Join(werr, cerr)
		}
		if err := os.Rename(tmp.Name(), path); err != nil {
			os.Remove(tmp.Name())
			return "", "", err
		}
	}
	return worker, readabilityPath, nil
}

// workerOptions are the production options for rt.
func (rt *Runtime) workerOptions() WorkerOptions {
	env := rt.Env
	policy := rt.Policy
	if policy == nil {
		p := DefaultBrowserPolicy()
		policy = &p
	}
	opts := WorkerOptions{
		StartupTimeout: time.Duration(env.CamoufoxStartupTimeoutMs) * time.Millisecond,
		StopGrace:      5 * time.Second,
	}
	if env.Debug {
		opts.Debug = rt.Stderr
	}
	opts.Command = func() (*exec.Cmd, map[string]any, error) {
		uv := env.UvBinary
		if uv == "" {
			uv = "uv"
		}
		path, err := exec.LookPath(uv)
		if err != nil {
			return nil, nil, fmt.Errorf("uv was not found (%s); install uv or set BROWSER_SEARCH_UV", uv)
		}
		dir := rt.WorkerDir
		if dir == "" {
			dir = env.CamoufoxWorkerDir
		}
		worker, readabilityPath, err := workerFiles(dir, rt.ReadabilitySource)
		if err != nil {
			return nil, nil, fmt.Errorf("could not write the Camoufox worker: %s", err)
		}
		// --no-config keeps project uv.toml files out; --script makes uv
		// build the environment from the file's inline metadata.
		args := []string{"run", "--no-config"}
		if env.PythonBinary != "" {
			args = append(args, "--python", env.PythonBinary)
		}
		args = append(args, "--script", worker)
		cmd := exec.Command(path, args...)
		cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1")
		init := map[string]any{"readabilityPath": readabilityPath, "policy": policy, "headless": env.CamoufoxHeadless}
		if env.CamoufoxProxy != "" {
			init["proxy"] = map[string]string{"server": env.CamoufoxProxy}
		}
		return cmd, init, nil
	}
	return opts
}

// spawnError is Node's spawn error text ("spawn <cmd> ENOENT").
func spawnError(binary string, err error) string {
	code := "UNKNOWN"
	switch {
	case errors.Is(err, os.ErrNotExist), errors.Is(err, exec.ErrNotFound):
		code = "ENOENT"
	case errors.Is(err, os.ErrPermission):
		code = "EACCES"
	}
	return fmt.Sprintf("spawn %s %s", binary, code)
}

func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	}
	return "SIG" + strings.ToUpper(sig.String())
}
