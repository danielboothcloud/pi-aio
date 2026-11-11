package yamlhooks

// Config path discovery and project trust (port of yaml-hooks/paths.ts),
// plus the console surface for the warn-once messages.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// HooksFileName and TrustedProjectsFileName are the file names paths.ts uses.
const (
	HooksFileName           = "hooks.yaml"
	TrustedProjectsFileName = "trusted-projects.json"
)

// Paths locates the agent directory and the project config directory name
// (Pi's getAgentDir() and CONFIG_DIR_NAME; PiG's sdk.AgentDir()).
type Paths struct {
	AgentDir      string
	ConfigDirName string
}

func (p Paths) configDir() string {
	if p.ConfigDirName == "" {
		return ".pi"
	}
	return p.ConfigDirName
}

// ---- console ----

var (
	consoleMu   sync.Mutex
	consoleSink = func(level, text string) { fmt.Fprintln(os.Stderr, text) }
)

// SetConsole replaces the console sink (console.info/warn/error in
// TypeScript) and returns a function that restores the previous one.
func SetConsole(sink func(level, text string)) func() {
	consoleMu.Lock()
	previous := consoleSink
	consoleSink = sink
	consoleMu.Unlock()
	return func() {
		consoleMu.Lock()
		consoleSink = previous
		consoleMu.Unlock()
	}
}

func console(level, text string) {
	consoleMu.Lock()
	sink := consoleSink
	consoleMu.Unlock()
	sink(level, text)
}

// ---- candidates ----

// globalCandidatePaths is paths.ts globalCandidatePaths.
func globalCandidatePaths(p Paths, exists func(string) bool) []string {
	var out []string
	for _, c := range []string{filepath.Join(p.AgentDir, "hook", HooksFileName), filepath.Join(p.AgentDir, HooksFileName)} {
		if exists(c) {
			out = append(out, c)
		}
	}
	return out
}

// projectCandidatePaths is paths.ts projectCandidatePaths.
func projectCandidatePaths(p Paths, root string) []string {
	return []string{
		filepath.Join(root, p.configDir(), "hook", HooksFileName),
		filepath.Join(root, p.configDir(), HooksFileName),
	}
}

// TrustedProjectsFilePath is paths.ts trustedProjectsFilePath.
func TrustedProjectsFilePath(p Paths) string {
	return filepath.Join(p.AgentDir, TrustedProjectsFileName)
}

// ConfigPaths is HookConfigPaths ("" when absent).
type ConfigPaths struct {
	Global  string
	Project string
}

// resolveHookConfigPaths is paths.ts resolveHookConfigPaths.
func resolveHookConfigPaths(p Paths, projectDir string) ConfigPaths {
	out := ConfigPaths{}
	if g := globalCandidatePaths(p, existsPath); len(g) > 0 {
		out.Global = g[0]
	}
	if projectDir != "" {
		if r := resolveProjectHookResolution(p, projectDir); r != nil {
			out.Project = r.ProjectConfigPath
		}
	}
	return out
}

// ProjectResolution is ProjectHookResolution ("" for absent fields).
type ProjectResolution struct {
	Cwd                   string
	AnchorDir             string
	CanonicalCwd          string
	CanonicalAnchorDir    string
	WorktreeRoot          string
	DiscoveredProjectRoot string
	TrustFilePath         string
	ProjectConfigPath     string
	Trusted               bool
}

const maxWarnedUntrustedProjects = 128

var (
	warnMu                  sync.Mutex
	warnedUntrustedProjects []string
	warnedTrustBypasses     = map[string]bool{}
	warnedImportBypasses    = map[string]bool{}
)

func rememberWarnedUntrustedProject(projectDir string) bool {
	warnMu.Lock()
	defer warnMu.Unlock()
	for i, p := range warnedUntrustedProjects {
		if p == projectDir {
			warnedUntrustedProjects = append(append(warnedUntrustedProjects[:i:i], warnedUntrustedProjects[i+1:]...), projectDir)
			return false
		}
	}
	warnedUntrustedProjects = append(warnedUntrustedProjects, projectDir)
	for len(warnedUntrustedProjects) > maxWarnedUntrustedProjects {
		warnedUntrustedProjects = warnedUntrustedProjects[1:]
	}
	return true
}

func warnUntrustedProjectOnce(projectDir, candidate, trustFilePath string) {
	if !rememberWarnedUntrustedProject(projectDir) {
		return
	}
	console("warn", "[aio yaml hooks] Skipping untrusted project hooks at "+candidate+".\n"+
		"         To trust this project, either:\n"+
		"           - set PI_YAML_HOOKS_TRUST_PROJECT=1 for this session, or\n"+
		"           - add "+Stringify(projectDir)+" to "+trustFilePath)
}

func warnTrustBypassOnce(projectDir string) {
	key := "PI_YAML_HOOKS_TRUST_PROJECT:" + projectDir
	warnMu.Lock()
	seen := warnedTrustBypasses[key]
	warnedTrustBypasses[key] = true
	warnMu.Unlock()
	if seen {
		return
	}
	console("warn", "[aio yaml hooks] PI_YAML_HOOKS_TRUST_PROJECT=1 is temporarily bypassing project hook trust for "+projectDir+". "+
		"Trusted project hooks can execute bash and inspect hook context for this session.")
}

