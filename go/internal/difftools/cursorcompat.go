package difftools

import (
	"regexp"
	"strings"
)

// EditOperation is cursor-compat.ts EditOperation.
type EditOperation struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

var (
	oldKeys = []string{"oldText", "old_text", "old_string"}
	newKeys = []string{"newText", "new_text", "new_string"}
)

// readEditField ports cursor-compat.ts readEditField.
func readEditField(record map[string]any, keys []string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok {
			return value
		}
	}
	return ""
}

func isEditOperation(op EditOperation) bool {
	return op.OldText != "" && op.OldText != op.NewText
}

// GetEditOperations ports getEditOperations.
func GetEditOperations(input map[string]any) []EditOperation {
	ops := []EditOperation{}
	if edits, ok := input["edits"].([]any); ok {
		for _, raw := range edits {
			record, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			op := EditOperation{readEditField(record, oldKeys), readEditField(record, newKeys)}
			if isEditOperation(op) {
				ops = append(ops, op)
			}
		}
		return ops
	}
	op := EditOperation{readEditField(input, oldKeys), readEditField(input, newKeys)}
	if isEditOperation(op) {
		ops = append(ops, op)
	}
	return ops
}

// NormalizeEditParams ports normalizeEditParams: Cursor argument shapes
// become Pi's oldText/newText (and edits).
func NormalizeEditParams(input map[string]any) map[string]any {
	ops := GetEditOperations(input)
	if len(ops) == 0 {
		return input
	}
	out := make(map[string]any, len(input)+3)
	for k, v := range input {
		out[k] = v
	}
	if edits, ok := input["edits"].([]any); ok {
		mapped := make([]any, len(edits))
		for i, raw := range edits {
			record, ok := raw.(map[string]any)
			if !ok {
				mapped[i] = raw
				continue
			}
			copyRec := make(map[string]any, len(record)+2)
			for k, v := range record {
				copyRec[k] = v
			}
			copyRec["oldText"] = readEditField(record, oldKeys)
			copyRec["newText"] = readEditField(record, newKeys)
			mapped[i] = copyRec
		}
		out["edits"] = mapped
		return out
	}
	out["oldText"] = ops[0].OldText
	out["newText"] = ops[0].NewText
	edits := make([]any, len(ops))
	for i, op := range ops {
		edits[i] = map[string]any{"oldText": op.OldText, "newText": op.NewText}
	}
	out["edits"] = edits
	return out
}

// ApplyPatchChange is apply-patch.ts ApplyPatchChange. Nil pointers are undefined.
type ApplyPatchChange struct {
	Path     string  `json:"path"`
	Action   string  `json:"action"`
	Content  *string `json:"content,omitempty"`
	OldText  *string `json:"oldText,omitempty"`
	NewText  *string `json:"newText,omitempty"`
	MovePath *string `json:"movePath,omitempty"`
}

type patchLine struct{ kind, content string }

type parsedPatchFile struct {
	path   string
	status string
	hunks  [][]patchLine
}

var (
	unifiedHunkRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)
	diffGitRe     = regexp.MustCompile(`^diff --git a/(` + jsDot + `*) b/(` + jsDot + `*)$`)
)

func normalizeDiffPath(path string) (string, bool) {
	if path == "/dev/null" {
		return "", false
	}
	if strings.HasPrefix(path, "a/") || strings.HasPrefix(path, "b/") {
		return path[2:], true
	}
	return path, true
}

// parseUnifiedPatch ports cursor-compat.ts parseUnifiedPatch.
func parseUnifiedPatch(patch string) []*parsedPatchFile {
	var files []*parsedPatchFile
	var current *parsedPatchFile
	hunk := -1
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			path := "unknown"
			if m := diffGitRe.FindStringSubmatch(line); m != nil {
				path = m[2]
			}
			current = &parsedPatchFile{path: path, status: "modified"}
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
				current = &parsedPatchFile{path: "unknown", status: "modified"}
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
				current = &parsedPatchFile{path: "unknown", status: "modified"}
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
		if unifiedHunkRe.MatchString(line) {
			current.hunks = append(current.hunks, []patchLine{})
			hunk = len(current.hunks) - 1
			continue
		}
		if hunk < 0 || line == `\ No newline at end of file` || line == "" {
			continue
		}
		switch line[0] {
		case '+':
			current.hunks[hunk] = append(current.hunks[hunk], patchLine{"add", line[1:]})
		case '-':
			current.hunks[hunk] = append(current.hunks[hunk], patchLine{"del", line[1:]})
		case ' ':
			current.hunks[hunk] = append(current.hunks[hunk], patchLine{"ctx", line[1:]})
		}
	}
	return files
}

