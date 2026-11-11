package userbash

import (
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Theme is the theme surface of the hint: fg.
type Theme interface {
	Fg(role, text string) string
}

// Base is the host editor the hint editor extends (CustomEditor).
type Base interface {
	Text() string
	SetText(text string)
	HandleInput(data string)
}

// Editor is BashHintEditor's logic: the space after `!`/`!!`, the
// `user-bash` status, and the native border label.
type Editor struct {
	Base Base
	// Status sets the user-bash status ("" clears it); nil outside the TUI.
	Status func(text string)
	// Theme returns the current theme.
	Theme func() Theme
	// FrameChrome is set while the AIO frame owns mode labels and hints.
	FrameChrome bool
}

// SyncHint is syncBashHint: the status for text.
func (e *Editor) SyncHint(text string) {
	if e.Status == nil {
		return
	}
	state := Parse(text)
	if !state.Active || e.FrameChrome {
		e.Status("")
		return
	}
	label := "!bash"
	if state.Hidden {
		label = "!!bash"
	}
	e.Status(e.Theme().Fg("bashMode", label))
}

// SetFrameChrome is setFrameChrome.
func (e *Editor) SetFrameChrome(active bool) {
	e.FrameChrome = active
	e.SyncHint(e.Base.Text())
}

// HandleInput is handleInput: the base editor's input, then the spacing
// and the status.
func (e *Editor) HandleInput(data string) {
	e.Base.HandleInput(data)
	if spaced, ok := EnsureSpacing(e.Base.Text()); ok {
		e.SetText(spaced)
	}
	e.SyncHint(e.Base.Text())
}

// SetText is setText.
func (e *Editor) SetText(text string) {
	e.Base.SetText(text)
	e.SyncHint(text)
}

// FitBorder is fitBorder: ─left──gap──right─ in exactly width columns.
func FitBorder(left, right string, width int, border func(string) string) string {
	if width <= 0 {
		return ""
	}
	if width == 1 {
		return border("─")
	}
	vw := tuiwidth.VisibleWidth
	const fixed, gap = 2, 1
	for fixed+vw(left)+vw(right)+gap > width && vw(right) > 0 {
		right = tuiwidth.TruncateToWidth(right, max(0, vw(right)-1), "", false)
	}
	for fixed+vw(left)+vw(right)+gap > width && vw(left) > 0 {
		left = tuiwidth.TruncateToWidth(left, max(0, vw(left)-1), "", false)
	}
	fill := max(0, width-fixed-vw(left)-vw(right))
	return border("─") + left + border(strings.Repeat("─", fill)) + right + border("─")
}

// RenderWithChrome is renderWithChrome over the base editor's rows: the
// top border carries the mode label and the run hint unless the frame owns
// them.
func RenderWithChrome(lines []string, text string, width int, frameChrome bool, theme Theme, border func(string) string) []string {
	state := Parse(text)
	if frameChrome || !state.Active || len(lines) < 2 {
		return lines
	}
	mode := theme.Fg("bashMode", " ! bash ")
	if state.Hidden {
		mode = theme.Fg("muted", " !! hidden ")
	}
	out := append([]string{}, lines...)
	out[0] = FitBorder(mode, theme.Fg("dim", " Enter to run "), width, border)
	return out
}
