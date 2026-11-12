package aio

// diff-tools wiring (port of diff-tools/index.ts and edit-guard.ts, plus the
// approval overlay of permission-modes/approval-dialog.ts). The logic is in
// go/internal/difftools; this file connects it to the PiG host.
//
// Differences from TypeScript:
//   - Highlighting is the host's highlight.js port (sdk.HighlightCode), not
//     Shiki. Shiki language names map to highlight.js names; pi-diff.json
//     shikiTheme and the presets' Shiki themes have no effect.
//   - Renderers are synchronous: a card shows its final diff at once, with
//     no "rendering diff…" placeholder.
//   - Relative tool paths resolve against the extension process directory
//     (pig's working directory), as process.cwd() does in TypeScript.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	"github.com/danielboothcloud/pi-aio/go/internal/difftools"
	pm "github.com/danielboothcloud/pi-aio/go/internal/permissionmodes"
)

func init() {
	addRegistrar(OrderDiffTools, "diff-tools", registerDiffTools)
}

// hljsNames maps the Shiki language names of difftools.ExtLang to the names
// the host's highlight.js port knows.
var hljsNames = map[string]string{"tsx": "typescript", "jsx": "javascript", "svelte": "xml", "vue": "xml"}

// hostHighlight is the difftools.Highlighter over sdk.HighlightCode.
func hostHighlight(code, language string) (string, error) {
	if mapped, ok := hljsNames[language]; ok {
		language = mapped
	}
	return strings.Join(sdk.HighlightCode(code, language), "\n"), nil
}

// loadDiffUserConfig ports hunk-preview.ts loadDiffConfig: the first of
// <cwd>/<configDir>/settings.json and <agentDir>/settings.json that sets
// diffTheme or diffColors.
func loadDiffUserConfig(cwd string) difftools.DiffUserConfig {
	agentDir, _ := sdk.AgentDir()
	configDir, _ := sdk.ConfigDirName()
	for _, path := range []string{filepath.Join(cwd, configDir, "settings.json"), filepath.Join(agentDir, "settings.json")} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var raw struct {
			DiffTheme  any            `json:"diffTheme"`
			DiffColors map[string]any `json:"diffColors"`
		}
		if json.Unmarshal(data, &raw) != nil {
			continue
		}
		theme, _ := raw.DiffTheme.(string)
		if theme == "" && raw.DiffColors == nil {
			continue
		}
		colors := map[string]string{}
		for k, v := range raw.DiffColors {
			if s, ok := v.(string); ok {
				colors[k] = s
			}
		}
		return difftools.DiffUserConfig{DiffTheme: theme, DiffColors: colors}
	}
	return difftools.DiffUserConfig{}
}

// diffTheme adapts sdk.UITheme to difftools.Theme.
type diffTheme struct{ sdk.UITheme }

func renderView(result sdk.ToolRenderResult) difftools.ToolResultView {
	v := difftools.ToolResultView{Texts: []*string{}, Details: result.Details}
	for i, block := range result.Content {
		var text *string
		if s, ok := block["text"].(string); ok {
			text = &s
		}
		if t, _ := block["type"].(string); t == "text" || t == "" {
			v.Texts = append(v.Texts, text)
		}
		if i == 0 {
			v.First = text
		}
	}
	return v
}

func renderCtx(render sdk.ToolRenderContext) difftools.RenderCtx {
	return difftools.RenderCtx{ToolCallID: render.ToolCallID, ArgsComplete: render.ArgsComplete, IsError: render.IsError}
}

func textResult(text string, isError bool, details any) sdk.AgentToolResult {
	return sdk.AgentToolResult{Content: []sdk.ToolResultContent{{Type: "text", Text: text}}, IsError: isError, Details: details}
}

// diffToolsState keeps the long-lived context for the terminal width.
type diffToolsState struct {
	mu     sync.Mutex
	loaded *sdk.Context
}

func (s *diffToolsState) width() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded == nil {
		return 0
	}
	return s.loaded.Width()
}

