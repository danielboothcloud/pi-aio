package yamlhooks

// Bash hook execution (port of yaml-hooks/bash-executor.ts and
// bash-types.ts): bash -c with the hook context env, a JSON stdin payload
// with byte caps, capped stdout/stderr on UTF-8 boundaries, and the
// timeout (SIGTERM to the process group, SIGKILL after 250 ms).

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const (
	// DefaultBashTimeout is bash-types.ts DEFAULT_BASH_TIMEOUT (ms).
	DefaultBashTimeout = 60_000
	// TimeoutExitCode is bash-types.ts TIMEOUT_EXIT_CODE.
	TimeoutExitCode     = 124
	blockingExitCode    = 2
	spawnErrorExitCode  = 127
	killGracePeriod     = 250 * time.Millisecond
	truncationMarker    = "\n…[aio yaml hooks: output truncated]"
	execContextCacheTTL = 5 * time.Minute
)

// BashContext is BashHookContext. Optional fields are nil when absent.
type BashContext struct {
	SessionID string
	Event     string
	Cwd       string
	Prompt    *string
	Files     []string // nil: absent
	HasFiles  bool
	Changes   []FileChange
	HasChange bool
	ToolName  *string
	ToolArgs  *Object // nil: absent
}

// ToObject is the context as the JSON object TypeScript stringifies.
func (c BashContext) ToObject() *Object {
	o := NewObject("session_id", c.SessionID, "event", c.Event, "cwd", c.Cwd)
	if c.Prompt != nil {
		o.Set("prompt", *c.Prompt)
	}
	if c.HasFiles {
		o.Set("files", stringsToAny(c.Files))
	}
	if c.HasChange {
		o.Set("changes", changesToAny(c.Changes))
	}
	if c.ToolName != nil {
		o.Set("tool_name", *c.ToolName)
	}
	if c.ToolArgs != nil {
		o.Set("tool_args", c.ToolArgs)
	}
	return o
}

func changesToAny(changes []FileChange) []any {
	out := make([]any, len(changes))
	for i, c := range changes {
		out[i] = changeObject(c)
	}
	return out
}

func changeObject(c FileChange) *Object {
	if c.Operation == "rename" {
		return NewObject("operation", c.Operation, "fromPath", c.FromPath, "toPath", c.ToPath)
	}
	return NewObject("operation", c.Operation, "path", c.Path)
}

// BashRequest is BashExecutionRequest. Timeout is in ms (0: default).
type BashRequest struct {
	Command    string
	Context    BashContext
	ProjectDir string
	Timeout    float64
}

// BashResult is BashHookResult. Signal is "" for null.
type BashResult struct {
	Command         string
	Stdout          string
	Stderr          string
	DurationMs      int64
	ExitCode        int
	Signal          string
	TimedOut        bool
	OutputTruncated bool
	StdinTruncated  bool
	Status          string // success, failed, blocked, timed_out
	Blocking        bool
}

// ExecuteBashFunc runs one bash hook (the executeBash seam).
type ExecuteBashFunc func(BashRequest) (BashResult, error)

// MapProcessResult is mapBashProcessResultToHookResult.
func MapProcessResult(r BashResult, event string) BashResult {
	switch {
	case r.TimedOut:
		r.Status, r.Blocking = "timed_out", false
	case r.ExitCode == 0:
		r.Status, r.Blocking = "success", false
	case r.ExitCode == blockingExitCode && IsBlockingToolBeforeEvent(event):
		r.Status, r.Blocking = "blocked", true
	default:
		r.Status, r.Blocking = "failed", false
	}
	return r
}

// IsBlockingToolBeforeEvent is bash-executor.ts isBlockingToolBeforeEvent.
func IsBlockingToolBeforeEvent(event string) bool { return strings.HasPrefix(event, "tool.before.") }

