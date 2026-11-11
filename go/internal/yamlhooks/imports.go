package yamlhooks

// Root-file import expansion (port of yaml-hooks/imports.ts): cycle
// detection, the depth cap, and the global, package, and trust-anchor
// boundaries.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MaxImportDepth is imports.ts MAX_IMPORT_DEPTH.
const MaxImportDepth = 32

// snapshot is DiscoveredHooksFileSnapshot: content, or a read error.
type snapshot struct {
	scope     string // "global" or "project"
	filePath  string
	content   string
	readError string
	hasRead   bool
}

func (s snapshot) hasContent() bool { return !s.hasRead }

type importExpansion struct {
	snapshots  []snapshot
	errors     []ValidationError
	watchPaths []string
}

// expandSnapshotImports is imports.ts expandSnapshotImports.
func expandSnapshotImports(root snapshot, loaded map[string]bool, cache map[string]Envelope, anchor string) importExpansion {
	var ordered []snapshot
	var errs []ValidationError
	watch := newOrderedSet()
	visiting := map[string]bool{}
	var visit func(cur snapshot, depth int)
	visit = func(cur snapshot, depth int) {
		if depth > MaxImportDepth {
			errs = append(errs, createError(cur.filePath, "invalid_imports", fmt.Sprintf("Import depth limit reached at %s (>%d); refusing to recurse further.", cur.filePath, MaxImportDepth), "imports"))
			return
		}
		canonical := canonicalizePath(cur.filePath)
		if loaded[canonical] {
			return
		}
		if visiting[canonical] {
			errs = append(errs, createError(cur.filePath, "invalid_imports", fmt.Sprintf("Import cycle detected involving %s.", cur.filePath), "imports"))
			return
		}
		visiting[canonical] = true
		for _, next := range readSnapshotImports(cur, &errs, cache, anchor, watch) {
			visit(next, depth+1)
		}
		delete(visiting, canonical)
		if !loaded[canonical] {
			loaded[canonical] = true
			ordered = append(ordered, cur)
		}
	}
	visit(root, 0)
	return importExpansion{snapshots: ordered, errors: errs, watchPaths: watch.items}
}

type orderedSet struct {
	items []string
	seen  map[string]bool
}

func newOrderedSet() *orderedSet { return &orderedSet{seen: map[string]bool{}} }

func (s *orderedSet) add(v string) {
	if !s.seen[v] {
		s.seen[v] = true
		s.items = append(s.items, v)
	}
}

func readSnapshotImports(cur snapshot, errs *[]ValidationError, cache map[string]Envelope, anchor string, watch *orderedSet) []snapshot {
	if !cur.hasContent() {
		return nil
	}
	env := getOrParseEnvelope(cur.filePath, cur.content, cache)
	*errs = append(*errs, env.Errors...)
	if len(env.Errors) > 0 {
		return nil
	}
	var out []snapshot
	for _, specifier := range env.Imports {
		filePaths, watchPaths, resolveErr := resolveHookImportTargets(cur.filePath, specifier, cur.scope)
		for _, w := range watchPaths {
			watch.add(w)
		}
		if resolveErr != nil {
			*errs = append(*errs, *resolveErr)
			continue
		}
		for _, filePath := range filePaths {
			if cur.scope == "project" {
				if containment := checkProjectImportContainment(cur.filePath, filePath, anchor, specifier); containment != nil {
					*errs = append(*errs, *containment)
					continue
				}
			}
			if info, err := os.Stat(filePath); err == nil && info.Size() > MaxHooksYAMLBytes {
				*errs = append(*errs, createError(cur.filePath, "invalid_imports", fmt.Sprintf("[aio yaml hooks] imported hooks file %s exceeds the %d-byte size cap (got %d bytes); refusing to read.", filePath, MaxHooksYAMLBytes, info.Size()), "imports"))
				continue
			}
			content, err := readFileUTF8(filePath)
			if err != nil {
				out = append(out, snapshot{scope: cur.scope, filePath: filePath, readError: formatHookReadError(err), hasRead: true})
				continue
			}
			out = append(out, snapshot{scope: cur.scope, filePath: filePath, content: content})
		}
	}
	return out
}

func getOrParseEnvelope(filePath, content string, cache map[string]Envelope) Envelope {
	key := canonicalizePath(filePath)
	if env, ok := cache[key]; ok {
		return env
	}
	env := ParseEnvelope(filePath, content)
	cache[key] = env
	return env
}

func warnImportBypassOnce(env, boundary string) {
	key := env + ":" + boundary
	warnMu.Lock()
	seen := warnedImportBypasses[key]
	warnedImportBypasses[key] = true
	warnMu.Unlock()
	if seen {
		return
	}
	console("warn", fmt.Sprintf("[aio yaml hooks] %s=1 bypasses %s. Imported hooks may execute bash with the importing hook's trust.", env, boundary))
}

func checkProjectImportContainment(importerPath, target, anchor, specifier string) *ValidationError {
	if envAllowProjectImportsOutsideAnchor() {
		warnImportBypassOnce("PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR", "project import trust anchor")
		return nil
	}
	if anchor == "" {
		return nil
	}
	canonicalTarget := canonicalizePath(target)
	if isPathInsideAnchor(canonicalTarget, anchor) {
		return nil
	}
	e := createError(importerPath, "invalid_imports", fmt.Sprintf("[aio yaml hooks] Refusing to resolve project import %s → %s: target escapes the trust anchor %s. Move the file inside the project, or set PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1 to opt in.", Stringify(specifier), canonicalTarget, anchor), "imports")
	return &e
}

