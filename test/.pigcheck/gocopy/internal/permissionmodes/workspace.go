package permissionmodes

// Workspace guard: edit/write/apply_patch targets outside the session cwd
// (and its subdirectories) need manual approval in every mode, auto included,
// and are blocked without a UI. Port of permission-modes/workspace-guard.ts.
//
// Paths resolve like Pi's file tools (leading @ stripped, ~ expanded,
// relative to cwd), then the nearest existing ancestor is resolved through
// symlinks, so .. and symlinks cannot move a write out of the workspace.
//
// Difference from TypeScript: relative paths resolve against the session cwd
// only. The Go extension runs in its own process, whose working directory is
// not the base that the host's file tools use. macOS realpath also folds
// letter case and Go's EvalSymlinks does not; a case variant then counts as
// outside, so the guard asks (fail closed).

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/difftools"
)

// GuardedTools are the tools whose targets the guard checks.
var GuardedTools = map[string]bool{"edit": true, "write": true, "apply_patch": true}

var unicodeSpacesRe = regexp.MustCompile(`[\x{a0}\x{2000}-\x{200a}\x{202f}\x{205f}\x{3000}]`)

// OutsideTarget is one mutation target outside the workspace.
type OutsideTarget struct {
	Raw      string `json:"raw"`
	Resolved string `json:"resolved"`
}

// MutationTargetPaths returns the raw target paths of an edit/write/apply_patch call.
func MutationTargetPaths(tool string, input map[string]any) []string {
	if tool == "apply_patch" {
		// The parser apply_patch's execute uses (structured changes or a
		// unified diff), so the guard checks what would be written.
		return difftools.ApplyPatchTargetPaths(input)
	}
	var paths []string
	for _, key := range []string{"path", "file_path"} {
		if value, ok := input[key].(string); ok && jsTrim(value) != "" {
			paths = append(paths, value)
		}
	}
	return paths
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/"
	}
	return home
}

// ResolveToolPath mirrors Pi's resolveToCwd.
func ResolveToolPath(filePath, base string) string {
	normalized := unicodeSpacesRe.ReplaceAllString(filePath, " ")
	normalized = strings.TrimPrefix(normalized, "@")
	if normalized == "~" {
		normalized = homeDir()
	} else if strings.HasPrefix(normalized, "~/") {
		normalized = filepath.Join(homeDir(), normalized[2:])
	}
	if filepath.IsAbs(normalized) {
		return filepath.Clean(normalized)
	}
	abs := filepath.Join(base, normalized)
	if !filepath.IsAbs(abs) {
		if resolved, err := filepath.Abs(abs); err == nil {
			return resolved
		}
	}
	return filepath.Clean(abs)
}

// CanonicalPath resolves the nearest existing ancestor through symlinks and
// appends the missing tail. An existing symlink target is followed.
func CanonicalPath(target string) string {
	current := filepath.Clean(target)
	var tail []string
	for {
		if real, err := filepath.EvalSymlinks(current); err == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				real = filepath.Join(real, tail[i])
			}
			return real
		}
		parent := filepath.Dir(current)
		if parent == current {
			return filepath.Clean(target)
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}
}

// IsWithin reports whether target is root or below it. Both must be canonical.
func IsWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

// FindOutsideTargets returns the targets outside cwd and every allowed root.
func FindOutsideTargets(tool string, input map[string]any, cwd string, allowedRoots []string) []OutsideTarget {
	if !GuardedTools[tool] {
		return nil
	}
	roots := append([]string{CanonicalPath(cwd)}, allowedRoots...)
	var outside []OutsideTarget
	seen := map[string]bool{}
	for _, raw := range MutationTargetPaths(tool, input) {
		resolved := CanonicalPath(ResolveToolPath(raw, cwd))
		inside := false
		for _, root := range roots {
			if IsWithin(root, resolved) {
				inside = true
				break
			}
		}
		if !inside && !seen[resolved] {
			seen[resolved] = true
			outside = append(outside, OutsideTarget{Raw: raw, Resolved: resolved})
		}
	}
	return outside
}

// ApprovalScopes returns the folders a "this session" approval grants.
func ApprovalScopes(targets []OutsideTarget) []string {
	var scopes []string
	seen := map[string]bool{}
	for _, target := range targets {
		dir := filepath.Dir(target.Resolved)
		if !seen[dir] {
			seen[dir] = true
			scopes = append(scopes, dir)
		}
	}
	return scopes
}
