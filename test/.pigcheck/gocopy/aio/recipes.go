package aio

// Recipes wiring (port of the in-session part of recipes/index.ts and
// recipes/apply.ts). The launch bridge stays in bin/aio-pig.mjs: it applies
// the extension set and model scope before pig starts and marks the launch
// with AIO_RECIPE_STAGE/AIO_RECIPE_ACTIVE/AIO_RECIPE_ORIGIN.
//
// Not ported yet: /recipe init, /recipe status and /recipe-status (they
// report that), launch-time notes that need pig's argv, --no-approve, and a
// session-side trust question (a hint points to /recipe trust instead).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/blocklist"
	pm "github.com/danielboothcloud/pi-aio/go/internal/permissionmodes"
	"github.com/danielboothcloud/pi-aio/go/internal/recipes"
)

// recipeShared is what other features read from the active recipe.
var recipeShared struct {
	sync.Mutex
	blocklist *blocklist.RecipeBlocklist
	mode      string // starting permission mode
	style     string // starting style
}

func activeRecipeBlocklist() *blocklist.RecipeBlocklist {
	recipeShared.Lock()
	defer recipeShared.Unlock()
	return recipeShared.blocklist
}

func recipeStartStyle() string {
	recipeShared.Lock()
	defer recipeShared.Unlock()
	return recipeShared.style
}

func recipeStartMode() string {
	recipeShared.Lock()
	defer recipeShared.Unlock()
	return recipeShared.mode
}

// publishRecipe sets (def != nil) or clears what other features read. The
// blocklist is mirrored into AIO_RECIPE_BLOCKLIST for subagent children.
func publishRecipe(def *recipes.Definition) {
	recipeShared.Lock()
	defer recipeShared.Unlock()
	recipeShared.blocklist, recipeShared.mode, recipeShared.style = nil, "", ""
	if def == nil {
		_ = os.Unsetenv(blocklist.RecipeEnv)
		return
	}
	recipeShared.mode, recipeShared.style = def.Config.PermissionMode, def.Config.Style
	if len(def.Config.Blocklist) > 0 {
		recipe := blocklist.RecipeBlocklist{Recipe: def.Name, Entries: def.Config.Blocklist}
		recipeShared.blocklist = &recipe
		_ = os.Setenv(blocklist.RecipeEnv, blocklist.EncodeRecipe(recipe))
	} else {
		_ = os.Unsetenv(blocklist.RecipeEnv)
	}
}

type recipeState struct {
	mu             sync.Mutex
	loaded         recipes.Loaded
	directoryTrust string
	activeName     string
	registeredMcp  map[string]bool
	directoryNoted bool
	warned         map[string]bool
}

func recipePaths() recipes.Paths {
	agentDir, _ := sdk.AgentDir()
	configDir, _ := sdk.ConfigDirName()
	return recipes.Paths{AgentDir: agentDir, ConfigDirName: configDir}
}

func trustStore() string {
	agentDir, _ := sdk.AgentDir()
	return recipes.TrustStorePath(agentDir)
}

func recipeEnv() map[string]string {
	env := map[string]string{}
	for _, key := range []string{recipes.ActiveEnv, recipes.OriginEnv, recipes.StageEnv} {
		env[key] = os.Getenv(key)
	}
	return env
}

// refresh reloads the recipes for the session cwd. The caller holds r.mu.
func (r *recipeState) refresh(ctx sdk.Context) {
	cwd := ctx.Cwd()
	r.directoryTrust = ""
	if file := recipes.DirectoryPath(cwd); file != "" {
		r.directoryTrust = recipes.FileTrust(file, trustStore())
	}
	projectTrusted, _ := ctx.IsProjectTrusted()
	r.loaded = recipes.Load(recipePaths(), cwd, projectTrusted, r.directoryTrust == recipes.Trusted)
	for _, warning := range r.loaded.Warnings {
		if !r.warned[warning] {
			r.warned[warning] = true
			ctx.Notify("[recipes] "+warning, "warning")
		}
	}
}

func (r *recipeState) updateStatus(ctx sdk.Context) {
	if !ctx.HasUI() {
		return
	}
	if r.activeName == "" {
		ctx.ClearStatus(recipes.StatusKey)
		return
	}
	ctx.SetStatus(recipes.StatusKey, "✦ recipe:"+r.activeName)
}

