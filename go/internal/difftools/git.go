package difftools

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// ReviewDiffMode is git.ts ReviewDiffMode: Type "working-tree" or "branch".
type ReviewDiffMode struct {
	Type string `json:"type"`
	Base string `json:"base,omitempty"`
}

// ReviewLine is git.ts ReviewLine.
type ReviewLine struct {
	Type    string `json:"type"`
	OldNum  *int   `json:"oldNum"`
	NewNum  *int   `json:"newNum"`
	Content string `json:"content"`
}

// ReviewHunk is git.ts ReviewHunk.
type ReviewHunk struct {
	ID       string       `json:"id"`
	OldStart int          `json:"oldStart"`
	OldLines int          `json:"oldLines"`
	NewStart int          `json:"newStart"`
	NewLines int          `json:"newLines"`
	Header   string       `json:"header"`
	Lines    []ReviewLine `json:"lines"`
}

// ReviewFileDiff is git.ts ReviewFileDiff. Nil paths are null.
type ReviewFileDiff struct {
	OldPath *string      `json:"oldPath"`
	NewPath *string      `json:"newPath"`
	Path    string       `json:"path"`
	Status  string       `json:"status"`
	Hunks   []ReviewHunk `json:"hunks"`
}

// ReviewDiff is git.ts ReviewDiff.
type ReviewDiff struct {
	Mode  ReviewDiffMode   `json:"mode"`
	Files []ReviewFileDiff `json:"files"`
	Raw   string           `json:"raw"`
}

// GitExec runs git with args in cwd and returns stdout (execFileSync).
type GitExec func(cwd string, args ...string) (string, error)

