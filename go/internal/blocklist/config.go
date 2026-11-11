// aio-blocklist.json loader and matcher. Port of blocklist/config.ts.
//
// Tiers are a UNION: global <agentDir>/aio-blocklist.json, project
// <cwd>/<configDir>/aio-blocklist.json, and the active recipe's entries.
// Each file's own `enabled` flag (default true) gates only that file.
//
// Entry forms: "substring", {pattern, regex?, reason?, match?}. `match` is
// "text" (whole command) or "command" (each segment's program and full form;
// an unsegmentable command fails closed). Matching is case-insensitive.
//
// Regex rules use JavaScript syntax through regexp2 in ECMAScript mode, so
// lookaround and backreferences work as in the TypeScript version (Go's RE2
// regexp would skip them and silently weaken the hard blocklist). A pattern
// that does not compile is skipped, as in TypeScript, and Load reports it in
// Skipped. A match that exceeds MatchTimeout counts as a match (fail closed).
package blocklist

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
)

// MatchTimeout bounds one regex match; a timeout counts as a match.
const MatchTimeout = time.Second

// FileName is the blocklist file name in every tier.
const FileName = "aio-blocklist.json"

// RecipeEnv carries the active recipe's blocklist to subagent children.
const RecipeEnv = "AIO_RECIPE_BLOCKLIST"

// Entry is one parsed blocklist entry.
type Entry struct {
	Pattern string `json:"pattern"`
	Regex   bool   `json:"regex,omitempty"`
	Reason  string `json:"reason,omitempty"`
	// Command is true for "match": "command" (the file default is folded in).
	Command bool `json:"-"`
}

// FileBlocklist is one tier: its entries in file order and its gate.
type FileBlocklist struct {
	Enabled bool
	Entries []Entry
}

// RecipeBlocklist is the active recipe's entries.
type RecipeBlocklist struct {
	Recipe  string
	Entries []Entry
}

// Rule is a compiled, ready-to-match rule.
type Rule struct {
	Source  string // "global", "project", or "recipe"
	Recipe  string
	Pattern string
	Command bool
	// Reason is the full user-facing reason, prefixed with "Blocked by aio blocklist".
	Reason  string
	matches func(subject string) bool
}

// Hit is the first rule that matched a command.
type Hit struct {
	Source        string
	Recipe        string
	Pattern       string
	Reason        string
	Command       bool
	Segment       string // command mode: the segment (Full form) that matched
	Unsegmentable string // command mode: why the command could not be segmented
}

// SkippedRule is a regex rule that does not compile.
type SkippedRule struct {
	Source  string
	Pattern string
	Error   string
}

// SourceLabel is "global", "project", or "recipe:<name>".
func SourceLabel(source, recipe string) string {
	if source == "recipe" {
		if recipe == "" {
			recipe = "?"
		}
		return "recipe:" + recipe
	}
	return source
}

func parseEntry(raw any, fileCommand bool) (Entry, bool) {
	if s, ok := raw.(string); ok {
		pattern := strings.TrimSpace(s)
		if pattern == "" {
			return Entry{}, false
		}
		return Entry{Pattern: pattern, Command: fileCommand}, true
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return Entry{}, false
	}
	s, ok := obj["pattern"].(string)
	if !ok || strings.TrimSpace(s) == "" {
		return Entry{}, false
	}
	entry := Entry{Pattern: strings.TrimSpace(s), Command: fileCommand}
	if regex, _ := obj["regex"].(bool); regex {
		entry.Regex = true
	}
	if reason, ok := obj["reason"].(string); ok {
		entry.Reason = strings.TrimSpace(reason)
	}
	// An entry's own `match` wins; only the literal "command" selects command mode.
	if match, present := obj["match"]; present {
		entry.Command = match == "command"
	}
	return entry, true
}

// ParseConfig validates an already-decoded blocklist (a file, or a recipe's
// `blocklist` key). A bare array is shorthand for {entries}. Junk yields an
// empty, enabled blocklist. It never fails.
func ParseConfig(raw any) FileBlocklist {
	if list, ok := raw.([]any); ok {
		raw = map[string]any{"entries": list}
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return FileBlocklist{Enabled: true}
	}
	fileCommand := obj["match"] == "command"
	result := FileBlocklist{Enabled: obj["enabled"] != false}
	if list, ok := obj["entries"].([]any); ok {
		for _, item := range list {
			if entry, ok := parseEntry(item, fileCommand); ok {
				result.Entries = append(result.Entries, entry)
			}
		}
	}
	return result
}

// ReadFile reads one blocklist file. A missing file, bad JSON, or a non-object
// value yields an empty, enabled blocklist; a broken file never disables the gate.
func ReadFile(path string) FileBlocklist {
	data, err := os.ReadFile(path)
	if err != nil {
		return FileBlocklist{Enabled: true}
	}
	var raw any
	if json.Unmarshal(data, &raw) != nil {
		return FileBlocklist{Enabled: true}
	}
	if _, ok := raw.(map[string]any); !ok {
		return FileBlocklist{Enabled: true}
	}
	return ParseConfig(raw)
}

// EncodeRecipe serializes a recipe blocklist for RecipeEnv (same JSON as TypeScript).
func EncodeRecipe(recipe RecipeBlocklist) string {
	entries := make([]any, len(recipe.Entries))
	for i, e := range recipe.Entries {
		m := map[string]any{"pattern": e.Pattern}
		if e.Regex {
			m["regex"] = true
		}
		if e.Reason != "" {
			m["reason"] = e.Reason
		}
		if e.Command {
			m["match"] = "command"
		}
		entries[i] = m
	}
	data, _ := json.Marshal(map[string]any{"recipe": recipe.Recipe, "entries": entries})
	return string(data)
}