// resolveProjectHookResolution is paths.ts resolveProjectHookResolution
// with the default (disk) seams. It returns nil only for an empty projectDir.
func resolveProjectHookResolution(p Paths, projectDir string) *ProjectResolution {
	if projectDir == "" {
		return nil
	}
	cwd := resolvePath(projectDir)
	canonicalCwd := canonicalizePath(cwd)
	worktreeRoot := resolveGitWorktreeRoot(cwd)
	discovered := findNearestProjectRoot(p, canonicalCwd, worktreeRoot, existsPath)
	configPath := ""
	if discovered != "" {
		for _, c := range projectCandidatePaths(p, discovered) {
			if existsPath(c) {
				configPath = c
				break
			}
		}
	}
	anchor := cwd
	if worktreeRoot != "" {
		anchor = worktreeRoot
	} else if discovered != "" {
		anchor = discovered
	}
	canonicalAnchor := canonicalizePath(anchor)
	trustFile := TrustedProjectsFilePath(p)
	trusted := isProjectTrusted(canonicalAnchor, trustFile)
	if configPath != "" && !trusted {
		warnUntrustedProjectOnce(anchor, configPath, trustFile)
	}
	if configPath != "" && trusted && envTrustProject() {
		warnTrustBypassOnce(anchor)
	}
	return &ProjectResolution{
		Cwd: cwd, AnchorDir: anchor, CanonicalCwd: canonicalCwd, CanonicalAnchorDir: canonicalAnchor,
		WorktreeRoot: worktreeRoot, DiscoveredProjectRoot: discovered, TrustFilePath: trustFile,
		ProjectConfigPath: configPath, Trusted: trusted,
	}
}

type cachedTrustList struct {
	fingerprint string
	entries     map[string]bool
}

var (
	trustMu        sync.Mutex
	trustListCache = map[string]cachedTrustList{}
)

// ResetCaches clears the trust-list, snapshot, lineage, and execution
// context caches (the TypeScript __reset*ForTests helpers, and /hooks-trust).
func ResetCaches() {
	resetTrustListCache()
	snapshotMu.Lock()
	snapshotCache = map[string]snapshotEntry{}
	snapshotMu.Unlock()
	lineageMu.Lock()
	lineageCache = nil
	lineageMu.Unlock()
	execContextMu.Lock()
	execContextCache = map[string]execContextEntry{}
	execContextMu.Unlock()
}

// resetWarnings forgets the warn-once state (tests).
func resetWarnings() {
	warnMu.Lock()
	warnedUntrustedProjects = nil
	warnedTrustBypasses = map[string]bool{}
	warnedImportBypasses = map[string]bool{}
	warnMu.Unlock()
}

func resetTrustListCache() {
	trustMu.Lock()
	trustListCache = map[string]cachedTrustList{}
	trustMu.Unlock()
}

// statFingerprint is `${mtimeNs}|${ctimeNs}|${size}|${ino}|${mode}`.
func statFingerprint(p string) string {
	info, err := os.Stat(p)
	if err != nil {
		return "missing"
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Sprintf("%d|%d|%d", info.ModTime().UnixNano(), info.Size(), info.Mode())
	}
	return fmt.Sprintf("%d|%d|%d|%d|%d", info.ModTime().UnixNano(), ctimeNanos(st), info.Size(), st.Ino, st.Mode)
}

func isProjectTrusted(canonicalAnchor, trustFile string) bool {
	if envTrustProject() {
		return true
	}
	fingerprint := statFingerprint(trustFile)
	trustMu.Lock()
	cached, ok := trustListCache[trustFile]
	trustMu.Unlock()
	if ok && cached.fingerprint == fingerprint {
		return cached.entries[canonicalAnchor]
	}
	entries := map[string]bool{}
	if existsPath(trustFile) {
		if data, err := os.ReadFile(trustFile); err == nil {
			var parsed any
			if json.Unmarshal(data, &parsed) == nil {
				if list, ok := parsed.([]any); ok {
					for _, entry := range list {
						s, ok := entry.(string)
						if !ok || !strings.HasPrefix(s, "/") {
							continue
						}
						entries[canonicalizePath(s)] = true
					}
				}
			}
		}
	}
	trustMu.Lock()
	trustListCache[trustFile] = cachedTrustList{fingerprint, entries}
	trustMu.Unlock()
	return entries[canonicalAnchor]
}

// resolveGitWorktreeRoot is paths.ts resolveGitWorktreeRoot.
func resolveGitWorktreeRoot(cwd string) string {
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")
	cmd.Dir = cwd
	if out, err := cmd.Output(); err == nil {
		top := strings.TrimSpace(string(out))
		if top != "" && strings.HasPrefix(top, "/") {
			if r, err := realpath(top); err == nil {
				return r
			}
			return resolvePath(top)
		}
	}
	if info, err := os.Stat(filepath.Join(cwd, ".git")); err == nil && info.IsDir() {
		if r, err := realpath(cwd); err == nil {
			return r
		}
	}
	return ""
}

func findNearestProjectRoot(p Paths, canonicalCwd, worktreeRoot string, exists func(string) bool) string {
	stopDir := worktreeRoot
	if stopDir == "" {
		stopDir = "/"
	}
	anyExists := func(dir string) bool {
		for _, c := range projectCandidatePaths(p, dir) {
			if exists(c) {
				return true
			}
		}
		return false
	}
	current := canonicalCwd
	for {
		if anyExists(current) {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		if parent == stopDir {
			if anyExists(parent) {
				return parent
			}
			return ""
		}
		if !pathInside(parent, stopDir) && parent != stopDir {
			return ""
		}
		current = parent
	}
}

func pathInside(child, parent string) bool {
	rel := relativePath(parent, child)
	return rel != "" && !strings.HasPrefix(rel, "..") && !strings.HasPrefix(rel, "/")
}