var (
	reviewHunkRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(` + jsDot + `*)$`)
	reviewGitRe  = regexp.MustCompile(`^diff --git a/(` + jsDot + `*) b/(` + jsDot + `*)$`)
)

// ReadGitDiff ports readGitDiff: tracked changes, plus untracked files as
// new-file diffs in working-tree mode.
func ReadGitDiff(run GitExec, cwd string, mode ReviewDiffMode) (ReviewDiff, error) {
	args := []string{"diff", "--no-ext-diff"}
	if mode.Type == "branch" {
		args = append(args, mode.Base+"...HEAD")
	}
	tracked, err := run(cwd, args...)
	if err != nil {
		return ReviewDiff{}, err
	}
	untracked := ""
	if mode.Type != "branch" {
		if untracked, err = readUntrackedFilesAsDiff(run, cwd); err != nil {
			return ReviewDiff{}, err
		}
	}
	var parts []string
	for _, p := range []string{jsTrimEnd(tracked), jsTrimEnd(untracked)} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	raw := strings.Join(parts, "\n")
	return ReviewDiff{Mode: mode, Files: ParseUnifiedGitDiff(raw), Raw: raw}, nil
}

func jsTrimEnd(s string) string { return strings.TrimRightFunc(s, isJSSpace) }

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func nonEmptyTrimmedLines(raw string) []string {
	var out []string
	for _, line := range strings.Split(raw, "\n") {
		if t := jsTrim(line); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// ReadChangedFiles ports readChangedFiles.
func ReadChangedFiles(run GitExec, cwd string, mode ReviewDiffMode) ([]string, error) {
	args := []string{"diff", "--name-only"}
	if mode.Type == "branch" {
		args = append(args, mode.Base+"...HEAD")
	}
	raw, err := run(cwd, args...)
	if err != nil {
		return nil, err
	}
	files := nonEmptyTrimmedLines(raw)
	if mode.Type == "branch" {
		return files, nil
	}
	untracked, err := readUntrackedFiles(run, cwd)
	if err != nil {
		return nil, err
	}
	return append(files, untracked...), nil
}

// LineCounts is an insertions/deletions pair.
type LineCounts struct {
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
}

// CountReviewHunkLines ports countReviewHunkLines.
func CountReviewHunkLines(h ReviewHunk) LineCounts {
	var c LineCounts
	for _, l := range h.Lines {
		switch l.Type {
		case "add":
			c.Insertions++
		case "del":
			c.Deletions++
		}
	}
	return c
}

// CountReviewFileLines ports countReviewFileLines.
func CountReviewFileLines(f ReviewFileDiff) LineCounts {
	var c LineCounts
	for _, h := range f.Hunks {
		hc := CountReviewHunkLines(h)
		c.Insertions += hc.Insertions
		c.Deletions += hc.Deletions
	}
	return c
}

// CountReviewDiffLines ports countReviewDiffLines.
func CountReviewDiffLines(d ReviewDiff) LineCounts {
	var c LineCounts
	for _, f := range d.Files {
		fc := CountReviewFileLines(f)
		c.Insertions += fc.Insertions
		c.Deletions += fc.Deletions
	}
	return c
}

func reviewPath(p string) *string {
	if p == "/dev/null" {
		return nil
	}
	if strings.HasPrefix(p, "a/") || strings.HasPrefix(p, "b/") {
		p = p[2:]
	}
	return &p
}

// ParseUnifiedGitDiff ports parseUnifiedGitDiff.
func ParseUnifiedGitDiff(raw string) []ReviewFileDiff {
	files := []ReviewFileDiff{}
	fileIdx, hunkIdx := -1, -1
	oldLine, newLine := 0, 0
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			files = append(files, createFileDiff(line))
			fileIdx, hunkIdx = len(files)-1, -1
			continue
		}
		if fileIdx < 0 {
			continue
		}
		f := &files[fileIdx]
		switch {
		case strings.HasPrefix(line, "new file mode"):
			f.Status = "added"
			continue
		case strings.HasPrefix(line, "deleted file mode"):
			f.Status = "deleted"
			continue
		case strings.HasPrefix(line, "rename from "):
			f.Status = "renamed"
			p := line[len("rename from "):]
			f.OldPath = &p
			continue
		case strings.HasPrefix(line, "rename to "):
			f.Status = "renamed"
			p := line[len("rename to "):]
			f.NewPath, f.Path = &p, p
			continue
		case strings.HasPrefix(line, "--- "):
			f.OldPath = reviewPath(line[4:])
			continue
		case strings.HasPrefix(line, "+++ "):
			f.NewPath = reviewPath(line[4:])
			if f.NewPath != nil {
				f.Path = *f.NewPath
			} else if f.OldPath != nil {
				f.Path = *f.OldPath
			}
			continue
		}
		if m := reviewHunkRe.FindStringSubmatch(line); m != nil {
			num := func(s string) int {
				if s == "" {
					return 1
				}
				n, _ := strconv.Atoi(s)
				return n
			}
			oldStart, _ := strconv.Atoi(m[1])
			newStart, _ := strconv.Atoi(m[3])
			f.Hunks = append(f.Hunks, ReviewHunk{
				ID:       f.Path + ":" + m[1] + ":" + m[3],
				OldStart: oldStart, OldLines: num(m[2]), NewStart: newStart, NewLines: num(m[4]),
				Header: line, Lines: []ReviewLine{},
			})
			hunkIdx = len(f.Hunks) - 1
			oldLine, newLine = oldStart, newStart
			continue
		}
		if hunkIdx < 0 || line == `\ No newline at end of file` || line == "" {
			continue
		}
		h := &f.Hunks[hunkIdx]
		content := line[1:]
		switch line[0] {
		case '+':
			h.Lines = append(h.Lines, ReviewLine{Type: "add", NewNum: intp(newLine), Content: content})
			newLine++
		case '-':
			h.Lines = append(h.Lines, ReviewLine{Type: "del", OldNum: intp(oldLine), Content: content})
			oldLine++
		case ' ':
			h.Lines = append(h.Lines, ReviewLine{Type: "ctx", OldNum: intp(oldLine), NewNum: intp(newLine), Content: content})
			oldLine++
			newLine++
		}
	}
	return files
}

func createFileDiff(header string) ReviewFileDiff {
	f := ReviewFileDiff{Status: "modified", Hunks: []ReviewHunk{}, Path: "unknown"}
	if m := reviewGitRe.FindStringSubmatch(header); m != nil {
		oldPath, newPath := m[1], m[2]
		f.OldPath, f.NewPath, f.Path = &oldPath, &newPath, newPath
	}
	return f
}

func readUntrackedFiles(run GitExec, cwd string) ([]string, error) {
	raw, err := run(cwd, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, p := range nonEmptyTrimmedLines(raw) {
		if info, err := os.Stat(filepath.Join(cwd, p)); err == nil && info.Mode().IsRegular() {
			out = append(out, p)
		}
	}
	return out, nil
}

func readUntrackedFilesAsDiff(run GitExec, cwd string) (string, error) {
	files, err := readUntrackedFiles(run, cwd)
	if err != nil {
		return "", err
	}
	parts := make([]string, 0, len(files))
	for _, p := range files {
		data, err := os.ReadFile(filepath.Join(cwd, p))
		if err != nil {
			return "", err
		}
		parts = append(parts, FormatNewFileDiff(p, string(data)))
	}
	return strings.Join(parts, "\n"), nil
}

// FormatNewFileDiff ports git.ts formatNewFileDiff.
func FormatNewFileDiff(path, content string) string {
	lines := strings.Split(content, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	out := []string{
		"diff --git a/" + path + " b/" + path,
		"new file mode 100644",
		"index 0000000..0000000",
		"--- /dev/null",
		"+++ b/" + path,
		"@@ -0,0 +1," + strconv.Itoa(max(len(lines), 1)) + " @@",
	}
	for _, l := range lines {
		out = append(out, "+"+l)
	}
	return strings.Join(out, "\n")
}