// findModel resolves a spec like findRecipeModel: registry, then the session
// scope, then the chat catalog. It returns "provider/id", or "".
func findModel(ctx sdk.Context, spec string) string {
	ref := func(m map[string]any) string {
		provider, _ := m["provider"].(string)
		id, _ := m["id"].(string)
		if provider == "" || id == "" {
			return ""
		}
		return provider + "/" + id
	}
	provider, id, split := "", "", false
	if slash := strings.Index(spec, "/"); slash > 0 {
		provider, id, split = spec[:slash], spec[slash+1:], true
	}
	registry := ctx.ModelRegistry()
	if split {
		if model, err := registry.Find(provider, id); err == nil && model != nil {
			return ref(model)
		}
	}
	if scoped, err := ctx.ScopedModels(); err == nil {
		for _, entry := range scoped {
			p, _ := entry.Model["provider"].(string)
			i, _ := entry.Model["id"].(string)
			if (!split && i == spec) || (split && p == provider && i == id) {
				return ref(entry.Model)
			}
		}
	}
	models, err := registry.GetModelsOfType(sdk.ModelTypeChat)
	if err != nil {
		return ""
	}
	for _, model := range models {
		p, _ := model["provider"].(string)
		i, _ := model["id"].(string)
		if (split && p == provider && i == id) || i == spec {
			return ref(model)
		}
	}
	return ""
}

func mcpConfig(raw map[string]any) (sdk.McpServerConfig, error) {
	var config sdk.McpServerConfig
	data, err := json.Marshal(raw)
	if err == nil {
		err = json.Unmarshal(data, &config)
	}
	return config, err
}

// apply activates a recipe (applyRecipe). live is set for a running session
// (a /recipe switch or a just-trusted default): the mode is set now. The
// caller holds r.mu.
func (r *recipeState) apply(ctx sdk.Context, def *recipes.Definition, persist, live bool) (applied, warnings []string) {
	r.activeName = def.Name
	// First: the gate must never see a stale recipe's rules.
	publishRecipe(def)
	c := def.Config
	thinking := c.ThinkingLevel
	if c.Model != "" {
		model, specThinking := recipes.ParseModelSpec(c.Model)
		if thinking == "" {
			thinking = specThinking
		}
		if ref := findModel(ctx, model); ref == "" {
			warnings = append(warnings, fmt.Sprintf("model %q not found — model left as the session default", model))
		} else if ok, err := ctx.SetModel(ref); err != nil {
			warnings = append(warnings, "model switch failed: "+err.Error())
		} else if !ok {
			warnings = append(warnings, "no API key for "+ref+" — model left unchanged")
		} else {
			applied = append(applied, "model")
		}
	}
	if thinking != "" {
		ctx.SetThinkingLevel(thinking)
		applied = append(applied, "thinking")
	}
	if len(c.McpServers) > 0 {
		for name := range r.registeredMcp {
			if _, wanted := c.McpServers[name]; !wanted {
				ctx.UnregisterMcpServer(name)
				delete(r.registeredMcp, name)
			}
		}
		names := make([]string, 0, len(c.McpServers))
		for name := range c.McpServers {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			config, err := mcpConfig(c.McpServers[name])
			if err == nil {
				err = ctx.RegisterMcpServer(name, config)
			}
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("mcp server %q: %s", name, err))
				continue
			}
			r.registeredMcp[name] = true
		}
		applied = append(applied, "mcp")
	}
	if len(c.Blocklist) > 0 {
		applied = append(applied, "blocklist")
	}
	if c.PermissionMode != "" {
		if live && modesAccess != nil {
			modesAccess.mu.Lock()
			if string(modesAccess.mode) != c.PermissionMode {
				modesAccess.setModeLocked(ctx, pm.Mode(c.PermissionMode))
			}
			modesAccess.mu.Unlock()
		}
		applied = append(applied, "mode")
	}
	if c.Style != "" {
		switch {
		case !live:
			applied = append(applied, "style")
		case stylesAccess == nil:
			warnings = append(warnings, fmt.Sprintf("style %q not applied: styles are not loaded", c.Style))
		default:
			stylesAccess.mu.Lock()
			if stylesAccess.current != c.Style {
				stylesAccess.setLocked(ctx, c.Style, true)
			}
			stylesAccess.mu.Unlock()
			applied = append(applied, "style")
		}
	}
	r.updateStatus(ctx)
	if persist {
		_ = ctx.AppendEntry(recipes.StateEntry, map[string]any{"name": def.Name})
	}
	return applied, warnings
}