// SerializeContextForStdin is serializeContextForStdinDetailed.
func SerializeContextForStdin(c BashContext) (string, bool) {
	maxBytes := envMaxStdinBytes()
	obj := c.ToObject()
	text := Stringify(obj)
	if byteLength(text) <= maxBytes {
		return text, false
	}
	original := float64(byteLength(text))
	truncated := &Object{Values: map[string]any{}}
	for _, k := range obj.Keys {
		truncated.Set(k, obj.Values[k])
	}
	truncated.Set("_aio_hooks_truncated", true)
	truncated.Set("_aio_hooks_original_byte_length", original)
	truncated.Set("_aio_hooks_max_byte_length", float64(maxBytes))
	for _, k := range truncated.Keys {
		if k == "_aio_hooks_truncated" || k == "_aio_hooks_original_byte_length" || k == "_aio_hooks_max_byte_length" {
			continue
		}
		switch v := truncated.Values[k].(type) {
		case string:
			if n := jsstr.Len16(v); n > 1024 {
				truncated.Values[k] = fmt.Sprintf("[aio yaml hooks: truncated string of %d chars]", n)
			}
		case *Object, []any:
			if size := byteLength(Stringify(v)); size > 4096 {
				truncated.Values[k] = fmt.Sprintf("[aio yaml hooks: truncated nested value of %d bytes]", size)
			}
		}
	}
	reduced := Stringify(truncated)
	if byteLength(reduced) <= maxBytes {
		return reduced, true
	}
	return Stringify(NewObject(
		"session_id", c.SessionID, "event", c.Event, "cwd", c.Cwd,
		"_aio_hooks_truncated", true,
		"_aio_hooks_original_byte_length", original,
		"_aio_hooks_max_byte_length", float64(maxBytes),
	)), true
}

// TrimToUTF8Boundary is bash-executor.ts trimToUtf8Boundary.
func TrimToUTF8Boundary(chunk []byte, maxBytes int) int {
	if maxBytes <= 0 {
		return 0
	}
	limit := min(maxBytes, len(chunk))
	if limit == 0 {
		return 0
	}
	for i := limit; i > 0; i-- {
		b := chunk[i-1]
		if b&0xC0 != 0x80 {
			expected := 0
			switch {
			case b&0x80 == 0:
				expected = 1
			case b&0xE0 == 0xC0:
				expected = 2
			case b&0xF0 == 0xE0:
				expected = 3
			case b&0xF8 == 0xF0:
				expected = 4
			}
			start := i - 1
			if expected > 0 && start+expected <= limit {
				return start + expected
			}
			return start
		}
	}
	return 0
}

// cappedBuffer is CappedOutputBuffer.
type cappedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.append(p)
	return len(p), nil
}

func (c *cappedBuffer) append(chunk []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.truncated {
		return
	}
	maxBytes := envMaxOutputBytes()
	if c.buf.Len()+len(chunk) <= maxBytes {
		c.buf.Write(chunk)
		return
	}
	if remaining := maxBytes - c.buf.Len(); remaining > 0 {
		if end := TrimToUTF8Boundary(chunk, remaining); end > 0 {
			c.buf.Write(chunk[:end])
		}
	}
	c.truncated = true
}

func (c *cappedBuffer) isTruncated() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.truncated
}

func (c *cappedBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := strings.ToValidUTF8(c.buf.String(), "\uFFFD")
	if c.truncated {
		return s + truncationMarker
	}
	return s
}

var requiredContextEnvKeys = map[string]bool{
	"PI_PROJECT_DIR": true, "OPENCODE_PROJECT_DIR": true,
	"PI_WORKTREE_DIR": true, "OPENCODE_WORKTREE_DIR": true,
	"PI_SESSION_ID": true, "OPENCODE_SESSION_ID": true,
	"PI_GIT_COMMON_DIR": true, "OPENCODE_GIT_COMMON_DIR": true,
}

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// EnvPair is one environment entry in order.
type EnvPair struct{ Key, Value string }

// BuildBashEnvironment is bash-executor.ts buildBashEnvironment: the
// inherited env (or only its allowlisted names), then the context env.
func BuildBashEnvironment(inherited []EnvPair, context []EnvPair) []EnvPair {
	lookup := map[string]string{}
	for _, p := range inherited {
		lookup[p.Key] = p.Value
	}
	var base []EnvPair
	if raw := lookup["PI_YAML_HOOKS_ENV_ALLOWLIST"]; raw == "" {
		base = append(base, inherited...)
	} else {
		seen := map[string]bool{}
		for _, entry := range strings.Split(raw, ",") {
			name := jsstr.Trim(entry)
			if !envNameRE.MatchString(name) || seen[name] || requiredContextEnvKeys[name] {
				continue
			}
			seen[name] = true
			if v, ok := lookup[name]; ok {
				base = append(base, EnvPair{name, v})
			}
		}
	}
	out := make([]EnvPair, 0, len(base)+len(context))
	override := map[string]int{}
	for _, p := range base {
		override[p.Key] = len(out)
		out = append(out, p)
	}
	for _, p := range context {
		if i, ok := override[p.Key]; ok {
			out[i].Value = p.Value
			continue
		}
		override[p.Key] = len(out)
		out = append(out, p)
	}
	return out
}

