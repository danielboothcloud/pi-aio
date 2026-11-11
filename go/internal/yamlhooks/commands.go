package yamlhooks

// /hooks-* commands (port of yaml-hooks/commands.ts) and the diagnostics
// message renderer (port of yaml-hooks/diagnostics.ts).

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// DiagnosticsMessageType is HOOK_DIAGNOSTICS_MESSAGE_TYPE.
const DiagnosticsMessageType = "aio-yaml-hooks-diagnostics"

// LogFileName is the hook log file name under <agentDir>/logs.
const LogFileName = "aio-yaml-hooks.ndjson"

// Commands lists the command names and descriptions in registration order.
var Commands = []struct{ Name, Description string }{
	{"hooks-status", "Show active hook files, trust state, and log path"},
	{"hooks-validate", "Validate active and project hook files with actionable feedback"},
	{"hooks-trust", "Trust the current project hook file"},
	{"hooks-reload", "Reload extensions; edited hooks also refresh lazily on the next relevant event"},
	{"hooks-tail-log", "Show the hook log path and a ready-to-run tail command"},
}

// LogFilePath is commands.ts getHookLogFilePath.
func LogFilePath(p Paths) string { return filepath.Join(p.AgentDir, "logs", LogFileName) }

// Command runs one /hooks-* command.
func (f *Feature) Command(h Host, name, args string) error {
	switch name {
	case "hooks-status":
		return f.hooksStatus(h)
	case "hooks-validate":
		return f.hooksValidate(h)
	case "hooks-trust":
		return f.hooksTrust(h)
	case "hooks-reload":
		message := "Reloading Pi extensions. Edited hooks.yaml files also refresh on the next relevant Pi event. In-flight hooks finish under the previously loaded configuration."
		if h.HasUI() {
			h.Notify(message, "info")
		} else {
			console("info", "[aio yaml hooks] "+message)
		}
		return h.Reload()
	case "hooks-tail-log":
		path := LogFilePath(f.opts.Paths)
		if strings.TrimSpace(args) == "--path" {
			notifyCommand(h, path, "info")
			return nil
		}
		notifyCommand(h, "Hook log: "+path+"\nTail it with: tail -F "+Stringify(path)+"\n(Pass --path to print only the path.)", "info")
	}
	return nil
}

func notifyCommand(h Host, message, level string) {
	if h.HasUI() {
		h.Notify(message, level)
		return
	}
	console("info", "[aio yaml hooks] "+message)
}

func sendDiagnostics(h Host, title, level, content string, sections []diagSection) error {
	details := NewObject("title", title, "level", level)
	if sections != nil {
		list := make([]any, len(sections))
		for i, s := range sections {
			list[i] = NewObject("label", s.label, "lines", stringsToAny(s.lines))
		}
		details.Set("sections", list)
	}
	return h.SendDiagnostics(content, details)
}

type diagSection struct {
	label string
	lines []string
}

type hooksStatus struct {
	projectDir          string
	projectTrusted      bool
	projectConfigExists bool
	projectStatusPath   string
	paths               ConfigPaths
	active              *Discovery
	logFilePath         string
	trustFilePath       string
}

func (f *Feature) status(cwd string) hooksStatus {
	p := f.opts.Paths
	projectDir := resolvePath(cwd)
	paths := resolveHookConfigPaths(p, projectDir)
	active := LoadDiscoveredHooks(LoadOptions{Paths: p, ProjectDir: projectDir})
	project := resolveProjectHookResolution(p, projectDir)
	statusPath := project.ProjectConfigPath
	if statusPath == "" {
		statusPath = filepath.Join(projectDir, p.configDir(), "hook", HooksFileName)
	}
	trustFile := project.TrustFilePath
	if trustFile == "" {
		trustFile = TrustedProjectsFilePath(p)
	}
	return hooksStatus{
		projectDir: projectDir, projectTrusted: project.Trusted, projectConfigExists: existsPath(statusPath),
		projectStatusPath: statusPath, paths: paths, active: active,
		logFilePath: LogFilePath(p), trustFilePath: trustFile,
	}
}

func formatStatusPath(p string) string {
	if p == "" {
		return "not applicable"
	}
	if existsPath(p) {
		return p
	}
	return p + " (missing)"
}

