package difftools

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ToolNames is config.ts PI_DIFF_TOOL_NAMES.
var ToolNames = []string{"write", "edit", "apply_patch"}

// Config is the merged pi-diff.json (config.ts PiDiffJson). Values keep the
// JSON shapes; accessors read the keys the tools use.
type Config map[string]any

// ConfigPaths ports loadPiDiffConfig's search list, lowest priority first:
// <agentDir>/pi-diff.json, <cwd>/<configDir>/pi-diff.json, <cwd>/pi-diff.json.
func ConfigPaths(agentDir, configDirName, cwd string) []string {
	return []string{
		filepath.Join(agentDir, "pi-diff.json"),
		filepath.Join(cwd, configDirName, "pi-diff.json"),
		filepath.Join(cwd, "pi-diff.json"),
	}
}

// LoadConfig ports loadPiDiffConfig without the cache: later files win,
// `colors` merges per key, invalid files are skipped, and disabledTools
// keeps only known tool names.
func LoadConfig(paths []string) Config {
	seen := map[string]bool{}
	merged := Config{}
	for _, p := range paths {
		abs := p
		if !filepath.IsAbs(abs) {
			if wd, err := os.Getwd(); err == nil {
				abs = filepath.Join(wd, p)
			}
		}
		if seen[abs] {
			continue
		}
		seen[abs] = true
		data, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		var raw map[string]any
		if json.Unmarshal(data, &raw) != nil || raw == nil {
			continue
		}
		if list, ok := raw["disabledTools"].([]any); ok {
			kept := []any{}
			for _, item := range list {
				if name, ok := item.(string); ok && isToolName(name) {
					kept = append(kept, name)
				}
			}
			raw["disabledTools"] = kept
		} else {
			delete(raw, "disabledTools")
		}
		for key, value := range raw {
			if colors, ok := value.(map[string]any); ok && key == "colors" {
				base, _ := merged["colors"].(map[string]any)
				next := map[string]any{}
				for k, v := range base {
					next[k] = v
				}
				for k, v := range colors {
					next[k] = v
				}
				merged["colors"] = next
				continue
			}
			merged[key] = value
		}
	}
	return merged
}

func isToolName(name string) bool {
	for _, t := range ToolNames {
		if t == name {
			return true
		}
	}
	return false
}

// DisabledTools is loadPiDiffConfig().disabledTools as a set.
func (c Config) DisabledTools() map[string]bool {
	out := map[string]bool{}
	if list, ok := c["disabledTools"].([]any); ok {
		for _, item := range list {
			if name, ok := item.(string); ok {
				out[name] = true
			}
		}
	}
	return out
}

// IndicatorStyle is configIndicatorStyle: "bar", "classic", "none", or "".
func (c Config) IndicatorStyle() string {
	s, _ := c["indicatorStyle"].(string)
	return s
}
