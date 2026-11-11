// Package userbash is the Go port of user-bash/: the `!`/`!!` editor hint.
// Explicit user shell commands keep Pi's native execution path; this only
// changes the editor display. It does not import the PiG SDK.
package userbash

import "strings"

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// State is the parsed editor text.
type State struct {
	Active  bool   `json:"active"`
	Hidden  bool   `json:"hidden"`
	Command string `json:"command"`
}

// Parse reads `!cmd` (shown) and `!!cmd` (hidden) input.
func Parse(text string) State {
	trimmed := strings.TrimLeft(text, jsSpace)
	if !strings.HasPrefix(trimmed, "!") {
		return State{}
	}
	hidden := strings.HasPrefix(trimmed, "!!")
	n := 1
	if hidden {
		n = 2
	}
	return State{Active: true, Hidden: hidden, Command: strings.TrimLeft(trimmed[n:], jsSpace)}
}

// EnsureSpacing inserts a space after `!`/`!!` when command text follows
// directly. It returns ok=false when nothing changes.
func EnsureSpacing(text string) (string, bool) {
	lead := text[:len(text)-len(strings.TrimLeft(text, jsSpace))]
	trimmed := text[len(lead):]
	if !strings.HasPrefix(trimmed, "!") {
		return "", false
	}
	prefix := "!"
	if strings.HasPrefix(trimmed, "!!") {
		prefix = "!!"
	}
	after := trimmed[len(prefix):]
	if after == "" || strings.HasPrefix(after, " ") {
		return "", false
	}
	return lead + prefix + " " + after, true
}
