// Package nvim is the Go port of nvim/core.ts: `/nvim` opens files in
// Neovim in a new Otty pane (then tmux, Otty tab, Terminal.app, or a printed
// command). It is user-initiated only; it owns no agent tool. No SDK imports.
package nvim

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/toolpaths"
)

// Binary is the Neovim executable.
const Binary = "nvim"

// Request is one file to open.
type Request struct {
	Path     string `json:"path"`
	Line     int    `json:"line,omitempty"`
	Column   int    `json:"column,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

// Attempt is one launcher in the plan.
type Attempt struct {
	Mode   string `json:"mode"` // otty-split, tmux, otty-tab, macos, print
	Reason string `json:"reason"`
}

// Plan is planNvimLaunchAttempts.
func Plan(env map[string]string, platform string) []Attempt {
	var out []Attempt
	if env["OTTY_PANE_ID"] != "" {
		out = append(out, Attempt{"otty-split", "splitting the current Otty pane so the file opens beside this session"})
	}
	if env["TMUX"] != "" {
		out = append(out, Attempt{"tmux", "opening in a new tmux window"})
	}
	out = append(out, Attempt{"otty-tab", "opening a new tab in the running Otty app"})
	if platform == "darwin" {
		out = append(out, Attempt{"macos", "opening in Terminal.app"})
	}
	return append(out, Attempt{"print", "no terminal launcher available; run this command yourself"})
}

// Args is buildNvimArgs.
func Args(r Request) []string {
	var args []string
	if r.ReadOnly {
		args = append(args, "-R")
	}
	if r.Line >= 1 {
		if r.Column >= 1 {
			args = append(args, fmt.Sprintf("+%d,%d", r.Line, r.Column))
		} else {
			args = append(args, fmt.Sprintf("+%d", r.Line))
		}
	}
	return append(args, "--", r.Path)
}

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func trim(s string) string { return strings.Trim(s, jsSpace) }

// The JavaScript pattern /^(.+?):(\d+)(?::(\d+))?$/ ends with optional
// groups, so RE2 matches it with a non-greedy first group the same way.
var targetRe = regexp.MustCompile(`^(.+?):(\d+)(?::(\d+))?$`)

// ParseTarget reads "path", "path:42", or "path:42:7".
func ParseTarget(target string) (path string, line, column int) {
	t := trim(target)
	m := targetRe.FindStringSubmatch(t)
	if m == nil || strings.ContainsAny(t, "\n\r\u2028\u2029") {
		return t, 0, 0
	}
	if n, err := strconv.Atoi(m[2]); err == nil && n >= 1 {
		line = n
	}
	if m[3] != "" {
		if n, err := strconv.Atoi(m[3]); err == nil && n >= 1 {
			column = n
		}
	}
	return m[1], line, column
}

var quotedAtRe = regexp.MustCompile(`^@"([^"]*)"$`)

// StripAt removes an @-reference wrapper (`@path` or `@"path"`).
func StripAt(token string) string {
	t := trim(token)
	if m := quotedAtRe.FindStringSubmatch(t); m != nil {
		return m[1]
	}
	return strings.TrimPrefix(t, "@")
}

var spaceRunRe = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// SplitTargets is splitNvimTargets: @-tokens are one target each; without
// an @ the whole string is one target (paths may contain spaces).
func SplitTargets(args string) []string {
	t := trim(args)
	if t == "" {
		return nil
	}
	if !strings.Contains(t, "@") {
		return []string{t}
	}
	var out []string
	for _, token := range spaceRunRe.Split(t, -1) {
		if token != "" {
			out = append(out, token)
		}
	}
	return out
}

var plainArgRe = regexp.MustCompile(`^[A-Za-z0-9@._/+:=,-]+$`)

