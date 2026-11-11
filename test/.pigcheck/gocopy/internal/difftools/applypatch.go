package difftools

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// nodeError renders a file-system error as Node's fs message
// ("ENOENT: no such file or directory, open '<path>'"), which the
// TypeScript tools put into their error texts.
func nodeError(err error, syscallName, path string) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		if errors.Is(err, fs.ErrNotExist) {
			errno = syscall.ENOENT
		} else {
			return err.Error()
		}
	}
	code, text := "", errno.Error()
	switch errno {
	case syscall.ENOENT:
		code, text = "ENOENT", "no such file or directory"
	case syscall.EACCES:
		code, text = "EACCES", "permission denied"
	case syscall.EISDIR:
		code, text = "EISDIR", "illegal operation on a directory"
		return fmt.Sprintf("%s: %s, %s", code, text, "read")
	case syscall.ENOTDIR:
		code, text = "ENOTDIR", "not a directory"
	case syscall.EEXIST:
		code, text = "EEXIST", "file already exists"
	case syscall.EPERM:
		code, text = "EPERM", "operation not permitted"
	case syscall.EROFS:
		code, text = "EROFS", "read-only file system"
	default:
		return err.Error()
	}
	return fmt.Sprintf("%s: %s, %s '%s'", code, text, syscallName, path)
}

// AppliedChange is apply-patch.ts AppliedChange.
type AppliedChange struct {
	Path       string  `json:"path"`
	Action     string  `json:"action"`
	Bytes      *int    `json:"bytes,omitempty"`
	Diff       *string `json:"diff,omitempty"`
	MovePath   *string `json:"movePath,omitempty"`
	OldContent *string `json:"oldContent,omitempty"`
	NewContent *string `json:"newContent,omitempty"`
}

// ApplyPatchError is apply-patch.ts ApplyPatchError.
type ApplyPatchError struct {
	Path   string `json:"path"`
	Action string `json:"action"`
	Error  string `json:"error"`
}

// ApplyPatchResult is apply-patch.ts ApplyPatchResult.
type ApplyPatchResult struct {
	OK      bool              `json:"ok"`
	Applied []AppliedChange   `json:"applied"`
	Errors  []ApplyPatchError `json:"errors"`
}

type preparedChange struct {
	change   ApplyPatchChange
	applied  AppliedChange
	commit   func() error
	rollback func() error
}

type fileSnapshot struct {
	content string
	mode    fs.FileMode
}

// atomicWriteFile ports apply-patch.ts atomicWriteFile. A zero mode is
// Node's default (0o666 before the umask).
func atomicWriteFile(filePath, content string, mode fs.FileMode, tmpTag string) error {
	dir := filepath.Dir(filePath)
	tmp := filepath.Join(dir, "."+filepath.Base(filePath)+"."+tmpTag+"."+strconv.Itoa(os.Getpid())+".tmp")
	perm := mode.Perm()
	if mode == 0 {
		perm = 0o666
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return errors.New(nodeError(err, "open", tmp))
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return errors.New(nodeError(err, "write", tmp))
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filePath); err != nil {
		return fmt.Errorf("%s", strings.Replace(nodeError(err, "rename", tmp), "'"+tmp+"'", "'"+tmp+"' -> '"+filePath+"'", 1))
	}
	return nil
}

// readRegularFile ports apply-patch.ts readRegularFile.
func readRegularFile(filePath, label string) (fileSnapshot, error) {
	info, err := os.Lstat(filePath)
	if err != nil {
		return fileSnapshot{}, fmt.Errorf("%s not found: %s", label, filePath)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return fileSnapshot{}, fmt.Errorf("%s must not be a symbolic link: %s", label, filePath)
	}
	if !info.Mode().IsRegular() {
		return fileSnapshot{}, fmt.Errorf("%s must be a regular file: %s", label, filePath)
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fileSnapshot{}, errors.New(nodeError(err, "open", filePath))
	}
	return fileSnapshot{content: string(data), mode: info.Mode()}, nil
}

func pathExists(filePath string) bool {
	_, err := os.Lstat(filePath)
	return err == nil
}

func intPtr(n int) *int { return &n }

// mkdirAll is fs.promises.mkdir(dir, { recursive: true }): an existing
// non-directory on the way is Node's EEXIST for the requested path.
func mkdirAll(dir string) error {
	err := os.MkdirAll(dir, 0o777)
	if err == nil {
		return nil
	}
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("EEXIST: file already exists, mkdir '%s'", dir)
	}
	return errors.New(nodeError(err, "mkdir", dir))
}

