package aio

// browser-search wiring (port of browser-search/index.ts
// registerBrowserSearch). The logic is in go/internal/browsersearch; this
// file connects it to the PiG host.
//
// Differences from TypeScript (deliberate):
//   - The fetch chain is the Camofox container (only when
//     BROWSER_SEARCH_CAMOFOX_BASE or CAMOFOX_BASE is set), then a local
//     Camoufox worker (Python, started with `uv run --script`), then a
//     plain HTTP fetch. There is no CloakBrowser Node worker. Missing uv,
//     Python, or camoufox never stops the extension from loading: the
//     browser tier fails and the HTTP fallback runs.
//   - A result of the HTTP fallback shows a warning notice, once per URL
//     and call. Without a UI (print and JSON modes) the notice goes to the
//     extension stderr.
//   - session_shutdown stops the worker and its browser. When the extension
//     exits, the worker sees end-of-file on stdin and closes the browser.
//   - Settings are read from <agent dir>/settings.json and the trusted
//     project's <config dir>/settings.json, as loadBrowserSearchConfig does.

import (
	"context"
	"fmt"
	"os"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	bs "github.com/danielboothcloud/pi-aio/go/internal/browsersearch"
)

func init() { addRegistrar(OrderBrowserSearch, "browser-search", registerBrowserSearch) }

// requestContext is a context.Context that ends when the tool request or
// the agent run is cancelled (Pi's tool `signal`).
func requestContext(ctx sdk.Context) (context.Context, context.CancelFunc) {
	run, cancel := context.WithCancel(context.Background())
	var signal <-chan struct{}
	if s := ctx.Signal(); s != nil {
		signal = s.Done()
	}
	go func() {
		select {
		case <-ctx.Done():
		case <-signal:
		case <-run.Done():
		}
		cancel()
	}()
	return run, cancel
}

// browserSearchNotify shows a fetch notice: a UI notification, or a stderr
// line when the mode has no UI.
func browserSearchNotify(ctx sdk.Context) func(message, level string) {
	return func(message, level string) {
		if ctx.HasUI() {
			ctx.Notify(message, level)
			return
		}
		fmt.Fprintf(os.Stderr, "[browser-search] %s\n", message)
	}
}

func registerBrowserSearch(e *sdk.Extension) {
	rt := bs.NewRuntime(bs.LoadEnv(os.LookupEnv))

	register := func(tool bs.Tool) {
		spec := tool.Spec
		e.RegisterTool(sdk.ToolDefinition{
			Name:             spec.Name,
			Label:            spec.Label,
			Description:      spec.Description,
			PromptSnippet:    spec.PromptSnippet,
			PromptGuidelines: spec.PromptGuidelines,
			Parameters:       sdk.Schema(spec.Parameters),
			Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
				run, cancel := requestContext(ctx)
				defer cancel()
				run = bs.WithReporter(run, bs.Reporter{Notify: browserSearchNotify(ctx)})
				result, err := tool.Execute(run, params, func(u bs.Update) {
					_ = ctx.OnUpdate(sdk.ToolResult{Content: u.Text, Details: u.Details})
				})
				if err != nil {
					return nil, err
				}
				return sdk.ToolResult{Content: result.Text, Details: result.Details}, nil
			},
		})
	}

	reg := rt.Register(bs.Dependencies{
		LoadConfig: func(cwd string, trusted bool) bs.ProviderConfig {
			agentDir, _ := sdk.AgentDir()
			configDir, _ := sdk.ConfigDirName()
			return bs.LoadConfig(agentDir, configDir, cwd, trusted, os.Stderr)
		},
	}, register)

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		trusted, _ := ctx.IsProjectTrusted()
		reg.Start(ctx.Cwd(), trusted)
		return nil, nil
	})
	e.OnSessionShutdown(func(sdk.Context, map[string]any) (any, error) {
		rt.Shutdown()
		return nil, nil
	})
}