// Quote quotes one argument for sh, as formatNvimCommand does.
func Quote(arg string) string {
	if plainArgRe.MatchString(arg) {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// Command is formatNvimCommand: the nvim command line, quoted for sh.
func Command(r Request) string {
	parts := append([]string{Binary}, Args(r)...)
	for i, p := range parts {
		parts[i] = Quote(p)
	}
	return strings.Join(parts, " ")
}

// Title is the pane title: "nvim <basename>[:line]".
func Title(r Request) string {
	parts := strings.Split(r.Path, "/")
	base := parts[len(parts)-1]
	if r.Line != 0 {
		return fmt.Sprintf("nvim %s:%d", base, r.Line)
	}
	return "nvim " + base
}

// OttyArgs are the otty CLI arguments for a split (paneID may be "") or a tab.
func OttyArgs(split bool, paneID, cwd string, r Request) []string {
	command := "exec " + Command(r)
	if split {
		args := []string{"pane", "split", "--direction", "right", "--size", "50"}
		if paneID != "" {
			args = append(args, "--pane", paneID)
		}
		return append(args, "--cwd", cwd, "--command", command, "--title", Title(r), "--quiet")
	}
	return []string{"tab", "new", "--cwd", cwd, "--command", command, "--title", Title(r), "--quiet"}
}

func appleScriptEscape(v string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v)
}

// AppleScript is the Terminal.app script for the macOS launcher.
func AppleScript(cwd string, r Request) string {
	return "tell application \"Terminal\"\n\tactivate\n\tdo script \"cd " + appleScriptEscape(cwd) + " && " + appleScriptEscape(Command(r)) + "\"\nend tell"
}

// Describe is the target text in the success message.
func Describe(r Request) string {
	label := r.Path
	if r.ReadOnly {
		label += " (read-only)"
	}
	if r.Line != 0 {
		return fmt.Sprintf("%s:%d", label, r.Line)
	}
	return label
}

// Success is the message after a launcher worked.
func Success(mode string, r Request) string {
	where := map[string]string{
		"otty-split": "in a new Otty pane beside this session",
		"tmux":       "in a new tmux window",
		"otty-tab":   "in a new Otty tab",
		"macos":      "in a new terminal window",
	}[mode]
	return "Opened " + Describe(r) + " in Neovim " + where
}

// PrintFallback is the message when no launcher worked.
func PrintFallback(r Request, reason string) string {
	return reason + ".\n  " + Command(r)
}

// ResolvePath joins a relative path to cwd (absolute paths pass through).
func ResolvePath(path, cwd string) string {
	if strings.HasPrefix(path, "/") {
		return path
	}
	return cwd + "/" + path
}

// Help is the /nvim usage text.
const Help = "/nvim <path>[:line[:col]] — open a file in Neovim in a new Otty pane beside this session.\n" +
	"  /nvim src/index.ts          open at the top\n" +
	"  /nvim src/index.ts:42       open with the cursor on line 42\n" +
	"  /nvim src/index.ts:42:7     line 42, column 7\n" +
	"  /nvim -r src/index.ts:42    read-only view\n" +
	"  /nvim @src/index.ts         @-references work too (pi's @-file completion)\n" +
	"  /nvim @a.ts:3 @b.ts         several files — one pane each\n" +
	"Typing /nvim suggests files this session read or edited first, then project files.\n" +
	"Launcher: Otty pane split (anchored to this session) → tmux → Otty tab → Terminal.app → the printed command."

var readOnlyPrefixRe = regexp.MustCompile(`^(--read-only|-r)[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// ParseCommand turns /nvim arguments into requests (cwd resolves relative
// paths). help is set for an empty argument, `help`, or `-h`; warn is set
// when only flags were given.
func ParseCommand(args, cwd string) (requests []Request, help, warn bool) {
	t := trim(args)
	if t == "" || t == "help" || t == "-h" {
		return nil, true, false
	}
	readOnly := false
	rest := t
	if strings.HasPrefix(rest, "-r ") || strings.HasPrefix(rest, "--read-only ") {
		readOnly = true
		rest = readOnlyPrefixRe.ReplaceAllString(rest, "")
	}
	var targets []string
	for i, token := range SplitTargets(rest) {
		if i == 0 && (token == "-r" || token == "--read-only") {
			readOnly = true
			continue
		}
		targets = append(targets, token)
	}
	if len(targets) == 0 {
		return nil, true, true
	}
	for _, target := range targets {
		path, line, column := ParseTarget(StripAt(target))
		if path == "" {
			continue
		}
		requests = append(requests, Request{Path: ResolvePath(path, cwd), Line: line, Column: column, ReadOnly: readOnly})
	}
	return requests, false, false
}

// SessionFileLimit bounds the session file list.
const SessionFileLimit = 40

// SessionFile is one file the session read or edited.
type SessionFile struct {
	Path      string  `json:"path"`
	Edited    bool    `json:"edited"`
	TouchedAt float64 `json:"touchedAt"`
}

// PathsFromToolResult is filePathsFromToolResult.
func PathsFromToolResult(tool string, input map[string]any, isError bool) (paths []string, edited bool) {
	if isError {
		return nil, false
	}
	if tool == "read" {
		for _, key := range []string{"path", "file_path"} {
			if s, ok := input[key].(string); ok && s != "" {
				return []string{s}, false
			}
		}
		return nil, false
	}
	var changes []toolpaths.Change
	if tool == "apply_patch" || tool == "patch" {
		changes = toolpaths.StructuredChanges(input)
	}
	if len(changes) == 0 {
		changes = toolpaths.FileChanges(tool, input)
	}
	if len(changes) == 0 {
		return nil, false
	}
	return toolpaths.ChangedPaths(changes), true
}

// Touch is touchSessionFiles: newest first, deduped, edited stays set.
func Touch(entries []SessionFile, paths []string, edited bool, now float64, limit int) []SessionFile {
	in := func(p string) bool {
		for _, q := range paths {
			if q == p {
				return true
			}
		}
		return false
	}
	var rest []SessionFile
	for _, e := range entries {
		if !in(e.Path) {
			rest = append(rest, e)
		}
	}
	var front []SessionFile
	for _, p := range paths {
		previous := false
		for _, e := range entries {
			if e.Path == p {
				previous = e.Edited
				break
			}
		}
		// TS unshifts paths in reverse order, so the result keeps path order;
		// a path listed twice appears twice, as in TypeScript.
		front = append(front, SessionFile{Path: p, Edited: previous || edited, TouchedAt: now})
	}
	out := append(front, rest...)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Completion is one /nvim argument suggestion.
type Completion struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// Completions is buildNvimCompletions: session files first, then project files.
func Completions(prefix string, session []SessionFile, project []string, cwd string, limit int) []Completion {
	raw := strings.ToLower(trim(strings.TrimPrefix(prefix, "@")))
	var out []Completion
	seen := map[string]bool{}
	push := func(abs, description string) {
		if len(out) >= limit || seen[abs] || (raw != "" && !strings.Contains(strings.ToLower(abs), raw)) {
			return
		}
		seen[abs] = true
		display := abs
		if rel, err := filepath.Rel(cwd, abs); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			display = rel
		}
		out = append(out, Completion{Value: "@" + display, Label: display, Description: description})
	}
	for _, e := range session {
		description := "read this session"
		if e.Edited {
			description = "edited this session"
		}
		push(e.Path, description)
	}
	for _, p := range project {
		abs := p
		if !filepath.IsAbs(p) {
			abs = filepath.Join(cwd, p)
		}
		push(filepath.Clean(abs), "project file")
	}
	return out
}

// Run executes a launcher and returns its exit code; an error is a failure.
type Run func(bin string, args []string) (int, error)

// Open walks the launch plan; the first launcher that works wins.
func Open(r Request, cwd string, env map[string]string, platform string, run Run) string {
	ok := func(bin string, args []string) bool {
		code, err := run(bin, args)
		return err == nil && code == 0
	}
	for _, attempt := range Plan(env, platform) {
		var launched bool
		switch attempt.Mode {
		case "otty-split":
			launched = ok("otty", OttyArgs(true, env["OTTY_PANE_ID"], cwd, r))
		case "tmux":
			launched = ok("tmux", []string{"new-window", "-c", cwd, Command(r)})
		case "otty-tab":
			launched = ok("otty", OttyArgs(false, "", cwd, r))
		case "macos":
			launched = ok("osascript", []string{"-e", AppleScript(cwd, r)})
		case "print":
			return PrintFallback(r, attempt.Reason)
		}
		if launched {
			return Success(attempt.Mode, r)
		}
	}
	return PrintFallback(r, "no terminal launcher available; run this command yourself")
}
