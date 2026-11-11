package frame

import (
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

var sgr = regexp.MustCompile(`\x1b\[[0-9;]*m`)

var bareRule = regexp.MustCompile(`^─+$`)

var (
	aboveRule = regexp.MustCompile(`^─+ ↑ ([1-9]\d*) more ─*$`)
	belowRule = regexp.MustCompile(`^─+ ↓ ([1-9]\d*) more ─*$`)
)

// ParseBaseBorderRule is parseBaseBorderRule: ok is false for a row that is
// not a border; count is the scroll indicator count ("" for a bare rule).
func ParseBaseBorderRule(line string, above bool) (count string, ok bool) {
	plain := strings.TrimSpace(sgr.ReplaceAllString(line, ""))
	if bareRule.MatchString(plain) {
		return "", true
	}
	re := belowRule
	if above {
		re = aboveRule
	}
	if m := re.FindStringSubmatch(plain); m != nil && m[1] != "" {
		return m[1], true
	}
	return "", false
}

// EditorBase is the wrapped editor as the frame sees it (FrameBaseEditor).
type EditorBase interface {
	// Render is the base editor's render.
	Render(width int) []string
	// HasUnframed reports whether the base has renderUnframed (the shell
	// editor's native-chrome render).
	HasUnframed() bool
	// RenderUnframed is renderUnframed; only called when HasUnframed.
	RenderUnframed(width int) []string
	// Text is getText.
	Text() string
	// ShowingAutocomplete is isShowingAutocomplete.
	ShowingAutocomplete() bool
	// PaddingX is the base editor's padding, which surrounds the
	// autocomplete rows it renders.
	PaddingX() int
}

// EditorOptions is MinimalistFrameEditorOptions.
type EditorOptions struct {
	Theme       Theme
	Style       Style
	Home        string
	GetMetadata func() Metadata
	// GetPanelLines returns extra framed rows (the queue panel).
	GetPanelLines func() []string
}

// AutocompleteRows recovers the autocomplete rows that a pi-tui editor
// rendered at width below its bottom border. TypeScript captures the list's
// own render output; the Go SDK has no access to the list, so the rows are
// cut from the base output: the rows after the last bottom rule, without
// the editor's left padding and trailing spaces. ok is false when no rows
// are found (TypeScript then falls back to the native render).
func AutocompleteRows(lines []string, width, paddingX int) (rows []string, ok bool) {
	end := -1
	for i := len(lines) - 1; i >= 1; i-- {
		if _, isRule := ParseBaseBorderRule(lines[i], false); isRule {
			end = i
			break
		}
	}
	if end < 0 || end == len(lines)-1 {
		return nil, false
	}
	pad := min(paddingX, max(0, (width-1)/2))
	prefix := strings.Repeat(" ", pad)
	for _, line := range lines[end+1:] {
		row := strings.TrimPrefix(line, prefix)
		rows = append(rows, strings.TrimRight(row, " "))
	}
	return rows, true
}

// RenderEditor is MinimalistFrameEditor.render: the base editor rendered
// inside the frame, or its native render when the frame cannot recognize
// the base layout.
func RenderEditor(base EditorBase, width int, o EditorOptions) []string {
	nativeFallback := func(lines []string) []string {
		if base.HasUnframed() {
			lines = base.RenderUnframed(width)
		}
		out := make([]string, len(lines))
		for i, line := range lines {
			out[i] = tuiwidth.TruncateToWidth(line, width, "", false)
		}
		return out
	}
	if width <= 4 {
		return nativeFallback(base.Render(width))
	}
	showing := base.ShowingAutocomplete()
	baseRendered := base.Render(width - 4)
	if len(baseRendered) < 2 {
		return nativeFallback(baseRendered)
	}
	var autocompleteLines []string
	if showing {
		rows, ok := AutocompleteRows(baseRendered, width-4, base.PaddingX())
		if !ok || len(rows) >= len(baseRendered) {
			return nativeFallback(baseRendered)
		}
		autocompleteLines = rows
	}
	editorFrame := baseRendered[:len(baseRendered)-len(autocompleteLines)]
	if len(editorFrame) < 1 {
		return nativeFallback(baseRendered)
	}
	topCount, topOK := ParseBaseBorderRule(editorFrame[0], true)
	bottomCount, bottomOK := ParseBaseBorderRule(editorFrame[len(editorFrame)-1], false)
	stripped := topOK && bottomOK
	if !stripped && base.HasUnframed() {
		return nativeFallback(baseRendered)
	}
	editorLines := editorFrame
	var viewport *Viewport
	if stripped {
		editorLines = editorFrame[1 : len(editorFrame)-1]
		if o.Style.ViewportIndicators {
			viewport = &Viewport{Above: topCount, Below: bottomCount}
		}
	}
	panel := append([]string{}, autocompleteLines...)
	if o.GetPanelLines != nil {
		panel = append(panel, o.GetPanelLines()...)
	}
	var metadata Metadata
	if o.GetMetadata != nil {
		metadata = o.GetMetadata()
	}
	metadata = metadata.Apply(ContributedMetadata())
	return RenderMinimalistFrame(RenderInput{
		Width:       width,
		EditorLines: editorLines,
		PanelLines:  panel,
		Viewport:    viewport,
		InputText:   base.Text(),
		Metadata:    metadata,
		Theme:       o.Theme,
		Style:       o.Style,
		Home:        o.Home,
	})
}
