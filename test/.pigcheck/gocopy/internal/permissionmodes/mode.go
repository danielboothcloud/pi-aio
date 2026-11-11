package permissionmodes

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/difftools"
)

// Mode is one permission mode.
type Mode string

const (
	ModeDefault Mode = "default"
	ModeAsk     Mode = "ask"
	ModePlan    Mode = "plan"
	ModeAuto    Mode = "auto"
)

// ModeCycle is the Shift+Tab order.
var ModeCycle = []Mode{ModeDefault, ModeAsk, ModePlan, ModeAuto}

// PlanModeTools are added to the active tools in ask and plan mode.
var PlanModeTools = []string{"read", "bash", "grep", "find", "ls"}

// FileMutationTools are disabled in ask and plan mode.
var FileMutationTools = map[string]bool{"edit": true, "write": true, "apply_patch": true}

const (
	CursorBridgeBuiltinsEnv  = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS"
	CursorReplayPrefix       = "cursor-replay-"
	cursorBridgeMutationList = "pi__edit, pi__write, pi__apply_patch, or pi__bash"
)

// Approval option labels (approval-dialog.ts).
var (
	ApprovalOptions = []string{"Allow", "Allow all (enable auto)", "Block"}
	OutsideOptions  = []string{"Allow once", "Allow this folder for the session", "Block"}
	ShellOptions    = []string{"Allow", "Block"}
)

// IsPassive reports whether a mode blocks mutations (ask and plan).
func IsPassive(mode Mode) bool { return mode == ModeAsk || mode == ModePlan }

// ParseMode accepts the four names (any case) and the legacy names; anything
// else is ok=false.
func ParseMode(value any) (Mode, bool) {
	s, ok := value.(string)
	if !ok {
		return ModeDefault, false
	}
	switch v := strings.ToLower(s); v {
	case "default", "ask", "plan", "auto":
		return Mode(v), true
	case "normal":
		return ModeDefault, true
	case "accept-edits":
		return ModeAuto, true
	}
	return ModeDefault, false
}

// NormalizeMode is ParseMode with default as the fallback.
func NormalizeMode(value any) Mode {
	mode, _ := ParseMode(value)
	return mode
}

// NextMode is the Shift+Tab successor.
func NextMode(mode Mode) Mode {
	for i, m := range ModeCycle {
		if m == mode {
			return ModeCycle[(i+1)%len(ModeCycle)]
		}
	}
	return ModeDefault
}

// Metadata is the icon, label, and theme role of a mode.
type Metadata struct {
	Icon  string
	Label string
	Role  string
}

// ModeMetadata returns the status pill data for a mode.
func ModeMetadata(mode Mode) Metadata {
	switch mode {
	case ModeAsk:
		return Metadata{"?", "Ask", "accent"}
	case ModePlan:
		return Metadata{"⏸", "Plan", "warning"}
	case ModeAuto:
		return Metadata{"▶", "Auto", "accent"}
	}
	return Metadata{"●", "Default", "muted"}
}

// PassiveTools returns the active tools for ask/plan mode from the snapshot before it.
func PassiveTools(before []string) []string {
	var tools []string
	seen := map[string]bool{}
	for _, tool := range append(append([]string{}, before...), PlanModeTools...) {
		if FileMutationTools[tool] || seen[tool] {
			continue
		}
		seen[tool] = true
		tools = append(tools, tool)
	}
	return tools
}

