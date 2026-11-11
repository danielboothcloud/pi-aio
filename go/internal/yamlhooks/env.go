package yamlhooks

// Environment surface (port of yaml-hooks/env.ts) and Node-style file
// system helpers (path.resolve, realpath, error texts).

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// isEnvEnabled is env.ts isEnvEnabled: true only for the literal "1".
func isEnvEnabled(name string) bool { return os.Getenv(name) == "1" }

// isEnvDisabled is env.ts isEnvDisabled: 0/false/off/no.
func isEnvDisabled(name string) bool {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return false
	}
	switch strings.ToLower(jsstr.Trim(raw)) {
	case "0", "false", "off", "no":
		return true
	}
	return false
}

// positiveIntEnv is env.ts positiveIntEnv (Number.parseInt semantics).
func positiveIntEnv(name string) (int, bool) {
	raw := os.Getenv(name)
	if raw == "" {
		return 0, false
	}
	s := strings.TrimLeftFunc(raw, jsstr.IsJSSpace)
	end := 0
	if end < len(s) && (s[end] == '+' || s[end] == '-') {
		end++
	}
	digits := end
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == digits {
		return 0, false
	}
	n, err := strconv.Atoi(s[:end])
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

func envBashExecutable() string {
	if v := os.Getenv("PI_YAML_HOOKS_BASH_EXECUTABLE"); v != "" {
		return v
	}
	if v := os.Getenv("OPENCODE_HOOKS_BASH_EXECUTABLE"); v != "" {
		return v
	}
	return "bash"
}

func envOr(name string, fallback int) int {
	if n, ok := positiveIntEnv(name); ok {
		return n
	}
	return fallback
}

func envMaxOutputBytes() int      { return envOr("PI_YAML_HOOKS_MAX_OUTPUT_BYTES", 1_048_576) }
func envMaxStdinBytes() int       { return envOr("PI_YAML_HOOKS_MAX_STDIN_BYTES", 262_144) }
func envMaxAsyncPending() int     { return envOr("PI_YAML_HOOKS_ASYNC_MAX_PENDING", 1_000) }
func envAsyncWatchdogMs() int     { n, _ := positiveIntEnv("PI_YAML_HOOKS_ASYNC_WATCHDOG_MS"); return n }
func envConfirmAutoApprove() bool { return isEnvEnabled("PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE") }
func envTrustProject() bool       { return isEnvEnabled("PI_YAML_HOOKS_TRUST_PROJECT") }
func envAllowGlobalImports() bool {
	return isEnvEnabled("PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS")
}
func envAllowPackageImports() bool {
	return isEnvEnabled("PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS")
}
func envAllowProjectImportsOutsideAnchor() bool {
	return isEnvEnabled("PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR")
}

// resolvePath is path.resolve(p) against the process working directory.
func resolvePath(parts ...string) string {
	p := ""
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] == "" {
			continue
		}
		if p == "" {
			p = parts[i]
		} else {
			p = parts[i] + "/" + p
		}
		if strings.HasPrefix(parts[i], "/") {
			return filepath.Clean(p)
		}
	}
	wd, _ := os.Getwd()
	if p == "" {
		return filepath.Clean(wd)
	}
	return filepath.Clean(wd + "/" + p)
}

// relativePath is path.relative(from, to) for absolute posix paths.
func relativePath(from, to string) string {
	from, to = resolvePath(from), resolvePath(to)
	if from == to {
		return ""
	}
	rel, err := filepath.Rel(from, to)
	if err != nil {
		return to
	}
	if rel == "." {
		return ""
	}
	return rel
}

// realpath is fs.realpathSync: the symlink-free absolute path.
func realpath(p string) (string, error) {
	abs := resolvePath(p)
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

// canonicalizePath is canonicalize.ts canonicalizePath.
func canonicalizePath(filePath string) string {
	if r, err := realpath(filePath); err == nil {
		return r
	}
	start := resolvePath(filePath)
	current := start
	for depth := 0; depth < 32; depth++ {
		if r, err := realpath(current); err == nil {
			return r
		}
		parent := filepath.Dir(current)
		if parent == current {
			return start
		}
		if r, err := realpath(parent); err == nil {
			return filepath.Join(r, filepath.Base(current))
		}
		current = parent
	}
	return start
}

// isFile is statSync(p).isFile() with errors as false.
func isFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}

// existsPath is fs.existsSync.
func existsPath(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

type nodeErr struct{ msg string }

func (e nodeErr) Error() string { return e.msg }

var errnoText = map[string]string{
	"ENOENT":  "no such file or directory",
	"EACCES":  "permission denied",
	"ENOTDIR": "not a directory",
	"EISDIR":  "illegal operation on a directory",
	"ELOOP":   "too many symbolic links encountered",
	"EPERM":   "operation not permitted",
}

func nodeError(code, syscallName, path string) error {
	msg := code + ": " + errnoText[code] + ", " + syscallName
	if path != "" {
		msg += " '" + path + "'"
	}
	return nodeErr{msg}
}

// nodeFsError renders a Go file error with Node's text, for example
// "ENOENT: no such file or directory, open '/x'".
func nodeFsError(err error, syscallName, path string) error {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case syscall.ENOENT:
			return nodeError("ENOENT", syscallName, path)
		case syscall.EACCES:
			return nodeError("EACCES", syscallName, path)
		case syscall.ENOTDIR:
			return nodeError("ENOTDIR", syscallName, path)
		case syscall.EISDIR:
			return nodeError("EISDIR", syscallName, "")
		case syscall.ELOOP:
			return nodeError("ELOOP", syscallName, path)
		case syscall.EPERM:
			return nodeError("EPERM", syscallName, path)
		}
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nodeError("ENOENT", syscallName, path)
	}
	return fmt.Errorf("%v", err)
}
