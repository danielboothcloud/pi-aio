package anthropicauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

type LoadedConfig struct {
	Providers []string `json:"providers"`
	Warnings  []string `json:"warnings"`
}

func emptyConfig() LoadedConfig { return LoadedConfig{[]string{}, []string{}} }
func GlobalConfigPath(agentDir string) string {
	return filepath.Join(agentDir, "extensions", "pi-anthropic-auth", "config.json")
}
func ProjectConfigPath(cwd string) string {
	return filepath.Join(cwd, ".pi", "extensions", "pi-anthropic-auth", "config.json")
}
func LoadConfig(path string) LoadedConfig {
	text, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return emptyConfig()
	}
	if err != nil {
		c := emptyConfig()
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s: could not be read (%s)", path, err))
		return c
	}
	return ParseConfig(string(text), path)
}

var providerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

func ParseConfig(text, path string) LoadedConfig {
	c := emptyConfig()
	warn := func(message string) LoadedConfig { c.Warnings = append(c.Warnings, path+": "+message); return c }
	if !json.Valid([]byte(text)) {
		return warn("is not valid JSON (" + jsstr.V8JSONError(text) + ")")
	}
	obj, ok := jsstr.DecodeObject([]byte(text))
	if !ok {
		return warn("must contain a JSON object")
	}
	configured, exists := obj.Values["providers"]
	if !exists {
		return c
	}
	var entries []json.RawMessage
	if !strings.HasPrefix(strings.TrimSpace(string(configured)), "[") || json.Unmarshal(configured, &entries) != nil {
		return warn(`"providers" must be an array of provider names`)
	}
	for i, entry := range entries {
		var name string
		if json.Unmarshal(entry, &name) != nil || !providerName.MatchString(name) {
			c.Warnings = append(c.Warnings, fmt.Sprintf("%s: providers[%d] must be a provider name, received %s", path, i, jsstr.CanonicalJSON(entry)))
			continue
		}
		if name != "anthropic" && !slices.Contains(c.Providers, name) {
			c.Providers = append(c.Providers, name)
		}
	}
	return c
}

type ShapedProvider struct {
	Name  string `json:"name"`
	Layer string `json:"layer"`
}

// ExtraProviders retains first-layer ownership and replaces warnings per layer.
// Apply does not hold its state mutex over a registrar/host call.
type ExtraProviders struct {
	applyMu, mu sync.Mutex
	shaped      []ShapedProvider
	warnings    map[string][]string
}

func (e *ExtraProviders) Apply(config LoadedConfig, layer string, register func(string) error) error {
	e.applyMu.Lock()
	defer e.applyMu.Unlock()
	e.mu.Lock()
	if e.warnings == nil {
		e.warnings = map[string][]string{}
	}
	e.warnings[layer] = slices.Clone(config.Warnings)
	e.mu.Unlock()
	for _, name := range config.Providers {
		e.mu.Lock()
		exists := slices.ContainsFunc(e.shaped, func(p ShapedProvider) bool { return p.Name == name })
		e.mu.Unlock()
		if exists {
			continue
		}
		if err := register(name); err != nil {
			return err
		}
		e.mu.Lock()
		e.shaped = append(e.shaped, ShapedProvider{name, layer})
		e.mu.Unlock()
	}
	return nil
}
func (e *ExtraProviders) ShapedProviders() []ShapedProvider {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]ShapedProvider{}, e.shaped...)
}
func (e *ExtraProviders) Warnings() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := append([]string{}, e.warnings["global"]...)
	return append(out, e.warnings["project"]...)
}

// ApplyProject never calls the loader for an untrusted directory.
func (e *ExtraProviders) ApplyProject(trusted bool, cwd string, load func(string) LoadedConfig, register func(string) error) error {
	if !trusted {
		return nil
	}
	return e.Apply(load(ProjectConfigPath(cwd)), "project", register)
}