// hunkToEditTexts ports cursor-compat.ts hunkToEditTexts.
func hunkToEditTexts(hunk []patchLine) EditOperation {
	var oldLines, newLines []string
	for _, l := range hunk {
		switch l.kind {
		case "ctx":
			oldLines = append(oldLines, l.content)
			newLines = append(newLines, l.content)
		case "del":
			oldLines = append(oldLines, l.content)
		case "add":
			newLines = append(newLines, l.content)
		}
	}
	return EditOperation{strings.Join(oldLines, "\n"), strings.Join(newLines, "\n")}
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// normalizeApplyPatchChange ports cursor-compat.ts normalizeApplyPatchChange.
func normalizeApplyPatchChange(raw any) (ApplyPatchChange, bool) {
	record, ok := raw.(map[string]any)
	if !ok {
		return ApplyPatchChange{}, false
	}
	path, okPath := record["path"].(string)
	action, okAction := record["action"].(string)
	if !okPath || !okAction {
		return ApplyPatchChange{}, false
	}
	c := ApplyPatchChange{Path: path, Action: action}
	if content, ok := record["content"].(string); ok {
		c.Content = &content
	}
	c.OldText = optString(readEditField(record, oldKeys))
	c.NewText = optString(readEditField(record, newKeys))
	if move, ok := record["movePath"].(string); ok {
		c.MovePath = &move
	} else if move, ok := record["move_path"].(string); ok {
		c.MovePath = &move
	}
	return c, true
}

// patchToChanges ports cursor-compat.ts patchToChanges.
func patchToChanges(patch string) []ApplyPatchChange {
	changes := []ApplyPatchChange{}
	for _, file := range parseUnifiedPatch(patch) {
		switch file.status {
		case "added":
			var lines []string
			for _, h := range file.hunks {
				for _, l := range h {
					if l.kind == "add" {
						lines = append(lines, l.content)
					}
				}
			}
			content := strings.Join(lines, "\n")
			changes = append(changes, ApplyPatchChange{Path: file.path, Action: "add", Content: &content})
			continue
		case "deleted":
			changes = append(changes, ApplyPatchChange{Path: file.path, Action: "delete"})
			continue
		}
		for _, h := range file.hunks {
			op := hunkToEditTexts(h)
			if isEditOperation(op) {
				oldText, newText := op.OldText, op.NewText
				changes = append(changes, ApplyPatchChange{Path: file.path, Action: "update", OldText: &oldText, NewText: &newText})
			}
		}
	}
	return changes
}

// ResolveApplyPatchChanges ports resolveApplyPatchChanges: Pi's changes
// array or a Cursor unified-diff patch string.
func ResolveApplyPatchChanges(params map[string]any) []ApplyPatchChange {
	if raw, ok := params["changes"].([]any); ok && len(raw) > 0 {
		changes := []ApplyPatchChange{}
		for _, item := range raw {
			if c, ok := normalizeApplyPatchChange(item); ok {
				changes = append(changes, c)
			}
		}
		return changes
	}
	if patch, ok := params["patch"].(string); ok && jsTrim(patch) != "" {
		return patchToChanges(patch)
	}
	return []ApplyPatchChange{}
}

// MutationTargetPaths returns the raw target paths of an apply_patch call
// (move destinations included), in change order.
func ApplyPatchTargetPaths(params map[string]any) []string {
	var paths []string
	for _, c := range ResolveApplyPatchChanges(params) {
		paths = append(paths, c.Path)
		if c.Action == "move" && c.MovePath != nil && *c.MovePath != "" {
			paths = append(paths, *c.MovePath)
		}
	}
	return paths
}
