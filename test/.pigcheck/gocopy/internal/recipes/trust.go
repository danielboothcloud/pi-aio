package recipes

// Explicit, remembered trust for `.pi-recipe` files (port of trust.ts).
// Decisions live in <agentDir>/aio-recipe-trust.json (AIO_RECIPE_TRUST_FILE
// overrides it), keyed by the file's real path and pinned to a SHA-256 of its
// contents. The store format is the same as TypeScript's, so pi, the
// aio-pig launcher, and this port share one store.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	TrustFileName = "aio-recipe-trust.json"
	TrustFileEnv  = "AIO_RECIPE_TRUST_FILE"
)

// Trust states of one file version.
const (
	Trusted = "trusted"
	Denied  = "denied"
	Unknown = "unknown"
)

// TrustChoice labels (TRUST_CHOICE_LABELS), in prompt order.
var TrustChoiceLabels = []string{
	"Trust this recipe file",
	"Not now (ask again next start)",
	"Never (until the file changes)",
}

type trustEntry struct {
	SHA256    string `json:"sha256"`
	Trusted   bool   `json:"trusted"`
	DecidedAt string `json:"decidedAt"`
}

type trustData struct {
	Version int                   `json:"version"`
	Files   map[string]trustEntry `json:"files"`
}

// TrustStorePath is AIO_RECIPE_TRUST_FILE, else <agentDir>/aio-recipe-trust.json.
func TrustStorePath(agentDir string) string {
	if override := jsTrim(os.Getenv(TrustFileEnv)); override != "" {
		return override
	}
	if agentDir == "" {
		return ""
	}
	return filepath.Join(agentDir, TrustFileName)
}

func fileKey(file string) string {
	if real, err := filepath.EvalSymlinks(file); err == nil {
		if abs, err := filepath.Abs(real); err == nil {
			return abs
		}
		return real
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		return file
	}
	return abs
}

// HashFile is the hex SHA-256 of a file, or "" when it cannot be read.
func HashFile(file string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func readStore(path string) trustData {
	empty := trustData{Version: 1, Files: map[string]trustEntry{}}
	data, err := os.ReadFile(path)
	if err != nil {
		return empty
	}
	var raw struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.Files == nil {
		return empty
	}
	for key, value := range raw.Files {
		var entry trustEntry
		if json.Unmarshal(value, &entry) == nil {
			empty.Files[key] = entry
		}
	}
	return empty
}

func writeStore(path string, data trustData) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	text, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, append(text, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// FileTrust returns Trusted, Denied, or Unknown for the file's current contents.
func FileTrust(file, store string) string {
	hash := HashFile(file)
	if store == "" || hash == "" {
		return Unknown
	}
	entry, ok := readStore(store).Files[fileKey(file)]
	if !ok || entry.SHA256 != hash {
		return Unknown
	}
	if entry.Trusted {
		return Trusted
	}
	return Denied
}

// RecordTrust remembers a decision for the file's current contents.
func RecordTrust(file, store string, trusted bool) error {
	if store == "" {
		return errors.New("agent directory is unavailable")
	}
	hash := HashFile(file)
	if hash == "" {
		return errors.New("cannot read " + file)
	}
	data := readStore(store)
	data.Files[fileKey(file)] = trustEntry{SHA256: hash, Trusted: trusted, DecidedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	return writeStore(store, data)
}

// ForgetTrust removes any decision for the file and reports whether one existed.
func ForgetTrust(file, store string) (bool, error) {
	if store == "" {
		return false, nil
	}
	data := readStore(store)
	key := fileKey(file)
	if _, ok := data.Files[key]; !ok {
		return false, nil
	}
	delete(data.Files, key)
	return true, writeStore(store, data)
}

// DescribeFile is the human summary shown in a trust prompt.
func DescribeFile(file string) []string {
	data, err := os.ReadFile(file)
	var raw any
	if err != nil || json.Unmarshal(data, &raw) != nil {
		return []string{"(not valid JSON — it will be ignored until fixed)"}
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return []string{"(not a JSON object — it will be ignored)"}
	}
	recipes, _ := obj["recipes"].(map[string]any)
	var lines []string
	if name, ok := obj["defaultRecipe"].(string); ok && jsTrim(name) != "" {
		name = jsTrim(name)
		note := ""
		if _, defined := recipes[name]; !defined || recipes[name] == nil {
			note = " (not defined in this file — ignored)"
		}
		lines = append(lines, "default recipe: "+name+note)
	} else {
		lines = append(lines, "default recipe: none")
	}
	for _, name := range sortedKeys(recipes) {
		entry, ok := recipes[name].(map[string]any)
		if !ok {
			continue
		}
		var bits []string
		if s, ok := entry["model"].(string); ok && jsTrim(s) != "" {
			bits = append(bits, "model "+jsTrim(s))
		}
		if list := rawStrings(entry["models"]); len(list) > 0 {
			bits = append(bits, "models "+strings.Join(list, ", "))
		}
		if list := rawStrings(entry["extensions"]); len(list) > 0 {
			bits = append(bits, "extensions "+strings.Join(list, ", "))
		}
		if servers, ok := entry["mcpServers"].(map[string]any); ok && len(servers) > 0 {
			bits = append(bits, "MCP "+strings.Join(sortedKeys(servers), ", "))
		}
		summary := "no settings"
		if len(bits) > 0 {
			summary = strings.Join(bits, " · ")
		}
		lines = append(lines, name+": "+summary)
	}
	return lines
}

// TrustPromptTitle is the trust question for a file.
func TrustPromptTitle(file string) string {
	lines := []string{"Trust this recipe file?", file}
	for _, line := range DescribeFile(file) {
		lines = append(lines, "  "+line)
	}
	lines = append(lines, "It can choose the model, MCP servers, and extensions pi starts with.")
	return strings.Join(lines, "\n")
}

func rawStrings(value any) []string {
	list, _ := value.([]any)
	var out []string
	for _, item := range list {
		if s, ok := item.(string); ok && jsTrim(s) != "" {
			out = append(out, s)
		}
	}
	return out
}
