package subagents

// Port of subagents/extensions.ts: the extension set a child loads mirrors
// the parent's own flags. The parent's argv comes from pig's
// PIG_HARNESS_ARGV_FILE (see piargs.HarnessArgv).

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/piargs"
)

var packageSource = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*:`)

// ExtensionEnv is the environment the launch reads.
type ExtensionEnv struct {
	// AioPath is the AIO entry a -ne child must load (the Go extension
	// directory). Empty when unknown: the parent's -e list then already
	// carries AIO, because a -ne parent loads only what it lists.
	AioPath string
	// Extra is AIO_SUBAGENT_EXTRA_EXTENSIONS.
	Extra string
	// CursorExtension is the pi-cursor-sdk entry, or "".
	CursorExtension string
	// Exists reports whether a path exists (os.Stat by default).
	Exists func(string) bool
}

func (e ExtensionEnv) exists(path string) bool {
	if e.Exists != nil {
		return e.Exists(path)
	}
	return exists(path)
}

// ParentFlags is parentExtensionFlags: local paths resolve against cwd,
// package specs (npm:, git:, builtin:) pass through.
func ParentFlags(argv []string, cwd string) (noExtensions bool, extensions []string) {
	parsed := piargs.Parse(argv)
	for _, entry := range parsed.Extensions {
		if packageSource.MatchString(entry) {
			extensions = append(extensions, entry)
		} else {
			extensions = append(extensions, resolvePath(cwd, entry))
		}
	}
	return parsed.NoExtensions, extensions
}

// resolvePath is path.resolve(cwd, entry).
func resolvePath(cwd, entry string) string {
	if strings.HasPrefix(entry, "~") {
		// path.resolve does not expand "~": it is a relative segment.
		return filepath.Join(cwd, entry)
	}
	if filepath.IsAbs(entry) {
		return filepath.Clean(entry)
	}
	return filepath.Join(cwd, entry)
}

func extraExtensionPaths(raw string) []string {
	var out []string
	for _, entry := range strings.Split(strings.TrimSpace(raw), ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			out = append(out, entry)
		}
	}
	return out
}

// ResolveChildExtensionLaunch is resolveChildExtensionLaunch.
func ResolveChildExtensionLaunch(argv []string, cwd, modelProvider string, env ExtensionEnv) ExtensionLaunch {
	noExtensions, parentExtensions := ParentFlags(argv, cwd)
	paths := []string{}
	aioListed := false
	add := func(entry string) {
		// The AIO entry stays first; a parent entry that names the same
		// extension (trailing slash, symlink) is the same load.
		if aioListed && sameAioEntry([]string{entry}, env.AioPath) {
			return
		}
		if !slices.Contains(paths, entry) {
			paths = append(paths, entry)
		}
	}
	if noExtensions && env.AioPath != "" {
		add(env.AioPath)
		aioListed = true
	}
	for _, entry := range parentExtensions {
		add(entry)
	}
	if noExtensions && modelProvider == "cursor" && env.CursorExtension != "" {
		add(env.CursorExtension)
	}
	for _, extra := range extraExtensionPaths(env.Extra) {
		if env.exists(extra) {
			add(extra)
		}
	}
	return EnforceChildExtensions(ExtensionLaunch{NoExtensions: noExtensions, Paths: paths}, env.AioPath)
}

// sameAioEntry reports whether the parent already lists the AIO entry (the
// Go extension directory may be listed with a trailing slash or a symlink).
func sameAioEntry(entries []string, aio string) bool {
	want := canonical(aio)
	for _, entry := range entries {
		if canonical(entry) == want {
			return true
		}
	}
	return false
}

func canonical(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

// EnforceChildExtensions is enforceChildExtensions: a -ne child always
// lists AIO. With an unknown AIO path the list is kept as it is.
func EnforceChildExtensions(launch ExtensionLaunch, aio string) ExtensionLaunch {
	paths := slices.Clone(launch.Paths)
	if paths == nil {
		paths = []string{}
	}
	if !launch.NoExtensions || aio == "" || slices.Contains(paths, aio) || sameAioEntry(paths, aio) {
		return ExtensionLaunch{NoExtensions: launch.NoExtensions, Paths: paths}
	}
	return ExtensionLaunch{NoExtensions: true, Paths: append([]string{aio}, paths...)}
}

// ChildSupportsModel is childSupportsModel.
func ChildSupportsModel(launch ExtensionLaunch, model, cursorExtension string) bool {
	if !strings.HasPrefix(model, "cursor/") || !launch.NoExtensions {
		return true
	}
	return cursorExtension != "" && slices.Contains(launch.Paths, cursorExtension)
}

// ResolveCursorExtensionPath is resolveCursorExtensionPath.
func ResolveCursorExtensionPath(home, agentDir string) string {
	if fromEnv := strings.TrimSpace(os.Getenv("AIO_SUBAGENT_CURSOR_EXTENSION")); fromEnv != "" && exists(fromEnv) {
		return fromEnv
	}
	candidates := []string{
		filepath.Join(home, ".config", "pi", "npm", "node_modules", "pi-cursor-sdk", "src", "index.ts"),
		filepath.Join(home, ".config", "pi", "npm", "node_modules", "pi-cursor-sdk", "dist", "index.js"),
	}
	if agentDir != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(agentDir), "npm", "node_modules", "pi-cursor-sdk", "src", "index.ts"))
	}
	for _, candidate := range candidates {
		if exists(candidate) {
			return candidate
		}
	}
	return ""
}
