// Package permissionmodes is the Go port of permission-modes/: the
// default/ask/plan/auto modes, the read-only shell allowlist, the workspace
// guard, the plan todo list, and the tool_call gate. It does not import the
// PiG SDK; go/aio wires it to the host.
//
// Regex note: the TypeScript patterns use JavaScript syntax. This port uses
// Go's RE2 regexp with equivalent boolean forms (a lookahead at the end of a
// match becomes a consumed character class) and an explicit JavaScript
// whitespace class, because Go's \s lacks \v and the Unicode spaces.
package permissionmodes

import (
	"regexp"
	"strings"
)

// jsSpace is the character set of JavaScript's \s (non-Unicode mode).
const jsSpace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// js compiles a pattern after it replaces \s and \S with JavaScript's
// whitespace set. Inside a character class, \s inserts the bare set.
func js(pattern string) *regexp.Regexp {
	var out strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		if c == '\\' && i+1 < len(pattern) {
			next := pattern[i+1]
			i++
			switch {
			case next == 's' && inClass:
				out.WriteString(jsSpace)
			case next == 's':
				out.WriteString("[" + jsSpace + "]")
			case next == 'S' && !inClass:
				out.WriteString("[^" + jsSpace + "]")
			default:
				out.WriteByte('\\')
				out.WriteByte(next)
			}
			continue
		}
		if c == '[' {
			inClass = true
		} else if c == ']' {
			inClass = false
		}
		out.WriteByte(c)
	}
	return regexp.MustCompile(out.String())
}

// DestructivePatterns mark a shell command as mutating.
var DestructivePatterns = []*regexp.Regexp{
	js(`(?i)\brm\b`),
	js(`(?i)\brmdir\b`),
	js(`(?i)\bmv\b`),
	js(`(?i)\bcp\b`),
	js(`(?i)\bmkdir\b`),
	js(`(?i)\btouch\b`),
	js(`(?i)\bchmod\b`),
	js(`(?i)\bchown\b`),
	js(`(?i)\bchgrp\b`),
	js(`(?i)\bln\b`),
	js(`(?i)\btee\b`),
	js(`(?i)\btruncate\b`),
	js(`(?i)\bdd\b`),
	js(`(?i)\bshred\b`),
	// JS: /(^|[^<])>(?!>)/ — the lookahead becomes "a non-> character or the end".
	js(`(^|[^<])>([^>]|$)`),
	js(`>>`),
	js(`(?i)\bnpm\s+(install|uninstall|update|ci|link|publish)`),
	js(`(?i)\byarn\s+(add|remove|install|publish)`),
	js(`(?i)\bpnpm\s+(add|remove|install|publish)`),
	js(`(?i)\bpip\s+(install|uninstall)`),
	js(`(?i)\bapt(-get)?\s+(install|remove|purge|update|upgrade)`),
	js(`(?i)\bbrew\s+(install|uninstall|upgrade)`),
	js(`(?i)\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)`),
	js(`(?i)\bsudo\b`),
	js(`(?i)\bsu\b`),
	js(`(?i)\bkill\b`),
	js(`(?i)\bpkill\b`),
	js(`(?i)\bkillall\b`),
	js(`(?i)\breboot\b`),
	js(`(?i)\bshutdown\b`),
	js(`(?i)\bsystemctl\s+(start|stop|restart|enable|disable)`),
	js(`(?i)\bservice\s+\S+\s+(start|stop|restart)`),
	js(`(?i)\b(vim?|nano|emacs|code|subl)\b`),
}

// SafePatterns is the deliberately narrow read-only allowlist. Programs with
// write or exec options (env, find, awk, sed, curl, package managers, pagers)
// and git diff/log/show (implicit external helpers) need approval.
var SafePatterns = []*regexp.Regexp{
	// JS lookahead (?=\s|$) becomes (\s|$): a boolean test only.
	js(`^\s*(cat|head|tail|grep|ls|pwd|echo|printf|wc|diff|stat|du|df|which|whereis|type|printenv|uname|whoami|id|cal|uptime|ps|free|rg|eza)(\s|$)`),
	js(`^\s*git\s+(status|ls-files|ls-tree)(\s|$)`),
	js(`^\s*git\s+branch(?:\s+(?:--show-current|--list|-a|-r|-v|--all|--remotes))*\s*$`),
	js(`^\s*git\s+remote(?:\s+(?:-v|--verbose))?\s*$`),
	js(`^\s*(node|python(?:\d+(?:\.\d+)?)?)\s+--version\s*$`),
}

var (
	outputFlagRe  = js(`--(?:output|pre|hostname-bin|ext-diff|textconv)(?:[=\s]|$)`)
	shortOFlagRe  = js(`\s-[^-\s]*o`)
	unsafeCharSet = ";&|`$<>()\\\r\n{}*?[]"
)

func anyMatch(patterns []*regexp.Regexp, s string) bool {
	for _, p := range patterns {
		if p.MatchString(s) {
			return true
		}
	}
	return false
}

// IsSafeCommand reports whether a shell command is on the read-only allowlist.
// It is an approval allowlist, not a shell parser: scripts, compound commands,
// expansions, and quoted metacharacters all take the conservative path.
func IsSafeCommand(command string) bool {
	if strings.ContainsAny(command, unsafeCharSet) {
		return false
	}
	for _, r := range command {
		if r <= 0x1f || r == 0x7f {
			return false
		}
	}
	// Strip quotes so --p''re and --out"put" cannot hide execution or output flags.
	unquoted := strings.NewReplacer(`"`, "", `'`, "").Replace(command)
	if outputFlagRe.MatchString(unquoted) || shortOFlagRe.MatchString(unquoted) {
		return false
	}
	return !anyMatch(DestructivePatterns, command) && anyMatch(SafePatterns, command)
}

// IsDestructiveCommand reports whether a command matches a destructive pattern.
func IsDestructiveCommand(command string) bool { return anyMatch(DestructivePatterns, command) }

// IsShellTool reports whether a tool runs shell commands. Gate both surfaces.
func IsShellTool(name string) bool { return name == "bash" || name == "hypa_shell" }
