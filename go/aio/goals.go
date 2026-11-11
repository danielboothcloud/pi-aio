package aio

// Goals wiring (port of goals/index.ts). The state machine, prompts, and
// review live in internal/goals; this file adapts sdk.Context to its Host.
//
// Not ported: AIO notification events (goal activity, "needs attention",
// "complete", agent prompts) and the ui/chrome draft card. The draft message
// renders as a plain-text card, and the status has no theme tone.

import (
	"encoding/json"
	"os"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/btw"
	"github.com/danielboothcloud/pi-aio/go/internal/goals"
)

func init() {
	addRegistrar(OrderGoals, "goals", registerGoals)
}

// goalHost adapts one sdk.Context to goals.Host.
type goalHost struct{ ctx sdk.Context }

func (h goalHost) HasUI() bool                  { return h.ctx.HasUI() }
func (h goalHost) Notify(message, level string) { h.ctx.Notify(message, level) }

func (h goalHost) SetStatus(text, _ string) {
	if text == "" {
		h.ctx.ClearStatus(goals.StatusKey)
		return
	}
	h.ctx.SetStatus(goals.StatusKey, text)
}

func (h goalHost) Persist(goal *goals.Goal) error {
	return h.ctx.AppendEntry(goals.StateEntry, map[string]any{"goal": goal})
}

func (h goalHost) Send(content string, display bool, details goals.MessageDetails) error {
	trigger := true
	return h.ctx.SendCustomMessage(sdk.CustomMessage{
		CustomType: goals.MessageType,
		Content:    content,
		Display:    display,
		Details:    details,
	}, sdk.SendMessageOptions{TriggerTurn: &trigger, DeliverAs: "followUp"})
}

func (h goalHost) Confirm(title, body string) bool {
	answer, err := h.ctx.Confirm(title, body)
	confirmed, _ := answer.(bool)
	return err == nil && confirmed
}

// IsIdle treats a failed host read as idle: nothing to abort, and resume
// sends its explicit continuation.
func (h goalHost) IsIdle() bool {
	idle, err := h.ctx.IsIdle()
	return err != nil || idle
}

func (h goalHost) Abort()                    { h.ctx.Abort() }
func (h goalHost) Branch() []json.RawMessage { return sessionBranch(h.ctx) }
func (h goalHost) HasModel() bool            { return h.ctx.Model() != "" }

func (h goalHost) Complete(systemPrompt, prompt string) (map[string]any, error) {
	return completeOnce(h.ctx, systemPrompt, prompt)
}

func (h goalHost) Exec(command string, args []string) (string, int, error) {
	result, err := h.ctx.ExecWithOptions(command, args, sdk.ExecOptions{Cwd: h.ctx.Cwd(), Timeout: goals.GitTimeoutMs})
	if err != nil {
		return "", 0, err
	}
	return result.Stdout, result.ExitCode, nil
}

// sessionBranch is the current branch with each entry's JSON key order kept
// (the digest prints tool arguments as JSON.stringify does).
func sessionBranch(ctx sdk.Context) []json.RawMessage {
	entries, err := ctx.GetEntries()
	if err != nil {
		return nil
	}
	leaf, err := ctx.GetLeafID()
	if err != nil || leaf == nil {
		return nil
	}
	return btw.BranchFromEntries(entries, *leaf)
}

// completeOnce runs one isolated completion on the session model. A model
// failure comes back as an assistant message with stopReason "error".
func completeOnce(ctx sdk.Context, systemPrompt, prompt string) (map[string]any, error) {
	return completeWith(ctx, ctx.ModelProvider(), ctx.Model(), systemPrompt, prompt)
}

// completeWith runs one isolated completion on the given model.
func completeWith(ctx sdk.Context, provider, id, systemPrompt, prompt string) (map[string]any, error) {
	registry := ctx.ModelRegistry()
	model, err := registry.Find(provider, id)
	if err != nil {
		return nil, err
	}
	if model == nil {
		return nil, errNoModel
	}
	return registry.Complete(model, map[string]any{
		"systemPrompt": systemPrompt,
		"messages": []any{map[string]any{
			"role": "user", "content": prompt, "timestamp": time.Now().UnixMilli(),
		}},
	}, map[string]any{}), nil
}

type staticError string

func (e staticError) Error() string { return string(e) }

const errNoModel = staticError("the session model is not in the model registry")

