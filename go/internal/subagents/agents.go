package subagents

// Port of subagents/agents.ts: agent discovery (builtin, user, and trusted
// project agents) from markdown files with YAML frontmatter.

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

//go:embed agents/*.md
var builtinAgents embed.FS

// BuiltinAgentDir is the path recorded as the filePath directory of builtin
// agents. The files are embedded copies of subagents/agents (the golden test
// fails when they drift).
var BuiltinAgentDir = "aio/subagents/agents"

type frontmatter map[string]any

func parseFrontmatter(content, filePath string) (frontmatter, string, error) {
	if !strings.HasPrefix(content, "---\n") {
		return nil, "", fmt.Errorf("Agent file '%s' must start with YAML frontmatter.", filePath)
	}
	end := strings.Index(content[4:], "\n---")
	if end == -1 {
		return nil, "", fmt.Errorf("Agent file '%s' has unterminated YAML frontmatter.", filePath)
	}
	end += 4
	var parsed any
	if err := yaml.Unmarshal([]byte(content[4:end]), &parsed); err != nil {
		return nil, "", fmt.Errorf("Agent file '%s' has invalid YAML frontmatter: %v", filePath, err)
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return nil, "", fmt.Errorf("Agent file '%s' frontmatter must be an object.", filePath)
	}
	return frontmatter(object), jsstr.Trim(content[end+4:]), nil
}

func stringList(fm frontmatter, field, filePath string) ([]string, error) {
	value, present := fm[field]
	if !present || value == nil || value == "" {
		return nil, nil
	}
	if s, ok := value.(string); ok {
		var out []string
		for _, item := range strings.Split(s, ",") {
			if item = jsstr.Trim(item); item != "" {
				out = append(out, item)
			}
		}
		return out, nil
	}
	if list, ok := value.([]any); ok {
		out := []string{}
		for _, item := range list {
			s, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("Agent '%s' field '%s' must be a string or string array.", filePath, field)
			}
			if s = jsstr.Trim(s); s != "" {
				out = append(out, s)
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("Agent '%s' field '%s' must be a string or string array.", filePath, field)
}

func yamlNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case uint64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

// ParseAgent parses one agent file's content.
func ParseAgent(content, filePath, source string) (AgentConfig, error) {
	fm, body, err := parseFrontmatter(content, filePath)
	if err != nil {
		return AgentConfig{}, err
	}
	name, ok := fm["name"].(string)
	if !ok || jsstr.Trim(name) == "" {
		return AgentConfig{}, fmt.Errorf("Agent '%s' requires a non-empty name.", filePath)
	}
	description, ok := fm["description"].(string)
	if !ok || jsstr.Trim(description) == "" {
		return AgentConfig{}, fmt.Errorf("Agent '%s' requires a non-empty description.", filePath)
	}
	if body == "" {
		return AgentConfig{}, fmt.Errorf("Agent '%s' requires a system prompt body.", filePath)
	}
	thinking := ""
	if value, present := fm["thinking"]; present {
		s, ok := value.(string)
		if !ok || !slices.Contains(ThinkingLevels, s) {
			return AgentConfig{}, fmt.Errorf("Agent '%s' has an invalid thinking level.", filePath)
		}
		thinking = s
	}
	var timeout *float64
	if value, present := fm["timeoutMs"]; present {
		n, ok := yamlNumber(value)
		if !ok || n != math.Trunc(n) || math.IsInf(n, 0) || n < 1000 {
			return AgentConfig{}, fmt.Errorf("Agent '%s' timeoutMs must be an integer of at least 1000 (milliseconds).", filePath)
		}
		timeout = fptr(n)
	}
	mode := "replace"
	if value, present := fm["systemPromptMode"]; present && value != nil {
		s, _ := value.(string)
		if s != "append" && s != "replace" {
			return AgentConfig{}, fmt.Errorf("Agent '%s' systemPromptMode must be 'append' or 'replace'.", filePath)
		}
		mode = s
	}
	tools, err := stringList(fm, "tools", filePath)
	if err != nil {
		return AgentConfig{}, err
	}
	model := ""
	if s, ok := fm["model"].(string); ok && jsstr.Trim(s) != "" && s != "inherit" {
		model = jsstr.Trim(s)
	}
	return AgentConfig{
		Name: jsstr.Trim(name), Description: jsstr.Trim(description), SystemPrompt: body,
		SystemPromptMode: mode, InheritProjectContext: fm["inheritProjectContext"] != false,
		InheritSkills: fm["inheritSkills"] == true, Tools: tools, Model: model, Thinking: thinking,
		TimeoutMs: timeout, Source: source, FilePath: filePath,
	}, nil
}

// readMarkdownFiles lists *.md files below dir, sorted as localeCompare.
func readMarkdownFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			files = append(files, readMarkdownFiles(path)...)
		} else if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".md") {
			files = append(files, path)
		}
	}
	slices.SortStableFunc(files, LocaleCompare)
	return files
}