func (f *Feature) hooksStatus(h Host) error {
	s := f.status(h.Cwd())
	trusted := "no"
	if s.projectTrusted {
		trusted = "yes"
	}
	lines := []string{
		"Hooks status for " + s.projectDir,
		"Active summary: " + FormatLoadSummary(s.active.Sources),
		"Global config: " + formatStatusPath(s.paths.Global),
		"Project config: " + formatStatusPath(s.projectStatusPath),
		"Trust store: " + s.trustFilePath,
		"Project trusted: " + trusted,
		"Hook log: " + s.logFilePath,
	}
	if s.projectConfigExists && !s.projectTrusted {
		lines = append(lines, "Project hooks exist but are not active until the project is trusted.")
	}
	sources := []string{}
	for _, src := range s.active.Sources {
		sources = append(sources, src.Scope+": "+src.FilePath+" ("+itoa(src.HookCount)+" hooks)")
	}
	return sendDiagnostics(h, "Hook status", "info", strings.Join(lines, "\n"), []diagSection{{"Loaded sources", sources}})
}

func formatValidationError(e ValidationError) string {
	path := ""
	if e.Path != "" {
		path = "#" + e.Path
	}
	return "- " + e.FilePath + path + ": " + e.Message
}

func (f *Feature) hooksValidate(h Host) error {
	s := f.status(h.Cwd())
	activeProject, activeGlobal := map[string]bool{}, map[string]bool{}
	var rootOrder []string
	for _, src := range s.active.Sources {
		if src.Scope == "global" && src.FilePath == s.paths.Global {
			if !activeGlobal[src.FilePath] {
				activeGlobal[src.FilePath] = true
			}
		}
	}
	for _, src := range s.active.Sources {
		if src.Scope == "project" && src.FilePath == s.paths.Project {
			activeProject[src.FilePath] = true
		}
	}
	for p := range activeGlobal {
		rootOrder = append(rootOrder, p)
	}
	for p := range activeProject {
		if !activeGlobal[p] {
			rootOrder = append(rootOrder, p)
		}
	}
	projectPath := s.projectStatusPath
	projectExists := s.projectConfigExists
	trusted := activeProject[projectPath]
	var projectErrors []ValidationError
	if projectExists {
		projectErrors = LoadHooksFile(projectPath, nil).Errors
	}
	var global, project, imported []ValidationError
	for _, e := range s.active.Errors {
		switch {
		case activeGlobal[e.FilePath]:
			global = append(global, e)
		case activeProject[e.FilePath]:
			project = append(project, e)
		default:
			imported = append(imported, e)
		}
	}
	if g := s.paths.Global; g != "" && existsPath(g) && !activeGlobal[g] {
		direct := LoadHooksFile(g, nil).Errors
		seen := map[string]bool{}
		key := func(e ValidationError) string { return e.FilePath + "#" + e.Path + "|" + e.Message }
		for _, e := range global {
			seen[key(e)] = true
		}
		for _, e := range direct {
			if !seen[key(e)] {
				seen[key(e)] = true
				global = append(global, e)
			}
		}
	}
	var advisories []string
	for _, p := range rootOrder {
		advisories = append(advisories, LoadHooksFile(p, nil).Advisories...)
	}

	lines := []string{"Hook validation for " + h.Cwd()}
	total := len(global) + len(project) + len(imported)
	if total == 0 {
		sum := SummarizeSources(s.active.Sources)
		lines = append(lines, "Active hooks are valid: "+itoa(sum.Total)+" loaded ("+itoa(sum.Global)+" global, "+itoa(sum.Project)+" project).")
	} else {
		for _, group := range []struct {
			label string
			errs  []ValidationError
		}{{"Global hook errors:", global}, {"Project hook errors:", project}, {"Imported file errors:", imported}} {
			if len(group.errs) > 0 {
				lines = append(lines, group.label)
				for _, e := range group.errs {
					lines = append(lines, formatValidationError(e))
				}
			}
		}
	}
	if len(advisories) > 0 {
		lines = append(lines, "Loader advisories:")
		for _, a := range advisories {
			lines = append(lines, "- "+a)
		}
	}
	if projectExists && !trusted {
		if len(projectErrors) == 0 {
			lines = append(lines, "Project hook file is valid but untrusted: "+projectPath,
				"Run /hooks-trust to add this project to "+TrustedProjectsFilePath(f.opts.Paths)+".")
		} else {
			lines = append(lines, "Project hook file is untrusted and has validation errors: "+projectPath)
			for _, e := range projectErrors {
				lines = append(lines, formatValidationError(e))
			}
		}
	} else if !projectExists {
		lines = append(lines, "No project hook file is present for the current repo/worktree scope. Create "+projectPath+".")
	}
	level := "info"
	if total > 0 || len(projectErrors) > 0 {
		level = "warning"
	}
	return sendDiagnostics(h, "Hook validation", level, strings.Join(lines, "\n"), nil)
}