func registerDiffTools(e *sdk.Extension) {
	cwd, _ := os.Getwd()
	agentDir, _ := sdk.AgentDir()
	configDir, _ := sdk.ConfigDirName()
	config := difftools.LoadConfig(difftools.ConfigPaths(agentDir, configDir, cwd))
	disabled := config.DisabledTools()
	palette := difftools.NewPalette(os.Getenv, loadDiffUserConfig(cwd), config.IndicatorStyle(), hostHighlight)
	state := &diffToolsState{}
	home := os.Getenv("HOME")
	tools := difftools.NewTools(palette, cwd, home, state.width)
	e.OnLoaded(func(ctx sdk.Context) {
		state.mu.Lock()
		state.loaded = &ctx
		state.mu.Unlock()
	})

	if !disabled["write"] {
		registerDiffWrite(e, tools, cwd)
	}
	if !disabled["edit"] {
		registerDiffEdit(e, tools, cwd)
	}
	if !disabled["apply_patch"] {
		registerApplyPatch(e, tools)
	}
	if !disabled["edit"] {
		// edit-guard.ts: block an edit whose oldText is not in the file.
		e.OnEvent("tool_call", func(ctx sdk.Context, data map[string]any) (any, error) {
			if name, _ := data["toolName"].(string); name != "edit" {
				return nil, nil
			}
			input, _ := data["input"].(map[string]any)
			if reason := difftools.EditGuardReason(input, cwd); reason != "" {
				return map[string]any{"block": true, "reason": reason}, nil
			}
			return nil, nil
		})
	}
}

func registerDiffWrite(e *sdk.Extension, tools *difftools.Tools, cwd string) {
	def, err := sdk.CreateWriteToolDefinition(cwd, nil)
	if err != nil {
		os.Stderr.WriteString("aio diff-tools: write keeps Pi's built-in tool: " + err.Error() + "\n")
		return
	}
	run := def.Execute
	def.Execute = func(ctx sdk.Context, params map[string]any) (any, error) {
		fp, old, hadOld := tools.WriteBefore(params)
		raw, err := run(ctx, params)
		if err != nil {
			return nil, err
		}
		result, ok := raw.(sdk.AgentToolResult)
		if !ok {
			return raw, nil
		}
		result.Details = tools.WriteDetails(ctx.ToolCallID(), fp, old, hadOld, params)
		return result, nil
	}
	def.RenderCall = func(ctx sdk.Context, args map[string]any, render sdk.ToolRenderContext, width int) ([]string, error) {
		return tools.RenderWriteCall(diffTheme{ctx.UITheme()}, args, renderCtx(render), width), nil
	}
	def.RenderResult = func(ctx sdk.Context, result sdk.ToolRenderResult, _ sdk.ToolRenderResultOptions, render sdk.ToolRenderContext, width int) ([]string, error) {
		return tools.RenderWriteResult(diffTheme{ctx.UITheme()}, renderView(result), renderCtx(render), width), nil
	}
	e.RegisterTool(def.ToolDefinition)
}

func registerDiffEdit(e *sdk.Extension, tools *difftools.Tools, cwd string) {
	def, err := sdk.CreateEditToolDefinition(cwd, nil)
	if err != nil {
		os.Stderr.WriteString("aio diff-tools: edit keeps Pi's built-in tool: " + err.Error() + "\n")
		return
	}
	run := def.Execute
	// The schema accepts Cursor's argument names, as index.ts declares.
	props := map[string]any{}
	if existing, ok := def.Parameters["properties"].(map[string]any); ok {
		for k, v := range existing {
			props[k] = v
		}
	}
	props["oldText"] = map[string]any{"type": "string", "description": "Exact existing text to replace."}
	props["newText"] = map[string]any{"type": "string", "description": "Replacement text for oldText."}
	props["old_string"] = map[string]any{"type": "string", "description": "Cursor IDE alias for oldText."}
	props["new_string"] = map[string]any{"type": "string", "description": "Cursor IDE alias for newText."}
	params := sdk.Schema{}
	for k, v := range def.Parameters {
		params[k] = v
	}
	params["properties"] = props
	params["required"] = []string{"path"}
	params["additionalProperties"] = true
	def.Parameters = params
	def.Execute = func(ctx sdk.Context, params map[string]any) (any, error) {
		fast, normalized, ok := tools.EditFast(params)
		if ok {
			return textResult(fast.Text, false, fast.Details), nil
		}
		raw, err := run(ctx, normalized)
		if err != nil {
			return nil, err
		}
		result, isResult := raw.(sdk.AgentToolResult)
		if !isResult {
			return raw, nil
		}
		if details, ok := tools.EditFallbackDetails(normalized); ok {
			result.Details = details
		}
		return result, nil
	}
	def.RenderCall = func(ctx sdk.Context, args map[string]any, render sdk.ToolRenderContext, width int) ([]string, error) {
		return tools.RenderEditCall(diffTheme{ctx.UITheme()}, args, renderCtx(render), width), nil
	}
	def.RenderResult = func(ctx sdk.Context, result sdk.ToolRenderResult, _ sdk.ToolRenderResultOptions, render sdk.ToolRenderContext, width int) ([]string, error) {
		return tools.RenderEditResult(diffTheme{ctx.UITheme()}, renderView(result), renderCtx(render), width), nil
	}
	e.RegisterTool(def.ToolDefinition)
}

