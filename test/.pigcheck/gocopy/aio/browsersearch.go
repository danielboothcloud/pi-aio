package aio

// browser-search wiring (port of browser-search/index.ts
// registerBrowserSearch). The logic is in go/internal/browsersearch; this
// file connects it to the PiG host.
//
// Differences from TypeScript:
//   - The CloakBrowser fallback starts the existing Node worker
//     (browser-search/cloak-worker.mjs, found from the extension's source
//     path) with `BROWSER_SEARCH_NODE_BINARY` or `node` on PATH. The worker
//     loads cloak-runtime.ts, so Node-side extraction (linkedom, turndown,
//     Readability) is the TypeScript code. When the worker file is missing,
//     each fallback fails with a clear error; loading never fails.
//   - Settings are read from <agent dir>/settings.json and the trusted
//     project's <config dir>/settings.json, as loadBrowserSearchConfig does.

import (
	"context"
	"os"
	"path/filepath"
	"sync"

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

// cloakWorkerPath finds browser-search/cloak-worker.mjs above the
// extension's source directory.
func cloakWorkerPath(ctx sdk.Context) string {
	info, ok := ctx.ExtensionSourceInfo()
	if !ok {
		return ""
	}
	for _, start := range []string{filepath.Dir(info.Path), info.BaseDir} {
		for dir := start; dir != "" && dir != "."; {
			candidate := filepath.Join(dir, "browser-search", "cloak-worker.mjs")
			if st, err := os.Stat(candidate); err == nil && st.Mode().IsRegular() {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func registerBrowserSearch(e *sdk.Extension) {
	rt := bs.NewRuntime(bs.LoadEnv(os.LookupEnv))
	var workerOnce sync.Once
	var worker string
	rt.Cloak.ResolveWorker = func() string { return worker }
	resolveWorker := func(ctx sdk.Context) {
		workerOnce.Do(func() { worker = cloakWorkerPath(ctx) })
	}

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
				resolveWorker(ctx)
				run, cancel := requestContext(ctx)
				defer cancel()
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
		resolveWorker(ctx)
		trusted, _ := ctx.IsProjectTrusted()
		reg.Start(ctx.Cwd(), trusted)
		return nil, nil
	})
}
