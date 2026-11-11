package subagents

// Port of subagents/runner.ts: spawn specs, child attempts with timeout,
// settle reaping and abort, automatic retry that resumes the child's own
// session, manual resume, and the run result text.

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const (
	defaultTimeoutMs            = 15 * 60 * 1000
	defaultTerminationGraceMs   = 3_000
	defaultSettleExitGraceMs    = 10_000
	deltaUpdateIntervalMs       = 250
	defaultConcurrency          = 4
	defaultMaxAttempts          = 2
	maxAttemptsCap              = 5
	defaultRetryBackoffMs       = 1_000
	maxTasks                    = 12
	taskArgLimit                = 8_000
	maxOutputChars              = 50_000
	maxStderrChars              = 50_000
	continuationPromptText      = "Your previous run was interrupted before you could finish (provider limit, request stall, timeout, or stop). Continue the original task from this session's history without redoing work already completed, then return the final result."
	childBoundaryPrompt         = "[CHILD AGENT BOUNDARY]\nYou are a focused child agent working for a parent Pi session. Complete only the assigned task. Do not launch or propose additional subagents. Return a concise, evidence-backed result to the parent. Follow the tool and repository constraints supplied to this child.\n\n"
	reapedNote                  = "(Note: the child finished but its process did not exit on its own — a loaded extension likely kept it alive — so it was terminated.)"
	completedWithoutResultLabel = "(Subagent completed without a textual result.)"
)

// ContinuationPrompt is continuationPrompt.
func ContinuationPrompt(task string) string {
	return continuationPromptText + "\n\nAssigned child task (not the parent's task):\n" + task
}

// Deps are the runner seams. Zero values use the defaults.
type Deps struct {
	// Binary is the child binary (piBinary); empty uses ChildAgentBinary.
	Binary string
	// ArgsPrefix comes before the child arguments (a fixture script).
	ArgsPrefix []string
	// RunsBaseDir holds child directories; empty is <AgentDir>/aio/subagents/runs.
	RunsBaseDir string
	AgentDir    string
	// TerminationGraceMs, SettleExitGraceMs, MaxAttempts, RetryBackoffMs:
	// nil keeps the default.
	TerminationGraceMs *float64
	SettleExitGraceMs  *float64
	MaxAttempts        *int
	RetryBackoffMs     *float64
	// Now is the activity clock; nil uses the registry clock.
	Now func() float64
	// Env is the parent environment; nil uses os.Environ().
	Env []string
	// AioPath and CursorExtension feed EnforceChildExtensions and
	// ChildSupportsModel.
	AioPath         string
	CursorExtension string
}

func (d *Deps) env() []string {
	if d != nil && d.Env != nil {
		return d.Env
	}
	return os.Environ()
}

func durationOr(v *float64, fallback float64) float64 {
	if v != nil {
		return *v
	}
	return fallback
}

// RunInput is RunInput. Done is the abort signal (nil: none).
type RunInput struct {
	Request  Request
	Agents   []AgentConfig
	Parent   Parent
	Done     <-chan struct{}
	OnUpdate func(*Run)
	Deps     *Deps
}

func (in RunInput) aborted() bool {
	if in.Done == nil {
		return false
	}
	select {
	case <-in.Done:
		return true
	default:
		return false
	}
}

func (in RunInput) update(run *Run) {
	if in.OnUpdate != nil {
		in.OnUpdate(run)
	}
}

// SavedChild is SavedChildSession: the source of a manual resume.
type SavedChild struct {
	SessionFile string
	Transcript  *Transcript
	From        ResumedFrom
}

// ---- launch snapshots ----

