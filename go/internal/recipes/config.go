// Package recipes is the Go port of the in-session part of recipes/:
// config loading (global, project, and `.pi-recipe` tiers), the trust store,
// recipe selection at session start, and the pure helpers. The launch bridge
// (relaunch with extensions and model scope) stays in the Node launcher
// bin/aio-pig.mjs, which runs before pig starts. This package does not import
// the PiG SDK; go/aio applies a recipe to the host.
package recipes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/blocklist"
)

// Names shared with the TypeScript version (env vars, files, entries).
const (
	FileName         = "aio-recipes.json"
	FileEnv          = "AIO_RECIPES_FILE"
	ActiveEnv        = "AIO_RECIPE_ACTIVE"
	StageEnv         = "AIO_RECIPE_STAGE"
	OriginEnv        = "AIO_RECIPE_ORIGIN"
	Flag             = "recipe"
	StateEntry       = "recipe-state"
	ContextType      = "recipe-context"
	StatusKey        = "recipe"
	PigLauncherEnv   = "AIO_PIG_LAUNCHER"
	PigTrustAskedEnv = "AIO_PIG_TRUST_ASKED"
)

// ThinkingLevels are the valid thinking levels, in order.
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// DirectoryFileNames are checked in this order in the cwd only.
var DirectoryFileNames = []string{".pi-recipe", ".pi-recipe.json"}

// PermissionModes are the values a recipe's permissionMode accepts.
var PermissionModes = []string{"default", "ask", "plan", "auto"}

// Styles are the values a recipe's style accepts (after legacy mapping).
var Styles = []string{"none", "collaborate", "tutor", "concise", "ste"}

// Config is one parsed recipe.
type Config struct {
	Description    string                    `json:"description,omitempty"`
	Model          string                    `json:"model,omitempty"`
	ThinkingLevel  string                    `json:"thinkingLevel,omitempty"`
	Models         []string                  `json:"models,omitempty"`
	McpServers     map[string]map[string]any `json:"mcpServers"`
	Extensions     []string                  `json:"extensions,omitempty"`
	Blocklist      []blocklist.Entry         `json:"-"`
	PermissionMode string                    `json:"permissionMode,omitempty"`
	Style          string                    `json:"style,omitempty"`
}

// Definition is a recipe with its provenance.
type Definition struct {
	Name    string `json:"name"`
	Source  string `json:"source"` // "global", "project", or "directory"
	BaseDir string `json:"baseDir"`
	Config  Config `json:"config"`
}

// Loaded is the effective recipe set for a cwd.
type Loaded struct {
	Recipes       map[string]*Definition
	DefaultRecipe string
	DefaultSource string
	DirectoryFile string
	// Warnings are read errors and ignored defaults, for one notification.
	Warnings []string
}

// Paths locate the tiers.
type Paths struct {
	AgentDir      string
	ConfigDirName string // ".pi" or ".pig"
}

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.Trim(s, jsSpace) }

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// GlobalPath is AIO_RECIPES_FILE, else <agentDir>/aio-recipes.json.
func GlobalPath(paths Paths) string {
	if override := jsTrim(os.Getenv(FileEnv)); override != "" {
		return override
	}
	if paths.AgentDir == "" {
		return ""
	}
	return filepath.Join(paths.AgentDir, FileName)
}

