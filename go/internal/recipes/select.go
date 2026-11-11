package recipes

import (
	"sort"
	"strings"
)

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sortLikeLocale(keys)
	return keys
}

// sortLikeLocale approximates localeCompare: case-insensitive first, then by bytes.
func sortLikeLocale(keys []string) {
	sort.Slice(keys, func(i, j int) bool {
		a, b := strings.ToLower(keys[i]), strings.ToLower(keys[j])
		if a != b {
			return a < b
		}
		return keys[i] < keys[j]
	})
}

// LatestPersisted scans the branch for the newest recipe-state entry. It
// returns the name ("" when the entry pins "off") and whether one exists.
func LatestPersisted(entries []map[string]any) (name string, present bool) {
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry["type"] != "custom" || entry["customType"] != StateEntry {
			continue
		}
		data, _ := entry["data"].(map[string]any)
		if s, ok := data["name"].(string); ok && jsTrim(s) != "" {
			return jsTrim(s), true
		}
		return "", true
	}
	return "", false
}

// FilterContext removes legacy recipe-context messages. It returns ok=false
// when nothing was removed.
func FilterContext(messages []any) ([]any, bool) {
	out := make([]any, 0, len(messages))
	for _, raw := range messages {
		if m, ok := raw.(map[string]any); ok && m["customType"] == ContextType {
			continue
		}
		out = append(out, raw)
	}
	return out, len(out) != len(messages)
}

// Selection inputs at session_start (port of the precedence in index.ts).
type Selection struct {
	Reason string // session_start reason: "startup", "new", "resume", ...
	// Flag is the --recipe value: a string, true for a bare flag, or nil.
	Flag any
	// Env holds ActiveEnv and OriginEnv.
	Env map[string]string
	// Persisted is the branch's newest recipe-state entry.
	PersistedName    string
	PersistedPresent bool
	Loaded           Loaded
}

// Selected is the result: the recipe name ("" for none) and how it was chosen.
type Selected struct {
	Name   string
	Source string // "flag", "env", "session", "directory", "default", or ""
	// BareFlag is set for `--recipe` with no value.
	BareFlag bool
}

// Select applies the precedence: flag > bridge env > session entry > startup
// default. A deliberate /resume ignores the launch flag and bridge env. /new
// re-applies only a trusted directory default.
func Select(in Selection) Selected {
	var out Selected
	if in.Reason != "resume" {
		switch flag := in.Flag.(type) {
		case string:
			if name := jsTrim(flag); name != "" {
				return Selected{Name: name, Source: "flag"}
			}
		case bool:
			out.BareFlag = flag
		}
	}
	envName := jsTrim(in.Env[ActiveEnv])
	origin := in.Env[OriginEnv]
	envIsDefault, envIsSession := origin == "directory", origin == "session"
	if in.Reason != "resume" && envName != "" && !envIsDefault && !envIsSession {
		out.Name, out.Source = envName, "env"
		return out
	}
	if in.PersistedPresent {
		out.Name, out.Source = in.PersistedName, "session"
		return out
	}
	newDirectoryDefault := in.Reason == "new" && in.Loaded.DefaultSource == "directory"
	if in.Reason == "startup" || newDirectoryDefault {
		if in.Reason == "startup" && envName != "" && envIsDefault {
			out.Name, out.Source = envName, "directory"
		} else if in.Loaded.DefaultRecipe != "" {
			out.Name = in.Loaded.DefaultRecipe
			out.Source = "default"
			if in.Loaded.DefaultSource == "directory" {
				out.Source = "directory"
			}
		}
	}
	return out
}

// Bridged reports whether the launcher (or a Pi relaunch) already applied
// this recipe's extension set and model scope.
func Bridged(env map[string]string, name string) bool {
	return env[StageEnv] == "1" && jsTrim(env[ActiveEnv]) == name
}

// SelectionLabels returns sorted names and their "name — description" labels.
func SelectionLabels(defs map[string]*Definition) (names, labels []string) {
	names = sortedKeys(defs)
	for _, name := range names {
		description := jsTrim(defs[name].Config.Description)
		if description == "" {
			labels = append(labels, name)
			continue
		}
		if runes := []rune(description); len(runes) > 42 {
			description = string(runes[:39]) + "..."
		}
		labels = append(labels, name+" — "+description)
	}
	return names, labels
}

// AvailableNames is the comma-separated sorted names, or "none configured".
func AvailableNames(l Loaded) string {
	if len(l.Recipes) == 0 {
		return "none configured"
	}
	return strings.Join(l.Names(), ", ")
}