func isPathInsideAnchor(target, anchor string) bool {
	if target == anchor {
		return true
	}
	rel := relativePath(anchor, target)
	if rel == "" || rel == "." {
		return true
	}
	return !strings.HasPrefix(rel, "..") && !strings.HasPrefix(rel, "/")
}

func isBareSpecifier(specifier string) bool {
	return !strings.HasPrefix(specifier, ".") && !strings.HasPrefix(specifier, "/")
}

// resolveHookImportTargets is imports.ts resolveHookImportTargets.
func resolveHookImportTargets(importerPath, specifier, scope string) ([]string, []string, *ValidationError) {
	if scope == "global" {
		if !envAllowGlobalImports() {
			e := createError(importerPath, "invalid_imports", fmt.Sprintf("[aio yaml hooks] Refusing to resolve import %s from the global hooks file. Global imports are disabled by default; set PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1 to opt in.", Stringify(specifier)), "imports")
			return nil, nil, &e
		}
		warnImportBypassOnce("PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS", "global hooks import boundary")
	}
	bare := isBareSpecifier(specifier)
	if bare {
		if !envAllowPackageImports() {
			e := createError(importerPath, "invalid_imports", fmt.Sprintf("[aio yaml hooks] Refusing to resolve package import %s. Bare-specifier (npm package) imports are disabled by default; use a relative path or set PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1 to opt in.", Stringify(specifier)), "imports")
			return nil, nil, &e
		}
		warnImportBypassOnce("PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS", "package import boundary")
	}
	var resolved string
	if !bare {
		resolved = resolvePath(filepath.Dir(importerPath), specifier)
	} else {
		r, err := resolvePackage(importerPath, specifier)
		if err != nil {
			e := createError(importerPath, "invalid_imports", fmt.Sprintf("Failed to resolve import %s: %s", Stringify(specifier), err.Error()), "imports")
			return nil, nil, &e
		}
		resolved = r
	}
	filePaths, err := expandHookImportPath(resolved)
	if err != nil {
		e := createError(importerPath, "invalid_imports", fmt.Sprintf("Failed to resolve import %s: %s", Stringify(specifier), err.Error()), "imports")
		return nil, []string{resolved}, &e
	}
	return filePaths, append([]string{resolved}, filePaths...), nil
}

// resolvePackage approximates require.resolve(specifier, { paths: [dir] }):
// node_modules lookup through the ancestors, then the exact file, the
// .js/.json/.node extensions, and a directory's package.json "main" or
// index file. Package "exports" maps are not read.
func resolvePackage(importerPath, specifier string) (string, error) {
	dir := filepath.Dir(importerPath)
	for {
		if filepath.Base(dir) != "node_modules" {
			if found, ok := resolveFileOrDir(filepath.Join(dir, "node_modules", specifier)); ok {
				return found, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", nodeErr{fmt.Sprintf("Cannot find module '%s'\nRequire stack:\n- %s", specifier, importerPath)}
}

func resolveFileOrDir(base string) (string, bool) {
	for _, ext := range []string{"", ".js", ".json", ".node"} {
		if isFile(base + ext) {
			return realOr(base + ext), true
		}
	}
	if data, err := os.ReadFile(filepath.Join(base, "package.json")); err == nil {
		var pkg struct {
			Main string `json:"main"`
		}
		if json.Unmarshal(data, &pkg) == nil && pkg.Main != "" {
			main := filepath.Join(base, pkg.Main)
			for _, candidate := range []string{main, main + ".js", main + ".json", main + ".node", filepath.Join(main, "index.js"), filepath.Join(main, "index.json"), filepath.Join(main, "index.node")} {
				if isFile(candidate) {
					return realOr(candidate), true
				}
			}
		}
	}
	for _, index := range []string{"index.js", "index.json", "index.node"} {
		if isFile(filepath.Join(base, index)) {
			return realOr(filepath.Join(base, index)), true
		}
	}
	return "", false
}

func realOr(p string) string {
	if r, err := realpath(p); err == nil {
		return r
	}
	return p
}

func isImportableHookEntry(name string) bool {
	if strings.HasPrefix(name, ".") {
		return false
	}
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".yaml") || strings.HasSuffix(lower, ".yml")
}

// expandHookImportPath is imports.ts expandHookImportPath. A directory
// yields its .yaml/.yml files in localeCompare order (approximated).
func expandHookImportPath(resolved string) ([]string, error) {
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, nodeFsError(err, "stat", resolved)
	}
	if !info.IsDir() {
		return []string{resolved}, nil
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return nil, nodeFsError(err, "scandir", resolved)
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	sortLocale(names)
	var out []string
	for _, name := range names {
		p := filepath.Join(resolved, name)
		if !isImportableHookEntry(name) {
			continue
		}
		st, err := os.Stat(p)
		if err != nil {
			return nil, nodeFsError(err, "stat", p)
		}
		if st.Mode().IsRegular() {
			out = append(out, p)
		}
	}
	return out, nil
}