func applyPatchSchema() sdk.Schema {
	str := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	return sdk.Schema{
		"type": "object",
		"properties": map[string]any{
			"patch": str("Unified diff string (Cursor IDE compatibility). Alternative to changes."),
			"changes": map[string]any{
				"type":        "array",
				"description": "Array of file changes to apply atomically.",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"path":       str("Absolute path to the file."),
						"action":     map[string]any{"type": "string", "enum": []string{"add", "update", "delete", "move"}, "description": "The operation to perform."},
						"content":    str("Content for new files (action=add)."),
						"oldText":    str("Text to find for updates (action=update)."),
						"newText":    str("Replacement text for updates (action=update)."),
						"old_string": str("Cursor IDE alias for oldText."),
						"new_string": str("Cursor IDE alias for newText."),
						"movePath":   str("Destination path for moves (action=move)."),
					},
					"required": []string{"path", "action"},
				},
			},
		},
	}
}

func registerApplyPatch(e *sdk.Extension, tools *difftools.Tools) {
	e.RegisterTool(sdk.ToolDefinition{
		Name:        "apply_patch",
		Label:       "apply_patch",
		Description: "Multi-file patch engine. One call can add, update, delete, or move multiple files. Accepts a structured JSON changes array or a unified diff patch string.",
		Parameters:  applyPatchSchema(),
		Execute: func(_ sdk.Context, params map[string]any) (any, error) {
			text, isError, details := tools.ApplyPatch(params)
			return textResult(text, isError, details), nil
		},
		RenderCall: func(ctx sdk.Context, args map[string]any, render sdk.ToolRenderContext, width int) ([]string, error) {
			return tools.RenderApplyPatchCall(diffTheme{ctx.UITheme()}, args, renderCtx(render), width), nil
		},
		RenderResult: func(ctx sdk.Context, result sdk.ToolRenderResult, _ sdk.ToolRenderResultOptions, render sdk.ToolRenderContext, width int) ([]string, error) {
			return tools.RenderApplyPatchResult(diffTheme{ctx.UITheme()}, renderView(result), renderCtx(render), width), nil
		},
	})
}

// approvalComponent shows difftools.ApprovalDialog as an SDK overlay.
type approvalComponent struct {
	mu     sync.Mutex
	dialog *difftools.ApprovalDialog
}

func (c *approvalComponent) Render(width int) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dialog.Render(width)
}

func (c *approvalComponent) HandleInput(data string) (sdk.RemoteComponentResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dialog.HandleInput(data)
	if decision, done := c.dialog.Done(); done {
		return sdk.RemoteComponentResult{Done: true, Value: decision}, nil
	}
	return sdk.RemoteComponentResult{}, nil
}

// ApproveMutation is showMutationApproval's overlay path: the scrollable
// diff approval in the TUI. Other modes report ok=false, and the gate falls
// back to ctx.Select with the capped plain preview.
func (u ctxUI) ApproveMutation(req pm.ApprovalRequest) (string, bool) {
	if u.ctx.Mode() != "tui" || !u.ctx.HasUI() {
		return "", false
	}
	var outside *difftools.Outside
	if req.Outside != nil {
		outside = &difftools.Outside{Cwd: req.Outside.Cwd, Scopes: req.Outside.Scopes}
	}
	header, diff := difftools.OverlayContent(req.Tool, req.Path, req.Input, outside, req.Cwd)
	ctx := u.ctx
	dialog := difftools.NewApprovalDialog(difftools.ApprovalDialogOptions{
		Theme:   ctx.UITheme(),
		Header:  header,
		Diff:    diff,
		Outside: outside != nil,
		Matches: func(data, binding string) bool { return sdktui.GetKeybindings().Matches(data, binding) },
		Rows:    func() int { return max(ctx.Height(), 1) },
		Columns: func() int { return max(ctx.Width(), 1) },
	})
	body := pm.MutationPromptBody
	if outside != nil {
		body = pm.OutsidePromptBody
	}
	end := beginAgentPrompt(ctx, "custom", "Approval needed", body, &header)
	value, err := ctx.Custom(&approvalComponent{dialog: dialog}, sdk.RemoteOverlayOptions{Overlay: true, OverlayOptions: &sdk.OverlayOptions{
		Anchor: "bottom-center", Width: sdk.OverlayPercent(100), MaxHeight: sdk.OverlayPercent(100), Margin: &sdk.OverlayMargin{},
	}})
	end()
	if err != nil {
		return "", false
	}
	result, _ := value.(string)
	return difftools.OverlayDecision(result, result != "", outside != nil), true
}