// DecodeRecipe reads RecipeEnv. It returns ok=false for an empty or invalid value.
func DecodeRecipe(raw string) (RecipeBlocklist, bool) {
	if raw == "" {
		return RecipeBlocklist{}, false
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(raw), &parsed) != nil {
		return RecipeBlocklist{}, false
	}
	name, ok := parsed["recipe"].(string)
	if !ok {
		name = "inherited"
	}
	entries := ParseConfig(map[string]any{"entries": parsed["entries"]}).Entries
	if len(entries) == 0 {
		return RecipeBlocklist{}, false
	}
	return RecipeBlocklist{Recipe: name, Entries: entries}, true
}

func compileRule(entry Entry, source, recipe string) (Rule, error) {
	reason := entry.Reason
	if reason == "" {
		reason = `matches blocked pattern "` + entry.Pattern + `"` // raw, like the TS template literal
	}
	rule := Rule{
		Source:  source,
		Recipe:  recipe,
		Pattern: entry.Pattern,
		Command: entry.Command,
		Reason:  "Blocked by aio blocklist: " + reason,
	}
	if entry.Regex {
		re, err := regexp2.Compile(entry.Pattern, regexp2.ECMAScript|regexp2.IgnoreCase)
		if err != nil {
			return Rule{}, err
		}
		re.MatchTimeout = MatchTimeout
		rule.matches = func(subject string) bool {
			matched, err := re.MatchString(subject)
			return matched || err != nil
		}
	} else {
		needle := strings.ToLower(entry.Pattern)
		rule.matches = func(subject string) bool { return strings.Contains(strings.ToLower(subject), needle) }
	}
	return rule, nil
}

// Paths locate the blocklist tiers.
type Paths struct {
	AgentDir      string // directory of the global file
	ConfigDirName string // project directory name, ".pi" or ".pig"
}

// Load compiles the effective rules for cwd: global + project + recipe (union).
// Skipped lists regex rules that do not compile.
func Load(paths Paths, cwd string, recipe *RecipeBlocklist) (rules []Rule, skipped []SkippedRule) {
	add := func(entries []Entry, source, name string) {
		for _, entry := range entries {
			rule, err := compileRule(entry, source, name)
			if err != nil {
				skipped = append(skipped, SkippedRule{Source: SourceLabel(source, name), Pattern: entry.Pattern, Error: err.Error()})
				continue
			}
			rules = append(rules, rule)
		}
	}
	if paths.AgentDir != "" {
		if global := ReadFile(filepath.Join(paths.AgentDir, FileName)); global.Enabled {
			add(global.Entries, "global", "")
		}
	}
	if paths.ConfigDirName != "" {
		if project := ReadFile(filepath.Join(cwd, paths.ConfigDirName, FileName)); project.Enabled {
			add(project.Entries, "project", "")
		}
	}
	if recipe != nil {
		add(recipe.Entries, "recipe", recipe.Recipe)
	}
	return rules, skipped
}

func hitFor(rule Rule) Hit {
	return Hit{Source: rule.Source, Recipe: rule.Recipe, Pattern: rule.Pattern, Reason: rule.Reason, Command: rule.Command}
}

// Evaluate checks a command against rules, in order. Text rules test the
// whole command. Command rules test each segment's Program and Full forms;
// an unsegmentable command is blocked by the first command rule (fail closed)
// unless a later text rule produces a specific hit.
func Evaluate(command string, rules []Rule) (Hit, bool) {
	if strings.TrimSpace(command) == "" {
		return Hit{}, false
	}
	var (
		segmented bool
		segments  []CommandSegment
		reason    string
		ok        bool
		failed    *Hit
	)
	for _, rule := range rules {
		if !rule.Command {
			if rule.matches(command) {
				return hitFor(rule), true
			}
			continue
		}
		if !segmented {
			segments, reason, ok = Segment(command)
			segmented = true
		}
		if !ok {
			if failed == nil {
				hit := hitFor(rule)
				hit.Unsegmentable = reason
				hit.Reason = "Blocked by aio blocklist: the command could not be checked against command-mode rules (" +
					reason + "); simplify it so each command is visible"
				failed = &hit
			}
			continue
		}
		for _, segment := range segments {
			for _, subject := range []string{segment.Program, segment.Full} {
				if subject != "" && rule.matches(subject) {
					hit := hitFor(rule)
					hit.Segment = segment.Full
					return hit, true
				}
			}
		}
	}
	if failed != nil {
		return *failed, true
	}
	return Hit{}, false
}

// SegmentPreviewChars bounds segment previews in block reasons.
const SegmentPreviewChars = 120

func preview(text string) string {
	flat := strings.Join(strings.Fields(text), " ")
	runes := []rune(flat)
	if len(runes) > SegmentPreviewChars {
		return string(runes[:SegmentPreviewChars-1]) + "…"
	}
	return flat
}

// BlockReason is the text a blocked shell tool call returns.
func BlockReason(hit Hit, command string) string {
	lines := []string{fmt.Sprintf("%s (%s)", hit.Reason, SourceLabel(hit.Source, hit.Recipe))}
	if hit.Segment != "" {
		lines = append(lines, "  Matched command: "+preview(hit.Segment))
	}
	lines = append(lines, "  Command: "+command)
	return strings.Join(lines, "\n")
}

// IsShellTool reports whether a tool runs shell commands. Gate both surfaces.
func IsShellTool(name string) bool { return name == "bash" || name == "hypa_shell" }
