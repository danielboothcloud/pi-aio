package chrome

import "fmt"

// GoldenTheme is the ANSI test theme of the TypeScript golden generators:
// each role is one SGR foreground code (unknown roles 37), Bg adds 10, and
// Bold is SGR 1/22. Tests use it so rendered rows compare byte for byte.
type GoldenTheme struct{ Codes map[string]int }

func (t GoldenTheme) code(role string) int {
	if c, ok := t.Codes[role]; ok {
		return c
	}
	return 37
}

// Fg colors text in the role's code.
func (t GoldenTheme) Fg(role, text string) string {
	return fmt.Sprintf("\x1b[%dm%s\x1b[39m", t.code(role), text)
}

// Bold is SGR 1/22.
func (t GoldenTheme) Bold(text string) string { return "\x1b[1m" + text + "\x1b[22m" }

// Bg is the role's code plus 10.
func (t GoldenTheme) Bg(role, text string) string {
	return fmt.Sprintf("\x1b[%dm%s\x1b[49m", t.code(role)+10, text)
}

// PlainTheme is a ChromeTheme with only fg, which returns the text.
type PlainTheme struct{}

func (PlainTheme) Fg(_, text string) string { return text }
func (PlainTheme) Bold(text string) string  { return text }
func (PlainTheme) Bg(_, text string) string { return text }
func (PlainTheme) HasBold() bool            { return false }
func (PlainTheme) HasBg() bool              { return false }
