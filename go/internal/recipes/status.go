package recipes

// `/recipe status` and `/recipe-status` (port of recipes/status.ts): an
// allowlisted runtime snapshot built from host reads only — no provider
// request, no authentication refresh, no configuration write.

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
)

// StatusEntry is the custom entry type; custom entries never enter model
// context or start a model call.
const StatusEntry = "recipe-status-report"

// ObservedSource is ObservedExtensionSource.
type ObservedSource struct {
	Path     string   `json:"path"`
	Source   string   `json:"source"`
	Commands []string `json:"commands"`
	Tools    []string `json:"tools"`
}

// StatusConfigured is the recipe's configured values (null when absent).
type StatusConfigured struct {
	Model          *string  `json:"model"`
	Thinking       *string  `json:"thinking"`
	Models         []string `json:"models"`
	Extensions     []string `json:"extensions"`
	PermissionMode *string  `json:"permissionMode"`
	Style          *string  `json:"style"`
}

// StatusRuntime is what the session actually runs.
type StatusRuntime struct {
	Model               *string   `json:"model"`
	API                 *string   `json:"api"`
	Thinking            string    `json:"thinking"`
	ModelMatchesRecipe  *bool     `json:"modelMatchesRecipe"`
	ScopeMode           string    `json:"scopeMode"`
	ScopedModels        []string  `json:"scopedModels"`
	ActiveTools         []string  `json:"activeTools"`
	RegisteredProviders *[]string `json:"registeredProviders"`
	PermissionMode      *string   `json:"permissionMode"`
	Style               *string   `json:"style"`
}

// StatusLaunch is how this process was launched.
type StatusLaunch struct {
	Recipe          *string   `json:"recipe"`
	Bridged         bool      `json:"bridged"`
	ExtensionPolicy string    `json:"extensionPolicy"`
	Extensions      []string  `json:"extensions"`
	Models          *[]string `json:"models"`
}

// StatusReport is RecipeStatusReport (version 1). Field order is the
// TypeScript key order.
type StatusReport struct {
	Version                  int              `json:"version"`
	CapturedAt               string           `json:"capturedAt"`
	Recipe                   *string          `json:"recipe"`
	Selection                *string          `json:"selection"`
	ConfigSource             *string          `json:"configSource"`
	Configured               StatusConfigured `json:"configured"`
	Runtime                  StatusRuntime    `json:"runtime"`
	Launch                   StatusLaunch     `json:"launch"`
	ObservedExtensionSources []ObservedSource `json:"observedExtensionSources"`
	Notes                    []string         `json:"notes"`
}

var (
	controlRe  = regexp.MustCompile(`[\x00-\x1f\x7f-\x{9f}]`)
	gitPrefix  = regexp.MustCompile(`(?i)^git:`)
	gitAtStart = regexp.MustCompile(`(?i)^git@`)
	queryRe    = regexp.MustCompile(`[?#][^\n\r\x{2028}\x{2029}]*$`)
)

// SafeText is safeText: control characters become spaces, and URL or Git
// shorthand userinfo and any query or fragment are redacted.
func SafeText(value string) string {
	text := controlRe.ReplaceAllString(value, " ")
	authorityStart := -1
	if scheme := strings.Index(text, "://"); scheme >= 0 {
		authorityStart = scheme + 3
	} else if gitPrefix.MatchString(text) {
		authorityStart = 4
	} else if gitAtStart.MatchString(text) {
		authorityStart = 0
	}
	if authorityStart >= 0 {
		suffix := text[authorityStart:]
		end := len(text)
		if boundary := strings.IndexAny(suffix, "/?#"); boundary >= 0 {
			end = authorityStart + boundary
		}
		// Remove ALL userinfo up to the final @ in the authority.
		if at := strings.LastIndex(text[:end], "@"); at >= authorityStart {
			text = text[:authorityStart] + "[redacted]@" + text[at+1:]
		}
		text = queryRe.ReplaceAllString(text, "?[redacted]")
	}
	return text
}

// Registration is one command or tool with its source info.
type Registration struct {
	Name string
	// Extension is false for a command that is a prompt or skill.
	Extension bool
	// Path and Source come from the SourceInfo; Path "" means none.
	Path, Source string
}

// StatusInput is everything buildRecipeStatus reads.
type StatusInput struct {
	CapturedAt string
	// Active is the active recipe (nil when off); Selection how it was chosen.
	ActiveName string
	Active     *Definition
	Selection  string
	Argv       []string
	Env        map[string]string // ActiveEnv and StageEnv
	// ExpectedModel is findRecipeModel's "provider/id" for the recipe's model, or "".
	ExpectedModel string
	Model, API    string // "" when none
	Thinking      string
	Scoped        []string
	ActiveTools   []string
	Commands      []Registration
	Tools         []Registration
	// Providers is nil when the registry cannot list them.
	Providers      *[]string
	PermissionMode *string
	Style          *string
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func safeList(items []string) []string {
	if items == nil {
		return nil
	}
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = SafeText(item)
	}
	return out
}