func loadDirectory(dir, source string) ([]AgentConfig, error) {
	var out []AgentConfig
	for _, path := range readMarkdownFiles(dir) {
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		agent, err := ParseAgent(string(content), path, source)
		if err != nil {
			return nil, err
		}
		out = append(out, agent)
	}
	return out, nil
}

func loadBuiltins() ([]AgentConfig, error) {
	names, err := fs.Glob(builtinAgents, "agents/*.md")
	if err != nil {
		return nil, err
	}
	slices.SortStableFunc(names, LocaleCompare)
	var out []AgentConfig
	for _, name := range names {
		content, err := builtinAgents.ReadFile(name)
		if err != nil {
			return nil, err
		}
		agent, err := ParseAgent(string(content), BuiltinAgentDir+"/"+filepath.Base(name), "builtin")
		if err != nil {
			return nil, err
		}
		out = append(out, agent)
	}
	return out, nil
}

// BuiltinAgentFiles returns the embedded builtin agent files by base name.
func BuiltinAgentFiles() map[string]string {
	out := map[string]string{}
	names, _ := fs.Glob(builtinAgents, "agents/*.md")
	for _, name := range names {
		content, _ := builtinAgents.ReadFile(name)
		out[filepath.Base(name)] = string(content)
	}
	return out
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// projectAgentDirectories walks from cwd up to the repository root.
func projectAgentDirectories(cwd string) []string {
	var dirs []string
	current, _ := filepath.Abs(cwd)
	for {
		for _, candidate := range []string{filepath.Join(current, ".pi", "agents"), filepath.Join(current, ".agents", "agents")} {
			if exists(candidate) {
				dirs = append(dirs, candidate)
			}
		}
		if exists(filepath.Join(current, ".git")) {
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	slices.Reverse(dirs)
	return dirs
}

// DiscoverAgents is discoverAgents. agentDir is the user agent directory
// (getAgentDir). Later sources override earlier ones by name.
func DiscoverAgents(cwd, agentDir string, includeProject bool) ([]AgentConfig, error) {
	var order []string
	merged := map[string]AgentConfig{}
	add := func(list []AgentConfig) {
		for _, agent := range list {
			if _, ok := merged[agent.Name]; !ok {
				order = append(order, agent.Name)
			}
			merged[agent.Name] = agent
		}
	}
	builtins, err := loadBuiltins()
	if err != nil {
		return nil, err
	}
	add(builtins)
	user, err := loadDirectory(filepath.Join(agentDir, "agents"), "user")
	if err != nil {
		return nil, err
	}
	add(user)
	if includeProject {
		for _, dir := range projectAgentDirectories(cwd) {
			project, err := loadDirectory(dir, "project")
			if err != nil {
				return nil, err
			}
			add(project)
		}
	}
	out := make([]AgentConfig, 0, len(order))
	for _, name := range order {
		out = append(out, merged[name])
	}
	slices.SortStableFunc(out, func(a, b AgentConfig) int { return LocaleCompare(a.Name, b.Name) })
	return out, nil
}

// FindAgent is findAgent.
func FindAgent(agents []AgentConfig, name string) (AgentConfig, error) {
	for _, agent := range agents {
		if agent.Name == name {
			return agent, nil
		}
	}
	names := make([]string, len(agents))
	for i, agent := range agents {
		names[i] = agent.Name
	}
	list := strings.Join(names, ", ")
	if list == "" {
		list = "none"
	}
	return AgentConfig{}, errors.New("Unknown agent '" + name + "'. Available agents: " + list + ".")
}

// LocaleCompare approximates String.prototype.localeCompare for names and
// paths: case-insensitive first, then lower case before upper case.
func LocaleCompare(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return -strings.Compare(a, b)
}
