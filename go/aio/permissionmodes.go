package aio

// Permission modes wiring (port of permission-modes/index.ts). The logic is
// in go/internal/permissionmodes; this file connects it to the PiG host.
//
// Differences from TypeScript, until the related features are ported:
//   - File-mutation approvals use the diff-tools overlay in the TUI
//     (ApproveMutation in difftools.go) and ctx.Select elsewhere. Every
//     approval and plan prompt emits the notification agent-prompt event
//     (withAgentPrompt), as in TypeScript.
//   - The Cursor bridge switch goes through PiG's shared environment
//     (ctx.SetSharedEnv, PiG divergence D234), which reaches the Node
//     provider's process.env but not this process's environment.

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/frame"
	pm "github.com/danielboothcloud/pi-aio/go/internal/permissionmodes"
)

// modesAccess lets recipes set the mode on a live /recipe switch.
var modesAccess *modesState

type modesState struct {
	mu                 sync.Mutex
	mode               pm.Mode
	toolsBeforePassive []string // nil is "no snapshot"
	planExecuting      bool
	planTodos          []pm.TodoItem
	allowedRoots       []string
	cursorBridge       pm.CursorBridge
}

// applyBridge makes change in the environment the Node providers share and
// records it once the host accepted it. The caller holds s.mu; the host call
// sends no event back to this extension.
func (s *modesState) applyBridge(ctx sdk.Context, change pm.BridgeChange) {
	var err error
	switch change {
	case pm.BridgeKeep:
		return
	case pm.BridgeEnable:
		err = ctx.SetSharedEnv(pm.CursorBridgeBuiltinsEnv, "1")
	case pm.BridgeDisable:
		err = ctx.UnsetSharedEnv(pm.CursorBridgeBuiltinsEnv)
	}
	if err == nil {
		s.cursorBridge.Commit(change)
	}
}

// syncCursorBridgeLocked is syncCursorPermissionBridge in index.ts. The
// caller holds s.mu.
func (s *modesState) syncCursorBridgeLocked(ctx sdk.Context) {
	s.applyBridge(ctx, s.cursorBridge.Sync(ctx.ModelProvider(), s.mode))
}

// ctxUI adapts sdk.Context to the gate's UI interface.
type ctxUI struct{ ctx sdk.Context }

func (u ctxUI) HasUI() bool { return u.ctx.HasUI() }

func (u ctxUI) Notify(message, level string) { u.ctx.Notify(message, level) }

func (u ctxUI) Select(title string, options []string) (string, bool) {
	choice, ok, err := u.ctx.Select(title, options)
	if err != nil || !ok {
		return "", false
	}
	s, isString := choice.(string)
	return s, isString
}