// BuildStatus is buildRecipeStatus.
func BuildStatus(in StatusInput) StatusReport {
	def := in.Active
	parsed := piargs.Parse(in.Argv)
	var requestedModel, requestedThinking string
	if def != nil && def.Config.Model != "" {
		requestedModel, requestedThinking = ParseModelSpec(def.Config.Model)
	}
	expected := ""
	if requestedModel != "" {
		expected = in.ExpectedModel
	}
	flagName := ""
	for _, flag := range parsed.UnknownFlags {
		if flag.Name == Flag {
			if s, ok := flag.Value.(string); ok {
				flagName = jsTrim(s)
			} else {
				flagName = ""
			}
		}
	}

	sources := map[string]*ObservedSource{}
	var order []string
	observe := func(r Registration, tools bool) {
		if r.Path == "" || strings.HasPrefix(r.Path, "builtin:") {
			return
		}
		path := SafeText(r.Path)
		source := sources[path]
		if source == nil {
			source = &ObservedSource{Path: path, Source: SafeText(r.Source), Commands: []string{}, Tools: []string{}}
			sources[path] = source
			order = append(order, path)
		}
		list := &source.Commands
		if tools {
			list = &source.Tools
		}
		if !contains(*list, r.Name) {
			*list = append(*list, r.Name)
		}
	}
	for _, command := range in.Commands {
		if command.Extension {
			observe(command, false)
		}
	}
	for _, tool := range in.Tools {
		observe(tool, true)
	}

	notes := []string{
		"Observed sources come from actual tool/command registrations; passive or provider-only extensions may be absent. This is not a complete loaded-extension inventory.",
		"pi list and package-update banners describe saved packages, not this runtime's extension selection.",
		"No provider request or authentication refresh was performed.",
		"Active tools are declarations to the model; registered deferred/codemode tools may remain callable through other tools. Provider IDs are not an extension inventory.",
	}
	launchRecipe := flagName
	if launchRecipe == "" {
		launchRecipe = jsTrim(in.Env[ActiveEnv])
	}
	if in.ActiveName != "" && launchRecipe != in.ActiveName && def != nil && (def.Config.Models != nil || def.Config.Extensions != nil) {
		notes = append(notes, "The active recipe differs from the launch recipe; restart to apply its extension set and model scope.")
	}
	if requestedModel != "" && expected != "" && in.Model != expected {
		notes = append(notes, "The runtime model differs from the recipe's configured model (it may have been changed in-session).")
	}
	if def != nil && len(def.Config.Models) > 0 && len(in.Scoped) == 0 {
		notes = append(notes, "The recipe declares a model scope, but the current runtime is unscoped (all available models).")
	}

	report := StatusReport{
		Version: 1, CapturedAt: in.CapturedAt,
		Recipe: strPtr(in.ActiveName), Selection: strPtr(in.Selection),
		Notes: notes, ObservedExtensionSources: []ObservedSource{},
	}
	if def != nil {
		source := def.Source + ": " + SafeText(def.BaseDir)
		report.ConfigSource = &source
		c := def.Config
		thinking := c.ThinkingLevel
		if thinking == "" {
			thinking = requestedThinking
		}
		report.Configured = StatusConfigured{
			Model: strPtr(c.Model), Thinking: strPtr(thinking),
			Models: append([]string(nil), c.Models...), Extensions: safeList(c.Extensions),
			PermissionMode: strPtr(c.PermissionMode), Style: strPtr(c.Style),
		}
	}
	runtime := StatusRuntime{
		Model: strPtr(in.Model), API: strPtr(in.API), Thinking: in.Thinking,
		ScopeMode: "all", ScopedModels: append([]string{}, in.Scoped...), ActiveTools: append([]string{}, in.ActiveTools...),
		PermissionMode: in.PermissionMode, Style: in.Style,
	}
	if expected != "" {
		matches := in.Model == expected
		runtime.ModelMatchesRecipe = &matches
	}
	if len(in.Scoped) > 0 {
		runtime.ScopeMode = "scoped"
	}
	if in.Providers != nil {
		providers := safeList(*in.Providers)
		if providers == nil {
			providers = []string{}
		}
		runtime.RegisteredProviders = &providers
	}
	report.Runtime = runtime
	launch := StatusLaunch{
		Recipe: strPtr(launchRecipe), Bridged: in.Env[StageEnv] == "1",
		ExtensionPolicy: "configured-plus-explicit", Extensions: []string{},
	}
	if parsed.NoExtensions {
		launch.ExtensionPolicy = "explicit-only"
	}
	if parsed.Extensions != nil {
		launch.Extensions = safeList(parsed.Extensions)
	}
	if parsed.Models != nil {
		models := append([]string{}, parsed.Models...)
		launch.Models = &models
	}
	report.Launch = launch
	sortLocalePaths(order)
	for _, path := range order {
		report.ObservedExtensionSources = append(report.ObservedExtensionSources, *sources[path])
	}
	return report
}

