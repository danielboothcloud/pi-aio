// Package piglaunch is the Go port of the aio-pig launch planner
// (recipes/pig-launch/plan.ts with the parts of recipes/trampoline.ts,
// recipes/continue.ts, recipes/trust.ts and recipes/pig-launch/pi-shim.ts it
// runs). It decides, before pig starts, how to start pig so that a recipe's
// extension set and model scope apply: pig cannot restart itself from an
// extension. cmd/aio-pig runs the plan and replaces itself with pig.
//
// The TypeScript planner stays the reference: testdata/gen-golden.ts records
// its plans through the same jiti alias bin/aio-pig.mjs uses, and the Go test
// replays them.
package piglaunch

import (
	"os"
	"path/filepath"
	"strings"
)

// Env is the launch environment. A key that is absent is unset.
type Env map[string]string

// jsSpace is the set String.prototype.trim removes.
const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func jsTrim(s string) string { return strings.Trim(s, jsSpace) }

// nonEmpty is pi-shim.ts nonEmpty: the trimmed value, "" when blank.
func nonEmpty(value string) string { return jsTrim(value) }

// Home is os.homedir(): $HOME, else the account's home directory.
func (e Env) Home() string {
	if home := e["HOME"]; home != "" {
		return home
	}
	home, _ := os.UserHomeDir()
	return home
}

// expandHome is pi-shim.ts expandHome.
func (e Env) expandHome(path string) string {
	if path == "~" {
		return e.Home()
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Join(e.Home(), path[2:])
	}
	return path
}

// resolvePath is pi-shim.ts resolvePath: path.resolve after ~ expansion.
func (e Env) resolvePath(path string) string {
	abs, err := filepath.Abs(e.expandHome(path))
	if err != nil {
		return filepath.Clean(path)
	}
	return abs
}

// SharedMode reports PIG_USE_PI_DIRS=1: PiG shares Pi's directories.
func (e Env) SharedMode() bool { return e["PIG_USE_PI_DIRS"] == "1" }

// ConfigRoot is PiG's configuration root in default mode.
func (e Env) ConfigRoot() string {
	if home := nonEmpty(e["PIG_HOME"]); home != "" {
		return e.resolvePath(home)
	}
	if xdg := nonEmpty(e["XDG_CONFIG_HOME"]); xdg != "" {
		return filepath.Join(e.resolvePath(xdg), "pig")
	}
	return filepath.Join(e.Home(), ".pig")
}

// AgentDir is PiG's agent directory: settings, sessions, and AIO's recipe files.
func (e Env) AgentDir() string {
	if e.SharedMode() {
		if pi := nonEmpty(e["PI_CODING_AGENT_DIR"]); pi != "" {
			return e.resolvePath(pi)
		}
		return filepath.Join(e.Home(), ".pi", "agent")
	}
	if own := nonEmpty(e["PIG_CODING_AGENT_DIR"]); own != "" {
		return e.resolvePath(own)
	}
	return filepath.Join(e.ConfigRoot(), "agent")
}

// SessionDirEnv is the session-directory variable PiG honors in the current mode.
func (e Env) SessionDirEnv() string {
	if e.SharedMode() {
		return nonEmpty(e["PI_CODING_AGENT_SESSION_DIR"])
	}
	return nonEmpty(e["PIG_CODING_AGENT_SESSION_DIR"])
}

// ConfigDirName is the project config directory name: `.pig`, or `.pi` in shared mode.
func (e Env) ConfigDirName() string {
	if e.SharedMode() {
		return ".pi"
	}
	return ".pig"
}