// MarkAgentPrompt marks the gate's select fallback (withAgentPrompt).
func (u ctxUI) MarkAgentPrompt(kind, title, body, preview string) func() {
	return beginAgentPrompt(u.ctx, kind, title, body, &preview)
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// updateStatus is updateStatus: the frame pill (or the "modes" footer
// status without the frame), the working indicator while the frame is not
// active, and the aio:ui-state event.
func (s *modesState) updateStatus(ctx sdk.Context) {
	_ = ctx.Events().Emit(frame.UIStateEvent, map[string]any{"mode": string(s.mode)})
	if !ctx.HasUI() {
		return
	}
	meta := pm.ModeMetadata(s.mode)
	if !frame.Probe().Supported {
		ctx.SetStatus("modes", ctx.UITheme().Fg(meta.Role, meta.Icon+" "+meta.Label))
	} else {
		pill := &frame.Pill{Icon: meta.Icon, Label: meta.Label, Role: meta.Role}
		frame.SetMetadataContributor("mode", func() frame.Contribution { return frame.Contribution{Mode: pill} })
		frame.RequestRepaint()
	}
	if !frame.Probe().Active {
		theme := ctx.UITheme()
		frames := make([]string, len(spinnerFrames))
		for i, f := range spinnerFrames {
			frames[i] = theme.Fg(meta.Role, f)
		}
		_ = ctx.SetWorkingIndicator(sdk.WorkingIndicatorOptions{"frames": frames, "intervalMs": 80})
	}
}

func (s *modesState) persist(ctx sdk.Context) {
	_ = ctx.AppendEntry(pm.StateEntry, pm.PersistedState{CurrentMode: string(s.mode), ToolsBeforePassiveMode: s.toolsBeforePassive})
}

func (s *modesState) syncTodoWidget(ctx sdk.Context) {
	if !ctx.HasUI() {
		return
	}
	if len(s.planTodos) == 0 {
		_ = ctx.SetWidget(pm.PlanTodoWidget, nil)
		return
	}
	lines := make([]string, len(s.planTodos))
	for i, item := range s.planTodos {
		if item.Completed {
			lines[i] = "☑ " + item.Text
		} else {
			lines[i] = "☐ " + item.Text
		}
	}
	_ = ctx.SetWidget(pm.PlanTodoWidget, lines)
}

func (s *modesState) applyPassiveTools(ctx sdk.Context) {
	if s.toolsBeforePassive == nil {
		tools, err := ctx.GetActiveTools()
		if err != nil {
			tools = []string{}
		}
		s.toolsBeforePassive = tools
	}
	ctx.SetActiveTools(pm.PassiveTools(s.toolsBeforePassive))
}

func (s *modesState) restoreTools(ctx sdk.Context) {
	if s.toolsBeforePassive != nil {
		ctx.SetActiveTools(s.toolsBeforePassive)
	}
	s.toolsBeforePassive = nil
}

// setModeLocked is setMode in index.ts. The caller holds s.mu.
func (s *modesState) setModeLocked(ctx sdk.Context, mode pm.Mode) {
	prev := s.mode
	s.mode = mode
	s.planExecuting = false
	s.planTodos = nil
	switch {
	case pm.IsPassive(mode) && !pm.IsPassive(prev):
		s.applyPassiveTools(ctx)
	case !pm.IsPassive(mode) && pm.IsPassive(prev):
		s.restoreTools(ctx)
	}
	if mode != pm.ModePlan && ctx.HasUI() {
		_ = ctx.SetWidget(pm.PlanTodoWidget, nil)
	}
	s.syncCursorBridgeLocked(ctx)
	s.updateStatus(ctx)
	s.persist(ctx)
}

func (s *modesState) setMode(ctx sdk.Context, mode pm.Mode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setModeLocked(ctx, mode)
}

func entriesOf(ctx sdk.Context) []map[string]any {
	raw, err := ctx.GetEntries()
	if err != nil {
		return nil
	}
	entries := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		var entry map[string]any
		if json.Unmarshal(item, &entry) == nil {
			entries = append(entries, entry)
		}
	}
	return entries
}

func (s *modesState) restore(ctx sdk.Context) {
	// Without an explicit --permission-mode, the active recipe's
	// permissionMode is the starting mode (CLI beats config). The flag has
	// no default, so an absent flag reads as nil.
	flag, _ := ctx.GetFlag("permission-mode")
	start := pm.NormalizeMode(flag)
	if flag == nil {
		if mode := recipeStartMode(); mode != "" {
			start = pm.Mode(mode)
		}
	}
	r := pm.RestoreState(start, entriesOf(ctx), os.Getenv("AIO_SUBAGENT_CHILD") == "1")
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mode, s.toolsBeforePassive, s.planExecuting, s.planTodos = r.Mode, r.ToolsBeforePassive, r.PlanExecuting, r.PlanTodos
	if pm.IsPassive(s.mode) {
		s.applyPassiveTools(ctx)
	}
	s.syncTodoWidget(ctx)
	s.syncCursorBridgeLocked(ctx)
	s.updateStatus(ctx)
}

