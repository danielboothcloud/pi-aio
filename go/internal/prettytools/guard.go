package prettytools

// Port of grep-guard.ts and grepGuardMessage (tools/bash.ts).

import (
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/blocklist"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// gnuGrepNames are GNU grep executable names.
var gnuGrepNames = map[string]bool{"grep": true, "egrep": true, "fgrep": true, "ggrep": true}

// rgShortValueFlags are ripgrep short options that take a value.
var rgShortValueFlags = map[byte]bool{'A': true, 'B': true, 'C': true, 'd': true, 'E': true, 'e': true, 'f': true, 'g': true, 'j': true, 'm': true, 'M': true, 'r': true, 't': true, 'T': true}

// rgLongValueFlags are ripgrep long options that take a value.
var rgLongValueFlags = map[string]bool{}

func init() {
	for _, f := range []string{"--after-context", "--before-context", "--color", "--colors", "--context", "--context-separator",
		"--dfa-size-limit", "--encoding", "--engine", "--field-context-separator", "--field-match-separator", "--file",
		"--generate", "--glob", "--hostname-bin", "--hyperlink-format", "--iglob", "--ignore-file", "--max-columns",
		"--max-count", "--max-depth", "--max-filesize", "--path-separator", "--pre", "--pre-glob", "--regex-size-limit",
		"--regexp", "--replace", "--sort", "--sortr", "--threads", "--type", "--type-add", "--type-clear", "--type-not"} {
		rgLongValueFlags[f] = true
	}
}

func lastSegment(value string) string {
	return value[strings.LastIndex(value, "/")+1:]
}

// argvs is the argv of every simple command, or none when the command
// cannot be segmented (the guard fails open).
func argvs(command string) [][]string {
	out, ok := blocklist.Argvs(command)
	if !ok {
		return nil
	}
	return out
}

// FindGnuGrepInvocation ports findGnuGrepInvocation: the GNU grep
// executable token of a command that runs GNU grep, or "".
func FindGnuGrepInvocation(command string) string {
	for _, argv := range argvs(command) {
		if len(argv) > 0 && argv[0] != "" && gnuGrepNames[lastSegment(argv[0])] {
			return argv[0]
		}
	}
	return ""
}

// RgReplaceMisuse is a ripgrep short-option cluster where -r swallowed
// letters meant as flags.
type RgReplaceMisuse struct {
	Flag        string `json:"flag"`
	Replacement string `json:"replacement"`
}

func rgArgs(argv []string) ([]string, bool) {
	if len(argv) == 0 {
		return nil, false
	}
	first := lastSegment(argv[0])
	if first == "rg" {
		return argv[1:], true
	}
	if first == "rtk" && len(argv) > 1 && argv[1] == "rg" {
		return argv[2:], true
	}
	return nil, false
}

var lettersRe = regexp.MustCompile(`^[A-Za-z]+$`)

// findMisuseInArgs ports findMisuseInArgs. Characters are UTF-16 units in
// TypeScript; option letters are ASCII, so bytes give the same result for
// every cluster that can match.
func findMisuseInArgs(args []string) *RgReplaceMisuse {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return nil
		}
		if strings.HasPrefix(arg, "--") {
			if !strings.Contains(arg, "=") && rgLongValueFlags[arg] {
				i++
			}
			continue
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			continue
		}
		for c := 1; c < len(arg); c++ {
			flag := arg[c]
			if !rgShortValueFlags[flag] {
				continue
			}
			attached := arg[c+1:]
			if flag == 'r' && lettersRe.MatchString(attached) {
				return &RgReplaceMisuse{Flag: arg, Replacement: attached}
			}
			if attached == "" {
				i++
			}
			break
		}
	}
	return nil
}

// FindRgReplaceMisuse ports findRgReplaceMisuse.
func FindRgReplaceMisuse(command string) *RgReplaceMisuse {
	for _, argv := range argvs(command) {
		args, ok := rgArgs(argv)
		if !ok {
			continue
		}
		if m := findMisuseInArgs(args); m != nil {
			return m
		}
	}
	return nil
}

// GrepGuardMessage ports grepGuardMessage: the error text when the guard
// blocks a command, or "".
func GrepGuardMessage(command string) string {
	if gnu := FindGnuGrepInvocation(command); gnu != "" {
		return strings.Join([]string{
			"Blocked GNU grep invocation: `" + gnu + "`. Use the grep tool instead — it runs ripgrep (rg).",
			`If you need shell search, run: rg -n "pattern"`,
			"Set PRETTY_BASH_GREP_GUARD=0 to disable this guard.",
		}, "\n")
	}
	if m := FindRgReplaceMisuse(command); m != nil {
		return strings.Join([]string{
			"Blocked `rg " + m.Flag + "`: in ripgrep, -r means --replace, so every match would be printed as \"" + m.Replacement + "\".",
			`rg already searches recursively. Drop -r and run: rg -n "pattern" [path]`,
			"To replace matches on purpose, use --replace=TEXT.",
			"Set PRETTY_BASH_GREP_GUARD=0 to disable this guard.",
		}, "\n")
	}
	return ""
}

// NormalizeFindGlobPattern ports normalizeFindGlobPattern.
func NormalizeFindGlobPattern(pattern string) string {
	p := strings.TrimFunc(pattern, jsstr.IsJSSpace)
	if p == "" || p == "**/*" {
		return p
	}
	if strings.Contains(p, "/") || strings.HasPrefix(p, "**/") {
		return p
	}
	if strings.ContainsAny(p, "*?[]") {
		return "**/" + p
	}
	return p
}

// IsLikelyGlobPattern ports isLikelyGlobPattern.
func IsLikelyGlobPattern(pattern string) bool {
	p := strings.TrimFunc(pattern, jsstr.IsJSSpace)
	if p == "" {
		return false
	}
	return strings.ContainsAny(p, "*?[]") || p == "**/*" || strings.HasPrefix(p, "**/")
}