// sortLocalePaths approximates localeCompare for source paths.
func sortLocalePaths(paths []string) { sortLikeLocale(paths) }

func orText(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func joinOr(items []string, fallback string) string {
	if items == nil {
		return fallback
	}
	return strings.Join(items, ", ")
}

// FormatStatus is formatRecipeStatus; full lists the declared tools.
func FormatStatus(r StatusReport, full bool) string {
	scope := "ALL available models"
	if r.Runtime.ScopeMode != "all" {
		scope = strconv.Itoa(len(r.Runtime.ScopedModels)) + " model(s)"
	}
	matches := "unverified"
	if r.Runtime.ModelMatchesRecipe != nil {
		matches = strconv.FormatBool(*r.Runtime.ModelMatchesRecipe)
	}
	launchModels := "not supplied"
	if r.Launch.Models != nil {
		launchModels = strings.Join(*r.Launch.Models, ", ")
	}
	bridged := ""
	if r.Launch.Bridged {
		bridged = " (recipe relaunch)"
	}
	lines := []string{
		"Snapshot: " + r.CapturedAt,
		"Recipe: " + orText(r.Recipe, "off") + " (selected by " + orText(r.Selection, "none") + ")",
		"Config source: " + orText(r.ConfigSource, "none"),
		"Model — runtime: " + orText(r.Runtime.Model, "none"),
		"API — runtime: " + orText(r.Runtime.API, "none"),
		"Thinking — runtime: " + r.Runtime.Thinking,
		"Model — configured: " + orText(r.Configured.Model, "inherited"),
		"Model matches recipe: " + matches,
		"Thinking — configured: " + orText(r.Configured.Thinking, "inherited"),
		"Scope — runtime: " + scope,
	}
	for _, model := range r.Runtime.ScopedModels {
		lines = append(lines, "  "+model)
	}
	lines = append(lines,
		"Scope — configured patterns: "+joinOr(r.Configured.Models, "inherited"),
		"Scope — launch CLI: "+launchModels,
		"Extensions — launch policy: "+r.Launch.ExtensionPolicy+bridged,
	)
	for _, source := range r.Launch.Extensions {
		lines = append(lines, "  "+source)
	}
	lines = append(lines,
		"Extensions — configured: "+joinOr(r.Configured.Extensions, "inherited"),
		"Permission mode — runtime: "+orText(r.Runtime.PermissionMode, "unavailable")+"; configured: "+orText(r.Configured.PermissionMode, "inherited"),
		"Style — runtime: "+orText(r.Runtime.Style, "unavailable")+"; configured: "+orText(r.Configured.Style, "inherited"),
		"Observed extension sources (runtime registrations):",
	)
	for _, source := range r.ObservedExtensionSources {
		lines = append(lines, "  "+source.Source+" — "+source.Path)
		lines = append(lines, "    "+strconv.Itoa(len(source.Commands))+" commands, "+strconv.Itoa(len(source.Tools))+" tools registered")
	}
	if len(r.ObservedExtensionSources) == 0 {
		lines = append(lines, "  No source metadata available.")
	}
	providers := "unavailable"
	if r.Runtime.RegisteredProviders != nil {
		providers = strings.Join(*r.Runtime.RegisteredProviders, ", ")
		if providers == "" {
			providers = "none"
		}
	}
	lines = append(lines, "Registered provider IDs: "+providers)
	lines = append(lines, "Tools declared to model: "+strconv.Itoa(len(r.Runtime.ActiveTools)))
	if full {
		tools := strings.Join(r.Runtime.ActiveTools, ", ")
		if tools == "" {
			tools = "none"
		}
		lines = append(lines, "  "+tools)
	}
	for _, note := range r.Notes {
		lines = append(lines, "Note: "+note)
	}
	for i, line := range lines {
		lines[i] = SafeText(line)
	}
	return strings.Join(lines, "\n")
}

// StatusRows is renderRecipeStatusRows: the width-safe shared-chrome view.
func StatusRows(r StatusReport, t chrome.Theme, width int, expanded bool) []string {
	if width <= 0 {
		return []string{}
	}
	rows := []string{chrome.FrameRule(t, width, "top", "RECIPE STATUS")}
	for _, line := range strings.Split(FormatStatus(r, expanded), "\n") {
		for _, wrapped := range chrome.Wrap(line, max(1, width-4)) {
			rows = append(rows, chrome.FrameRow(t, wrapped, width))
		}
	}
	return append(rows, chrome.FrameRule(t, width, "bottom", ""))
}

// StatusJSON is JSON.stringify(report, null, 2).
func StatusJSON(r StatusReport, indent string) string {
	data, err := json.Marshal(r)
	if err != nil {
		return "{}"
	}
	return jsstr.StringifyIndent(data, indent)
}