// deactivate clears the active recipe and this feature's MCP servers. The
// session keeps its model, mode, and style. The caller holds r.mu.
func (r *recipeState) deactivate(ctx sdk.Context, persist bool) {
	r.activeName = ""
	publishRecipe(nil)
	for name := range r.registeredMcp {
		ctx.UnregisterMcpServer(name)
	}
	r.registeredMcp = map[string]bool{}
	r.updateStatus(ctx)
	if persist {
		_ = ctx.AppendEntry(recipes.StateEntry, map[string]any{"name": nil})
	}
}

func (r *recipeState) notifyActivation(ctx sdk.Context, def *recipes.Definition, applied, warnings []string) {
	text := fmt.Sprintf("Recipe %q active", def.Name)
	if len(applied) > 0 {
		text += " — applied: " + strings.Join(applied, ", ")
	}
	level := "info"
	if len(warnings) > 0 {
		text += "; " + strings.Join(warnings, "; ")
		level = "warning"
	}
	ctx.Notify(text, level)
	if recipes.IsRestartScoped(def.Config) && !recipes.Bridged(recipeEnv(), def.Name) {
		how := "start pig through AIO's bin/aio-pig.mjs launcher"
		if os.Getenv(recipes.PigLauncherEnv) == "1" {
			how = fmt.Sprintf("restart with `pig --recipe %q`", def.Name)
		}
		ctx.Notify(fmt.Sprintf("%q also scopes the extension set and enabled models — %s to apply them", def.Name, how), "info")
	}
}

func branchEntries(ctx sdk.Context) []map[string]any {
	entries, err := ctx.SessionManager().GetBranch(nil)
	if err != nil {
		return nil
	}
	return entries
}

func (r *recipeState) sessionStart(ctx sdk.Context, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refresh(ctx)
	if file := r.loaded.DirectoryFile; file != "" && r.directoryTrust == recipes.Unknown && reason == "startup" &&
		!r.directoryNoted && os.Getenv(recipes.PigTrustAskedEnv) != "1" {
		r.directoryNoted = true
		ctx.Notify(file+" is new or changed and not trusted yet — run /recipe trust to apply it", "warning")
	}
	flag, _ := ctx.GetFlag(recipes.Flag)
	name, present := recipes.LatestPersisted(branchEntries(ctx))
	selected := recipes.Select(recipes.Selection{
		Reason: reason, Flag: flag, Env: recipeEnv(),
		PersistedName: name, PersistedPresent: present, Loaded: r.loaded,
	})
	if selected.BareFlag {
		ctx.Notify("recipes: --recipe needs a recipe name (see /recipe)", "warning")
	}
	def := r.loaded.Recipes[selected.Name]
	if reason == "resume" && selected.Source != "directory" && selected.Source != "default" {
		r.resumeHint(ctx, selected.Name, def)
	}
	if selected.Name == "" {
		r.deactivate(ctx, false)
		return
	}
	if def == nil {
		r.deactivate(ctx, false)
		ctx.Notify(fmt.Sprintf("Unknown recipe %q. Available: %s", selected.Name, recipes.AvailableNames(r.loaded)), "warning")
		return
	}
	// An empty resolved scope means "all models". A scoped launch whose scope
	// resolves to nothing must not silently run unrestricted.
	if reason == "startup" && recipes.Bridged(recipeEnv(), def.Name) && len(def.Config.Models) > 0 {
		if scoped, err := ctx.ScopedModels(); err == nil && len(scoped) == 0 {
			r.deactivate(ctx, false)
			message := fmt.Sprintf("Recipe %q: no available models matched %s. Check that its provider extension loaded, authentication is available, and the model ID exists in its catalog. Stopping instead of enabling all models.",
				def.Name, strings.Join(def.Config.Models, ", "))
			ctx.Notify(message, "error")
			fmt.Fprintln(os.Stderr, "recipes: "+message)
			ctx.Shutdown()
			return
		}
	}
	source := selected.Source
	applied, warnings := r.apply(ctx, def, source != "session", false)
	r.notifyActivation(ctx, def, applied, warnings)
}

