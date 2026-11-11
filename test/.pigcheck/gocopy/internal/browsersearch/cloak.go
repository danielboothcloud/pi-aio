package browsersearch

// CloakBrowser fallback (port of browser-search/cloak.ts cloakFetch). The
// browser runs in the existing Node worker (browser-search/cloak-worker.mjs),
// as in TypeScript: Go starts it as a child process with ordinary pipes,
// writes the request to stdin, and reads the AIO_CLOAK_RESULT line. Missing
// Node or a missing worker is a per-URL error, never a load failure.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const cloakResultPrefix = "AIO_CLOAK_RESULT:"

// CloakDeps are cloak.ts CloakWorkerDependencies. Zero values use the
// TypeScript defaults.
type CloakDeps struct {
	NodeBinary     string
	WorkerPath     string
	TimeoutMs      int
	KillGraceMs    int
	MaxOutputBytes int
	// Environ is the worker environment base (os.Environ() when nil).
	Environ []string
	// ResolveWorker finds the worker when WorkerPath is empty.
	ResolveWorker func() string
}

// CloakRequest is the CloakFetchOptions subset that fetchSingleUrl sends.
type CloakRequest struct {
	URL    string
	Format string // "" leaves format undefined (the worker uses "text")
	Unsafe bool
}

// FetchResult is types.ts FetchResult.
type FetchResult struct {
	URL               string          `json:"url"`
	FinalURL          *string         `json:"finalUrl,omitempty"`
	Title             *string         `json:"title,omitempty"`
	Content           string          `json:"content"`
	Format            string          `json:"format"`
	Chars             float64         `json:"chars"`
	Truncated         bool            `json:"truncated"`
	Tier              string          `json:"tier"`
	ChallengeStrategy json.RawMessage `json:"challengeStrategy,omitempty"`
	ChallengeResolved *bool           `json:"challengeResolved,omitempty"`
	Error             *string         `json:"error,omitempty"`
}

func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGABRT:
		return "SIGABRT"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	}
	return "SIG" + strings.ToUpper(sig.String())
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