func prepareAdd(c ApplyPatchChange) (*preparedChange, error) {
	if pathExists(c.Path) {
		return nil, fmt.Errorf("add target already exists: %s", c.Path)
	}
	content := ""
	if c.Content != nil {
		content = *c.Content
	}
	final := content
	if !strings.HasSuffix(final, "\n") {
		final += "\n"
	}
	return &preparedChange{
		change:  c,
		applied: AppliedChange{Path: c.Path, Action: "add", Bytes: intPtr(len(final)), NewContent: &final},
		commit: func() error {
			if err := mkdirAll(filepath.Dir(c.Path)); err != nil {
				return err
			}
			return atomicWriteFile(c.Path, final, 0, "pi-apply-patch")
		},
		rollback: func() error {
			if err := os.Remove(c.Path); err != nil {
				return errors.New(nodeError(err, "unlink", c.Path))
			}
			return nil
		},
	}, nil
}

func prepareUpdate(c ApplyPatchChange) (*preparedChange, error) {
	if c.OldText == nil || *c.OldText == "" {
		return nil, errors.New("update requires oldText")
	}
	newText := ""
	if c.NewText != nil {
		newText = *c.NewText
	}
	if c.NewText != nil && *c.OldText == *c.NewText {
		return nil, errors.New("oldText and newText are identical — no change")
	}
	original, err := readRegularFile(c.Path, "update target")
	if err != nil {
		return nil, err
	}
	result := ReplaceForPatch(original.content, *c.OldText, newText)
	if !result.Changed {
		return nil, fmt.Errorf("oldText not found in %s", c.Path)
	}
	newContent := result.Content
	oldContent := original.content
	return &preparedChange{
		change: c,
		applied: AppliedChange{
			Path: c.Path, Action: "update", Diff: generateDiff(original.content, newContent),
			Bytes: intPtr(len(newContent)), OldContent: &oldContent, NewContent: &newContent,
		},
		commit:   func() error { return atomicWriteFile(c.Path, newContent, original.mode, "pi-apply-patch") },
		rollback: func() error { return atomicWriteFile(c.Path, original.content, original.mode, "pi-apply-patch") },
	}, nil
}

func prepareDelete(c ApplyPatchChange) (*preparedChange, error) {
	original, err := readRegularFile(c.Path, "delete target")
	if err != nil {
		return nil, err
	}
	oldContent := original.content
	return &preparedChange{
		change:  c,
		applied: AppliedChange{Path: c.Path, Action: "delete", OldContent: &oldContent},
		commit: func() error {
			if err := os.Remove(c.Path); err != nil {
				return errors.New(nodeError(err, "unlink", c.Path))
			}
			return nil
		},
		rollback: func() error { return atomicWriteFile(c.Path, original.content, original.mode, "pi-apply-patch") },
	}, nil
}

func prepareMove(c ApplyPatchChange) (*preparedChange, error) {
	if c.MovePath == nil || *c.MovePath == "" {
		return nil, errors.New("move requires movePath")
	}
	movePath := *c.MovePath
	if _, err := readRegularFile(c.Path, "move source"); err != nil {
		return nil, err
	}
	if pathExists(movePath) {
		return nil, fmt.Errorf("move destination already exists: %s", movePath)
	}
	return &preparedChange{
		change:  c,
		applied: AppliedChange{Path: c.Path, Action: "move", MovePath: &movePath},
		commit: func() error {
			if err := mkdirAll(filepath.Dir(movePath)); err != nil {
				return err
			}
			if err := os.Rename(c.Path, movePath); err != nil {
				return errors.New(nodeError(err, "rename", c.Path))
			}
			return nil
		},
		rollback: func() error { return os.Rename(movePath, c.Path) },
	}, nil
}

func prepareChange(c ApplyPatchChange) (*preparedChange, error) {
	switch c.Action {
	case "add":
		return prepareAdd(c)
	case "update":
		return prepareUpdate(c)
	case "delete":
		return prepareDelete(c)
	case "move":
		return prepareMove(c)
	}
	return nil, fmt.Errorf("unknown action: %s", c.Action)
}