// resumeHint: pig cannot relaunch itself, so a resumed branch whose recipe
// needs another extension set or model scope gets the restart command.
func (r *recipeState) resumeHint(ctx sdk.Context, name string, def *recipes.Definition) {
	file, _ := ctx.SessionManager().GetSessionFile()
	if file == nil {
		return
	}
	var reasons []string
	recipeName := name
	if def != nil && def.Source != "project" && recipes.IsRestartScoped(def.Config) {
		if len(def.Config.Extensions) > 0 {
			reasons = append(reasons, "extension set")
		}
		if len(def.Config.Models) > 0 {
			reasons = append(reasons, "model scope")
		}
	} else if injected, _ := strconv.Atoi(os.Getenv("AIO_RECIPE_INJECTED_ARGS")); os.Getenv(recipes.StageEnv) == "1" && injected > 0 {
		reasons = []string{"previous recipe settings cleared"}
		if recipeName == "" {
			recipeName = "off"
		}
	}
	if len(reasons) == 0 {
		return
	}
	ctx.Notify(fmt.Sprintf("Recipe %q needs a restart for its %s: pig --session %q", recipeName, strings.Join(reasons, " + "), *file), "warning")
}

func (r *recipeState) restoreFromBranch(ctx sdk.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name, present := recipes.LatestPersisted(branchEntries(ctx))
	def := r.loaded.Recipes[name]
	if !present || name == "" || def == nil {
		r.deactivate(ctx, false)
		return
	}
	r.apply(ctx, def, false, false)
}

// activateDirectoryDefault starts a just-trusted `.pi-recipe` default. The caller holds r.mu.
func (r *recipeState) activateDirectoryDefault(ctx sdk.Context, fileName string) {
	name := ""
	if r.loaded.DefaultSource == "directory" {
		name = r.loaded.DefaultRecipe
	}
	def := r.loaded.Recipes[name]
	if def == nil {
		ctx.Notify(fileName+" is trusted; its recipes are available in /recipe (no valid defaultRecipe)", "info")
		return
	}
	if r.activeName != "" {
		ctx.Notify(fmt.Sprintf("%s is trusted; %q starts automatically on the next fresh `pi` here (active recipe %q unchanged — /recipe %s switches now)",
			fileName, name, r.activeName, name), "info")
		return
	}
	applied, warnings := r.apply(ctx, def, true, true)
	r.notifyActivation(ctx, def, applied, warnings)
}

func (r *recipeState) trust(ctx sdk.Context) {
	file := r.loaded.DirectoryFile
	if file == "" {
		ctx.Notify(fmt.Sprintf("No %s in %s — /recipe init creates one", strings.Join(recipes.DirectoryFileNames, " or "), ctx.Cwd()), "info")
		return
	}
	if err := recipes.RecordTrust(file, trustStore(), true); err != nil {
		ctx.Notify(fmt.Sprintf("recipes: could not save trust for %s: %s", file, err), "error")
		return
	}
	r.refresh(ctx)
	r.activateDirectoryDefault(ctx, filepath.Base(file))
}

func (r *recipeState) untrust(ctx sdk.Context) {
	file := r.loaded.DirectoryFile
	if file == "" {
		ctx.Notify(fmt.Sprintf("No %s in %s", strings.Join(recipes.DirectoryFileNames, " or "), ctx.Cwd()), "info")
		return
	}
	forgot, err := recipes.ForgetTrust(file, trustStore())
	if err != nil {
		ctx.Notify(fmt.Sprintf("recipes: could not update trust for %s: %s", file, err), "error")
		return
	}
	r.refresh(ctx)
	if forgot {
		ctx.Notify("Forgot the trust decision for "+filepath.Base(file)+" — the next start asks again (the active recipe stays for this session)", "info")
	} else {
		ctx.Notify(filepath.Base(file)+" has no saved trust decision", "info")
	}
}

func (r *recipeState) switchTo(ctx sdk.Context, name string) {
	r.refresh(ctx)
	def := r.loaded.Recipes[name]
	if def == nil {
		ctx.Notify(fmt.Sprintf("Unknown recipe %q. Available: %s", name, recipes.AvailableNames(r.loaded)), "error")
		return
	}
	applied, warnings := r.apply(ctx, def, true, true)
	r.notifyActivation(ctx, def, applied, warnings)
}

const recipeOffNote = "Recipe: off — MCP servers cleared; model keeps its current state"

