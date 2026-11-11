package aio

// pretty-tools wiring (port of pretty-tools/index.ts and tools/*.ts). The
// logic is in go/internal/prettytools; this file connects it to the PiG
// host. It registers after rtk and hypa (OrderPrettyTools), so their
// tool_call rewrites reach the bash tool's execute, as in index.ts.
//
// Differences from TypeScript:
//   - FFF is not ported. The tools take the path TypeScript takes when FFF
//     does not load: rtk first, then the host's built-in tool. The /fff-*
//     commands report "FFF not initialized"; no @-mention provider is added.
//   - Highlighting is the host's highlight.js port (sdk.HighlightCode), not
//     Shiki. PRETTY_THEME and the settings theme have no effect.
//   - rtk runs through ctx.ExecWithOptions (pi.exec). TypeScript deletes
//     RTK_DISABLED from its own process first; the Go extension cannot
//     change the host's environment.

import (
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/prettytools"
	"github.com/danielboothcloud/pi-aio/go/internal/rtk"
)

func init() {
	addRegistrar(OrderPrettyTools, "pretty-tools", registerPrettyTools)
}

// prettyLangs maps pretty-tools' Shiki names that highlight.js knows by
// another name; hostHighlight maps the rest.
var prettyLangs = map[string]string{"jsonc": "json", "mdx": "markdown", "make": "makefile"}

func prettyHighlight(code, language string) (string, error) {
	if mapped, ok := prettyLangs[language]; ok {
		language = mapped
	}
	return hostHighlight(code, language)
}

// prettyState keeps the long-lived context for the terminal width.
type prettyState struct {
	mu     sync.Mutex
	loaded *sdk.Context
}

// termWidth ports termWidth(): the terminal columns (at most 210), else
// COLUMNS or 200, less 4.
func (s *prettyState) termWidth() int {
	s.mu.Lock()
	loaded := s.loaded
	s.mu.Unlock()
	if loaded != nil {
		if w := loaded.Width(); w > 0 {
			return max(1, min(w, 210))
		}
	}
	raw, err := strconv.Atoi(os.Getenv("COLUMNS"))
	if err != nil || raw == 0 {
		raw = 200
	}
	return max(1, min(raw-4, 210))
}