type execContext struct {
	worktreeDir  string
	gitCommonDir string
}

type execContextEntry struct {
	context execContext
	expires time.Time
}

var (
	execContextMu    sync.Mutex
	execContextCache = map[string]execContextEntry{}
)

func gitOutput(dir string, args ...string) (string, bool) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func resolveExecutionContext(projectDir string) execContext {
	now := time.Now()
	execContextMu.Lock()
	cached, ok := execContextCache[projectDir]
	execContextMu.Unlock()
	if ok && cached.expires.After(now) {
		return cached.context
	}
	ctx := execContext{worktreeDir: projectDir}
	if top, ok := gitOutput(projectDir, "rev-parse", "--show-toplevel"); ok {
		if top != "" && strings.HasPrefix(top, "/") {
			ctx.worktreeDir = top
		}
		if common, ok := gitOutput(projectDir, "rev-parse", "--git-common-dir"); ok && common != "" {
			if strings.HasPrefix(common, "/") {
				ctx.gitCommonDir = common
			} else {
				ctx.gitCommonDir = resolvePath(projectDir, common)
			}
		}
	}
	execContextMu.Lock()
	execContextCache[projectDir] = execContextEntry{ctx, now.Add(execContextCacheTTL)}
	execContextMu.Unlock()
	return ctx
}

func osEnviron() []EnvPair {
	var out []EnvPair
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if ok && k != "" {
			out = append(out, EnvPair{k, v})
		}
	}
	return out
}

// ExecuteBashHook is bash-executor.ts executeBashHook.
func ExecuteBashHook(req BashRequest) (BashResult, error) {
	return MapProcessResult(executeBashProcess(req), req.Context.Event), nil
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT",
	syscall.SIGILL: "SIGILL", syscall.SIGTRAP: "SIGTRAP", syscall.SIGABRT: "SIGABRT",
	syscall.SIGBUS: "SIGBUS", syscall.SIGFPE: "SIGFPE", syscall.SIGKILL: "SIGKILL",
	syscall.SIGUSR1: "SIGUSR1", syscall.SIGSEGV: "SIGSEGV", syscall.SIGUSR2: "SIGUSR2",
	syscall.SIGPIPE: "SIGPIPE", syscall.SIGALRM: "SIGALRM", syscall.SIGTERM: "SIGTERM",
}