func (f *Feature) hooksTrust(h Host) error {
	p := f.opts.Paths
	projectDir := resolvePath(h.Cwd())
	project := resolveProjectHookResolution(p, projectDir)
	if project.ProjectConfigPath == "" || !existsPath(project.ProjectConfigPath) {
		configPath := project.ProjectConfigPath
		if configPath == "" {
			configPath = filepath.Join(projectDir, p.configDir(), "hook", HooksFileName)
		}
		notifyCommand(h, "No project hook file was found for "+projectDir+". Create "+configPath+" first, then run /hooks-trust again.", "warning")
		return nil
	}
	trustFile := TrustedProjectsFilePath(p)
	ok, err := updateTrustedProjects(trustFile, project.CanonicalAnchorDir)
	if err != nil {
		return err
	}
	if !ok {
		notifyCommand(h, "Cannot update "+trustFile+" because it is not valid JSON. Fix or remove that file, then run /hooks-trust again.", "error")
		return nil
	}
	resetTrustListCache()
	notifyCommand(h, "Trusted project hooks for "+project.AnchorDir+". Trust store: "+trustFile+". Run /hooks-validate or trigger another Pi event to confirm the active hook set.", "info")
	return nil
}

func readTrustedProjects(path string) ([]string, bool) {
	if !existsPath(path) {
		return []string{}, true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var parsed any
	if json.Unmarshal(data, &parsed) != nil {
		return nil, false
	}
	list, ok := parsed.([]any)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, e := range list {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out, true
}

func updateTrustedProjects(path, anchor string) (bool, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	lock := filepath.Join(dir, filepath.Base(path)+".lock")
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := os.Mkdir(lock, 0o700)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) || time.Now().After(deadline) {
			return false, err
		}
		time.Sleep(25 * time.Millisecond)
	}
	defer os.RemoveAll(lock)
	current, ok := readTrustedProjects(path)
	if !ok {
		return false, nil
	}
	has := false
	for _, e := range current {
		if canonicalizePath(e) == anchor {
			has = true
		}
	}
	isLink := false
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		isLink = true
	}
	if !has || isLink {
		next := current
		if !has {
			next = append(append([]string{}, current...), anchor)
		}
		content := StringifyIndent(stringsToAny(next), "  ") + "\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			return false, err
		}
	}
	return true, nil
}

// RenderDiagnostics is the diagnostics message renderer: a [LEVEL] badge,
// the bold title, the content, and (expanded) the sections, in a pi-tui
// Text component (padding 1).
func RenderDiagnostics(t chrome.Theme, content string, details map[string]any, expanded bool, width int) []string {
	level, _ := details["level"].(string)
	if level == "" {
		level = "info"
	}
	title, _ := details["title"].(string)
	if title == "" {
		title = "aio yaml hooks diagnostics"
	}
	badge := "dim"
	switch level {
	case "error":
		badge = "error"
	case "warning":
		badge = "warning"
	}
	rows := []string{t.Fg(badge, "["+strings.ToUpper(level)+"]") + " " + t.Bold(title), content}
	if sections, ok := details["sections"].([]any); ok && expanded {
		for _, s := range sections {
			section, _ := s.(map[string]any)
			label, _ := section["label"].(string)
			rows = append(rows, "", t.Fg("dim", label))
			lines, _ := section["lines"].([]any)
			for _, l := range lines {
				text, _ := l.(string)
				rows = append(rows, text)
			}
		}
	}
	return renderText(strings.Join(rows, "\n"), width, 1, 1)
}

// renderText is pi-tui Text.render without a background.
func renderText(text string, width, paddingX, paddingY int) []string {
	if text == "" || jsstr.Trim(text) == "" {
		return []string{}
	}
	normalized := strings.ReplaceAll(text, "\t", "   ")
	px := min(paddingX, max(0, (width-1)/2))
	contentWidth := max(1, width-px*2)
	margin := strings.Repeat(" ", px)
	var lines []string
	for _, line := range tuiwidth.WrapTextWithAnsi(normalized, contentWidth) {
		withMargins := margin + line + margin
		pad := max(0, width-tuiwidth.VisibleWidth(withMargins))
		lines = append(lines, withMargins+strings.Repeat(" ", pad))
	}
	empty := strings.Repeat(" ", max(0, width))
	var out []string
	for range paddingY {
		out = append(out, empty)
	}
	out = append(out, lines...)
	for range paddingY {
		out = append(out, empty)
	}
	return out
}

// DiagnosticsContent is diagnostics.ts contentText: a string content, or
// the text of its text blocks.
func DiagnosticsContent(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, part := range c {
			block, _ := part.(map[string]any)
			if t, _ := block["type"].(string); t == "text" {
				text, _ := block["text"].(string)
				b.WriteString(text)
			}
		}
		return b.String()
	}
	return ""
}