// ProjectPath is <cwd>/<configDir>/aio-recipes.json.
func ProjectPath(paths Paths, cwd string) string {
	return filepath.Join(cwd, paths.ConfigDirName, FileName)
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// DirectoryPath is the cwd's `.pi-recipe`, else `.pi-recipe.json`, else "".
func DirectoryPath(cwd string) string {
	for _, name := range DirectoryFileNames {
		if path := filepath.Join(cwd, name); isFile(path) {
			return path
		}
	}
	return ""
}

func parseThinkingLevel(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	level := strings.ToLower(jsTrim(s))
	if contains(ThinkingLevels, level) {
		return level
	}
	return ""
}

func parseStringList(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range list {
		if s, ok := item.(string); ok && jsTrim(s) != "" {
			out = append(out, jsTrim(s))
		}
	}
	return out
}

// ParsePermissionMode accepts the four modes, trimmed and in any case.
func ParsePermissionMode(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	if mode := strings.ToLower(jsTrim(s)); contains(PermissionModes, mode) {
		return mode
	}
	return ""
}

// ParseStyle accepts the styles plus `off`, `mentor`, and `humanised`.
func ParseStyle(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	switch style := strings.ToLower(jsTrim(s)); style {
	case "off":
		return "none"
	case "mentor":
		return "tutor"
	case "humanised":
		return "ste"
	default:
		if contains(Styles, style) {
			return style
		}
	}
	return ""
}

// ParseRecipe parses one `recipes.<name>` entry. Unknown keys are dropped
// and malformed values count as absent. A non-object entry is ok=false.
func ParseRecipe(name, source, baseDir string, raw any) (*Definition, bool) {
	entry, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	c := Config{McpServers: map[string]map[string]any{}}
	if s, ok := entry["description"].(string); ok && jsTrim(s) != "" {
		c.Description = jsTrim(s)
	}
	if s, ok := entry["model"].(string); ok && jsTrim(s) != "" {
		c.Model = jsTrim(s)
	}
	c.ThinkingLevel = parseThinkingLevel(entry["thinkingLevel"])
	c.Models = parseStringList(entry["models"])
	if servers, ok := entry["mcpServers"].(map[string]any); ok {
		for serverName, config := range servers {
			if jsTrim(serverName) == "" {
				continue
			}
			if m, ok := config.(map[string]any); ok {
				c.McpServers[serverName] = m
			}
		}
	}
	c.Extensions = parseStringList(entry["extensions"])
	if raw, present := entry["blocklist"]; present {
		if parsed := blocklist.ParseConfig(raw); parsed.Enabled && len(parsed.Entries) > 0 {
			c.Blocklist = parsed.Entries
		}
	}
	mode, present := entry["permissionMode"]
	if !present || mode == nil {
		mode = entry["mode"]
	}
	c.PermissionMode = ParsePermissionMode(mode)
	c.Style = ParseStyle(entry["style"])
	return &Definition{Name: name, Source: source, BaseDir: baseDir, Config: c}, true
}

// ParseModelSpec splits a trailing `:thinking` level from a model spec.
// Only a last-colon suffix that is a known level counts.
func ParseModelSpec(spec string) (model, thinking string) {
	if colon := strings.LastIndex(spec, ":"); colon > 0 {
		suffix := strings.ToLower(jsTrim(spec[colon+1:]))
		if contains(ThinkingLevels, suffix) {
			return jsTrim(spec[:colon]), suffix
		}
	}
	return jsTrim(spec), ""
}

// IsRestartScoped reports whether a recipe has extensions or a model scope.
func IsRestartScoped(c Config) bool { return len(c.Models) > 0 || len(c.Extensions) > 0 }

type rawFile struct {
	recipes       map[string]any
	defaultRecipe any
	ok            bool
}

func readFile(path string, warnings *[]string, source string) rawFile {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			*warnings = append(*warnings, "could not read "+source+" recipes from "+path+": "+err.Error())
		}
		return rawFile{}
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		*warnings = append(*warnings, "could not read "+source+" recipes from "+path+": "+err.Error())
		return rawFile{}
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return rawFile{}
	}
	recipes, _ := obj["recipes"].(map[string]any)
	if list, isList := obj["recipes"].([]any); isList {
		// JavaScript's Object.entries on an array keys the items "0", "1", ...
		recipes = make(map[string]any, len(list))
		for i, item := range list {
			recipes[strconv.Itoa(i)] = item
		}
	}
	return rawFile{recipes: recipes, defaultRecipe: obj["defaultRecipe"], ok: true}
}

func collect(file rawFile, source, baseDir string) map[string]*Definition {
	out := map[string]*Definition{}
	for name, entry := range file.recipes {
		if def, ok := ParseRecipe(name, source, baseDir, entry); ok {
			out[name] = def
		}
	}
	return out
}

func defaultOf(file rawFile) string {
	s, ok := file.defaultRecipe.(string)
	if !ok {
		return ""
	}
	return jsTrim(s)
}

// Load reads the effective recipes for cwd. Override order is global <
// project < directory, for recipes and the default. The project file is read
// only when projectTrusted, and the directory file only when directoryTrusted.
// A directory default must be defined in that file.
func Load(paths Paths, cwd string, projectTrusted, directoryTrusted bool) Loaded {
	l := Loaded{Recipes: map[string]*Definition{}}
	globalPath := GlobalPath(paths)
	var global rawFile
	if globalPath != "" {
		baseDir := paths.AgentDir
		if jsTrim(os.Getenv(FileEnv)) != "" {
			baseDir = filepath.Dir(globalPath)
		}
		global = readFile(globalPath, &l.Warnings, "global")
		for name, def := range collect(global, "global", baseDir) {
			l.Recipes[name] = def
		}
	}
	var project rawFile
	if cwd != "" && projectTrusted {
		project = readFile(ProjectPath(paths, cwd), &l.Warnings, "project")
		for name, def := range collect(project, "project", filepath.Join(cwd, paths.ConfigDirName)) {
			l.Recipes[name] = def
		}
	}
	if cwd != "" {
		l.DirectoryFile = DirectoryPath(cwd)
	}
	var directory rawFile
	directoryRecipes := map[string]*Definition{}
	if l.DirectoryFile != "" && directoryTrusted {
		directory = readFile(l.DirectoryFile, &l.Warnings, "directory")
		directoryRecipes = collect(directory, "directory", cwd)
		for name, def := range directoryRecipes {
			l.Recipes[name] = def
		}
	}
	if name := defaultOf(global); name != "" {
		l.DefaultRecipe, l.DefaultSource = name, "global"
	}
	if name := defaultOf(project); name != "" {
		l.DefaultRecipe, l.DefaultSource = name, "project"
	}
	if name := defaultOf(directory); name != "" {
		if directoryRecipes[name] != nil {
			l.DefaultRecipe, l.DefaultSource = name, "directory"
		} else {
			l.Warnings = append(l.Warnings, l.DirectoryFile+`: defaultRecipe "`+name+`" must be defined in that file's "recipes"; ignoring it`)
		}
	}
	if l.DefaultRecipe != "" && l.Recipes[l.DefaultRecipe] == nil {
		l.DefaultRecipe, l.DefaultSource = "", ""
	}
	return l
}

// Names returns the recipe names in sorted order.
func (l Loaded) Names() []string {
	names := make([]string, 0, len(l.Recipes))
	for name := range l.Recipes {
		names = append(names, name)
	}
	sortLikeLocale(names)
	return names
}