func (r *recipeState) command(ctx sdk.Context, args string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refresh(ctx)
	requested := strings.TrimSpace(args)
	if r.loaded.Recipes[requested] == nil {
		switch {
		case requested == "status" || requested == "status --json" || requested == "init" || strings.HasPrefix(requested, "init "):
			ctx.Notify("/recipe "+strings.Fields(requested)[0]+" is not ported to the Go extension yet; use it from pi", "warning")
			return nil
		case requested == "trust":
			r.trust(ctx)
			return nil
		case requested == "untrust":
			r.untrust(ctx)
			return nil
		}
	}
	if requested == "" {
		if len(r.loaded.Recipes) == 0 {
			ctx.Notify("No recipes configured. Add them to `<agent-dir>/"+recipes.FileName+"` (see the recipes README section)", "info")
			return nil
		}
		active := r.activeName
		if active == "" {
			active = "none"
		}
		if !ctx.HasUI() {
			ctx.Notify(fmt.Sprintf("Recipe: %s — available: %s", active, recipes.AvailableNames(r.loaded)), "info")
			return nil
		}
		names, labels := recipes.SelectionLabels(r.loaded.Recipes)
		choice, ok := ctxUI{ctx}.Select(fmt.Sprintf("Recipe: %s — switch to:", active), append(labels, "off — clear the active recipe"))
		if !ok {
			return nil
		}
		if strings.HasPrefix(choice, "off — ") {
			r.deactivate(ctx, true)
			ctx.Notify(recipeOffNote, "info")
			return nil
		}
		for i, label := range labels {
			if label == choice {
				r.switchTo(ctx, names[i])
			}
		}
		return nil
	}
	if lower := strings.ToLower(requested); lower == "off" || lower == "none" {
		r.deactivate(ctx, true)
		ctx.Notify(recipeOffNote, "info")
		return nil
	}
	r.switchTo(ctx, requested)
	return nil
}

func (r *recipeState) completions(prefix string) ([]sdk.AutocompleteItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	wanted := strings.ToLower(strings.TrimSpace(prefix))
	var items []sdk.AutocompleteItem
	names, _ := recipes.SelectionLabels(r.loaded.Recipes)
	for _, name := range names {
		if strings.HasPrefix(strings.ToLower(name), wanted) {
			description := strings.TrimSpace(r.loaded.Recipes[name].Config.Description)
			if description == "" {
				description = "named launch recipe"
			}
			items = append(items, sdk.AutocompleteItem{Value: name, Label: name, Description: description})
		}
	}
	if strings.HasPrefix("off", wanted) {
		items = append(items, sdk.AutocompleteItem{Value: "off", Label: "off", Description: "clear the active recipe"})
	}
	file := r.loaded.DirectoryFile
	for _, sub := range []struct {
		word, description string
		offered           bool
	}{
		{"trust", "trust this folder's .pi-recipe and start its default", file != "" && r.directoryTrust != recipes.Trusted},
		{"untrust", "forget the .pi-recipe trust decision", file != "" && r.directoryTrust != recipes.Unknown},
	} {
		if sub.offered && strings.HasPrefix(sub.word, wanted) && r.loaded.Recipes[sub.word] == nil {
			items = append(items, sdk.AutocompleteItem{Value: sub.word, Label: sub.word, Description: sub.description})
		}
	}
	return items, nil
}

func registerRecipes(e *sdk.Extension) {
	e.Flag(recipes.Flag, sdk.FlagOptions{
		Description: "Start with a named recipe from aio-recipes.json (extensions, model scope, MCP)",
		Type:        sdk.FlagString,
	})
	// Old sessions may contain recipe instruction messages: strip them in
	// every process, subagent children included.
	e.OnEvent("context", func(_ sdk.Context, data map[string]any) (any, error) {
		messages, ok := data["messages"].([]any)
		if !ok {
			return nil, nil
		}
		if filtered, changed := recipes.FilterContext(messages); changed {
			return map[string]any{"messages": filtered}, nil
		}
		return nil, nil
	})
	if os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	r := &recipeState{registeredMcp: map[string]bool{}, warned: map[string]bool{}}
	e.OnSessionStart(func(ctx sdk.Context, data map[string]any) (any, error) {
		reason, _ := data["reason"].(string)
		r.sessionStart(ctx, reason)
		return nil, nil
	})
	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		r.restoreFromBranch(ctx)
		return nil, nil
	})
	e.RegisterCommand("recipe", sdk.CommandOptions{
		Description:            "Show, switch, or clear the active launch recipe (aio-recipes.json); trust/untrust manage this folder's .pi-recipe",
		GetArgumentCompletions: r.completions,
		Handler:                r.command,
	})
}
