package yamlhooks

// Discovery and snapshot loading (port of yaml-hooks/discovery.ts): the
// global and trusted project root configs, imports, parsing, merging,
// overrides, and a cache keyed by a stat fingerprint of the watched paths.

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"
)

// SourceSummary is HookSourceSummary.
type SourceSummary struct {
	Scope     string `json:"scope"`
	FilePath  string `json:"filePath"`
	HookCount int    `json:"hookCount"`
}

// Discovery is HookDiscoveryResult.
type Discovery struct {
	Hooks      *HookMap
	Errors     []ValidationError
	Advisories []string
	Sources    []SourceSummary
	Files      []string
	WatchPaths []string
	Signature  string
}

// LoadOptions is HookLoadOptions (default seams only).
type LoadOptions struct {
	Paths       Paths
	ProjectDir  string
	IgnoreTrust bool
}

type snapshotEntry struct {
	fingerprint string
	result      *Discovery
}

var (
	snapshotMu    sync.Mutex
	snapshotCache = map[string]snapshotEntry{}
)

// LoadDiscoveredHooks is discovery.ts loadDiscoveredHooks.
func LoadDiscoveredHooks(o LoadOptions) *Discovery {
	projectDir := ""
	if o.ProjectDir != "" {
		projectDir = resolvePath(o.ProjectDir)
	}
	watch := computeWatchPaths(o.Paths, projectDir)
	fingerprint := computeStatFingerprint(watch)
	key := projectDir
	if key == "" {
		key = "<global-only>"
	}
	snapshotMu.Lock()
	cached, ok := snapshotCache[key]
	snapshotMu.Unlock()
	if ok && cached.fingerprint == fingerprint {
		return cached.result
	}
	result := loadDiscoveredHooksFresh(o, projectDir, watch)
	snapshotMu.Lock()
	snapshotCache[key] = snapshotEntry{fingerprint, result}
	snapshotMu.Unlock()
	return result
}

func loadDiscoveredHooksFresh(o LoadOptions, projectDir string, watch []string) *Discovery {
	cache := map[string]Envelope{}
	loaded := map[string]bool{}
	var sources []SourceSummary
	var files []string
	var errs []ValidationError
	var advisories []string
	var ordered []snapshot
	var overrides []*Override
	globalHooks, projectHooks := NewHookMap(), NewHookMap()

	if g := globalCandidatePaths(o.Paths, isFile); len(g) > 0 {
		ordered = append(ordered, expandRootSnapshot("global", g[0], &errs, loaded, cache, "")...)
	}
	if projectDir != "" {
		resolution := resolveProjectHookResolution(o.Paths, projectDir)
		projectPath := resolution.ProjectConfigPath
		trusted := o.IgnoreTrust || resolution.Trusted
		if projectPath != "" {
			if trusted {
				ordered = append(ordered, expandRootSnapshot("project", projectPath, &errs, loaded, cache, resolution.CanonicalAnchorDir)...)
			} else if !o.IgnoreTrust {
				errs = append(errs, ValidationError{Code: "invalid_frontmatter", FilePath: projectPath, Message: "Project hooks file exists but the project is untrusted; run /hooks-trust or set PI_YAML_HOOKS_TRUST_PROJECT=1.", Path: "trust"})
			}
		}
	}
	for _, snap := range ordered {
		if !snap.hasContent() {
			errs = append(errs, ValidationError{Code: "invalid_frontmatter", FilePath: snap.filePath, Message: snap.readError})
			continue
		}
		parsed := ParseHooksFile(snap.filePath, snap.content)
		errs = append(errs, parsed.Errors...)
		advisories = append(advisories, parsed.Advisories...)
		target := globalHooks
		if snap.scope != "global" {
			target = projectHooks
		}
		if parsed.Hooks.Size() > 0 {
			mergeHookMapsInto(target, parsed.Hooks)
		}
		overrides = append(overrides, parsed.Overrides...)
		if parsed.Hooks.Size() > 0 || len(parsed.Overrides) > 0 {
			sources = append(sources, SourceSummary{Scope: snap.scope, FilePath: snap.filePath, HookCount: countHooks(parsed.Hooks)})
		}
		files = append(files, snap.filePath)
	}
	merged := NewHookMap()
	mergeHookMapsInto(merged, globalHooks)
	mergeHookMapsInto(merged, projectHooks)
	resolved, overrideErrs := ResolveOverrides(merged, overrides)
	errs = append(errs, overrideErrs...)

	sortedFiles := append([]string{}, files...)
	sort.Strings(sortedFiles)
	signature := Stringify(NewObject(
		"files", stringsToAny(sortedFiles),
		"errors", float64(len(errs)),
		"hooks", float64(countHooks(resolved)),
		"overrides", float64(len(overrides)),
	))
	return &Discovery{
		Hooks:      resolved,
		Errors:     dedupeValidationErrors(errs),
		Advisories: uniqueStrings(advisories),
		Sources:    sources,
		Files:      uniqueStrings(files),
		WatchPaths: watch,
		Signature:  signature,
	}
}

