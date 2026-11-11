package sessionnav

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
)

const (
	// RewindCommand is REWIND_COMMAND.
	RewindCommand = "rewind"
	// SessionsCommand is SESSIONS_COMMAND.
	SessionsCommand = "sessions"
	// SessionsFlag is SESSIONS_FLAG.
	SessionsFlag = "sessions"
	// DoubleEscapeMs is DOUBLE_ESCAPE_MS.
	DoubleEscapeMs = 500
)

func readSettings(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var v map[string]any
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	return v
}

// ReadDoubleEscapeAction is readDoubleEscapeAction: Pi's doubleEscapeAction
// ("tree", "fork", "none"); trusted project settings override global ones.
func ReadDoubleEscapeAction(agentDir, cwd, configDirName string, projectTrusted bool) string {
	sources := []map[string]any{readSettings(filepath.Join(agentDir, "settings.json"))}
	if projectTrusted {
		sources = append(sources, readSettings(filepath.Join(cwd, configDirName, "settings.json")))
	}
	action := "tree"
	for _, s := range sources {
		if v, ok := s["doubleEscapeAction"].(string); ok && (v == "tree" || v == "fork" || v == "none") {
			action = v
		}
	}
	return action
}

// LaunchSelectsSession is launchSelectsSession over the arguments after
// the binary (TypeScript slices process.argv by 2).
func LaunchSelectsSession(args []string) bool {
	p := piargs.Parse(args)
	return p.Continue || p.Resume || p.Session != nil || p.SessionID != nil || p.Fork != nil || p.NoSession
}

// MaxPickerRows is maxPickerRows.
func MaxPickerRows(rows int) int { return max(10, rows*8/10) }

// UsesDefaultSessionDir is usesDefaultSessionDir.
func UsesDefaultSessionDir(sessionDir, agentDir string) bool {
	a, _ := filepath.Abs(filepath.Dir(sessionDir))
	b, _ := filepath.Abs(filepath.Join(agentDir, "sessions"))
	return a == b
}

// EscapeState is registerSessionNav's double-Esc state.
type EscapeState struct {
	mu           sync.Mutex
	DoubleEscape string
	last         *float64
}

// Reset forgets the first press (session_start).
func (e *EscapeState) Reset() {
	e.mu.Lock()
	e.last = nil
	e.mu.Unlock()
}

// OnEscape is onEscape: true (consumed, open /rewind) for the second
// Escape within DoubleEscapeMs on an idle TUI without pending messages.
func (e *EscapeState) OnEscape(tui, idle, pending bool, now float64) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !tui || e.DoubleEscape == "none" {
		return false
	}
	if !idle || pending {
		e.last = nil
		return false
	}
	if e.last != nil && now-*e.last < DoubleEscapeMs {
		e.last = nil
		return true
	}
	e.last = &now
	return false
}

// RewindCall is the host call applyRewind makes for a result: Op is
// "navigateTree" (TargetID, Summarize) or "fork" (TargetID, position
// before); Notice is shown first when not empty.
type RewindCall struct {
	Op        string `json:"op"`
	TargetID  string `json:"targetId"`
	Summarize bool   `json:"summarize,omitempty"`
	Notice    string `json:"notice,omitempty"`
}

// ApplyRewind is applyRewind's mapping.
func ApplyRewind(r RewindResult) RewindCall {
	switch r.Action {
	case "after":
		return RewindCall{Op: "navigateTree", TargetID: r.Checkpoint.EndID}
	case "summary":
		return RewindCall{Op: "navigateTree", TargetID: r.Checkpoint.ID, Summarize: true, Notice: "Summarizing the later conversation…"}
	case "fork":
		return RewindCall{Op: "fork", TargetID: r.Checkpoint.ID}
	}
	return RewindCall{Op: "navigateTree", TargetID: r.Checkpoint.ID}
}

// OpensStartupPicker is the --sessions decision at session_start: a fresh
// startup with the flag, once, unless argv already selects a session.
func OpensStartupPicker(reason string, alreadyShown, flag bool, args []string) bool {
	return reason == "startup" && !alreadyShown && flag && !LaunchSelectsSession(args)
}

// IsResumeText reports the submitted text that opens /sessions.
func IsResumeText(text string) bool { return jsstr.Trim(text) == "/resume" }

// RewindGuard is /rewind's checks before the picker: ok is false with the
// notice to show.
func RewindGuard(tui, idle bool, checkpoints int) (message, level string, ok bool) {
	switch {
	case !tui:
		return "Rewind needs the interactive terminal; use /tree instead.", "warning", false
	case !idle:
		return "Wait for pi to finish (or press Esc to stop it), then rewind.", "warning", false
	case checkpoints == 0:
		return "No prompts to rewind to yet.", "info", false
	}
	return "", "", true
}

// SessionsGuard is /sessions' check before the picker.
func SessionsGuard(tui bool) (message, level string, ok bool) {
	if !tui {
		return "The session picker needs the interactive terminal.", "warning", false
	}
	return "", "", true
}