// toMap decodes a details value (an *sdk.OrderedObject or a map) to a map.
func toMap(v any) map[string]any {
	if v == nil {
		return nil
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	return m
}

func fromSDKResult(r sdk.AgentToolResult) prettytools.Result {
	out := prettytools.Result{IsError: r.IsError, Details: toMap(r.Details)}
	for _, c := range r.Content {
		block := prettytools.Content{Type: c.Type, Data: c.Data, MimeType: c.MimeType}
		if c.Type == "text" {
			text := c.Text
			block.Text = &text
		}
		out.Content = append(out.Content, block)
	}
	return out
}

func toSDKResult(r prettytools.Result) sdk.AgentToolResult {
	out := sdk.AgentToolResult{Content: []sdk.ToolResultContent{}, IsError: r.IsError}
	if r.Details != nil {
		out.Details = r.Details
	}
	for _, c := range r.Content {
		block := sdk.ToolResultContent{Type: c.Type, Data: c.Data, MimeType: c.MimeType}
		if c.Text != nil {
			block.Text = *c.Text
		}
		out.Content = append(out.Content, block)
	}
	return out
}

func prettyRenderView(result sdk.ToolRenderResult) prettytools.RenderView {
	v := prettytools.RenderView{Details: toMap(result.Details)}
	for _, block := range result.Content {
		c := prettytools.Content{}
		c.Type, _ = block["type"].(string)
		if text, ok := block["text"]; ok {
			s, _ := text.(string)
			c.Text = &s
		}
		v.Content = append(v.Content, c)
	}
	return v
}

func builtinDefinition(name, cwd string) (sdk.BuiltinToolDefinition, error) {
	switch name {
	case "read":
		return sdk.CreateReadToolDefinition(cwd, nil)
	case "bash":
		return sdk.CreateBashToolDefinition(cwd, nil)
	case "ls":
		return sdk.CreateLsToolDefinition(cwd, nil)
	case "find":
		return sdk.CreateFindToolDefinition(cwd, nil)
	}
	return sdk.CreateGrepToolDefinition(cwd, nil)
}

func registerPrettyTools(e *sdk.Extension) {
	cwd, _ := os.Getwd()
	agentDir, _ := sdk.AgentDir()
	state := &prettyState{}
	e.OnLoaded(func(ctx sdk.Context) {
		state.mu.Lock()
		state.loaded = &ctx
		state.mu.Unlock()
	})
	pretty := prettytools.NewPretty(os.Getenv)
	pretty.Highlight = prettyHighlight
	pretty.TermWidth = state.termWidth
	pretty.ConfigDir = func() string {
		if dir, ok := os.LookupEnv("PRETTY_CONFIG_DIR"); ok {
			return dir
		}
		return agentDir
	}
	tools := &prettytools.Tools{Pretty: pretty, Cwd: cwd, Home: os.Getenv("HOME")}
	start := time.Now()

	for _, name := range prettytools.EnabledTools(os.Getenv) {
		def, err := builtinDefinition(name, cwd)
		if err != nil {
			os.Stderr.WriteString("aio pretty-tools: " + name + " keeps Pi's built-in tool: " + err.Error() + "\n")
			continue
		}
		name := name
		run := def.Execute
		meta := prettytools.ToolMeta(name, def.Description)
		def.Label, def.Description = meta.Label, meta.Description
		def.PromptSnippet, def.PromptGuidelines = meta.PromptSnippet, meta.PromptGuidelines
		def.RenderShell = sdk.ToolRenderShellSelf
		def.Execute = func(ctx sdk.Context, params map[string]any) (any, error) {
			call := *tools
			call.Host = prettytools.Host{
				Getenv: os.Getenv,
				NowMs:  func() float64 { return float64(time.Since(start).Microseconds()) / 1000 },
				Exec: func(command string, args []string, dir string) (rtk.ExecResult, error) {
					res, err := ctx.ExecWithOptions(command, args, sdk.ExecOptions{Cwd: dir})
					if err != nil {
						return rtk.ExecResult{}, err
					}
					if res == nil {
						return rtk.ExecResult{}, os.ErrNotExist
					}
					return rtk.ExecResult{Stdout: res.Stdout, Stderr: res.Stderr, Code: res.ExitCode, Killed: res.Killed}, nil
				},
				Builtin: func(_ string, p map[string]any) (prettytools.Result, error) {
					raw, err := run(ctx, p)
					if err != nil {
						return prettytools.Result{}, err
					}
					switch r := raw.(type) {
					case sdk.AgentToolResult:
						return fromSDKResult(r), nil
					case *sdk.AgentToolResult:
						return fromSDKResult(*r), nil
					}
					return prettytools.Result{}, nil
				},
			}
			result, err := call.Execute(name, params, ctx.Cwd())
			if err != nil {
				return nil, err
			}
			return toSDKResult(result), nil
		}
		def.RenderCall = func(ctx sdk.Context, args map[string]any, render sdk.ToolRenderContext, width int) ([]string, error) {
			rc := prettytools.RenderCtx{Expanded: render.Expanded, IsError: render.IsError}
			return tools.RenderCall(name, ctx.UITheme(), args, rc, width), nil
		}
		def.RenderResult = func(ctx sdk.Context, result sdk.ToolRenderResult, options sdk.ToolRenderResultOptions, render sdk.ToolRenderContext, width int) ([]string, error) {
			rc := prettytools.RenderCtx{Expanded: render.Expanded || options.Expanded, IsError: render.IsError}
			return tools.RenderResult(name, ctx.UITheme(), prettyRenderView(result), rc, width), nil
		}
		e.RegisterTool(def.ToolDefinition)
	}

	notify := func(ctx sdk.Context, step string) {
		for _, call := range prettytools.Lifecycle(step, ctx.Mode()) {
			if call.Fn == "notify" {
				ctx.Notify(call.Message, call.Level)
			} else {
				ctx.SetToolsExpanded(call.Value)
			}
		}
	}
	e.RegisterCommand("fff-health", sdk.CommandOptions{
		Description: prettytools.FFFHealthDescription,
		Handler:     func(ctx sdk.Context, _ string) error { notify(ctx, "fff-health"); return nil },
	})
	e.RegisterCommand("fff-rescan", sdk.CommandOptions{
		Description: prettytools.FFFRescanDescription,
		Handler:     func(ctx sdk.Context, _ string) error { notify(ctx, "fff-rescan"); return nil },
	})
	e.Shortcut(prettytools.ExpandShortcut, prettytools.ExpandShortcutSummary, func(ctx sdk.Context) error {
		notify(ctx, "shortcut")
		return nil
	})
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		notify(ctx, "session_start")
		return nil, nil
	})
}
