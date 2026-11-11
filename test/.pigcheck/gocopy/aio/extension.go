// Package aio is the Go port of the AIO extension for PiG.
//
// Load it with `pig -e <repo>/go/aio`. The port is staged: each feature in
// go/internal/<feature> mirrors one TypeScript feature directory. The
// TypeScript extension (index.ts) stays the implementation for native Pi
// until the Go port reaches parity. See go/README.md for the status.
//
// Registration order follows index.ts. Each feature file registers itself
// from an init() with addRegistrar and its Order* slot below, so a new
// feature never edits this file. Extension() runs them in slot order.
package aio

import (
	"os"
	"sort"
	"strings"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/blocklist"
)

// cursorReplayPrefix marks pi-cursor-sdk replay calls: work the Cursor host
// already did. Blocking the replay card cannot undo it, so it is skipped.
const cursorReplayPrefix = "cursor-replay-"

// Registration slots: the line order of the register* calls in index.ts.
// Recipes run first (session_start applies the recipe before the others
// restore); the blocklist gate runs before permission-modes (a hard block
// wins over every mode); yaml-hooks runs last.
const (
	OrderRecipes         = 10
	OrderAskUserQuestion = 20
	OrderGoals           = 30
	OrderAstGrep         = 40
	OrderBrowserSearch   = 50
	OrderCopyWidget      = 60
	OrderEffort          = 70
	OrderInit            = 80
	OrderDiffTools       = 90
	OrderBlocklist       = 100
	OrderNvim            = 110
	OrderPermissionModes = 120
	OrderStyles          = 130
	OrderSubagents       = 140
	OrderUserBash        = 150
	OrderRtk             = 160
	OrderHypa            = 170
	OrderQueue           = 180
	OrderPrettyTools     = 190
	OrderStatusLine      = 200
	OrderTuicr           = 210
	OrderSessionNav      = 220
	OrderFrame           = 230
	OrderBtw             = 240
	OrderSessionNaming   = 250
	OrderNotifications   = 260
	OrderYamlHooks       = 270
)

type registrar struct {
	order int
	name  string
	fn    func(*sdk.Extension)
}

var registrars []registrar

// addRegistrar adds a feature. Call it from the feature file's init().
func addRegistrar(order int, name string, fn func(*sdk.Extension)) {
	registrars = append(registrars, registrar{order, name, fn})
}

func init() {
	addRegistrar(OrderRecipes, "recipes", registerRecipes)
	addRegistrar(OrderBlocklist, "blocklist", registerBlocklist)
	addRegistrar(OrderPermissionModes, "permission-modes", registerPermissionModes)
}

func Extension() *sdk.Extension {
	e := sdk.New("aio")
	ordered := append([]registrar{}, registrars...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].order < ordered[j].order })
	for _, r := range ordered {
		r.fn(e)
	}
	return e
}

func blocklistPaths() blocklist.Paths {
	agentDir, _ := sdk.AgentDir()
	configDir, _ := sdk.ConfigDirName()
	return blocklist.Paths{AgentDir: agentDir, ConfigDirName: configDir}
}

// recipeBlocklistTier is the active recipe's blocklist, or in a subagent
// child (which never activates recipes) the parent's, from the env.
func recipeBlocklistTier() *blocklist.RecipeBlocklist {
	if active := activeRecipeBlocklist(); active != nil {
		return active
	}
	if os.Getenv("AIO_SUBAGENT_CHILD") != "1" {
		return nil
	}
	recipe, ok := blocklist.DecodeRecipe(os.Getenv(blocklist.RecipeEnv))
	if !ok {
		return nil
	}
	return &recipe
}

func registerBlocklist(e *sdk.Extension) {
	// A top-level session must not enforce a recipe blocklist leaked from an
	// enclosing session's env; recipes republish the active one. Children
	// keep it: it is their only copy.
	if os.Getenv("AIO_SUBAGENT_CHILD") != "1" {
		_ = os.Unsetenv(blocklist.RecipeEnv)
	}
	e.OnEvent("tool_call", func(ctx sdk.Context, data map[string]any) (any, error) {
		name, _ := data["toolName"].(string)
		if !blocklist.IsShellTool(name) {
			return nil, nil
		}
		if id, _ := data["toolCallId"].(string); strings.HasPrefix(id, cursorReplayPrefix) {
			return nil, nil
		}
		input, _ := data["input"].(map[string]any)
		command, ok := input["command"].(string)
		if !ok {
			return nil, nil
		}
		rules, _ := blocklist.Load(blocklistPaths(), ctx.Cwd(), recipeBlocklistTier())
		hit, blocked := blocklist.Evaluate(command, rules)
		if !blocked {
			return nil, nil
		}
		return map[string]any{"block": true, "reason": blocklist.BlockReason(hit, command)}, nil
	})

	// A rule that does not compile is skipped; say so once per session.
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		_, skipped := blocklist.Load(blocklistPaths(), ctx.Cwd(), recipeBlocklistTier())
		for _, rule := range skipped {
			ctx.Notify("aio blocklist: skipped "+rule.Source+" rule "+rule.Pattern+" ("+rule.Error+")", "warning")
		}
		return nil, nil
	})
}
