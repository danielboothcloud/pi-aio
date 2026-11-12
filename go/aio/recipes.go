package aio

// Recipes wiring (port of the in-session part of recipes/index.ts,
// recipes/apply.ts, and recipes/status.ts). The launch bridge stays in
// bin/aio-pig.mjs: it applies the extension set and model scope before pig
// starts and marks the launch with AIO_RECIPE_STAGE/AIO_RECIPE_ACTIVE/
// AIO_RECIPE_ORIGIN.
//
// pig's own argv comes from PIG_HARNESS_ARGV_FILE (piargs.HarnessArgv): it
// gives --no-approve, the actual --models scope for the empty-scope stop,
// and the launch note of decideRelaunch (recipes.LaunchNote). A Go
// extension cannot ask on the terminal before pig's TUI starts, so a new
// or changed `.pi-recipe` is asked about through the session UI (a
// non-blocking select), or with a stderr hint where no UI exists.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/blocklist"
	"github.com/danielboothcloud/pi-aio/go/internal/frame"
	pm "github.com/danielboothcloud/pi-aio/go/internal/permissionmodes"
	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
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
	active         *recipes.Definition
	source         string // the RecipeSourceMarker of the active recipe
	registeredMcp  map[string]bool
	directoryAsked bool
	launchChecked  bool
	warned         map[string]bool
	// argv is pig's argv after the binary, read once at registration.
	argv []string
	// loaded is the long-lived context from OnLoaded, for the trust
	// question that outlives the session_start handler.
	long *sdk.Context
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
	for _, key := range []string{recipes.ActiveEnv, recipes.OriginEnv, recipes.StageEnv, recipes.SubagentChildEnv,
		recipes.PigLauncherEnv, recipes.PigHarnessEnv, "AI_AGENT"} {
		env[key] = os.Getenv(key)
	}
	// This extension always runs in a PiG cell (pig-host.ts isPigHost).
	env["AI_AGENT"] = "pig"
	if strings.TrimSpace(env[recipes.PigHarnessEnv]) == "" {
		env[recipes.PigHarnessEnv] = "pig"
	}
	return env
}

