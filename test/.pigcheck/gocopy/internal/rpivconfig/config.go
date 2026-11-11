// Package rpivconfig is the Go port of the part of @juicesharp/rpiv-config
// 2.0.0 (config.ts) that ask-user-question uses: the XDG-aware config path,
// the JSON config load with the legacy ~/.config fallback, and
// validateGuidanceFields. The package does not import the SDK.
package rpivconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Env is the process state config.ts reads: os.homedir() and
// process.env.
type Env struct {
	// Home is os.homedir().
	Home string
	// Getenv is process.env[key] ("" when unset).
	Getenv func(key string) string
}

// OSEnv is the Env of this process.
func OSEnv() Env {
	home, _ := os.UserHomeDir()
	return Env{Home: home, Getenv: os.Getenv}
}

func (e Env) getenv(key string) string {
	if e.Getenv == nil {
		return ""
	}
	return e.Getenv(key)
}

// expandTilde ports expandTilde: only "~" and "~/…" expand.
func (e Env) expandTilde(p string) string {
	if p == "~" {
		return e.Home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(e.Home, p[2:])
	}
	return p
}

// readEnvVar ports readEnvVar without a fallback: the trimmed value, or ""
// when unset or blank.
func (e Env) readEnvVar(key string) string { return jsstr.Trim(e.getenv(key)) }

func (e Env) defaultConfigDir() string { return filepath.Join(e.Home, ".config") }

// resolveConfigDir ports resolveConfigDir: XDG_CONFIG_HOME when it is an
// absolute path (after tilde expansion), else ~/.config.
func (e Env) resolveConfigDir() string {
	xdg := e.readEnvVar("XDG_CONFIG_HOME")
	if xdg == "" {
		return e.defaultConfigDir()
	}
	expanded := e.expandTilde(xdg)
	if filepath.IsAbs(expanded) {
		return expanded
	}
	return e.defaultConfigDir()
}

// ConfigPath ports configPath: <resolveConfigDir()>/<name>/<file>. An empty
// file is "config.json".
func ConfigPath(env Env, name, file string) string {
	if file == "" {
		file = "config.json"
	}
	return filepath.Join(env.resolveConfigDir(), name, file)
}

// LegacyConfigPath ports legacyConfigPath: always under ~/.config.
func LegacyConfigPath(env Env, name, file string) string {
	if file == "" {
		file = "config.json"
	}
	return filepath.Join(env.defaultConfigDir(), name, file)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// LoadJSONConfig ports loadJsonConfig: the parsed plain object, or an empty
// map for a missing file, malformed JSON, or a value that is not a plain
// object. Malformed JSON calls warn with config.ts's console.warn text; the
// parse error text is Go's, not JSON.parse's.
func LoadJSONConfig(path string, warn func(string)) map[string]any {
	if !exists(path) {
		return map[string]any{}
	}
	data, err := os.ReadFile(path)
	if err == nil {
		var parsed any
		if err = json.Unmarshal(data, &parsed); err == nil {
			if obj, ok := parsed.(map[string]any); ok {
				return obj
			}
			return map[string]any{}
		}
	}
	if warn != nil {
		warn("rpiv-config: invalid JSON at " + path + ", using default ({}) — " + err.Error())
	}
	return map[string]any{}
}

// LoadJSONConfigWithLegacyFallback ports loadJsonConfigWithLegacyFallback:
// the XDG path wins when it exists (even malformed); otherwise the legacy
// ~/.config/<name>/<file> path is read.
func LoadJSONConfigWithLegacyFallback(env Env, name, file string, warn func(string)) map[string]any {
	xdgPath := ConfigPath(env, name, file)
	if exists(xdgPath) {
		return LoadJSONConfig(xdgPath, warn)
	}
	return LoadJSONConfig(LegacyConfigPath(env, name, file), warn)
}

// GuidanceFields ports GuidanceFields. A nil field is absent.
type GuidanceFields struct {
	PromptSnippet    *string  `json:"promptSnippet,omitempty"`
	PromptGuidelines []string `json:"promptGuidelines,omitempty"`
}

// ValidateGuidanceFields ports validateGuidanceFields: a non-empty
// promptSnippet string and a non-empty array of non-empty strings for
// promptGuidelines; anything else is dropped.
func ValidateGuidanceFields(fields any) GuidanceFields {
	g, ok := fields.(map[string]any)
	if !ok {
		return GuidanceFields{}
	}
	var result GuidanceFields
	if s, ok := g["promptSnippet"].(string); ok && s != "" {
		result.PromptSnippet = &s
	}
	if list, ok := g["promptGuidelines"].([]any); ok && len(list) > 0 {
		out := make([]string, 0, len(list))
		for _, item := range list {
			s, ok := item.(string)
			if !ok || s == "" {
				out = nil
				break
			}
			out = append(out, s)
		}
		if out != nil {
			result.PromptGuidelines = out
		}
	}
	return result
}
