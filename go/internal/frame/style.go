// Package frame is the Go port of frame/: AIO's minimalist editor frame
// (adapted from pi-zentui, MIT, see frame/UPSTREAM.md). It holds the pure
// parts: theme styling, formatting, the frame renderer, the wrapped editor's
// render logic, the git probe, the Codex quota poller, and the in-process
// frame protocol. The PiG wiring is in go/aio/frame.go.
package frame

import (
	"strings"
	"unicode"
)

// Theme is ThemeLike: fg is required; Bold, Italic and Underline are
// optional (see Styler).
type Theme interface {
	Fg(role, text string) string
}

// Styler is the optional bold/italic/underline part of ThemeLike.
type Styler interface {
	Bold(text string) string
	Italic(text string) string
	Underline(text string) string
}

var themeStyleModifiers = map[string]bool{"bold": true, "italic": true, "underline": true}

var themeColorNameMap = map[string]string{
	"red": "error", "bright-red": "error",
	"green": "success", "bright-green": "success",
	"yellow": "warning", "bright-yellow": "warning",
	"blue": "syntaxFunction", "bright-blue": "syntaxFunction",
	"cyan": "syntaxFunction", "bright-cyan": "syntaxFunction",
	"purple": "syntaxKeyword", "bright-purple": "syntaxKeyword",
	"black": "muted", "bright-black": "muted",
	"white": "text", "bright-white": "text",
}

func applyThemeModifiers(theme Theme, tokens []string, text string) string {
	styler, ok := theme.(Styler)
	rendered := text
	for _, token := range tokens {
		if !ok {
			continue
		}
		switch strings.ToLower(token) {
		case "bold":
			rendered = styler.Bold(rendered)
		case "italic":
			rendered = styler.Italic(rendered)
		case "underline":
			rendered = styler.Underline(rendered)
		}
	}
	return rendered
}

// SafeThemeFg is safeThemeFg: theme.fg, or the text when the theme fails.
func SafeThemeFg(theme Theme, color, text string) (out string) {
	defer func() {
		if recover() != nil {
			out = text
		}
	}()
	return theme.Fg(color, text)
}

func mapThemeColor(tokens []string) (string, bool) {
	fallback, has := "", false
	for _, token := range tokens {
		normalized := strings.ToLower(token)
		if themeStyleModifiers[normalized] {
			continue
		}
		if normalized == "dim" || normalized == "dimmed" {
			fallback, has = "muted", true
			continue
		}
		if mapped, ok := themeColorNameMap[normalized]; ok {
			return mapped, true
		}
		return token, true
	}
	return fallback, has
}

// RenderThemeStyle is renderThemeStyle: a space-separated style spec
// ("bold green") through theme tokens.
func RenderThemeStyle(theme Theme, style, text string) string {
	trimmed := strings.TrimFunc(style, unicode.IsSpace)
	if trimmed == "" {
		return text
	}
	tokens := strings.Fields(trimmed)
	color, ok := mapThemeColor(tokens)
	if !ok {
		color = "text"
	}
	return SafeThemeFg(theme, color, applyThemeModifiers(theme, tokens, text))
}