func stringsToAny(list []string) []any {
	out := make([]any, len(list))
	for i, s := range list {
		out[i] = s
	}
	return out
}

func uniqueStrings(list []string) []string {
	set := newOrderedSet()
	for _, s := range list {
		set.add(s)
	}
	if set.items == nil {
		return []string{}
	}
	return set.items
}

func expandRootSnapshot(scope, filePath string, errs *[]ValidationError, loaded map[string]bool, cache map[string]Envelope, anchor string) []snapshot {
	content, err := readFileUTF8(filePath)
	if err != nil {
		*errs = append(*errs, ValidationError{Code: "invalid_frontmatter", FilePath: filePath, Message: formatHookReadError(err)})
		return nil
	}
	expanded := expandSnapshotImports(snapshot{scope: scope, filePath: filePath, content: content}, loaded, cache, anchor)
	*errs = append(*errs, expanded.errors...)
	return expanded.snapshots
}

func computeWatchPaths(p Paths, projectDir string) []string {
	set := newOrderedSet()
	candidates := globalCandidatePaths(p, isFile)
	for _, c := range candidates {
		set.add(c)
	}
	if len(candidates) > 0 {
		set.add(filepath.Dir(candidates[0]))
	} else {
		set.add(filepath.Join(p.AgentDir, "hook"))
	}
	if projectDir != "" {
		dir := resolvePath(projectDir)
		for {
			for _, c := range projectCandidatePaths(p, dir) {
				set.add(c)
			}
			set.add(filepath.Join(dir, ".git"))
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return set.items
}

func computeStatFingerprint(files []string) string {
	parts := make([]string, len(files))
	for i, f := range files {
		parts[i] = f + "|" + statFingerprint(f)
	}
	return strings.Join(parts, "\n")
}

// Summary is HookLoadSummary.
type Summary struct {
	Total   int `json:"total"`
	Global  int `json:"global"`
	Project int `json:"project"`
}

// SummarizeSources is discovery.ts summarizeHookSources.
func SummarizeSources(sources []SourceSummary) Summary {
	s := Summary{}
	for _, src := range sources {
		if src.Scope == "global" {
			s.Global += src.HookCount
		} else {
			s.Project += src.HookCount
		}
	}
	s.Total = s.Global + s.Project
	return s
}

// FormatLoadSummary is discovery.ts formatHookLoadSummary.
func FormatLoadSummary(sources []SourceSummary) string {
	s := SummarizeSources(sources)
	return fmt.Sprintf("%d hooks (%d global, %d project)", s.Total, s.Global, s.Project)
}

// sortLocale approximates Array.sort with String.prototype.localeCompare
// (ICU root collation): punctuation before digits before letters, letters
// compared case-insensitively first, then lowercase before uppercase.
func sortLocale(names []string) {
	sort.SliceStable(names, func(i, j int) bool { return localeLess(names[i], names[j]) })
}

func collationClass(r rune) int {
	switch {
	case unicode.IsSpace(r):
		return 0
	case unicode.IsPunct(r) || unicode.IsSymbol(r):
		return 1
	case unicode.IsDigit(r):
		return 2
	case unicode.IsLetter(r):
		return 3
	}
	return 4
}

func localeLess(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		ca, cb := collationClass(ra[i]), collationClass(rb[i])
		if ca != cb {
			return ca < cb
		}
		la, lb := unicode.ToLower(ra[i]), unicode.ToLower(rb[i])
		if la != lb {
			return la < lb
		}
	}
	if len(ra) != len(rb) {
		return len(ra) < len(rb)
	}
	for i := range ra {
		if ra[i] != rb[i] {
			return unicode.IsLower(ra[i])
		}
	}
	return false
}