func executeBashProcess(req BashRequest) BashResult {
	timeout := req.Timeout
	if timeout == 0 {
		timeout = DefaultBashTimeout
	}
	start := time.Now()
	ec := resolveExecutionContext(req.ProjectDir)
	contextEnv := []EnvPair{
		{"PI_PROJECT_DIR", req.ProjectDir}, {"OPENCODE_PROJECT_DIR", req.ProjectDir},
		{"PI_WORKTREE_DIR", ec.worktreeDir}, {"OPENCODE_WORKTREE_DIR", ec.worktreeDir},
		{"PI_SESSION_ID", req.Context.SessionID}, {"OPENCODE_SESSION_ID", req.Context.SessionID},
	}
	if ec.gitCommonDir != "" {
		contextEnv = append(contextEnv, EnvPair{"PI_GIT_COMMON_DIR", ec.gitCommonDir}, EnvPair{"OPENCODE_GIT_COMMON_DIR", ec.gitCommonDir})
	}
	env := BuildBashEnvironment(osEnviron(), contextEnv)
	envList := make([]string, len(env))
	for i, p := range env {
		envList[i] = p.Key + "=" + p.Value
	}
	stdout, stderr := &cappedBuffer{}, &cappedBuffer{}
	payload, stdinTruncated := SerializeContextForStdin(req.Context)
	bin := envBashExecutable()
	cmd := exec.Command(bin, "-c", req.Command)
	cmd.Dir = req.Context.Cwd
	cmd.Env = envList
	cmd.Stdin = strings.NewReader(payload)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	result := func(exitCode int, signal string, timedOut bool) BashResult {
		return BashResult{
			Command: req.Command, Stdout: stdout.String(), Stderr: stderr.String(),
			DurationMs: time.Since(start).Milliseconds(), ExitCode: exitCode, Signal: signal,
			TimedOut: timedOut, OutputTruncated: stdout.isTruncated() || stderr.isTruncated(),
			StdinTruncated: stdinTruncated,
		}
	}
	if err := cmd.Start(); err != nil {
		stderr.append([]byte("\n" + spawnErrorMessage(bin, err)))
		return result(spawnErrorExitCode, "", false)
	}
	pid := cmd.Process.Pid
	var notesMu sync.Mutex
	var notes []string
	var timedOut bool
	var killTimer *time.Timer
	timeoutTimer := time.AfterFunc(time.Duration(timeout*float64(time.Millisecond)), func() {
		notesMu.Lock()
		timedOut = true
		notes = append(notes, signalTimedOut(pid, syscall.SIGTERM, timeout)...)
		killTimer = time.AfterFunc(killGracePeriod, func() {
			notesMu.Lock()
			notes = append(notes, signalTimedOut(pid, syscall.SIGKILL, timeout)...)
			notesMu.Unlock()
		})
		notesMu.Unlock()
	})
	waitErr := cmd.Wait()
	timeoutTimer.Stop()
	notesMu.Lock()
	if killTimer != nil {
		killTimer.Stop()
	}
	wasTimedOut := timedOut
	collected := append([]string{}, notes...)
	notesMu.Unlock()

	code, signal := -1, ""
	if state := cmd.ProcessState; state != nil {
		if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			signal = signalNames[ws.Signal()]
			if signal == "" {
				signal = ws.Signal().String()
			}
		} else {
			code = state.ExitCode()
		}
	} else if waitErr != nil {
		code = -1
	}
	exitCode := code
	if wasTimedOut {
		exitCode = TimeoutExitCode
	} else if code < 0 {
		exitCode = spawnErrorExitCode
	}
	if wasTimedOut {
		codeText, signalText := "none", "none"
		if code >= 0 {
			codeText = fmt.Sprint(code)
		}
		if signal != "" {
			signalText = signal
		}
		lines := append([]string{fmt.Sprintf("Command timed out after %sms", jsstr.NumberJS(timeout))}, collected...)
		lines = append(lines, fmt.Sprintf("Timeout cleanup: final result exitCode=%s signal=%s", codeText, signalText))
		for _, line := range lines {
			if line != "" {
				stderr.append([]byte("\n" + line))
			}
		}
	}
	return result(exitCode, signal, wasTimedOut)
}

func spawnErrorMessage(bin string, err error) string {
	code := "ENOENT"
	var errno syscall.Errno
	switch {
	case errors.As(err, &errno) && errno == syscall.EACCES, errors.Is(err, fs.ErrPermission):
		code = "EACCES"
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		code = "ENOENT"
	default:
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) && pathErr.Op == "chdir" {
			code = "ENOENT"
		}
	}
	if strings.Contains(bin, "/") {
		bin = filepath.Clean(bin)
	}
	return "spawn " + bin + " " + code
}

func signalTimedOut(pid int, sig syscall.Signal, timeout float64) []string {
	name := signalNames[sig]
	var groupErr, directErr string
	if err := syscall.Kill(-pid, sig); err != nil {
		groupErr = killErrorText(err)
	}
	// child.kill only throws for EINVAL/ENOSYS; ESRCH means "already dead".
	if err := syscall.Kill(pid, sig); err != nil && errors.Is(err, syscall.EINVAL) {
		directErr = killErrorText(err)
	}
	verb := "sent"
	if sig == syscall.SIGKILL {
		verb = "escalated"
	}
	failed := ""
	if groupErr != "" {
		failed = " (failed: " + groupErr + ")"
	}
	notes := []string{fmt.Sprintf("Timeout cleanup: %s %s to process group%s and pid %d after %sms timeout", verb, name, failed, pid, jsstr.NumberJS(timeout))}
	if groupErr != "" && directErr != "" {
		notes = append(notes, fmt.Sprintf("Timeout cleanup: group kill failed (%s); direct kill failed (%s)", groupErr, directErr))
	}
	return notes
}

func killErrorText(err error) string {
	if errors.Is(err, syscall.ESRCH) {
		return "kill ESRCH"
	}
	if errors.Is(err, syscall.EPERM) {
		return "kill EPERM"
	}
	return err.Error()
}