func registerPermissionModes(e *sdk.Extension) {
	s := &modesState{mode: pm.ModeDefault, cursorBridge: pm.NewCursorBridge(os.LookupEnv(pm.CursorBridgeBuiltinsEnv))}
	modesAccess = s

	e.Flag("permission-mode", sdk.FlagOptions{
		Description: "Start in a permission mode: default | ask | plan | auto",
		Type:        sdk.FlagString,
	})
	for _, c := range []struct {
		mode pm.Mode
		desc string
	}{
		{pm.ModeDefault, "Switch to default mode (prompt for edits & mutating bash)"},
		{pm.ModeAsk, "Switch to ask mode (passive read-only Q&A)"},
		{pm.ModePlan, "Switch to plan mode (read-only planning)"},
		{pm.ModeAuto, "Switch to auto mode (auto-approve without follow-up prompts)"},
	} {
		mode := c.mode
		e.Command(string(mode), c.desc, func(ctx sdk.Context, _ string) error {
			s.setMode(ctx, mode)
			return nil
		})
	}
	e.Command("mode", "Show or change the current permission mode", func(ctx sdk.Context, args string) error {
		trimmed := strings.ToLower(strings.TrimSpace(args))
		s.mu.Lock()
		current := s.mode
		s.mu.Unlock()
		if trimmed == "" {
			if !ctx.HasUI() {
				ctx.Notify("Mode: "+string(current), "info")
				return nil
			}
			choice, ok := ctxUI{ctx}.Select(fmt.Sprintf("Mode: %s — switch to:", current), []string{"default", "ask", "plan", "auto"})
			if ok {
				s.setMode(ctx, pm.Mode(choice))
			}
			return nil
		}
		switch pm.Mode(trimmed) {
		case pm.ModeDefault, pm.ModeAsk, pm.ModePlan, pm.ModeAuto:
			s.setMode(ctx, pm.Mode(trimmed))
		default:
			ctx.Notify(fmt.Sprintf("Unknown mode %q. Use: default | ask | plan | auto", trimmed), "error")
		}
		return nil
	})
	e.Shortcut("shift+tab", "Cycle permission mode (default → ask → plan → auto)", func(ctx sdk.Context) error {
		s.mu.Lock()
		next := pm.NextMode(s.mode)
		s.setModeLocked(ctx, next)
		s.mu.Unlock()
		ctx.Notify("Mode: "+string(next), "info")
		return nil
	})

	registerTodoTool(e, s)

	e.OnEvent("tool_call", func(ctx sdk.Context, data map[string]any) (any, error) {
		tool, _ := data["toolName"].(string)
		id, _ := data["toolCallId"].(string)
		input, _ := data["input"].(map[string]any)
		s.mu.Lock()
		gate := &pm.Gate{Mode: s.mode, AllowedRoots: append([]string{}, s.allowedRoots...)}
		s.mu.Unlock()
		// The prompt can wait for the user, so the gate runs unlocked on a copy.
		verdict := gate.Check(ctxUI{ctx}, tool, id, input, ctx.Cwd())
		s.mu.Lock()
		if len(gate.AllowedRoots) > len(s.allowedRoots) {
			s.allowedRoots = gate.AllowedRoots
		}
		if verdict.SwitchToAuto {
			s.setModeLocked(ctx, pm.ModeAuto)
		}
		s.mu.Unlock()
		if verdict.Block {
			return map[string]any{"block": true, "reason": verdict.Reason}, nil
		}
		return nil, nil
	})

	e.OnEvent("context", func(_ sdk.Context, data map[string]any) (any, error) {
		messages, ok := data["messages"].([]any)
		if !ok {
			return nil, nil
		}
		return map[string]any{"messages": pm.FilterContext(messages)}, nil
	})

	e.OnEvent("before_agent_start", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		s.syncCursorBridgeLocked(ctx)
		mode, executing, todos := s.mode, s.planExecuting, append([]pm.TodoItem{}, s.planTodos...)
		bridge, set := s.cursorBridge.Value()
		s.mu.Unlock()
		content := ""
		if executing && len(todos) > 0 {
			content = pm.ExecutingContext(todos)
		} else {
			content = pm.ModeContext(mode, ctx.ModelProvider(), bridge, set)
		}
		return map[string]any{"message": map[string]any{"customType": pm.ContextType, "content": content, "display": false}}, nil
	})

	e.OnEvent("turn_end", func(ctx sdk.Context, data map[string]any) (any, error) {
		text, ok := pm.AssistantText(data["message"])
		if !ok {
			return nil, nil
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.planExecuting && len(s.planTodos) > 0 {
			pm.MarkCompletedSteps(text, s.planTodos)
			s.syncTodoWidget(ctx)
			s.persist(ctx)
		}
		return nil, nil
	})

	e.OnEvent("agent_end", func(ctx sdk.Context, data map[string]any) (any, error) {
		s.agentEnd(ctx, data)
		return nil, nil
	})

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		s.allowedRoots = nil // outside-folder approvals never outlive their session
		s.mu.Unlock()
		s.restore(ctx)
		return nil, nil
	})
	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.restore(ctx)
		return nil, nil
	})
	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.mu.Lock()
		s.allowedRoots = nil
		s.applyBridge(ctx, s.cursorBridge.Shutdown())
		s.mu.Unlock()
		return nil, nil
	})
}