// FileMutationTarget is the target label of a mutation prompt.
func FileMutationTarget(input map[string]any) string {
	if path, ok := input["path"].(string); ok {
		return path
	}
	changes, ok := input["changes"].([]any)
	if !ok {
		return "(unknown)"
	}
	var paths []string
	seen := map[string]bool{}
	for _, raw := range changes {
		change, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if path, ok := change["path"].(string); ok && !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	switch {
	case len(paths) == 0:
		return "(unknown)"
	case len(paths) <= 3:
		return strings.Join(paths, ", ")
	}
	return fmt.Sprintf("%s (+%d more)", strings.Join(paths[:3], ", "), len(paths)-3)
}

var replayMutationRe = regexp.MustCompile(`(?i)\b(edit|write|delete|shell)\b`)

// CursorReplayMutation names the mutation a Cursor replay card shows, or "".
func CursorReplayMutation(tool string, input map[string]any) string {
	if FileMutationTools[tool] {
		return tool
	}
	if IsShellTool(tool) {
		if IsSafeCommand(commandOf(input)) {
			return ""
		}
		return "shell command"
	}
	if tool != "cursor" {
		return ""
	}
	var parts []string
	for _, key := range []string{"activityTitle", "sourceToolName", "toolName"} {
		if s, ok := input[key].(string); ok {
			parts = append(parts, s)
		}
	}
	if m := replayMutationRe.FindStringSubmatch(strings.Join(parts, " ")); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

// commandOf is String(input.command ?? "").
func commandOf(input map[string]any) string {
	switch v := input["command"].(type) {
	case nil:
		return ""
	case string:
		return v
	default:
		return fmt.Sprint(v)
	}
}

// ApprovalRequest is a file-mutation approval (showMutationApproval's params).
type ApprovalRequest struct {
	Tool  string
	Input map[string]any
	// Path is the target label shown in the prompt.
	Path string
	Cwd  string
	// Outside is set when the targets fall outside the working directory.
	Outside *OutsideInfo
}

// OutsideInfo is approval-dialog.ts OutsideWorkspaceInfo.
type OutsideInfo struct {
	Cwd    string
	Scopes []string
}

// Approval decisions (approval-dialog.ts ApprovalDecision).
const (
	DecisionAllow      = "allow"
	DecisionAllowAll   = "allowAll"
	DecisionAllowScope = "allowScope"
	DecisionBlock      = "block"
)

// MutationApprover is an optional UI extension: the scrollable diff
// approval overlay. ok=false falls back to Select, as non-TUI hosts do.
type MutationApprover interface {
	ApproveMutation(req ApprovalRequest) (decision string, ok bool)
}

// UI is the part of the host that the gate needs.
type UI interface {
	HasUI() bool
	// Select returns the chosen option, or ok=false when cancelled.
	Select(title string, options []string) (choice string, ok bool)
	Notify(message, level string)
}

// Verdict is the gate result. Block is false when the call may run.
type Verdict struct {
	Block  bool
	Reason string
	// SwitchToAuto is set when the user chose "Allow all (enable auto)".
	SwitchToAuto bool
}

func blocked(reason string) Verdict { return Verdict{Block: true, Reason: reason} }

// Gate holds the session state that the tool_call handler reads.
type Gate struct {
	Mode Mode
	// AllowedRoots are folders allowed for this session by the outside prompt.
	AllowedRoots []string
}

func (g *Gate) approveOutside(ui UI, tool string, input map[string]any, cwd string, outside []OutsideTarget) Verdict {
	listed := make([]string, len(outside))
	for i, target := range outside {
		listed[i] = target.Resolved
	}
	shown := strings.Join(listed, ", ")
	if len(listed) > 3 {
		shown = fmt.Sprintf("%s (+%d more)", strings.Join(listed[:3], ", "), len(listed)-3)
	}
	if !ui.HasUI() {
		return blocked(fmt.Sprintf("%s blocked: %s is outside the working directory %s, and there is no UI to approve it. Only change files inside %s.", tool, shown, cwd, cwd))
	}
	scopes := ApprovalScopes(outside)
	decision, handled := "", false
	if approver, ok := ui.(MutationApprover); ok {
		decision, handled = approver.ApproveMutation(ApprovalRequest{Tool: tool, Input: input, Path: shown, Cwd: cwd, Outside: &OutsideInfo{Cwd: cwd, Scopes: scopes}})
	}
	if !handled {
		switch choice, _ := ui.Select(OutsideBody(cwd, scopes)+"\n"+ApprovalPrompt(tool, shown, input, cwd), OutsideOptions); choice {
		case OutsideOptions[1]:
			decision = DecisionAllowScope
		case OutsideOptions[0]:
			decision = DecisionAllow
		}
	}
	switch decision {
	case DecisionAllowScope:
		g.AllowedRoots = append(g.AllowedRoots, scopes...)
		return Verdict{}
	case DecisionAllow:
		return Verdict{}
	}
	return blocked(fmt.Sprintf("%s blocked by user: %s is outside the working directory %s.", tool, shown, cwd))
}

// OutsideBody ports approval-dialog.ts outsideBody.
func OutsideBody(cwd string, scopes []string) string { return difftools.OutsideBody(cwd, scopes) }

// Check is the tool_call gate. A Cursor replay call is allowed and, when it
// shows a mutation outside auto mode, the user gets a warning.
func (g *Gate) Check(ui UI, tool, toolCallID string, input map[string]any, cwd string) Verdict {
	if input == nil {
		input = map[string]any{}
	}
	if strings.HasPrefix(toolCallID, CursorReplayPrefix) {
		if mutation := CursorReplayMutation(tool, input); mutation != "" && g.Mode != ModeAuto && ui.HasUI() {
			ui.Notify(fmt.Sprintf("Cursor host %s bypassed %s mode; the action already ran outside Pi's permission gate. Use %s so Pi can show the diff and prompt before execution.",
				mutation, g.Mode, cursorBridgeMutationList), "warning")
		}
		return Verdict{}
	}
	if IsPassive(g.Mode) {
		label := "Plan"
		if g.Mode == ModeAsk {
			label = "Ask"
		}
		if FileMutationTools[tool] {
			return blocked(fmt.Sprintf("%s mode: %s disabled. Switch modes to make changes.", label, tool))
		}
		if IsShellTool(tool) {
			if cmd := commandOf(input); !IsSafeCommand(cmd) {
				return blocked(fmt.Sprintf("%s mode: read-only commands only.\n  Command: %s", label, cmd))
			}
		}
		return Verdict{}
	}
	if FileMutationTools[tool] {
		if outside := FindOutsideTargets(tool, input, cwd, g.AllowedRoots); len(outside) > 0 {
			return g.approveOutside(ui, tool, input, cwd, outside)
		}
	}
	if g.Mode == ModeAuto {
		return Verdict{}
	}
	if FileMutationTools[tool] {
		path := FileMutationTarget(input)
		if !ui.HasUI() {
			return blocked(tool + " blocked: no UI to confirm.")
		}
		decision := DecisionBlock
		handled := false
		if approver, ok := ui.(MutationApprover); ok {
			decision, handled = approver.ApproveMutation(ApprovalRequest{Tool: tool, Input: input, Path: path, Cwd: cwd})
			if decision == DecisionAllowScope {
				decision = DecisionBlock
			}
		}
		if !handled {
			switch choice, _ := ui.Select(ApprovalPrompt(tool, path, input, cwd), ApprovalOptions); choice {
			case ApprovalOptions[1]:
				decision = DecisionAllowAll
			case ApprovalOptions[0]:
				decision = DecisionAllow
			default:
				decision = DecisionBlock
			}
		}
		switch decision {
		case DecisionAllowAll:
			g.Mode = ModeAuto
			return Verdict{SwitchToAuto: true}
		case DecisionAllow:
			return Verdict{}
		}
		return blocked(fmt.Sprintf("%s blocked by user on %s", tool, path))
	}
	if IsShellTool(tool) {
		cmd := commandOf(input)
		if IsSafeCommand(cmd) {
			return Verdict{}
		}
		if !ui.HasUI() {
			return blocked(tool + " blocked: no UI to confirm.")
		}
		if choice, _ := ui.Select(fmt.Sprintf("Allow %s \"%s\"?", tool, cmd), ShellOptions); choice == "Allow" {
			return Verdict{}
		}
		return blocked(tool + " blocked by user")
	}
	return Verdict{}
}

// ApprovalPrompt ports the select fallback of approval-dialog.ts
// showMutationApproval: "Allow <tool> on <target>?" plus the plain diff
// preview from diff-tools (formatMutationPreview with its default caps).
// Relative paths resolve against cwd.
func ApprovalPrompt(tool, target string, input map[string]any, cwd string) string {
	preview, ok := difftools.FormatMutationPreview(tool, input, difftools.PreviewOptions{Cwd: cwd})
	return difftools.BuildMutationApprovalPrompt(tool, target, preview, ok)
}
