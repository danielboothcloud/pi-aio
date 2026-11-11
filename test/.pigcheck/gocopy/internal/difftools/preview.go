package difftools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Mutation preview caps (mutation-preview.ts). The overlay passes large values.
const (
	MaxPreviewLines = 40
	MaxPreviewChars = 2000
	// OverlayMaxLines and OverlayMaxChars are approval-dialog.ts's caps.
	OverlayMaxLines = 10000
	OverlayMaxChars = 200000
)

// PreviewOptions is MutationPreviewOptions. Zero values use the defaults.
type PreviewOptions struct {
	MaxLines int
	MaxChars int
	// Cwd resolves relative paths. TypeScript reads them against
	// process.cwd(); the Go extension passes the session cwd.
	Cwd string
}

func (o PreviewOptions) lines() int {
	if o.MaxLines > 0 {
		return o.MaxLines
	}
	return MaxPreviewLines
}

func (o PreviewOptions) chars() int {
	if o.MaxChars > 0 {
		return o.MaxChars
	}
	return MaxPreviewChars
}

func (o PreviewOptions) resolve(p string) string {
	if o.Cwd == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(o.Cwd, p)
}

// FormatParsedDiffPlain ports formatParsedDiffPlain.
func FormatParsedDiffPlain(diff ParsedDiff, maxLines int) string {
	var lines []string
	shown, total := 0, 0
	for _, l := range diff.Lines {
		if l.Type == "sep" {
			continue
		}
		total++
		if shown >= maxLines {
			continue
		}
		prefix := " "
		switch l.Type {
		case "add":
			prefix = "+"
		case "del":
			prefix = "-"
		}
		lines = append(lines, prefix+" "+l.Content)
		shown++
	}
	if total > shown {
		lines = append(lines, fmt.Sprintf("… %d more lines", total-shown))
	}
	return strings.Join(lines, "\n")
}

// truncatePreview ports truncatePreview.
func truncatePreview(text string, maxChars int) string {
	if jsstr.Len16(text) <= maxChars {
		return text
	}
	return jsstr.Slice16(text, maxChars) + "\n… (preview truncated)"
}

func jsBasename(p string) string {
	trimmed := strings.TrimRight(p, "/")
	if trimmed == "" {
		return ""
	}
	return filepath.Base(trimmed)
}

// previewEditInput ports previewEditInput.
func previewEditInput(input map[string]any, o PreviewOptions) (string, bool) {
	filePath, _ := input["path"].(string)
	if _, ok := input["path"].(string); !ok {
		filePath, _ = input["file_path"].(string)
	}
	ops := GetEditOperations(input)
	if filePath == "" || len(ops) == 0 {
		return "", false
	}
	data, err := os.ReadFile(o.resolve(filePath))
	if err != nil {
		if _, statErr := os.Stat(o.resolve(filePath)); statErr != nil {
			return "(file not found: " + filePath + ")", true
		}
		return "", false
	}
	content := string(data)
	original := content
	for _, op := range ops {
		r := Replace(content, op.OldText, op.NewText, false)
		if !r.Changed {
			return "(could not preview: oldText not found in " + jsBasename(filePath) + ")", true
		}
		content = r.Content
	}
	if content == original {
		return "(no changes)", true
	}
	body := FormatParsedDiffPlain(ParseDiff(original, content, 3), o.lines())
	if body == "" {
		return "(no diff)", true
	}
	return truncatePreview(body, o.chars()), true
}

// formatApplyPatchPreview ports formatApplyPatchPreview.
func formatApplyPatchPreview(changes []ApplyPatchChange, o PreviewOptions) (string, bool) {
	maxLines := o.lines()
	result := PreviewApplyPatch(changes)
	if !result.OK {
		if len(result.Errors) > 0 {
			return "(could not preview: " + result.Errors[0].Error + ")", true
		}
		return "(could not preview patch)", true
	}
	var blocks []string
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	for _, c := range result.Applied {
		label := jsBasename(c.Path)
		switch c.Action {
		case "add":
			lines := strings.Split(deref(c.NewContent), "\n")
			var preview []string
			for i, line := range lines {
				if i >= maxLines {
					break
				}
				preview = append(preview, "+ "+line)
			}
			if len(lines) > maxLines {
				preview = append(preview, fmt.Sprintf("… %d more lines", len(lines)-maxLines))
			}
			blocks = append(blocks, "--- "+label+" (new file) ---\n"+strings.Join(preview, "\n"))
		case "delete":
			body := FormatParsedDiffPlain(ParseDiff(deref(c.OldContent), "", 3), maxLines)
			if body == "" {
				body = "(empty file)"
			}
			blocks = append(blocks, "--- "+label+" (delete) ---\n"+body)
		case "move":
			move := "?"
			if c.MovePath != nil {
				move = *c.MovePath
			}
			blocks = append(blocks, "--- "+label+" ---\nmove "+c.Path+" -> "+move)
		case "update":
			body := FormatParsedDiffPlain(ParseDiff(deref(c.OldContent), deref(c.NewContent), 3), maxLines)
			if body == "" {
				body = "(no diff)"
			}
			blocks = append(blocks, "--- "+label+" ---\n"+body)
		}
	}
	if len(blocks) == 0 {
		return "", false
	}
	return truncatePreview(strings.Join(blocks, "\n\n"), o.chars()), true
}

// FormatMutationPreview ports formatMutationPreview: a plain diff of what
// an edit or apply_patch call would change. ok=false is undefined.
func FormatMutationPreview(tool string, input map[string]any, o PreviewOptions) (string, bool) {
	switch tool {
	case "edit":
		return previewEditInput(input, o)
	case "apply_patch":
		changes := ResolveApplyPatchChanges(input)
		if len(changes) == 0 {
			return "", false
		}
		if o.Cwd != "" {
			for i := range changes {
				changes[i].Path = o.resolve(changes[i].Path)
				if changes[i].MovePath != nil {
					move := o.resolve(*changes[i].MovePath)
					changes[i].MovePath = &move
				}
			}
		}
		return formatApplyPatchPreview(changes, o)
	}
	return "", false
}

// BuildMutationApprovalPrompt ports buildMutationApprovalPrompt.
func BuildMutationApprovalPrompt(tool, target, preview string, hasPreview bool) string {
	header := "Allow " + tool + " on " + target + "?"
	if !hasPreview || preview == "" {
		return header
	}
	return header + "\n\n" + preview
}

// EditGuardReason ports edit-guard.ts guardEditToolCall: the block reason
// when an edit's oldText is missing from its file, or "" to allow.
// Relative paths resolve against cwd.
func EditGuardReason(input map[string]any, cwd string) string {
	normalized := NormalizeEditParams(input)
	path, _ := normalized["path"].(string)
	ops := GetEditOperations(normalized)
	if path == "" || len(ops) == 0 {
		return ""
	}
	full := path
	if cwd != "" && !filepath.IsAbs(path) {
		full = filepath.Join(cwd, path)
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		return ""
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	content := string(data)
	for _, op := range ops {
		if !strings.Contains(content, op.OldText) {
			return "oldText not found in " + path + ". Re-read the file and copy the exact text (edit protocol: VERIFY before EDIT)."
		}
	}
	return ""
}
