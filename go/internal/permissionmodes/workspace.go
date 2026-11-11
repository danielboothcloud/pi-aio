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
)

// GuardedTools are the tools whose targets the guard checks.
var GuardedTools = map[string]bool{"edit": true, "write": true, "apply_patch": true}

var (
	unicodeSpacesRe = regexp.MustCompile(`[\x{a0}\x{2000}-\x{200a}\x{202f}\x{205f}\x{3000}]`)
	hunkRe          = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)
	diffGitRe       = regexp.MustCompile("^diff --git a/([^\r\n\u2028\u2029]*) b/([^\r\n\u2028\u2029]*)$")
	editOldKeys     = []string{"oldText", "old_text", "old_string"}
	editNewKeys     = []string{"newText", "new_text", "new_string"}
)

// OutsideTarget is one mutation target outside the workspace.
type OutsideTarget struct {
	Raw      string `json:"raw"`
	Resolved string `json:"resolved"`
}

func readEditField(record map[string]any, keys []string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok {
			return value
		}
	}
	return ""
}

type patchFile struct {
	path   string
	status string
	hunks  [][2][]string // per hunk: old lines, new lines
}

func normalizeDiffPath(path string) (string, bool) {
	if path == "/dev/null" {
		return "", false
	}
	if strings.HasPrefix(path, "a/") || strings.HasPrefix(path, "b/") {
		return path[2:], true
	}
	return path, true
}

// parseUnifiedPatch ports cursor-compat.ts parseUnifiedPatch (paths and hunk texts).
func parseUnifiedPatch(patch string) []*patchFile {
	var files []*patchFile
	var current *patchFile
	hunk := -1
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			path := "unknown"
			if m := diffGitRe.FindStringSubmatch(line); m != nil {
				path = m[2]
			}
			current = &patchFile{path: path, status: "modified"}
			files = append(files, current)
			hunk = -1
			continue
		case strings.HasPrefix(line, "new file mode"):
			if current != nil {
				current.status = "added"
			}
			continue
		case strings.HasPrefix(line, "deleted file mode"):
			if current != nil {
				current.status = "deleted"
			}
			continue
		case strings.HasPrefix(line, "--- "):
			oldPath, ok := normalizeDiffPath(jsTrim(line[4:]))
			if current == nil {
				current = &patchFile{path: "unknown", status: "modified"}
				if ok {
					current.path = oldPath
				} else {
					current.status = "added"
				}
				files = append(files, current)
			}
			if !ok {
				current.status = "added"
			} else if current.path == "unknown" {
				current.path = oldPath
			}
			hunk = -1
			continue
		case strings.HasPrefix(line, "+++ "):
			newPath, ok := normalizeDiffPath(jsTrim(line[4:]))
			if current == nil {
				current = &patchFile{path: "unknown", status: "modified"}
				if ok {
					current.path = newPath
				} else {
					current.status = "deleted"
				}
				files = append(files, current)
			}
			if !ok {
				current.status = "deleted"
			} else {
				current.path = newPath
			}
			hunk = -1
			continue
		}
		if current == nil {
			continue
		}
		if hunkRe.MatchString(line) {
			current.hunks = append(current.hunks, [2][]string{})
			hunk = len(current.hunks) - 1
			continue
		}
		if hunk < 0 || line == `\ No newline at end of file` || line == "" {
			continue
		}
		h := &current.hunks[hunk]
		content := string([]rune(line)[1:])
		switch line[0] {
		case '+':
			h[1] = append(h[1], content)
		case '-':
			h[0] = append(h[0], content)
		case ' ':
			h[0] = append(h[0], content)
			h[1] = append(h[1], content)
		}
	}
	return files
}

// applyPatchPaths ports resolveApplyPatchChanges, reduced to the target paths
// (move destinations included) in change order.
func applyPatchPaths(input map[string]any) []string {
	var paths []string
	if changes, ok := input["changes"].([]any); ok && len(changes) > 0 {
		for _, raw := range changes {
			change, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			path, okPath := change["path"].(string)
			action, okAction := change["action"].(string)
			if !okPath || !okAction {
				continue
			}
			paths = append(paths, path)
			if action == "move" {
				move, _ := change["movePath"].(string)
				if move == "" {
					move, _ = change["move_path"].(string)
				}
				if move != "" {
					paths = append(paths, move)
				}
			}
		}
		return paths
	}
	patch, ok := input["patch"].(string)
	if !ok || jsTrim(patch) == "" {
		return nil
	}
	for _, file := range parseUnifiedPatch(patch) {
		if file.status == "added" || file.status == "deleted" {
			paths = append(paths, file.path)
			continue
		}
		for _, h := range file.hunks {
			oldText, newText := strings.Join(h[0], "\n"), strings.Join(h[1], "\n")
			if oldText != "" && oldText != newText {
				paths = append(paths, file.path)
			}
		}
	}
	return paths
}

// MutationTargetPaths returns the raw target paths of an edit/write/apply_patch call.
func MutationTargetPaths(tool string, input map[string]any) []string {
	if tool == "apply_patch" {
		return applyPatchPaths(input)
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