// agentEnd ends a finished plan, or offers to execute a new plan in plan mode.
func (s *modesState) agentEnd(ctx sdk.Context, data map[string]any) {
	s.mu.Lock()
	if s.planExecuting && len(s.planTodos) > 0 {
		done := true
		for _, item := range s.planTodos {
			done = done && item.Completed
		}
		if done {
			message := pm.PlanCompleteMessage(s.planTodos)
			s.planExecuting = false
			s.planTodos = nil
			if ctx.HasUI() {
				_ = ctx.SetWidget(pm.PlanTodoWidget, nil)
			}
			s.updateStatus(ctx)
			s.persist(ctx)
			s.mu.Unlock()
			no := false
			_ = ctx.SendMessage(pm.PlanDoneType, message, true, sdk.SendMessageOptions{TriggerTurn: &no})
			return
		}
		s.mu.Unlock()
		return
	}
	if s.mode != pm.ModePlan || !ctx.HasUI() {
		s.mu.Unlock()
		return
	}
	messages, _ := data["messages"].([]any)
	var items []pm.TodoItem
	for i := len(messages) - 1; i >= 0; i-- {
		if text, ok := pm.AssistantText(messages[i]); ok {
			items = pm.ExtractTodoItems(text)
			break
		}
	}
	if len(items) == 0 {
		s.mu.Unlock()
		return
	}
	s.planTodos = items
	s.persist(ctx)
	listMessage := pm.PlanListMessage(items)
	s.mu.Unlock()

	end := beginAgentPrompt(ctx, "select", "Plan ready", "Review the agent's plan and choose what happens next.", nil)
	choice, ok := ctxUI{ctx}.Select("Plan ready — what next?", []string{"Execute the plan", "Stay in plan mode", "Refine the plan"})
	end()
	if !ok {
		return
	}
	switch {
	case strings.HasPrefix(choice, "Execute"):
		s.mu.Lock()
		s.planExecuting = true
		s.restoreTools(ctx)
		s.mode = pm.ModeAuto
		s.updateStatus(ctx)
		s.persist(ctx)
		body := pm.ExecutionBody(s.planTodos)
		s.syncTodoWidget(ctx)
		s.mu.Unlock()
		yes := true
		_ = ctx.SendMessage(pm.PlanListType, listMessage, true, sdk.SendMessageOptions{DeliverAs: "followUp"})
		_ = ctx.SendMessage(pm.ExecuteType, body, true, sdk.SendMessageOptions{TriggerTurn: &yes, DeliverAs: "followUp"})
	case choice == "Refine the plan":
		end := beginAgentPrompt(ctx, "editor", "Input needed", "The agent is waiting for your plan refinement.", nil)
		refinement, ok, err := ctx.Editor("Refine the plan:", "")
		end()
		text, _ := refinement.(string)
		if err == nil && ok && strings.TrimSpace(text) != "" {
			_ = ctx.SendMessage(pm.PlanListType, listMessage, true, sdk.SendMessageOptions{DeliverAs: "followUp"})
			_ = ctx.SendUserMessage(strings.TrimSpace(text), "followUp")
		}
	}
}

func registerTodoTool(e *sdk.Extension, s *modesState) {
	e.RegisterTool(sdk.ToolDefinition{
		Name:          "todo",
		Label:         "Todo",
		Description:   "Manage the active plan todo list. Actions: list, toggle (step), create (text, optional position), rename (step, text), reorder (step, position), delete (step)",
		PromptSnippet: "Track plan steps and mark each step done with todo action=toggle",
		PromptGuidelines: []string{
			"When executing a numbered plan, call todo action=toggle for the matching step immediately after that step's work is finished, before starting the next step.",
			"Use todo action=list at the start of plan execution and again whenever you need to confirm which steps remain.",
			"Do not leave completed steps unchecked; toggle flips completion state, so only call it once per finished step.",
		},
		Parameters: sdk.Schema{
			"type":     "object",
			"required": []string{"action"},
			"properties": map[string]any{
				"action":   map[string]any{"type": "string", "enum": []string{"list", "toggle", "create", "rename", "reorder", "delete"}},
				"step":     map[string]any{"type": "integer", "minimum": 1, "description": "Step number (for toggle, rename, reorder, or delete)"},
				"text":     map[string]any{"type": "string", "description": "Step text (for create or rename)"},
				"position": map[string]any{"type": "integer", "minimum": 1, "description": "1-based insertion or destination position (for create or reorder)"},
			},
		},
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			req := pm.TodoRequest{}
			req.Action, _ = params["action"].(string)
			if v, ok := params["step"].(float64); ok {
				n := int(v)
				req.Step = &n
			}
			if v, ok := params["position"].(float64); ok {
				n := int(v)
				req.Position = &n
			}
			if v, ok := params["text"].(string); ok {
				req.Text = &v
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			items, text, errCode := pm.ApplyTodo(s.planTodos, req)
			s.planTodos = items
			if req.Action != "list" && errCode == "" {
				s.syncTodoWidget(ctx)
			}
			details := map[string]any{"action": req.Action, "todos": append([]pm.TodoItem{}, items...)}
			if errCode != "" {
				details["error"] = errCode
			}
			return sdk.ToolResult{Content: text, Details: details}, nil
		},
	})
}