// refresh reloads the recipes for the session cwd. The caller holds r.mu.
func (r *recipeState) refresh(ctx sdk.Context) {
	cwd := ctx.Cwd()
	r.directoryTrust = ""
	if file := recipes.DirectoryPath(cwd); file != "" {
		r.directoryTrust = recipes.FileTrustForLaunch(file, trustStore(), r.argv)
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

// updateStatus is updateRecipeStatus: the aio:ui-state event, the frame
// pill while the frame is registered, else the footer status.
func (r *recipeState) updateStatus(ctx sdk.Context) {
	update := map[string]any{}
	if r.activeName != "" {
		update["recipe"] = r.activeName
	}
	_ = ctx.Events().Emit(frame.UIStateEvent, update)
	if !ctx.HasUI() {
		return
	}
	framed := frame.Probe().Supported
	if framed && r.activeName != "" {
		pill := &frame.Pill{Icon: "✦", Label: r.activeName, Role: "accent"}
		frame.SetMetadataContributor(recipeFrameKey, func() frame.Contribution { return frame.Contribution{Recipe: pill} })
		frame.RequestRepaint()
	} else {
		frame.SetMetadataContributor(recipeFrameKey, nil)
	}
	if framed || r.activeName == "" {
		ctx.ClearStatus(recipes.StatusKey)
		return
	}
	ctx.SetStatus(recipes.StatusKey, ctx.UITheme().Fg("accent", "✦ recipe:"+r.activeName))
}

const recipeFrameKey = "recipe"

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
func (r *recipeState) apply(ctx sdk.Context, def *recipes.Definition, source string, persist, live bool) (applied, warnings []string) {
	r.activeName, r.active, r.source = def.Name, def, source
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
		switch {
		case !live:
			applied = append(applied, "mode")
		case modesAccess == nil:
			warnings = append(warnings, fmt.Sprintf("permission mode \"%s\" not applied: permission modes are not loaded", c.PermissionMode))
		default:
			modesAccess.mu.Lock()
			if string(modesAccess.mode) != c.PermissionMode {
				modesAccess.setModeLocked(ctx, pm.Mode(c.PermissionMode))
			}
			modesAccess.mu.Unlock()
			applied = append(applied, "mode")
		}
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
	r.activeName, r.active, r.source = "", nil, ""
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
	text, level := recipes.ActivationText(def.Name, applied, warnings)
	ctx.Notify(text, level)
	if recipes.IsRestartScoped(def.Config) && !recipes.Bridged(recipeEnv(), def.Name) {
		how := "start pig through AIO's bin/aio-pig.mjs launcher"
		if os.Getenv(recipes.PigLauncherEnv) == "1" {
			how = fmt.Sprintf("restart with `pig --recipe \"%s\"`", def.Name)
		}
		ctx.Notify(fmt.Sprintf("\"%s\" also scopes the extension set and enabled models — %s to apply them", def.Name, how), "info")
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

	// A new or changed `.pi-recipe` the launch could not ask about: ask
	// through the session UI without blocking startup, or leave a one-line
	// hint where no UI exists. Once per process.
	if file := r.loaded.DirectoryFile; file != "" && r.directoryTrust == recipes.Unknown && reason == "startup" && !r.directoryAsked {
		r.directoryAsked = true
		if ctx.HasUI() {
			go r.askDirectoryTrust(file)
		} else {
			_, _ = os.Stderr.WriteString(recipes.TrustHint(file))
		}
	}

	// The factory's launch notice (decideRelaunch), shown once.
	if !r.launchChecked && reason == "startup" {
		r.launchChecked = true
		if note := r.launchNote(ctx); note != "" {
			ctx.Notify(note, "warning")
		}
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
		ctx.Notify(fmt.Sprintf("Unknown recipe \"%s\". Available: %s", selected.Name, recipes.AvailableNames(r.loaded)), "warning")
		return
	}
	// Pi reads an empty resolved scope as "all models". A scoped startup
	// (the actual CLI --models, launcher-injected included) whose scope
	// matches nothing must stop before any prompt reaches a provider.
	if requested := recipes.RequestedModels(r.argv); reason == "startup" && len(requested) > 0 {
		if scoped, err := ctx.ScopedModels(); err == nil && len(scoped) == 0 {
			r.deactivate(ctx, false)
			message := recipes.EmptyScopeMessage(def.Name, requested)
			ctx.Notify(message, "error")
			_, _ = os.Stderr.WriteString("recipes: " + message + "\n")
			exitWithCode(ctx, 1)
			return
		}
	}
	source := selected.Source
	if source == "" {
		source = "session"
	}
	applied, warnings := r.apply(ctx, def, source, source != "session", false)
	r.notifyActivation(ctx, def, applied, warnings)
}

// exitWithCode is the startup exit of index.ts (process.exit(1) before any
// prompt). A pig whose SDK has Context.ShutdownWithCode (PiG divergence
// D236) stops with that status in every mode; an older pig gets
// ctx.Shutdown(), which print and JSON mode ignore (see PIG-LIMITS.md).
func exitWithCode(ctx sdk.Context, code int) {
	if exiter, ok := any(ctx).(interface{ ShutdownWithCode(int) error }); ok {
		if exiter.ShutdownWithCode(code) == nil {
			return
		}
	}
	ctx.Shutdown()
}

// launchNote is the factory's decideRelaunch inside pig: the launch-time
// recipes (global, plus a `.pi-recipe` trusted for this launch; project
// trust is not resolved at factory time), and the branch recipe of a session
// opened with --continue/--session/--session-id. The caller holds r.mu.
func (r *recipeState) launchNote(ctx sdk.Context) string {
	cwd := ctx.Cwd()
	directoryTrusted := false
	if file := recipes.DirectoryPath(cwd); file != "" {
		directoryTrusted = recipes.FileTrustForLaunch(file, trustStore(), r.argv) == recipes.Trusted
	}
	launch := recipes.Load(recipePaths(), cwd, false, directoryTrusted)
	in := recipes.LaunchInput{Argv: r.argv, Env: recipeEnv(), Recipes: launch.Recipes}
	if launch.DefaultSource == "directory" {
		in.DirectoryRecipe = launch.DefaultRecipe
	}
	if recipes.ContinuedSession(r.argv, in.Env) {
		if name, _ := recipes.LatestPersisted(branchEntries(ctx)); name != "" {
			if file, _ := ctx.SessionManager().GetSessionFile(); file != nil {
				in.Continued = &recipes.Continued{Name: name, File: *file}
			}
		}
	}
	return recipes.LaunchNote(in)
}

// askDirectoryTrust is index.ts askDirectoryTrust on the long-lived
// context: the select runs after session_start returned.
func (r *recipeState) askDirectoryTrust(file string) {
	defer func() { _ = recover() }() // a replaced session makes the context stale
	if r.long == nil {
		return
	}
	ctx := *r.long
	choice, err := recipes.AskDirectoryTrust(trustUI{ctx}, file, trustStore())
	if err != nil {
		ctx.Notify("recipes: trust prompt failed: "+err.Error(), "warning")
		return
	}
	if choice == "skip" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refresh(ctx)
	if choice == "trust" {
		r.activateDirectoryDefault(ctx, filepath.Base(file))
	}
}

// trustUI adapts sdk.Context to recipes.TrustHost.
type trustUI struct{ ctx sdk.Context }

func (u trustUI) HasUI() bool { return u.ctx.HasUI() }
func (u trustUI) Select(title string, options []string) (string, bool) {
	return ctxUI{u.ctx}.Select(title, options)
}
func (u trustUI) Stderr(text string) { _, _ = os.Stderr.WriteString(text) }

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
	r.apply(ctx, def, "session", false, false)
}

// activateDirectoryDefault starts a just-trusted `.pi-recipe` default. The caller holds r.mu.
func (r *recipeState) activateDirectoryDefault(ctx sdk.Context, fileName string) {
	def, note := recipes.DirectoryDefault(r.loaded, r.activeName, fileName)
	if def == nil {
		ctx.Notify(note, "info")
		return
	}
	applied, warnings := r.apply(ctx, def, "directory", true, true)
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
	if r.directoryTrust != recipes.Trusted {
		ctx.Notify("Trusted "+filepath.Base(file)+", but --no-approve skips it for this run; it applies on the next start", "warning")
		return
	}
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
		ctx.Notify(fmt.Sprintf("Unknown recipe \"%s\". Available: %s", name, recipes.AvailableNames(r.loaded)), "error")
		return
	}
	applied, warnings := r.apply(ctx, def, "command", true, true)
	r.notifyActivation(ctx, def, applied, warnings)
}

const recipeOffNote = "Recipe: off — MCP servers cleared; model keeps its current state"

func (r *recipeState) command(ctx sdk.Context, args string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refresh(ctx)
	requested := strings.TrimSpace(args)
	// Like the subcommands below, a recipe literally named one keeps switching.
	if r.loaded.Recipes[requested] == nil {
		switch {
		case requested == "status" || requested == "status --json":
			r.showStatus(ctx, strings.HasSuffix(requested, "--json"))
			return nil
		case requested == "init" || strings.HasPrefix(requested, "init "):
			recipes.Init(initHost{ctx: ctx, r: r}, recipePaths(), trustStore(), requested[len("init"):])
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

var initFromRe = regexp.MustCompile(`^(init\b.*--from\s+)(\S*)$`)

func (r *recipeState) completions(prefix string) ([]sdk.AutocompleteItem, error) {
	// `init [name] --from <home recipe>`: complete the template name.
	if m := initFromRe.FindStringSubmatch(strings.TrimLeft(prefix, " \t")); m != nil {
		home := recipes.Load(recipePaths(), "", false, false).Recipes
		names := make([]string, 0, len(home))
		for name := range home {
			if strings.HasPrefix(name, m[2]) {
				names = append(names, name)
			}
		}
		names, _ = recipes.SelectionLabels(pick(home, names))
		var items []sdk.AutocompleteItem
		for _, name := range names {
			description := strings.TrimSpace(home[name].Config.Description)
			if description == "" {
				description = "home recipe template"
			}
			items = append(items, sdk.AutocompleteItem{Label: name, Value: m[1] + name, Description: description})
		}
		return items, nil
	}
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
		{"init", "create a .pi-recipe for this folder", file == ""},
		{"trust", "trust this folder's .pi-recipe and start its default", file != "" && r.directoryTrust != recipes.Trusted},
		{"untrust", "forget the .pi-recipe trust decision", file != "" && r.directoryTrust != recipes.Unknown},
	} {
		if sub.offered && strings.HasPrefix(sub.word, wanted) && r.loaded.Recipes[sub.word] == nil {
			items = append(items, sdk.AutocompleteItem{Value: sub.word, Label: sub.word, Description: sub.description})
		}
	}
	if strings.HasPrefix("status", wanted) && r.loaded.Recipes["status"] == nil {
		items = append(items, sdk.AutocompleteItem{Label: "status", Value: "status", Description: "inspect actual runtime (no model request)"})
	}
	if strings.HasPrefix(wanted, "status ") && strings.HasPrefix("status --json", wanted) {
		items = append(items, sdk.AutocompleteItem{Label: "status --json", Value: "status --json", Description: "runtime report as JSON"})
	}
	return items, nil
}

// pick is the subset of defs named in names.
func pick(defs map[string]*recipes.Definition, names []string) map[string]*recipes.Definition {
	out := make(map[string]*recipes.Definition, len(names))
	for _, name := range names {
		out[name] = defs[name]
	}
	return out
}

// initHost adapts sdk.Context to recipes.InitHost for /recipe init.
type initHost struct {
	ctx sdk.Context
	r   *recipeState
}

func (h initHost) Cwd() string                  { return h.ctx.Cwd() }
func (h initHost) HasUI() bool                  { return h.ctx.HasUI() }
func (h initHost) Notify(message, level string) { h.ctx.Notify(message, level) }
func (h initHost) Select(title string, options []string) (string, bool) {
	return ctxUI{h.ctx}.Select(title, options)
}
func (h initHost) Input(title, placeholder string) (string, bool) {
	value, ok, err := h.ctx.Input(title, placeholder)
	text, isString := value.(string)
	return text, err == nil && ok && isString
}
func (h initHost) Model() string {
	if h.ctx.Model() == "" || h.ctx.ModelProvider() == "" {
		return ""
	}
	return h.ctx.ModelProvider() + "/" + h.ctx.Model()
}
func (h initHost) ThinkingLevel() string {
	level, _ := h.ctx.GetThinkingLevel()
	return level
}

// Refresh runs while /recipe holds r.mu.
func (h initHost) Refresh() { h.r.refresh(h.ctx) }

// statusHost adapts sdk.Context to recipes.StatusHost.
type statusHost struct{ ctx sdk.Context }

func (h statusHost) Mode() string                            { return h.ctx.Mode() }
func (h statusHost) AppendEntry(customType string, data any) { _ = h.ctx.AppendEntry(customType, data) }
func (h statusHost) Notify(message, level string)            { h.ctx.Notify(message, level) }
func (h statusHost) Stderr(text string)                      { _, _ = os.Stderr.WriteString(text) }

// statusReport is buildRecipeStatus: host reads only — no provider request,
// no authentication refresh. The caller holds r.mu.
func (r *recipeState) statusReport(ctx sdk.Context) recipes.StatusReport {
	in := recipes.StatusInput{
		CapturedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		ActiveName: r.activeName, Active: r.active, Selection: r.source,
		Argv: r.argv, Env: map[string]string{recipes.ActiveEnv: os.Getenv(recipes.ActiveEnv), recipes.StageEnv: os.Getenv(recipes.StageEnv)},
	}
	if r.active != nil && r.active.Config.Model != "" {
		model, _ := recipes.ParseModelSpec(r.active.Config.Model)
		in.ExpectedModel = findModel(ctx, model)
	}
	registry := ctx.ModelRegistry()
	if provider, id := ctx.ModelProvider(), ctx.Model(); id != "" {
		in.Model = provider + "/" + id
		if model, err := registry.Find(provider, id); err == nil && model != nil {
			in.API, _ = model["api"].(string)
		}
	}
	in.Thinking, _ = ctx.GetThinkingLevel()
	if scoped, err := ctx.ScopedModels(); err == nil {
		for _, entry := range scoped {
			provider, _ := entry.Model["provider"].(string)
			id, _ := entry.Model["id"].(string)
			in.Scoped = append(in.Scoped, provider+"/"+id)
		}
	}
	in.ActiveTools, _ = ctx.GetActiveTools()
	if commands, err := ctx.GetCommands(); err == nil {
		for _, command := range commands {
			in.Commands = append(in.Commands, recipes.Registration{Name: command.Name, Extension: command.Source == "extension",
				Path: command.SourceInfo.Path, Source: command.SourceInfo.Source})
		}
	}
	if tools, err := ctx.GetAllTools(); err == nil {
		for _, tool := range tools {
			in.Tools = append(in.Tools, recipes.Registration{Name: tool.Name, Path: tool.SourceInfo.Path, Source: tool.SourceInfo.Source})
		}
	}
	if providers, err := registry.GetRegisteredProviderIDs(); err == nil {
		in.Providers = &providers
	}
	if modesAccess != nil {
		modesAccess.mu.Lock()
		mode := string(modesAccess.mode)
		modesAccess.mu.Unlock()
		in.PermissionMode = &mode
	}
	if stylesAccess != nil {
		stylesAccess.mu.Lock()
		style := stylesAccess.current
		stylesAccess.mu.Unlock()
		in.Style = &style
	}
	return recipes.BuildStatus(in)
}

// showStatus is showRecipeStatus. The caller holds r.mu.
func (r *recipeState) showStatus(ctx sdk.Context, json bool) {
	recipes.ShowStatus(statusHost{ctx}, r.statusReport(ctx), json)
}

// statusRenderer is registerRecipeStatusRenderer's renderer: the
// width-safe shared-chrome view of the persisted report.
func statusRenderer(ctx sdk.Context, entry map[string]any, options sdk.EntryRenderOptions, width int) ([]string, error) {
	raw, err := json.Marshal(entry["data"])
	if err != nil {
		return nil, nil
	}
	var report recipes.StatusReport
	if json.Unmarshal(raw, &report) != nil || report.Version != 1 {
		return nil, nil
	}
	return recipes.StatusRows(report, ctx.UITheme(), width, options.Expanded), nil
}

func registerRecipes(e *sdk.Extension) {
	e.Flag(recipes.Flag, sdk.FlagOptions{
		Description: "Start with a named recipe from aio-recipes.json (extensions, model scope, MCP)",
		Type:        sdk.FlagString,
	})
	// The status report renders in every process, subagent children included.
	e.EntryRenderer(recipes.StatusEntry, statusRenderer)
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
	argv, _ := piargs.HarnessArgv()
	r := &recipeState{registeredMcp: map[string]bool{}, warned: map[string]bool{}, argv: argv}
	// The aio-pig launcher already asked the terminal trust question.
	if os.Getenv(recipes.PigTrustAskedEnv) == "1" {
		r.directoryAsked = true
	}
	e.OnLoaded(func(ctx sdk.Context) { r.long = &ctx })
	e.OnSessionStart(func(ctx sdk.Context, data map[string]any) (any, error) {
		reason, _ := data["reason"].(string)
		r.sessionStart(ctx, reason)
		return nil, nil
	})
	e.OnEvent("session_tree", func(ctx sdk.Context, _ map[string]any) (any, error) {
		r.restoreFromBranch(ctx)
		return nil, nil
	})
	e.OnSessionShutdown(func(sdk.Context, map[string]any) (any, error) {
		frame.SetMetadataContributor(recipeFrameKey, nil)
		return nil, nil
	})
	e.RegisterCommand("recipe", sdk.CommandOptions{
		Description:            "Show, switch, or clear the active launch recipe (aio-recipes.json); init/trust/untrust manage this folder's .pi-recipe",
		GetArgumentCompletions: r.completions,
		Handler:                r.command,
	})
	// The dedicated spelling stays available when a recipe is named "status".
	e.RegisterCommand("recipe-status", sdk.CommandOptions{
		Description: "Inspect actual recipe runtime, model scope, tools, and registration sources (no model request)",
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			if strings.HasPrefix("--json", strings.TrimSpace(prefix)) {
				return []sdk.AutocompleteItem{{Label: "--json", Value: "--json", Description: "runtime report as JSON"}}, nil
			}
			return nil, nil
		},
		Handler: func(ctx sdk.Context, args string) error {
			value := strings.TrimSpace(args)
			if value != "" && value != "--json" {
				ctx.Notify(recipes.StatusUsage, "error")
				return nil
			}
			r.mu.Lock()
			defer r.mu.Unlock()
			r.showStatus(ctx, value == "--json")
			return nil
		},
	})
}
