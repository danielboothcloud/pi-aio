package aio

// yaml-hooks wiring (port of yaml-hooks/index.ts). The loader, runtime, and
// commands live in internal/yamlhooks; this file adapts sdk.Context to
// yamlhooks.Host. It registers last, as in index.ts.
//
// Differences from TypeScript:
//   - Event payloads arrive as Go maps, so a tool call's arguments reach
//     hooks with sorted keys (stdin tool_args, file.changed paths are the
//     same).
//   - Console output (warn-once notices, PI_YAML_HOOKS_DEBUG logs) goes to
//     the extension's stderr.

import (
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	notify "github.com/danielboothcloud/pi-aio/go/internal/notifications"
	"github.com/danielboothcloud/pi-aio/go/internal/yamlhooks"
)

func init() { addRegistrar(OrderYamlHooks, "yaml-hooks", registerYamlHooks) }

// hookHost adapts one sdk.Context to yamlhooks.Host.
type hookHost struct{ ctx sdk.Context }

func (h hookHost) Cwd() string   { return h.ctx.Cwd() }
func (h hookHost) HasUI() bool   { return h.ctx.HasUI() }
func (h hookHost) Reload() error { return h.ctx.Reload() }

func (h hookHost) SessionID() string {
	id, err := h.ctx.SessionManager().GetSessionID()
	if err != nil {
		return ""
	}
	return id
}

func (h hookHost) SessionHeader() *yamlhooks.SessionHeader {
	header, err := h.ctx.SessionManager().GetHeader()
	if err != nil || header == nil {
		return nil
	}
	id, _ := header["id"].(string)
	parent, _ := header["parentSession"].(string)
	return &yamlhooks.SessionHeader{ID: id, ParentSession: parent}
}

func (h hookHost) Notify(text, level string) { h.ctx.Notify(text, level) }

func (h hookHost) Confirm(title, message string) (bool, error) {
	answer, err := h.ctx.Confirm(title, message)
	if err != nil {
		return false, err
	}
	approved, _ := answer.(bool)
	return approved, nil
}

func (h hookHost) SetStatus(key string, text *string) {
	if text == nil {
		h.ctx.ClearStatus(key)
		return
	}
	h.ctx.SetStatus(key, *text)
}

func (h hookHost) SendUserMessage(text, deliverAs string) error {
	return h.ctx.SendUserMessage(text, deliverAs)
}

func (h hookHost) SendDiagnostics(content string, details *yamlhooks.Object) error {
	return h.ctx.SendCustomMessage(sdk.CustomMessage{
		CustomType: yamlhooks.DiagnosticsMessageType,
		Content:    content,
		Display:    true,
		Details:    yamlhooks.ToGo(details),
	}, sdk.SendMessageOptions{})
}

func (h hookHost) EmitAgentPrompt(data *yamlhooks.Object) {
	_ = h.ctx.Events().Emit(notify.AgentPromptEvent, yamlhooks.ToGo(data))
}

func hookInput(data map[string]any) *yamlhooks.Object {
	input, _ := yamlhooks.FromGo(data["input"]).(*yamlhooks.Object)
	return input
}

func registerYamlHooks(e *sdk.Extension) {
	agentDir, _ := sdk.AgentDir()
	configDir, _ := sdk.ConfigDirName()
	f := yamlhooks.New(yamlhooks.Options{Paths: yamlhooks.Paths{AgentDir: agentDir, ConfigDirName: configDir}})

	e.MessageRenderer(yamlhooks.DiagnosticsMessageType, func(ctx sdk.Context, message map[string]any, options sdk.MessageRenderOptions, width int) ([]string, error) {
		details, _ := message["details"].(map[string]any)
		return yamlhooks.RenderDiagnostics(ctx.UITheme(), yamlhooks.DiagnosticsContent(message["content"]), details, options.Expanded, width), nil
	})

	for _, c := range yamlhooks.Commands {
		name := c.Name
		e.RegisterCommand(name, sdk.CommandOptions{
			Description: c.Description,
			Handler: func(ctx sdk.Context, args string) error {
				return f.Command(hookHost{ctx}, name, args)
			},
		})
	}

	e.OnEvent("before_agent_start", func(ctx sdk.Context, data map[string]any) (any, error) {
		messageType, _ := data["messageType"].(string)
		prompt, _ := data["prompt"].(string)
		system := ""
		switch sp := data["systemPrompt"].(type) {
		case *sdk.SystemPrompt:
			if text, err := sp.Get(); err == nil {
				system = text
			}
		case string:
			system = sp
		}
		next, ok := f.BeforeAgentStart(hookHost{ctx}, messageType, prompt, system)
		if !ok {
			return nil, nil
		}
		return map[string]any{"systemPrompt": next}, nil
	})

	e.OnSessionStart(func(ctx sdk.Context, data map[string]any) (any, error) {
		reason, _ := data["reason"].(string)
		f.SessionStart(hookHost{ctx}, reason)
		return nil, nil
	})
	e.OnEvent("session_before_switch", func(ctx sdk.Context, data map[string]any) (any, error) {
		reason, _ := data["reason"].(string)
		f.SessionEnd(hookHost{ctx}, reason)
		return nil, nil
	})
	e.OnSessionShutdown(func(ctx sdk.Context, data map[string]any) (any, error) {
		reason, _ := data["reason"].(string)
		f.SessionEnd(hookHost{ctx}, reason)
		return nil, nil
	})

	e.OnEvent("tool_call", func(ctx sdk.Context, data map[string]any) (any, error) {
		tool, _ := data["toolName"].(string)
		callID, _ := data["toolCallId"].(string)
		if reason, blocked := f.ToolCall(hookHost{ctx}, tool, callID, hookInput(data)); blocked {
			return map[string]any{"block": true, "reason": reason}, nil
		}
		return nil, nil
	})
	e.OnToolResult(func(ctx sdk.Context, data map[string]any) (any, error) {
		tool, _ := data["toolName"].(string)
		callID, _ := data["toolCallId"].(string)
		f.ToolResult(hookHost{ctx}, tool, callID, hookInput(data))
		return nil, nil
	})
}