// CloakFetch is cloak.ts cloakFetch.
func (rt *Runtime) CloakFetch(ctx context.Context, req CloakRequest) (FetchResult, error) {
	if err := aborted(ctx); err != nil {
		return FetchResult{}, err
	}
	if !req.Unsafe {
		check := ValidateURLWithDNS(ctx, rt.Resolver, req.URL)
		if err := aborted(ctx); err != nil {
			return FetchResult{}, err
		}
		if !check.Valid {
			return FetchResult{}, errors.New("URL blocked: " + check.Reason)
		}
	}
	deps := rt.Cloak
	node := deps.NodeBinary
	if node == "" {
		node = rt.Env.NodeBinary
	}
	if node == "" {
		node = "node"
	}
	timeout := deps.TimeoutMs
	if timeout == 0 {
		timeout = 240_000
	}
	grace := deps.KillGraceMs
	if grace == 0 {
		grace = 2_000
	}
	limit := deps.MaxOutputBytes
	if limit == 0 {
		limit = 8*rt.Env.CloakMaxChars + 65_536
	}
	input := `{"url":` + jsstr.QuoteJS(req.URL)
	if req.Format != "" {
		input += `,"format":` + jsstr.QuoteJS(req.Format)
	}
	if req.Unsafe {
		input += `,"unsafe":true`
	}
	input += "}"
	wantFormat := req.Format
	if wantFormat == "" {
		wantFormat = "text"
	}

	ownershipDir, err := os.MkdirTemp("", "aio-cloak-worker-")
	if err != nil {
		return FetchResult{}, fmt.Errorf("Could not start CloakBrowser Node worker: %s", err)
	}
	defer os.RemoveAll(ownershipDir)
	ownershipFile := filepath.Join(ownershipDir, "children")

	workerPath := deps.WorkerPath
	if workerPath == "" && deps.ResolveWorker != nil {
		workerPath = deps.ResolveWorker()
	}
	if workerPath == "" {
		return FetchResult{}, errors.New("Could not start CloakBrowser Node worker: browser-search/cloak-worker.mjs was not found beside the extension")
	}
	environ := deps.Environ
	if environ == nil {
		environ = os.Environ()
	}
	cmd := exec.Command(node, workerPath)
	cmd.Env = append(append([]string{}, environ...), "AIO_CLOAK_OWNERSHIP_FILE="+ownershipFile)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdin = strings.NewReader(input)
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return FetchResult{}, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdoutR.Close()
		stdoutW.Close()
		return FetchResult{}, err
	}
	cmd.Stdout, cmd.Stderr = stdoutW, stderrW
	if err := cmd.Start(); err != nil {
		stdoutR.Close()
		stdoutW.Close()
		stderrR.Close()
		stderrW.Close()
		return FetchResult{}, errors.New("Could not start CloakBrowser Node worker: " + spawnError(node, err))
	}
	stdoutW.Close()
	stderrW.Close()
	pid := cmd.Process.Pid

	signalTree := func(sig syscall.Signal) {
		_ = syscall.Kill(-pid, sig)
		data, _ := os.ReadFile(ownershipFile)
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 2 {
				continue
			}
			child, err := strconv.Atoi(fields[0])
			if err != nil || child <= 0 || child == os.Getpid() {
				continue
			}
			if fields[1] == "1" {
				_ = syscall.Kill(-child, sig)
			} else {
				_ = syscall.Kill(child, sig)
			}
		}
		_ = cmd.Process.Signal(sig)
	}

	var mu sync.Mutex
	var output bytes.Buffer
	var stderrText string
	outputBytes := 0
	overflow := make(chan struct{}, 1)
	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		buf := make([]byte, 32*1024)
		for {
			n, err := stdoutR.Read(buf)
			if n > 0 {
				mu.Lock()
				outputBytes += n
				if outputBytes > limit {
					select {
					case overflow <- struct{}{}:
					default:
					}
				} else {
					output.Write(buf[:n])
				}
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := stderrR.Read(buf)
			if n > 0 {
				mu.Lock()
				stderrText += string(buf[:n])
				if len(stderrText) > 8192 {
					stderrText = stderrText[len(stderrText)-8192:]
				}
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	exited := make(chan *os.ProcessState, 1)
	go func() {
		state, _ := cmd.Process.Wait()
		exited <- state
	}()
	closePipes := func() {
		stdoutR.Close()
		stderrR.Close()
	}

	var failure error
	var state *os.ProcessState
	timer := time.NewTimer(time.Duration(timeout) * time.Millisecond)
	defer timer.Stop()
	var killC <-chan time.Time
	stop := func(err error) {
		if failure != nil {
			return
		}
		failure = err
		signalTree(syscall.SIGTERM)
		killC = time.After(time.Duration(grace) * time.Millisecond)
	}
	done := ctx.Done()
wait:
	for {
		select {
		case <-done:
			done = nil
			stop(ErrAborted)
		case <-timer.C:
			stop(errors.New("CloakBrowser Node worker timed out"))
		case <-overflow:
			stop(errors.New("CloakBrowser worker exceeded its output limit"))
		case <-killC:
			// A descendant holding stdio must never keep the tool pending.
			signalTree(syscall.SIGKILL)
			closePipes()
			time.Sleep(25 * time.Millisecond)
			break wait
		case state = <-exited:
			// Normal close follows once buffered output drains; bound it.
			select {
			case <-stdoutDone:
			case <-time.After(100 * time.Millisecond):
			}
			break wait
		}
	}
	signalTree(syscall.SIGKILL)
	closePipes()
	if failure != nil {
		return FetchResult{}, failure
	}
	mu.Lock()
	out, errText := output.String(), stderrText
	mu.Unlock()
	if state == nil || !state.Success() {
		reason := "exit null"
		if state != nil {
			if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				reason = signalName(ws.Signal())
			} else {
				reason = "exit " + strconv.Itoa(state.ExitCode())
			}
		}
		diag := jsstr.Trim(errText)
		if diag == "" {
			diag = "no diagnostic output"
		}
		return FetchResult{}, fmt.Errorf("CloakBrowser Node worker failed (%s): %s", reason, diag)
	}
	return parseWorkerOutput(out, req.URL, wantFormat)
}

// parseWorkerOutput reads the last AIO_CLOAK_RESULT line (cloak.ts finish).
func parseWorkerOutput(out, url, format string) (FetchResult, error) {
	invalid := func(msg string) error {
		return errors.New("Invalid CloakBrowser worker response: " + msg)
	}
	line := ""
	found := false
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, cloakResultPrefix) {
			line, found = l, true
		}
	}
	if !found {
		return FetchResult{}, invalid("Error: missing result")
	}
	text := strings.TrimPrefix(line, cloakResultPrefix)
	message, err := parseJS(text)
	if err != nil {
		return FetchResult{}, invalid("SyntaxError: " + err.Error())
	}
	if msg, ok := get(message, "error").(string); ok {
		return FetchResult{}, errors.New(msg)
	}
	result := get(message, "result")
	_, isString := get(result, "content").(string)
	_, isNumber := get(result, "chars").(float64)
	_, isBool := get(result, "truncated").(bool)
	if !truthy(result) || get(result, "url") != url || get(result, "tier") != "cloak" || get(result, "format") != format || !isString || !isNumber || !isBool {
		return FetchResult{}, invalid("Error: invalid result shape")
	}
	var raw struct {
		Result FetchResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return FetchResult{}, invalid("Error: invalid result shape")
	}
	return raw.Result, nil
}
