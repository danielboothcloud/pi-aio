// Package rtk is the Go port of rtk/: agent bash commands are routed
// through `rtk rewrite` to cut token use. RTK_DISABLED cannot switch it
// off. This package does not import the PiG SDK.
package rtk

import (
	"regexp"
	"strings"
)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// s is JavaScript's \s as an RE2 class body.
const s = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	prefixRe   = regexp.MustCompile(`(^|(?:&&|\|\||;|\|)[` + s + `]*)((?:env[` + s + `]+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^` + s + `]+[` + s + `]+)+)`)
	disabledRe = regexp.MustCompile(`\bRTK_DISABLED=1[` + s + `]+`)
	bareEnvRe  = regexp.MustCompile(`^[` + s + `]*env[` + s + `]*$`)
)

// RemoveDisabledPrefix drops RTK_DISABLED=1 assignments from command
// prefixes (and a bare `env` left behind), so routing stays enforced.
func RemoveDisabledPrefix(command string) string {
	return prefixRe.ReplaceAllStringFunc(command, func(match string) string {
		parts := prefixRe.FindStringSubmatch(match)
		cleaned := disabledRe.ReplaceAllString(parts[2], "")
		if bareEnvRe.MatchString(cleaned) {
			cleaned = ""
		}
		return parts[1] + cleaned
	})
}

// ShouldSkip reports whether a command already runs through rtk.
func ShouldSkip(command string) bool {
	trimmed := strings.TrimLeft(command, jsSpace)
	return trimmed == "rtk" || strings.HasPrefix(trimmed, "rtk ")
}

// Prepare returns the command to rewrite, or ok=false when rtk must not touch it.
func Prepare(command string) (string, bool) {
	enforced := RemoveDisabledPrefix(command)
	if ShouldSkip(enforced) {
		return "", false
	}
	return enforced, true
}

// Result interprets an `rtk rewrite` run: exit 0 (rewrite) or 3 (advisory)
// with non-empty stdout that differs from the input is a rewrite.
func Result(input, stdout string, code int, killed bool) (string, bool) {
	if killed || (code != 0 && code != 3) {
		return "", false
	}
	out := strings.TrimRight(stdout, jsSpace)
	if out == "" || out == input {
		return "", false
	}
	return out, true
}

// Unavailable messages for a missing or non-executable binary.
const (
	MissingMessage      = "[aio-rtk] rtk binary not found on PATH. Shell command rewrites are disabled. Install rtk: https://github.com/rtk-ai/rtk#installation"
	UnexecutableMessage = "[aio-rtk] rtk binary found on PATH but is not executable. Shell command rewrites are disabled. Run: chmod +x $(command -v rtk)"
)

// StatusReport is the /rtk status text.
func StatusReport(binary string) string {
	return "Routing: enforced\nBinary: " + binary + "\nNative fallback is used only when RTK has no equivalent or cannot execute."
}

// SubcommandError is the /rtk error for an unknown subcommand.
const SubcommandError = "RTK routing is enforced. The only subcommand is /rtk status."