// generateDiff ports apply-patch.ts generateDiff (the simple UI diff).
func generateDiff(oldContent, newContent string) *string {
	if oldContent == newContent {
		return nil
	}
	oldLines, newLines := strings.Split(oldContent, "\n"), strings.Split(newContent, "\n")
	var b strings.Builder
	changed := false
	for i := 0; i < max(len(oldLines), len(newLines)); i++ {
		o, n := "", ""
		if i < len(oldLines) {
			o = oldLines[i]
		}
		if i < len(newLines) {
			n = newLines[i]
		}
		if o != n {
			if o != "" {
				b.WriteString("- " + o + "\n")
			}
			if n != "" {
				b.WriteString("+ " + n + "\n")
			}
			changed = true
		} else if o != "" {
			b.WriteString("  " + o + "\n")
		}
	}
	if !changed {
		return nil
	}
	s := b.String()
	return &s
}

func resolveAbs(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return abs
}

// prepareApplyPatchChanges ports prepareApplyPatchChanges.
func prepareApplyPatchChanges(changes []ApplyPatchChange) ([]*preparedChange, []ApplyPatchError) {
	var prepared []*preparedChange
	errs := []ApplyPatchError{}
	claimed := map[string]bool{}
	for _, c := range changes {
		paths := []string{c.Path}
		if c.Action == "move" && c.MovePath != nil && *c.MovePath != "" {
			paths = append(paths, *c.MovePath)
		}
		dup := false
		for i, p := range paths {
			paths[i] = resolveAbs(p)
			if claimed[paths[i]] {
				dup = true
			}
		}
		if dup {
			errs = append(errs, ApplyPatchError{c.Path, c.Action, "each source and destination path may appear only once per patch"})
			continue
		}
		for _, p := range paths {
			claimed[p] = true
		}
		p, err := prepareChange(c)
		if err != nil {
			errs = append(errs, ApplyPatchError{c.Path, c.Action, err.Error()})
			continue
		}
		prepared = append(prepared, p)
	}
	return prepared, errs
}

func appliedOf(prepared []*preparedChange) []AppliedChange {
	out := make([]AppliedChange, len(prepared))
	for i, p := range prepared {
		out[i] = p.applied
	}
	return out
}

// PreviewApplyPatch ports previewApplyPatch: validate without writing.
func PreviewApplyPatch(changes []ApplyPatchChange) ApplyPatchResult {
	prepared, errs := prepareApplyPatchChanges(changes)
	if len(errs) > 0 {
		return ApplyPatchResult{Applied: []AppliedChange{}, Errors: errs}
	}
	return ApplyPatchResult{OK: true, Applied: appliedOf(prepared), Errors: []ApplyPatchError{}}
}

// ExecuteApplyPatch ports executeApplyPatch: prepare everything, commit in
// order, and roll back committed changes when one fails.
func ExecuteApplyPatch(changes []ApplyPatchChange) ApplyPatchResult {
	prepared, errs := prepareApplyPatchChanges(changes)
	if len(errs) > 0 {
		return ApplyPatchResult{Applied: []AppliedChange{}, Errors: errs}
	}
	committed := 0
	for _, p := range prepared {
		if err := p.commit(); err != nil {
			for i := committed - 1; i >= 0; i-- {
				if rbErr := prepared[i].rollback(); rbErr != nil {
					errs = append(errs, ApplyPatchError{prepared[i].change.Path, prepared[i].change.Action, "rollback failed: " + rbErr.Error()})
				}
			}
			failed := ApplyPatchError{p.change.Path, p.change.Action, err.Error()}
			return ApplyPatchResult{Applied: []AppliedChange{}, Errors: append([]ApplyPatchError{failed}, errs...)}
		}
		committed++
	}
	return ApplyPatchResult{OK: true, Applied: appliedOf(prepared), Errors: []ApplyPatchError{}}
}

// FormatApplyPatchResult ports formatApplyPatchResult.
func FormatApplyPatchResult(r ApplyPatchResult) string {
	var lines []string
	if len(r.Applied) > 0 {
		lines = append(lines, fmt.Sprintf("Applied %d change(s):", len(r.Applied)))
		for _, c := range r.Applied {
			switch c.Action {
			case "add":
				lines = append(lines, "  A "+c.Path)
			case "update":
				lines = append(lines, "  M "+c.Path)
			case "delete":
				lines = append(lines, "  D "+c.Path)
			case "move":
				move := "undefined"
				if c.MovePath != nil {
					move = *c.MovePath
				}
				lines = append(lines, "  M "+c.Path+" -> "+move)
			}
		}
	}
	if len(r.Errors) > 0 {
		lines = append(lines, fmt.Sprintf("\nFailed %d change(s):", len(r.Errors)))
		for _, e := range r.Errors {
			lines = append(lines, "  ["+e.Action+"] "+e.Path+": "+e.Error)
		}
	}
	return strings.Join(lines, "\n")
}
