// Package chrome is the Go port of ui/chrome.ts: the shared visual
// vocabulary of AIO surfaces (accent rails, headers, items, hints, dividers,
// rounded frames, pluralization, and width fitting). Every returned line fits
// its supplied width, measured as pi-tui does (go/internal/tuiwidth).
package chrome

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Theme is ChromeTheme. sdk.UITheme implements it. A theme without bold or
// background styling returns the text unchanged from Bold and Bg; set
// NoBold/NoBg through Optional to reproduce a TypeScript theme that lacks
// them.
type Theme interface {
	Fg(role, text string) string
	Bold(text string) string
	Bg(role, text string) string
}

// Optional reports which optional ChromeTheme members a theme lacks.
type Optional interface {
	HasBold() bool
	HasBg() bool
}

func hasBold(t Theme) bool {
	if o, ok := t.(Optional); ok {
		return o.HasBold()
	}
	return true
}

func hasBg(t Theme) bool {
	if o, ok := t.(Optional); ok {
		return o.HasBg()
	}
	return true
}

// HeaderOptions is HeaderOptions. An empty Tone is "accent", an empty Icon
// is "▎".
type HeaderOptions struct {
	Title  string
	Meta   string
	Tone   string
	Icon   string
	Indent int
}

// ItemOptions is ItemOptions. Indent nil is 1.
type ItemOptions struct {
	Label  string
	Meta   string
	Marker string
	Tone   string
	Active bool
	Indent *int
}

// Indent returns a pointer for ItemOptions.Indent.
func Indent(n int) *int { return &n }

// Width is pi-tui's visibleWidth.
func Width(text string) int { return tuiwidth.VisibleWidth(text) }

// Truncate is pi-tui's truncateToWidth without padding.
func Truncate(text string, width int, ellipsis string) string {
	return tuiwidth.TruncateToWidth(text, width, ellipsis, false)
}

// Wrap is pi-tui's wrapTextWithAnsi.
func Wrap(text string, width int) []string { return tuiwidth.WrapTextWithAnsi(text, width) }

// FitLine is fitLine with the default "…" ellipsis.
func FitLine(text string, width int) string { return FitLineWith(text, width, "…") }

// FitLineWith is fitLine with an explicit ellipsis.
func FitLineWith(text string, width int, ellipsis string) string {
	if width <= 0 {
		return ""
	}
	return Truncate(text, width, ellipsis)
}

// PadToWidth is padToWidth.
func PadToWidth(text string, width int) string {
	fitted := FitLineWith(text, width, "")
	return fitted + strings.Repeat(" ", max(0, width-Width(fitted)))
}

func bold(t Theme, text string) string {
	if hasBold(t) {
		return t.Bold(text)
	}
	return text
}

func meta(t Theme, text string) string {
	if text == "" {
		return ""
	}
	return t.Fg("dim", " · ") + t.Fg("muted", text)
}

// Header is chromeHeader.
func Header(t Theme, o HeaderOptions, width int) string {
	tone := o.Tone
	if tone == "" {
		tone = "accent"
	}
	icon := o.Icon
	if icon == "" {
		icon = "▎"
	}
	indent := strings.Repeat(" ", max(0, o.Indent))
	title := t.Fg(tone, bold(t, strings.ToUpper(o.Title)))
	return FitLine(indent+t.Fg(tone, icon)+" "+title+meta(t, o.Meta), width)
}

// Item is chromeItem.
func Item(t Theme, o ItemOptions, width int) string {
	tone := o.Tone
	if tone == "" {
		tone = "text"
		if o.Active {
			tone = "accent"
		}
	}
	indentN := 1
	if o.Indent != nil {
		indentN = *o.Indent
	}
	marker := o.Marker
	if marker == "" {
		marker = "·"
		if o.Active {
			marker = "›"
		}
	}
	label := o.Label
	if o.Active {
		label = bold(t, label)
	}
	line := strings.Repeat(" ", max(0, indentN)) + t.Fg(tone, marker) + " " + t.Fg(tone, label) + meta(t, o.Meta)
	fitted := FitLine(line, width)
	if o.Active && hasBg(t) {
		return t.Bg("selectedBg", PadToWidth(fitted, width))
	}
	return fitted
}

// Hint is chromeHint.
func Hint(t Theme, text string, width, indent int) string {
	return FitLine(strings.Repeat(" ", max(0, indent))+t.Fg("dim", text), width)
}

// Divider is chromeDivider. The label length is in UTF-16 code units, as in
// TypeScript.
func Divider(t Theme, width int, label string) string {
	if width <= 0 {
		return ""
	}
	if label == "" {
		return t.Fg("borderMuted", strings.Repeat("─", width))
	}
	decorated := "─ " + label + " "
	suffix := strings.Repeat("─", max(0, width-len16(decorated)))
	return FitLineWith(t.Fg("borderMuted", decorated+suffix), width, "")
}

// FrameRule is chromeFrameRule. Edge is "top", "divider", or "bottom".
func FrameRule(t Theme, width int, edge, label string) string {
	if width <= 0 {
		return ""
	}
	if width <= 4 {
		return Divider(t, width, label)
	}
	left, right := "├", "┤"
	switch edge {
	case "top":
		left, right = "╭", "╮"
	case "bottom":
		left, right = "╰", "╯"
	}
	inner := width - 2
	title := ""
	if label != "" {
		title = FitLineWith("─ "+label+" ", inner, "")
	}
	fill := strings.Repeat("─", max(0, inner-Width(title)))
	return t.Fg("borderMuted", left+title+fill+right)
}

// FrameRow is chromeFrameRow.
func FrameRow(t Theme, text string, width int) string {
	if width <= 4 {
		return FitLineWith(text, width, "")
	}
	border := t.Fg("borderMuted", "│")
	return border + " " + PadToWidth(text, width-4) + " " + border
}

// Plural is plural with the default "s" form.
func Plural(count int, singular string) string { return PluralForm(count, singular, singular+"s") }

// PluralForm is plural with an explicit plural form.
func PluralForm(count int, singular, plural string) string {
	word := plural
	if count == 1 {
		word = singular
	}
	return strconv.Itoa(count) + " " + word
}

func len16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// BoldText is theme.bold?.(text) ?? text.
func BoldText(t Theme, text string) string { return bold(t, text) }
