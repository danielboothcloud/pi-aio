package aio

// copy-widget wiring (port of copy-widget/index.ts). /pick and ctrl+p open
// the picker overlay (an sdk.RemoteComponent) over the last assistant
// response's code blocks and quotes and copy the chosen one through the
// host clipboard. The logic is in go/internal/copywidget.

import (
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	sdktui "github.com/MichaelKinsy/PiG/extensions/sdk/tui"

	"github.com/danielboothcloud/pi-aio/go/internal/copywidget"
)

func init() {
	addRegistrar(OrderCopyWidget, "copy-widget", registerCopyWidget)
}

// pickerComponent shows copywidget.Picker as an SDK overlay. It closes with
// the chosen block's ordinal, or nil for a cancel.
type pickerComponent struct {
	mu     sync.Mutex
	picker *copywidget.Picker
}

func (c *pickerComponent) Render(width int) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.picker.Render(width)
}

func (c *pickerComponent) HandleInput(data string) (sdk.RemoteComponentResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.picker.HandleInput(data)
	if block, done := c.picker.Done(); done {
		if block == nil {
			return sdk.RemoteComponentResult{Done: true}, nil
		}
		return sdk.RemoteComponentResult{Done: true, Value: block.Ordinal}, nil
	}
	return sdk.RemoteComponentResult{}, nil
}

// markdownTheme is getMarkdownTheme() with the terminal's hyperlink support.
func markdownTheme() copywidget.MarkdownTheme {
	t := sdk.GetMarkdownTheme()
	return copywidget.MarkdownTheme{
		Heading: t.Heading, Link: t.Link, LinkURL: t.LinkUrl, Code: t.Code, CodeBlock: t.CodeBlock,
		CodeBlockBorder: t.CodeBlockBorder, Quote: t.Quote, QuoteBorder: t.QuoteBorder, Hr: t.Hr,
		ListBullet: t.ListBullet, Bold: t.Bold, Italic: t.Italic, Underline: t.Underline,
		Strikethrough: t.Strikethrough, HighlightCode: t.HighlightCode,
		Hyperlinks: sdktui.GetCapabilities().Hyperlinks,
	}
}

// ordinalOf reads the overlay's result value (a JSON number).
func ordinalOf(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case float64:
		return int(v), true
	case int64:
		return int(v), true
	}
	return 0, false
}

func openCopyPicker(ctx sdk.Context) error {
	blocks, notice := copywidget.OpenStep(ctx.Mode(), sessionBranch(ctx))
	if notice != nil {
		ctx.Notify(notice.Message, notice.Level)
		return nil
	}
	picker := copywidget.NewPicker(copywidget.PickerOptions{
		Blocks:   blocks,
		Theme:    ctx.UITheme(),
		MaxRows:  func() int { return ctx.Height() * 9 / 10 },
		Matches:  func(data, keyID string) bool { return sdktui.MatchesKey(data, sdktui.KeyID(keyID)) },
		Markdown: markdownTheme(),
	})
	margin := 1
	value, err := ctx.Custom(&pickerComponent{picker: picker}, sdk.RemoteOverlayOptions{Overlay: true, OverlayOptions: &sdk.OverlayOptions{
		Anchor: "center", Margin: &sdk.OverlayMargin{All: &margin}, MaxHeight: sdk.OverlayPercent(90), MinWidth: 50, Width: sdk.OverlayPercent(85),
	}})
	if err != nil {
		return nil
	}
	ordinal, ok := ordinalOf(value)
	if !ok || ordinal < 1 || ordinal > len(blocks) {
		return nil
	}
	block := blocks[ordinal-1]
	result := copywidget.CopyNotice(block, ctx.CopyToClipboard(block.Text))
	ctx.Notify(result.Message, result.Level)
	return nil
}

func registerCopyWidget(e *sdk.Extension) {
	e.RegisterCommand(copywidget.CommandName, sdk.CommandOptions{
		Description: copywidget.CommandDescription,
		Handler:     func(ctx sdk.Context, _ string) error { return openCopyPicker(ctx) },
	})
	e.Shortcut(copywidget.Shortcut, copywidget.ShortcutDescription, openCopyPicker)
}
