// Package subagents is the Go port of subagents/: child pig agents that run
// as spawned `pig --mode json -p` processes, their live activity and bounded
// transcripts, the run registry, history restore, the runner with automatic
// retry and manual resume, the above-editor widget rows, and the inspector
// overlay. It does not import the SDK; go/aio/subagents.go wires it to PiG.
package subagents

import "os/exec"

// Thinking levels a child accepts.
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// AgentConfig is one configured agent (a markdown file with frontmatter).
type AgentConfig struct {
	Name                  string   `json:"name"`
	Description           string   `json:"description"`
	SystemPrompt          string   `json:"systemPrompt"`
	SystemPromptMode      string   `json:"systemPromptMode"`
	InheritProjectContext bool     `json:"inheritProjectContext"`
	InheritSkills         bool     `json:"inheritSkills"`
	Tools                 []string `json:"tools,omitempty"`
	Model                 string   `json:"model,omitempty"`
	Thinking              string   `json:"thinking,omitempty"`
	TimeoutMs             *float64 `json:"timeoutMs,omitempty"`
	Source                string   `json:"source"`
	FilePath              string   `json:"filePath"`
}

// Task is one child assignment.
type Task struct {
	Agent    string `json:"agent"`
	Task     string `json:"task"`
	Model    string `json:"model,omitempty"`
	Thinking string `json:"thinking,omitempty"`
}

// Request is the subagent tool's run request. Pointer fields are optional.
type Request struct {
	Agent       *string
	Task        *string
	Tasks       []Task
	HasTasks    bool
	Context     string
	Async       bool
	Concurrency int
	Model       string
	Thinking    string
	TimeoutMs   *float64
}

// Usage is the summed token usage of a child.
type Usage struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Cost       float64 `json:"cost"`
}

// RunningTool is a tool the child is executing now.
type RunningTool struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Summary   string  `json:"summary"`
	StartedAt float64 `json:"startedAt"`
}

// Retry is a provider retry in progress.
type Retry struct {
	Attempt     float64 `json:"attempt"`
	MaxAttempts float64 `json:"maxAttempts"`
	Error       *string `json:"error,omitempty"`
}

// Activity is the live progress derived from the child's event stream.
type Activity struct {
	Phase        string        `json:"phase"`
	LastEventAt  float64       `json:"lastEventAt"`
	Turns        int           `json:"turns"`
	ToolCount    int           `json:"toolCount"`
	RunningTools []RunningTool `json:"runningTools"`
	Retry        *Retry        `json:"retry,omitempty"`
	SettledAt    *float64      `json:"settledAt,omitempty"`
}

// Result is a finished child.
type Result struct {
	Index             int     `json:"index"`
	Agent             string  `json:"agent"`
	Task              string  `json:"task"`
	State             string  `json:"state"`
	Output            string  `json:"output"`
	Error             string  `json:"error,omitempty"`
	ExitCode          int     `json:"exitCode"`
	Model             string  `json:"model,omitempty"`
	Thinking          string  `json:"thinking,omitempty"`
	SessionFile       string  `json:"sessionFile,omitempty"`
	StartedAt         float64 `json:"startedAt"`
	EndedAt           float64 `json:"endedAt"`
	Usage             Usage   `json:"usage"`
	Attempts          int     `json:"attempts"`
	ReapedAfterSettle *bool   `json:"reapedAfterSettle,omitempty"`
}

// Child is ChildRunStatus. Mutate it only with the registry lock held.
type Child struct {
	Index       int
	Agent       string
	Task        string
	State       string
	Model       string
	Thinking    string
	StartedAt   *float64
	EndedAt     *float64
	Output      *string
	Error       string
	SessionFile string
	Attempts    *int
	Activity    *Activity
	// Transcript is the bounded live transcript (see transcript.go).
	Transcript        *Transcript
	ReapedAfterSettle *bool

	process *exec.Cmd
	launch  *LaunchSnapshot
}

// Running reports whether the child has a live process handle.
func (c *Child) Running() bool { return c.process != nil }

// ResumedFrom links a manual continuation to its source child.
type ResumedFrom struct {
	RunID string `json:"runId"`
	Index int    `json:"index"`
}

// Run is SubagentRun. Results has nil holes for children that never ran,
// like the sparse TypeScript array.
type Run struct {
	ID            string
	State         string
	Mode          string
	Context       string
	Cwd           string
	StartedAt     float64
	EndedAt       *float64
	Children      []*Child
	Results       []*Result
	Error         string
	StopRequested bool
	ResumedFrom   *ResumedFrom
}

// Active reports a queued or running run.
func (r *Run) Active() bool { return r.State == "running" || r.State == "queued" }

// Terminal reports a completed, failed, or stopped state.
func Terminal(state string) bool {
	return state == "completed" || state == "failed" || state == "stopped"
}

// ExtensionLaunch is how a child loads extensions.
type ExtensionLaunch struct {
	NoExtensions bool     `json:"noExtensions"`
	Paths        []string `json:"paths"`
}

// Parent is the parent session context a child inherits.
type Parent struct {
	Cwd               string           `json:"cwd"`
	Model             string           `json:"model,omitempty"`
	ModelProvider     string           `json:"modelProvider,omitempty"`
	Thinking          string           `json:"thinking,omitempty"`
	ParentSessionFile string           `json:"parentSessionFile,omitempty"`
	ExtensionLaunch   *ExtensionLaunch `json:"extensionLaunch,omitempty"`
}

// LaunchRequest is the request part of a launch snapshot.
type LaunchRequest struct {
	Context   string   `json:"context,omitempty"`
	TimeoutMs *float64 `json:"timeoutMs,omitempty"`
}

// LaunchSnapshot is the private launch data kept for recovery. It never
// enters tool details or model context.
type LaunchSnapshot struct {
	Task       Task          `json:"task"`
	Request    LaunchRequest `json:"request"`
	Agent      AgentConfig   `json:"agent"`
	Parent     Parent        `json:"parent"`
	Resumed    bool          `json:"resumed"`
	SessionDir string        `json:"sessionDir,omitempty"`
	PID        int           `json:"pid,omitempty"`
}

// Launch returns the child's private launch snapshot, or nil.
func (c *Child) Launch() *LaunchSnapshot { return c.launch }

// SpawnSpec is one child process launch.
type SpawnSpec struct {
	Command              string
	Args                 []string
	Cwd                  string
	Env                  []string
	SessionDir           string
	RequestedSessionFile string
}

func fptr(v float64) *float64 { return &v }
func sptr(v string) *string   { return &v }
func bptr(v bool) *bool       { return &v }
func iptr(v int) *int         { return &v }