// ChildLaunchStateKey is childLaunchStateKey. The caller holds Mu.
func ChildLaunchStateKey(run *Run) string {
	parts := make([]string, len(run.Children))
	for i, c := range run.Children {
		if l := c.launch; l != nil {
			pid := "null"
			if l.PID > 0 {
				pid = strconv.Itoa(l.PID)
			}
			dir := "null"
			if l.SessionDir != "" {
				dir = jsstr.QuoteJS(l.SessionDir)
			}
			parts[i] = "[" + strconv.FormatBool(l.Resumed) + "," + dir + "," + pid + "]"
		} else {
			parts[i] = "[null,null,null]"
		}
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// SnapshotChildLaunches is snapshotChildLaunches (null for a missing one).
func SnapshotChildLaunches(run *Run) []any {
	out := make([]any, len(run.Children))
	for i, c := range run.Children {
		if c.launch != nil {
			out[i] = EncodeLaunch(c.launch)
		}
	}
	return out
}

// RestoreChildLaunches is restoreChildLaunches. The caller holds Mu.
func RestoreChildLaunches(run *Run, launches []*LaunchSnapshot) {
	for index, c := range run.Children {
		if index >= len(launches) || launches[index] == nil {
			continue
		}
		launch := CloneLaunch(launches[index])
		c.launch = launch
		if c.SessionFile == "" && launch.SessionDir != "" {
			c.SessionFile = findSessionFile(launch.SessionDir, "")
			for _, result := range run.Results {
				if result != nil && result.Index == c.Index {
					result.SessionFile = c.SessionFile
					break
				}
			}
		}
	}
}

// ---- child output ----

type parsedOutput struct {
	finalOutput    string
	model          string
	usage          Usage
	assistantError *string
	settled        bool
}

var runnerAnsi = regexp.MustCompile(`[\x{1B}\x{9B}][\[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\x{07})|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`)

func textFromContent(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	list, ok := content.([]any)
	if !ok {
		return ""
	}
	var parts []string
	for _, part := range list {
		if block, ok := part.(*Object); ok && block.Get("type") == "text" {
			if text, ok := block.Get("text").(string); ok {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// ParseEventLine is parseEventLine.
func ParseEventLine(line string) *Object {
	clean := jsstr.Trim(runnerAnsi.ReplaceAllString(line, ""))
	start := strings.Index(clean, "{")
	if start == -1 {
		return nil
	}
	value, err := Decode([]byte(clean[start:]))
	if err != nil {
		return nil
	}
	event, _ := value.(*Object)
	return event
}

func (p *parsedOutput) apply(event *Object) {
	if event.Get("type") == "agent_settled" {
		p.settled = true
		return
	}
	message, ok := event.Get("message").(*Object)
	if event.Get("type") != "message_end" || !ok || message.Get("role") != "assistant" {
		return
	}
	if text := jsstr.Trim(textFromContent(message.Get("content"))); text != "" {
		if jsstr.Len16(text) > maxOutputChars {
			text = jsstr.Slice16(text, maxOutputChars) + "\n\n[Subagent output truncated at " + strconv.Itoa(maxOutputChars) + " characters]"
		}
		p.finalOutput = text
	}
	if model, ok := message.Get("model").(string); ok {
		p.model = model
	}
	if msg, ok := message.Get("errorMessage").(string); ok {
		p.assistantError = sptr(msg)
	}
	usage, ok := message.Get("usage").(*Object)
	if !ok {
		return
	}
	p.usage.Input += jsNumberOrZero(usage.Get("input"))
	p.usage.Output += jsNumberOrZero(usage.Get("output"))
	p.usage.CacheRead += jsNumberOrZero(usage.Get("cacheRead"))
	p.usage.CacheWrite += jsNumberOrZero(usage.Get("cacheWrite"))
	if cost, ok := usage.Get("cost").(*Object); ok {
		p.usage.Cost += jsNumberOrZero(cost.Get("total"))
	}
}

// ---- spawn spec ----

func (d *Deps) runsBaseDir() string {
	if d != nil && d.RunsBaseDir != "" {
		return d.RunsBaseDir
	}
	if d != nil && d.AgentDir != "" {
		return filepath.Join(d.AgentDir, "aio", "subagents", "runs")
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, ".aio-subagents", "runs")
}

func (d *Deps) aio() string {
	if d == nil {
		return ""
	}
	return d.AioPath
}

func (d *Deps) cursor() string {
	if d == nil {
		return ""
	}
	return d.CursorExtension
}

func childExtensionLaunch(parent Parent, deps *Deps) ExtensionLaunch {
	launch := ExtensionLaunch{Paths: []string{}}
	if parent.ExtensionLaunch != nil {
		launch = *parent.ExtensionLaunch
	}
	return EnforceChildExtensions(launch, deps.aio())
}

// ResolvedModel is resolvedModel: task, request, agent, then parent.
func ResolvedModel(task Task, request Request, agent AgentConfig, parent Parent, deps *Deps) string {
	model := firstString(task.Model, request.Model, agent.Model, parent.Model)
	if model == "" {
		return ""
	}
	if ChildSupportsModel(childExtensionLaunch(parent, deps), model, deps.cursor()) {
		return model
	}
	return ""
}

// ResolvedThinking is resolvedThinking.
func ResolvedThinking(task Task, request Request, agent AgentConfig, parent Parent) string {
	return firstString(task.Thinking, request.Thinking, agent.Thinking, parent.Thinking)
}

func firstString(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func findSessionFile(sessionDir, requested string) string {
	if requested != "" && exists(requested) {
		return requested
	}
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return ""
	}
	var names []string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".jsonl") {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return ""
	}
	slices.SortStableFunc(names, LocaleCompare)
	return filepath.Join(sessionDir, names[len(names)-1])
}

// SpawnInput is the input of BuildSpawnSpec.
type SpawnInput struct {
	RunID             string
	Index             int
	Task              Task
	Request           Request
	Agent             AgentConfig
	Parent            Parent
	Deps              *Deps
	ResumeSessionFile string
	PromptOverride    *string
}

// BuildSpawnSpec is buildSpawnSpec. It writes the system prompt (and a
// large task) as private files in the child directory.
func BuildSpawnSpec(in SpawnInput) (SpawnSpec, error) {
	childDir := filepath.Join(in.Deps.runsBaseDir(), in.RunID, "child-"+strconv.Itoa(in.Index))
	if err := os.MkdirAll(childDir, 0o777); err != nil {
		return SpawnSpec{}, err
	}
	promptPath := filepath.Join(childDir, "system-prompt.md")
	if err := writePrivate(promptPath, childBoundaryPrompt+in.Agent.SystemPrompt); err != nil {
		return SpawnSpec{}, err
	}
	var args []string
	if in.Deps != nil {
		args = append(args, in.Deps.ArgsPrefix...)
	}
	args = append(args, "--mode", "json", "-p")
	launch := childExtensionLaunch(in.Parent, in.Deps)
	if launch.NoExtensions {
		args = append(args, "--no-extensions")
	}
	for _, path := range launch.Paths {
		args = append(args, "--extension", path)
	}
	context := in.Request.Context
	if context == "" {
		context = "fresh"
	}
	requested := ""
	switch {
	case in.ResumeSessionFile != "":
		requested = in.ResumeSessionFile
		args = append(args, "--session", in.ResumeSessionFile)
	case context == "fork":
		if in.Parent.ParentSessionFile == "" {
			return SpawnSpec{}, errors.New("Forked subagents require a persisted parent session file.")
		}
		args = append(args, "--fork", in.Parent.ParentSessionFile, "--session-dir", childDir)
	default:
		requested = filepath.Join(childDir, "session.jsonl")
		args = append(args, "--session", requested)
	}
	if model := ResolvedModel(in.Task, in.Request, in.Agent, in.Parent, in.Deps); model != "" {
		args = append(args, "--model", model)
	}
	if thinking := ResolvedThinking(in.Task, in.Request, in.Agent, in.Parent); thinking != "" {
		args = append(args, "--thinking", thinking)
	}
	args = append(args, "--permission-mode", "auto")
	if in.Agent.SystemPromptMode == "append" {
		args = append(args, "--append-system-prompt", promptPath)
	} else {
		args = append(args, "--system-prompt", promptPath)
	}
	if !in.Agent.InheritProjectContext {
		args = append(args, "--no-context-files")
	}
	if !in.Agent.InheritSkills {
		args = append(args, "--no-skills")
	}
	var tools []string
	for _, tool := range in.Agent.Tools {
		if tool != "subagent" {
			tools = append(tools, tool)
		}
	}
	if len(tools) > 0 {
		args = append(args, "--tools", strings.Join(tools, ","))
	}
	args = append(args, "--exclude-tools", "subagent")
	prompt := "Task: " + in.Task.Task
	if in.PromptOverride != nil {
		prompt = *in.PromptOverride
	}
	if jsstr.Len16(prompt) > taskArgLimit {
		taskPath := filepath.Join(childDir, "task.md")
		if err := writePrivate(taskPath, prompt); err != nil {
			return SpawnSpec{}, err
		}
		args = append(args, "@"+taskPath)
	} else {
		args = append(args, prompt)
	}
	command := ""
	if in.Deps != nil {
		command = in.Deps.Binary
	}
	if command == "" {
		command = ChildAgentBinary(envMap(in.Deps.env()))
	}
	env := ChildBaseEnv(in.Deps.env())
	env = setEnv(env, "AIO_SUBAGENT_CHILD", "1")
	env = setEnv(env, "AIO_SUBAGENT_RUN_ID", in.RunID)
	env = setEnv(env, "AIO_SUBAGENT_AGENT", in.Agent.Name)
	return SpawnSpec{Command: command, Args: args, Cwd: in.Parent.Cwd, Env: env, SessionDir: childDir, RequestedSessionFile: requested}, nil
}

func writePrivate(path, content string) error {
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func envMap(env []string) map[string]string {
	out := map[string]string{}
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			out[k] = v
		}
	}
	return out
}

func setEnv(env []string, key, value string) []string {
	out := slices.DeleteFunc(slices.Clone(env), func(kv string) bool { return strings.HasPrefix(kv, key+"=") })
	return append(out, key+"="+value)
}

// ChildAgentBinary is childAgentBinary: AIO_SUBAGENT_PI_BINARY, else pig
// under PiG, else pi.
func ChildAgentBinary(env map[string]string) string {
	if binary := strings.TrimSpace(env["AIO_SUBAGENT_PI_BINARY"]); binary != "" {
		return binary
	}
	if env["AI_AGENT"] == "pig" {
		if binary := strings.TrimSpace(env["PIG_HARNESS_BINARY"]); binary != "" {
			return binary
		}
	}
	return "pi"
}

// ChildBaseEnv is childBaseEnv: the environment without PiG's per-cell
// wiring (PIG_EXT_*, PIG_HARNESS_*).
func ChildBaseEnv(env []string) []string {
	var out []string
	for _, kv := range env {
		if strings.HasPrefix(kv, "PIG_EXT_") || strings.HasPrefix(kv, "PIG_HARNESS_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// ---- tasks ----

// NormalizeTasks is normalizeTasks.
func NormalizeTasks(r Request) ([]Task, error) {
	hasSingle := r.Agent != nil || r.Task != nil
	if hasSingle == r.HasTasks {
		return nil, errors.New("Provide either 'agent' and 'task' for a single run, or 'tasks' for a parallel run.")
	}
	if hasSingle {
		if r.Agent == nil || r.Task == nil || jsstr.Trim(*r.Agent) == "" || jsstr.Trim(*r.Task) == "" {
			return nil, errors.New("Single runs require non-empty 'agent' and 'task' values.")
		}
		return []Task{{Agent: *r.Agent, Task: *r.Task}}, nil
	}
	if len(r.Tasks) == 0 {
		return nil, errors.New("Parallel runs require at least one task.")
	}
	if len(r.Tasks) > maxTasks {
		return nil, fmt.Errorf("Parallel runs support at most %d tasks.", maxTasks)
	}
	for _, task := range r.Tasks {
		if jsstr.Trim(task.Agent) == "" || jsstr.Trim(task.Task) == "" {
			return nil, errors.New("Every parallel task requires non-empty 'agent' and 'task' values.")
		}
	}
	return r.Tasks, nil
}

// ---- attempts ----

type attemptOutcome struct {
	code              int
	signal            string
	timedOut          bool
	reapedAfterSettle bool
	stderr            string
	parsed            parsedOutput
	sessionFile       string
}

func (o *attemptOutcome) failed() bool {
	exitedCleanly := o.code == 0 || o.reapedAfterSettle
	return o.timedOut || o.parsed.assistantError != nil || !exitedCleanly
}

func sessionHasUserTurn(file string) bool {
	data, err := os.ReadFile(file)
	return err == nil && strings.Contains(string(data), `"role":"user"`)
}

func preservedNote(o *attemptOutcome) string {
	if o.sessionFile == "" {
		return ""
	}
	return " Child session preserved at " + o.sessionFile + "."
}

func describedFailure(o *attemptOutcome, timeoutMs float64, attempts, maxAttempts int) string {
	if o.timedOut {
		return "Subagent timed out after " + jsstr.NumberJS(timeoutMs) + "ms on attempt " + strconv.Itoa(attempts) +
			" of " + strconv.Itoa(maxAttempts) + "." + preservedNote(o)
	}
	suffix := " (attempt " + strconv.Itoa(attempts) + " of " + strconv.Itoa(maxAttempts) + ")"
	if o.parsed.assistantError != nil {
		return *o.parsed.assistantError + suffix + "." + preservedNote(o)
	}
	base := jsstr.Trim(o.stderr)
	if base == "" {
		base = "Subagent exited with code " + strconv.Itoa(o.code)
		if o.signal != "" {
			base += " (" + o.signal + ")"
		}
	}
	return base + suffix + "." + preservedNote(o)
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGTERM: "SIGTERM", syscall.SIGKILL: "SIGKILL", syscall.SIGINT: "SIGINT", syscall.SIGHUP: "SIGHUP",
	syscall.SIGQUIT: "SIGQUIT", syscall.SIGABRT: "SIGABRT", syscall.SIGSEGV: "SIGSEGV", syscall.SIGPIPE: "SIGPIPE",
	syscall.SIGBUS: "SIGBUS", syscall.SIGILL: "SIGILL", syscall.SIGUSR1: "SIGUSR1", syscall.SIGUSR2: "SIGUSR2",
}

// spawnErrorMessage is Node's spawn error text for a failed start.
func spawnErrorMessage(command string, err error) string {
	switch {
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		return "spawn " + command + " ENOENT"
	case errors.Is(err, fs.ErrPermission):
		return "spawn " + command + " EACCES"
	}
	return err.Error()
}

type attemptInput struct {
	run                *Run
	child              *Child
	spec               SpawnSpec
	timeoutMs          float64
	terminationGraceMs float64
	settleExitGraceMs  float64
	in                 RunInput
}

func ms(v float64) time.Duration { return time.Duration(v * float64(time.Millisecond)) }

func (r *Registry) runAttempt(a attemptInput) *attemptOutcome {
	out := &attemptOutcome{}
	now := r.Now
	if a.in.Deps != nil && a.in.Deps.Now != nil {
		now = a.in.Deps.Now
	}
	cmd := exec.Command(a.spec.Command, a.spec.Args...)
	cmd.Dir = a.spec.Cwd
	cmd.Env = a.spec.Env
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	startErr := cmd.Start()

	r.Mu.Lock()
	if startErr == nil {
		a.child.process = cmd
		if a.child.launch != nil {
			a.child.launch.PID = cmd.Process.Pid
		}
	}
	if a.child.Activity == nil {
		a.child.Activity = NewActivity(now())
	}
	a.child.Activity.ResetForAttempt(now())
	r.Mu.Unlock()

	if startErr != nil {
		out.code = 1
		out.stderr = jsstr.Trim(out.stderr + "\n" + spawnErrorMessage(a.spec.Command, startErr))
		a.in.update(a.run)
		r.Mu.Lock()
		out.sessionFile = findSessionFile(a.spec.SessionDir, a.spec.RequestedSessionFile)
		r.Mu.Unlock()
		return out
	}

	var exitMu sync.Mutex
	exited := false
	isExited := func() bool { exitMu.Lock(); defer exitMu.Unlock(); return exited }
	var timers []*time.Timer
	var timersMu sync.Mutex
	after := func(d time.Duration, fn func()) *time.Timer {
		t := time.AfterFunc(d, fn)
		timersMu.Lock()
		timers = append(timers, t)
		timersMu.Unlock()
		return t
	}
	terminate := func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		after(ms(a.terminationGraceMs), func() {
			if !isExited() {
				_ = cmd.Process.Signal(syscall.SIGKILL)
			}
		})
	}
	var flagMu sync.Mutex
	timeout := after(ms(a.timeoutMs), func() {
		flagMu.Lock()
		out.timedOut = true
		flagMu.Unlock()
		terminate()
	})
	var settleTimer *time.Timer
	onSettled := func() {
		if settleTimer != nil {
			return
		}
		timeout.Stop()
		settleTimer = after(ms(a.settleExitGraceMs), func() {
			if isExited() {
				return
			}
			flagMu.Lock()
			out.reapedAfterSettle = true
			flagMu.Unlock()
			terminate()
		})
	}

	abortDone := make(chan struct{})
	if a.in.Done != nil {
		go func() {
			select {
			case <-a.in.Done:
				_ = cmd.Process.Signal(syscall.SIGTERM)
				after(ms(a.terminationGraceMs), func() {
					if !isExited() {
						_ = cmd.Process.Signal(syscall.SIGKILL)
					}
				})
			case <-abortDone:
			}
		}()
	}

	var wg sync.WaitGroup
	wg.Add(2)
	lastNotify := 0.0
	go func() {
		defer wg.Done()
		reader := bufio.NewReaderSize(stdout, 64*1024)
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
				if event := ParseEventLine(line); event != nil {
					r.Mu.Lock()
					out.parsed.apply(event)
					if out.parsed.finalOutput != "" {
						a.child.Output = sptr(out.parsed.finalOutput)
					}
					significant := a.child.Activity.ApplyEvent(event, now())
					if a.child.Transcript != nil {
						a.child.Transcript.ApplyEvent(event, now())
					}
					settled := out.parsed.settled
					r.Mu.Unlock()
					if settled {
						onSettled()
					}
					at := now()
					if significant || event.Get("type") == "message_end" || at-lastNotify >= deltaUpdateIntervalMs {
						lastNotify = at
						a.in.update(a.run)
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		buf := make([]byte, 64*1024)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				text := decodeUTF8(buf[:n])
				r.Mu.Lock()
				out.stderr = jsstr.SliceFrom(out.stderr+text, -maxStderrChars)
				if a.child.Transcript != nil {
					a.child.Transcript.AppendLog(text, now())
				}
				r.Mu.Unlock()
			}
			if err != nil {
				if err != io.EOF {
					return
				}
				return
			}
		}
	}()

	a.in.update(a.run)
	wg.Wait()
	waitErr := cmd.Wait()
	exitMu.Lock()
	exited = true
	exitMu.Unlock()
	close(abortDone)
	timersMu.Lock()
	for _, t := range timers {
		t.Stop()
	}
	timersMu.Unlock()

	out.code = 1
	if state := cmd.ProcessState; state != nil {
		if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			out.signal = signalNames[ws.Signal()]
			if out.signal == "" {
				out.signal = "SIG" + strings.ToUpper(ws.Signal().String())
			}
		} else if code := state.ExitCode(); code >= 0 {
			out.code = code
		}
	} else if waitErr != nil {
		out.stderr = jsstr.Trim(out.stderr + "\n" + waitErr.Error())
	}

	r.Mu.Lock()
	a.child.process = nil
	if a.child.launch != nil {
		a.child.launch.PID = 0
	}
	out.sessionFile = findSessionFile(a.spec.SessionDir, a.spec.RequestedSessionFile)
	r.Mu.Unlock()
	flagMu.Lock()
	defer flagMu.Unlock()
	return out
}

// ---- children ----

type childInput struct {
	run    *Run
	child  *Child
	task   Task
	agent  AgentConfig
	in     RunInput
	resume *SavedChild
}

func (r *Registry) runChild(c childInput) *Result {
	in := c.in
	deps := in.Deps
	r.Mu.Lock()
	startedAt := r.Now()
	c.child.State = "running"
	c.child.StartedAt = fptr(startedAt)
	c.child.Model = ResolvedModel(c.task, in.Request, c.agent, in.Parent, deps)
	c.child.Thinking = ResolvedThinking(c.task, in.Request, c.agent, in.Parent)
	c.child.Attempts = iptr(0)
	r.Mu.Unlock()
	in.update(c.run)

	maxAttempts := defaultMaxAttempts
	if deps != nil && deps.MaxAttempts != nil {
		maxAttempts = *deps.MaxAttempts
	}
	maxAttempts = max(1, min(maxAttempts, maxAttemptsCap))
	var backoff, terminationGrace, settleGrace float64 = defaultRetryBackoffMs, defaultTerminationGraceMs, defaultSettleExitGraceMs
	if deps != nil {
		backoff = durationOr(deps.RetryBackoffMs, backoff)
		terminationGrace = durationOr(deps.TerminationGraceMs, terminationGrace)
		settleGrace = durationOr(deps.SettleExitGraceMs, settleGrace)
	}
	timeoutMs := float64(defaultTimeoutMs)
	if in.Request.TimeoutMs != nil {
		timeoutMs = *in.Request.TimeoutMs
	} else if c.agent.TimeoutMs != nil {
		timeoutMs = *c.agent.TimeoutMs
	}
	now := r.Now
	if deps != nil && deps.Now != nil {
		now = deps.Now
	}

	r.Mu.Lock()
	c.child.Activity = NewActivity(now())
	transcript := NewTranscript()
	if c.resume != nil && c.resume.Transcript != nil {
		transcript = c.resume.Transcript
	}
	c.child.Transcript = transcript
	if c.resume != nil {
		transcript.PushNotice("Manual resume from run "+jsstr.Slice16(c.resume.From.RunID, 8)+" · saved child session", "muted", r.Now())
	}
	r.Mu.Unlock()

	resumeFile := ""
	var promptOverride *string
	if c.resume != nil {
		resumeFile = c.resume.SessionFile
		promptOverride = sptr(ContinuationPrompt(c.task.Task))
	}
	var outcome *attemptOutcome
	var specErr *string
	attempts := 0
	var total Usage
	lastOutput, lastModel := "", ""

	for attempts < maxAttempts {
		attempts++
		r.Mu.Lock()
		c.child.Attempts = iptr(attempts)
		if attempts > 1 {
			note := ""
			if resumeFile != "" {
				note = " · resuming child session"
			}
			transcript.PushNotice("attempt "+strconv.Itoa(attempts)+"/"+strconv.Itoa(maxAttempts)+note, "warning", r.Now())
		}
		r.Mu.Unlock()
		in.update(c.run)

		spec, err := BuildSpawnSpec(SpawnInput{RunID: c.run.ID, Index: c.child.Index, Task: c.task, Request: in.Request,
			Agent: c.agent, Parent: in.Parent, Deps: deps, ResumeSessionFile: resumeFile, PromptOverride: promptOverride})
		if err != nil {
			specErr = sptr(err.Error())
			break
		}
		r.Mu.Lock()
		if c.child.launch != nil {
			c.child.launch.SessionDir = spec.SessionDir
		}
		if spec.RequestedSessionFile != "" {
			c.child.SessionFile = spec.RequestedSessionFile
		}
		r.Mu.Unlock()
		in.update(c.run)
		outcome = r.runAttempt(attemptInput{run: c.run, child: c.child, spec: spec, timeoutMs: timeoutMs,
			terminationGraceMs: terminationGrace, settleExitGraceMs: settleGrace, in: in})
		total.Input += outcome.parsed.usage.Input
		total.Output += outcome.parsed.usage.Output
		total.CacheRead += outcome.parsed.usage.CacheRead
		total.CacheWrite += outcome.parsed.usage.CacheWrite
		total.Cost += outcome.parsed.usage.Cost
		if outcome.parsed.finalOutput != "" {
			lastOutput = outcome.parsed.finalOutput
		}
		if outcome.parsed.model != "" {
			lastModel = outcome.parsed.model
		}
		if r.stopped(c.run, in) || !outcome.failed() || attempts >= maxAttempts {
			break
		}
		r.Mu.Lock()
		transcript.PushNotice(describedFailure(outcome, timeoutMs, attempts, maxAttempts), "warning", r.Now())
		r.Mu.Unlock()
		resumeFile, promptOverride = "", nil
		if outcome.sessionFile != "" {
			resumeFile = outcome.sessionFile
			if sessionHasUserTurn(resumeFile) {
				promptOverride = sptr(ContinuationPrompt(c.task.Task))
			}
		}
		if backoff > 0 {
			time.Sleep(ms(backoff))
		}
		if r.stopped(c.run, in) {
			break
		}
	}

	r.Mu.Lock()
	defer func() { in.update(c.run) }()
	defer r.Mu.Unlock()
	endedAt := r.Now()
	wasStopped := c.run.StopRequested || in.aborted()
	state, errText := "completed", ""
	switch {
	case specErr != nil:
		state, errText = "failed", *specErr
	case outcome == nil:
		state, errText = "failed", "Subagent child did not run."
	case wasStopped:
		state = "stopped"
	case outcome.failed():
		state, errText = "failed", describedFailure(outcome, timeoutMs, attempts, maxAttempts)
	}
	switch state {
	case "failed":
		message := errText
		if message == "" {
			message = "failed"
		}
		transcript.PushNotice(message, "error", r.Now())
	case "completed":
		transcript.PushNotice(state, "success", r.Now())
	default:
		transcript.PushNotice(state, "warning", r.Now())
	}
	sessionFile := ""
	if outcome != nil {
		sessionFile = outcome.sessionFile
	}
	if sessionFile == "" && c.resume != nil {
		sessionFile = c.resume.SessionFile
	}
	reaped := state == "completed" && outcome != nil && outcome.reapedAfterSettle
	output := lastOutput
	if output == "" && errText == "" {
		output = completedWithoutResultLabel
	}
	model := lastModel
	if model == "" {
		model = c.child.Model
	}
	c.child.State = state
	c.child.Output = sptr(output)
	c.child.Error = errText
	c.child.EndedAt = fptr(endedAt)
	c.child.SessionFile = sessionFile
	c.child.Attempts = iptr(attempts)
	c.child.ReapedAfterSettle = bptr(reaped)
	c.child.Model = model
	exit := 0
	if state != "completed" {
		exit = 1
		if outcome != nil && outcome.code != 0 {
			exit = outcome.code
		}
	}
	return &Result{Index: c.child.Index, Agent: c.agent.Name, Task: c.task.Task, State: state, Output: output,
		Error: errText, ExitCode: exit, Model: model, Thinking: c.child.Thinking, SessionFile: sessionFile,
		StartedAt: startedAt, EndedAt: endedAt, Usage: total, Attempts: attempts, ReapedAfterSettle: bptr(reaped)}
}

func (r *Registry) stopped(run *Run, in RunInput) bool {
	r.Mu.Lock()
	defer r.Mu.Unlock()
	return run.StopRequested || in.aborted()
}

// Prepare is the synchronous part of executeSubagentRun: it validates the
// request, creates the run, and returns a start function that runs it to
// the end. The first OnUpdate happens inside Prepare, as in TypeScript.
func (r *Registry) Prepare(in RunInput, resume *SavedChild) (*Run, func() *Run, error) {
	// The stdout reader, the child loops, and the workers all report
	// progress. Callbacks run one at a time, as on TypeScript's one thread.
	if user := in.OnUpdate; user != nil {
		var updateMu sync.Mutex
		in.OnUpdate = func(run *Run) {
			updateMu.Lock()
			defer updateMu.Unlock()
			user(run)
		}
	}
	tasks, err := NormalizeTasks(in.Request)
	if err != nil {
		return nil, nil, err
	}
	agents := make([]AgentConfig, len(tasks))
	for i, task := range tasks {
		if agents[i], err = FindAgent(in.Agents, task.Agent); err != nil {
			return nil, nil, err
		}
	}
	context := in.Request.Context
	if context == "" {
		context = "fresh"
	}
	children := make([]*Child, len(tasks))
	for i, task := range tasks {
		children[i] = &Child{Index: i, Agent: task.Agent, Task: task.Task, State: "queued",
			Model:    ResolvedModel(task, in.Request, agents[i], in.Parent, in.Deps),
			Thinking: ResolvedThinking(task, in.Request, agents[i], in.Parent)}
	}
	mode := "parallel"
	if len(tasks) == 1 {
		mode = "single"
	}
	r.Mu.Lock()
	run := r.CreateRun(mode, context, in.Parent.Cwd, children)
	run.State = "running"
	if resume != nil {
		from := resume.From
		run.ResumedFrom = &from
	}
	for i, c := range children {
		parent := in.Parent
		ext := childExtensionLaunch(in.Parent, in.Deps)
		parent.ExtensionLaunch = &ext
		agent := agents[i]
		agent.Tools = slices.Clone(agent.Tools)
		c.launch = &LaunchSnapshot{
			Task:    Task{Agent: tasks[i].Agent, Task: tasks[i].Task, Model: c.Model, Thinking: c.Thinking},
			Request: LaunchRequest{Context: context, TimeoutMs: in.Request.TimeoutMs},
			Agent:   agent, Parent: parent,
		}
	}
	r.Mu.Unlock()
	in.update(run)

	start := func() *Run {
		concurrency := defaultConcurrency
		if in.Request.Concurrency > 0 {
			concurrency = in.Request.Concurrency
		}
		concurrency = max(1, min(concurrency, len(tasks)))
		next := 0
		var wg sync.WaitGroup
		for w := 0; w < concurrency; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					r.Mu.Lock()
					if run.StopRequested {
						r.Mu.Unlock()
						return
					}
					index := next
					next++
					r.Mu.Unlock()
					if index >= len(tasks) {
						return
					}
					result := r.runChild(childInput{run: run, child: children[index], task: tasks[index], agent: agents[index], in: in, resume: resume})
					r.Mu.Lock()
					for len(run.Results) <= index {
						run.Results = append(run.Results, nil)
					}
					run.Results[index] = result
					r.Mu.Unlock()
				}
			}()
		}
		wg.Wait()
		r.Mu.Lock()
		for _, c := range children {
			if c.State == "queued" {
				c.State = "stopped"
			}
		}
		run.EndedAt = fptr(r.Now())
		failed := 0
		for _, result := range run.Results {
			if result != nil && result.State == "failed" {
				failed++
			}
		}
		switch {
		case run.StopRequested || in.aborted():
			run.State = "stopped"
		case failed > 0:
			run.State = "failed"
			run.Error = strconv.Itoa(failed) + " subagent task(s) failed."
		default:
			run.State = "completed"
		}
		r.Mu.Unlock()
		in.update(run)
		return run
	}
	return run, start, nil
}

// Execute is executeSubagentRun.
func (r *Registry) Execute(in RunInput, resume *SavedChild) (*Run, error) {
	_, start, err := r.Prepare(in, resume)
	if err != nil {
		return nil, err
	}
	return start(), nil
}

// ResumeUnavailable is childResumeUnavailable: why recovery is unavailable,
// or "" when the child can resume now. The caller holds Mu.
func (r *Registry) ResumeUnavailable(run *Run, child *Child) string {
	if r.GetRun(run.ID) != run || !slices.Contains(run.Children, child) {
		return "This run is no longer in the current session."
	}
	if child.State != "failed" && child.State != "stopped" {
		return "Only failed or stopped children can resume."
	}
	hasResult := slices.ContainsFunc(run.Results, func(res *Result) bool { return res != nil && res.Index == child.Index })
	if child.process != nil || !hasResult {
		return "The child is still stopping; try again shortly."
	}
	launch := child.launch
	if launch == nil {
		return "The original launch configuration is no longer available."
	}
	if launch.Resumed {
		return "Already resumed; select the latest continuation run."
	}
	if child.SessionFile != "" {
		if runID, index, ok := r.ChildSessionOwner(child.SessionFile); ok && (runID != run.ID || index != child.Index) {
			return "Already resumed; run " + jsstr.Slice16(runID, 8) + " owns this saved child session."
		}
	}
	if launch.PID > 0 {
		err := syscall.Kill(launch.PID, 0)
		if err == nil {
			return "The previous child process is still running; it must exit before resuming."
		}
		if !errors.Is(err, syscall.ESRCH) {
			return "Could not confirm that the previous child process has exited."
		}
	}
	if child.SessionFile != "" {
		if info, err := os.Stat(child.SessionFile); err == nil && info.Mode().IsRegular() {
			return ""
		}
	}
	return "No saved child session is available to resume."
}

// ResumeInput is the input of Resume.
type ResumeInput struct {
	Run      *Run
	Child    *Child
	OnUpdate func(*Run)
	Deps     *Deps
}

// PrepareResume is the synchronous part of resumeSubagentChild: it claims
// the saved session and returns the start function of the continuation.
func (r *Registry) PrepareResume(in ResumeInput) (*Run, func() *Run, error) {
	r.Mu.Lock()
	if reason := r.ResumeUnavailable(in.Run, in.Child); reason != "" {
		r.Mu.Unlock()
		return nil, nil, errors.New(reason)
	}
	launch := in.Child.launch
	sessionFile := in.Child.SessionFile
	if launch == nil || sessionFile == "" {
		r.Mu.Unlock()
		return nil, nil, errors.New("The saved child launch is unavailable.")
	}
	if err := syscall.Access(sessionFile, 4); err != nil {
		r.Mu.Unlock()
		return nil, nil, fmt.Errorf("EACCES: permission denied, access '%s'", sessionFile)
	}
	var transcript *Transcript
	if in.Child.Transcript != nil {
		transcript = in.Child.Transcript.Clone()
	}
	launch.Resumed = true
	snapshot := CloneLaunch(launch)
	from := ResumedFrom{RunID: in.Run.ID, Index: in.Child.Index}
	r.Mu.Unlock()
	if transcript == nil {
		transcript = LoadSavedTranscript(sessionFile, r.Now())
	}
	timeout := snapshot.Request.TimeoutMs
	request := Request{Agent: sptr(snapshot.Task.Agent), Task: sptr(snapshot.Task.Task), Context: snapshot.Request.Context,
		TimeoutMs: timeout, Model: snapshot.Task.Model, Thinking: snapshot.Task.Thinking}
	var self func(*Run)
	self = func(continuation *Run) {
		r.Mu.Lock()
		if r.GetRun(continuation.ID) == continuation {
			r.ClaimChildSession(sessionFile, continuation.ID, continuation.Children[0].Index)
		}
		r.Mu.Unlock()
		if in.OnUpdate != nil {
			in.OnUpdate(continuation)
		}
	}
	return r.Prepare(RunInput{Request: request, Agents: []AgentConfig{snapshot.Agent}, Parent: snapshot.Parent,
		OnUpdate: self, Deps: in.Deps}, &SavedChild{SessionFile: sessionFile, Transcript: transcript, From: from})
}

// Resume is resumeSubagentChild: a new single-child run that continues the
// saved session; the original run stays unchanged.
func (r *Registry) Resume(in ResumeInput) (*Run, error) {
	_, start, err := r.PrepareResume(in)
	if err != nil {
		return nil, err
	}
	return start(), nil
}

// FormatRunResult is formatRunResult. The caller holds Mu.
func FormatRunResult(run *Run) string {
	continuation := ""
	if run.ResumedFrom != nil {
		continuation = " Resumed child #" + strconv.Itoa(run.ResumedFrom.Index+1) + " from run " + run.ResumedFrom.RunID + "."
	}
	parts := []string{"Subagent run " + run.ID + " " + run.State + " (" + run.Mode + ", " + run.Context + " context)." + continuation}
	for _, result := range run.Results {
		if result == nil {
			parts = append(parts, "")
			continue
		}
		note := ""
		if result.Attempts > 1 {
			note = " (" + strconv.Itoa(result.Attempts) + " attempts)"
		}
		title := "=== " + result.Agent + " [" + result.State + "]" + note + " ==="
		body := result.Output
		if result.Error != "" {
			body = result.Error
			if result.Output != "" {
				body = result.Error + "\n\n" + result.Output
			}
		}
		if result.ReapedAfterSettle != nil && *result.ReapedAfterSettle {
			body += "\n\n" + reapedNote
		}
		parts = append(parts, title+"\n"+body)
	}
	return strings.Join(parts, "\n\n")
}