func registerGoals(e *sdk.Extension) {
	if os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	m := goals.NewMachine(nil)

	e.MessageRenderer(goals.MessageType, func(_ sdk.Context, message map[string]any, _ sdk.MessageRenderOptions, width int) ([]string, error) {
		details, _ := message["details"].(map[string]any)
		if kind, _ := details["kind"].(string); kind != "draft" {
			return nil, nil
		}
		text, _ := details["text"].(string)
		return goals.DraftRows(sdkLayout{}, text, width), nil
	})

	text := func(s string) any { return sdk.ToolResult{Content: s, Details: map[string]any{}} }
	str := func(params map[string]any, key string) string { v, _ := params[key].(string); return v }

	e.RegisterTool(sdk.ToolDefinition{
		Name:        "goal_propose",
		Label:       "Propose goal",
		Description: "Propose the goal the user started with /goal: a precise objective and concrete done criteria. The user confirms it, then you start the work. Use only after a /goal draft message.",
		Parameters: sdk.Schema{
			"type":     "object",
			"required": []string{"objective", "doneWhen"},
			"properties": map[string]any{
				"objective": map[string]any{"type": "string", "description": "Precise statement of what to build or change"},
				"doneWhen":  map[string]any{"type": "string", "description": "Concrete behavior, tests, or checks that prove the goal is complete"},
			},
		},
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			out, err := m.Propose(goalHost{ctx}, str(params, "objective"), str(params, "doneWhen"))
			if err != nil {
				return nil, err
			}
			return text(out), nil
		},
	})

	e.RegisterTool(sdk.ToolDefinition{
		Name:        "goal_done",
		Label:       "Goal done",
		Description: "Report that the active /goal is complete. An independent review checks the claim; if it rejects, you get the open points and continue. Use only while a goal is active.",
		Parameters: sdk.Schema{
			"type":     "object",
			"required": []string{"summary"},
			"properties": map[string]any{
				"summary": map[string]any{"type": "string", "description": "What you did and the evidence that each done criterion is met"},
			},
		},
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			out, err := m.Done(goalHost{ctx}, str(params, "summary"),
				func() bool { return ctx.Err() != nil },
				func(update string) { _ = ctx.OnUpdate(sdk.ToolResult{Content: update, Details: map[string]any{}}) })
			if err != nil {
				return nil, err
			}
			return text(out), nil
		},
	})

	e.RegisterTool(sdk.ToolDefinition{
		Name:        "goal_blocked",
		Label:       "Goal blocked",
		Description: "Pause the active /goal when you cannot continue without the user (missing access, a decision only the user can make). Use only while a goal is active.",
		Parameters: sdk.Schema{
			"type":     "object",
			"required": []string{"reason"},
			"properties": map[string]any{
				"reason": map[string]any{"type": "string", "description": "What you need from the user"},
			},
		},
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			out, err := m.Blocked(goalHost{ctx}, str(params, "reason"))
			if err != nil {
				return nil, err
			}
			return text(out), nil
		},
	})

	e.RegisterCommand("goal", sdk.CommandOptions{
		Description: "Give the agent a goal to work on until it is done: /goal <text> | status | pause | resume | cancel",
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			var items []sdk.AutocompleteItem
			for _, sub := range goals.Completions(prefix) {
				items = append(items, sdk.AutocompleteItem{Label: sub.Name, Value: sub.Name, Description: sub.Description})
			}
			return items, nil
		},
		Handler: func(ctx sdk.Context, args string) error {
			return m.Command(goalHost{ctx}, args)
		},
	})

	// The loop: while the goal is active, each settle boundary adds the
	// state entry and one hidden continuation and asks for one more run.
	e.OnEvent("agent_before_settle", func(ctx sdk.Context, data map[string]any) (any, error) {
		outcome, _ := data["outcome"].(string)
		entries, _ := data["entries"].([]any)
		result := m.BeforeSettle(goalHost{ctx}, outcome, entries)
		if !result.Handled {
			return nil, nil
		}
		// PiG returns the event's entries beside the handler result; keep
		// both the same so either reading appends each entry once.
		data["entries"] = result.Entries
		reply := map[string]any{"entries": result.Entries}
		if result.Continue {
			reply["continue"] = true
		}
		return reply, nil
	})

	e.OnEvent("agent_settled", func(ctx sdk.Context, data map[string]any) (any, error) {
		aborted, _ := data["aborted"].(bool)
		m.Settled(goalHost{ctx}, aborted)
		return nil, nil
	})

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		entries, _ := ctx.GetEntries()
		m.SessionStart(goalHost{ctx}, entries)
		return nil, nil
	})

	e.OnSessionShutdown(func(ctx sdk.Context, _ map[string]any) (any, error) {
		m.Shutdown(goalHost{ctx})
		return nil, nil
	})
}
