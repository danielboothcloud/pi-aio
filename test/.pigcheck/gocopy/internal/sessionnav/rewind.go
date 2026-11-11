package sessionnav

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// RewindResult is RewindResult.
type RewindResult struct {
	Checkpoint Checkpoint `json:"checkpoint"`
	Action     string     `json:"action"`
}

// RewindPickerOptions is RewindPickerOptions.
type RewindPickerOptions struct {
	Theme         chrome.Theme
	Keys          Keys
	Checkpoints   []Checkpoint
	MaxRows       func() int
	Done          func(*RewindResult)
	RequestRender func()
	Now           func() float64
	Location      *time.Location
}

const ageWidth = 6

// RewindPicker is RewindPicker: your prompts as checkpoints with a
// preview, then one plain-English action step.
type RewindPicker struct {
	o           RewindPickerOptions
	closed      bool
	View        string
	Query       string
	selectedID  string
	actionIndex int
}

// NewRewindPicker selects the current checkpoint (else the newest).
func NewRewindPicker(o RewindPickerOptions) *RewindPicker {
	if o.Location == nil {
		o.Location = time.Local
	}
	if o.Now == nil {
		o.Now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	p := &RewindPicker{o: o, View: "list"}
	for _, c := range o.Checkpoints {
		if c.IsCurrent {
			p.selectedID = c.ID
			break
		}
	}
	if p.selectedID == "" && len(o.Checkpoints) > 0 {
		p.selectedID = o.Checkpoints[0].ID
	}
	return p
}

func (p *RewindPicker) filtered() []Checkpoint {
	if p.Query == "" {
		return p.o.Checkpoints
	}
	var out []Checkpoint
	for _, c := range p.o.Checkpoints {
		if MatchesQuery(p.Query, c.Title, c.Text, c.Label) {
			out = append(out, c)
		}
	}
	return out
}

func (p *RewindPicker) selectedIndex(items []Checkpoint) int {
	for i, c := range items {
		if c.ID == p.selectedID {
			return i
		}
	}
	return 0
}

// Selected is selected().
func (p *RewindPicker) Selected() (Checkpoint, bool) {
	items := p.filtered()
	if len(items) == 0 {
		return Checkpoint{}, false
	}
	return items[p.selectedIndex(items)], true
}

func (p *RewindPicker) move(delta int) {
	items := p.filtered()
	if len(items) == 0 {
		return
	}
	i := max(0, min(len(items)-1, p.selectedIndex(items)+delta))
	p.selectedID = items[i].ID
}

func (p *RewindPicker) finish(result *RewindResult) {
	if p.closed {
		return
	}
	p.closed = true
	p.o.Done(result)
}

// HandleInput is handleInput.
func (p *RewindPicker) HandleInput(data string) {
	if p.closed {
		return
	}
	if p.o.Keys.MatchesKey(data, "ctrl+c") {
		p.finish(nil)
		return
	}
	if p.View == "actions" {
		p.handleActionInput(data)
	} else {
		p.handleListInput(data)
	}
	p.o.RequestRender()
}

const infinity = math.MaxInt32

func (p *RewindPicker) handleListInput(data string) {
	k := p.o.Keys
	page := max(1, p.listRows()-1)
	switch {
	case k.MatchesKey(data, "escape"):
		if p.Query != "" {
			p.Query = ""
		} else {
			p.finish(nil)
		}
	case k.MatchesKey(data, "up"):
		p.move(-1)
	case k.MatchesKey(data, "down"):
		p.move(1)
	case k.MatchesKey(data, "pageUp"):
		p.move(-page)
	case k.MatchesKey(data, "pageDown"):
		p.move(page)
	case k.MatchesKey(data, "home"):
		p.move(-infinity)
	case k.MatchesKey(data, "end"):
		p.move(infinity)
	case k.MatchesKey(data, "enter") || k.MatchesKey(data, "right"):
		if _, ok := p.Selected(); ok {
			p.View, p.actionIndex = "actions", 0
		}
	case k.MatchesKey(data, "backspace"):
		p.Query = jsstr.Slice(p.Query, 0, max(0, jsstr.Len16(p.Query)-1))
		p.keepSelectionVisible()
	default:
		if ch, ok := PrintableInput(k, data); ok {
			p.Query += ch
			p.keepSelectionVisible()
		}
	}
}

func (p *RewindPicker) keepSelectionVisible() {
	items := p.filtered()
	for _, c := range items {
		if c.ID == p.selectedID {
			return
		}
	}
	p.selectedID = ""
	if len(items) > 0 {
		p.selectedID = items[0].ID
	}
}

func (p *RewindPicker) handleActionInput(data string) {
	k := p.o.Keys
	checkpoint, ok := p.Selected()
	if !ok {
		p.View = "list"
		return
	}
	options := RewindOptions(checkpoint)
	switch {
	case k.MatchesKey(data, "escape") || k.MatchesKey(data, "left"):
		p.View = "list"
	case k.MatchesKey(data, "up"):
		p.actionIndex = max(0, p.actionIndex-1)
	case k.MatchesKey(data, "down"):
		p.actionIndex = min(len(options)-1, p.actionIndex+1)
	case k.MatchesKey(data, "enter"):
		if p.actionIndex < len(options) {
			p.finish(&RewindResult{checkpoint, options[p.actionIndex].Action})
		}
	case len(data) == 1 && data[0] >= '1' && data[0] <= '9':
		if i := int(data[0] - '1'); i < len(options) {
			p.finish(&RewindResult{checkpoint, options[i].Action})
		}
	}
}

func (p *RewindPicker) listRows() int {
	extra := 0
	if p.Query != "" {
		extra = 1
	}
	return max(3, p.o.MaxRows()-10-extra)
}

// Render is render.
func (p *RewindPicker) Render(width int) []string {
	if width <= 0 {
		return []string{}
	}
	if p.View == "actions" {
		return p.renderActions(width)
	}
	return p.renderList(width)
}

func (p *RewindPicker) renderList(width int) []string {
	theme := p.o.Theme
	inner := InnerWidth(width)
	items := p.filtered()
	title := "▎ REWIND · " + chrome.Plural(len(p.o.Checkpoints), "checkpoint")
	intro := []string{theme.Fg("muted", "Go back to an earlier point. Files on disk are not changed.")}
	if p.Query != "" {
		intro = append(intro, theme.Fg("accent", "filter")+" "+p.Query+theme.Fg("accent", "▏"))
	}
	var rows []string
	if len(items) == 0 {
		msg := "No prompts in this session yet."
		if len(p.o.Checkpoints) > 0 {
			msg = "No prompts match the filter."
		}
		rows = append(rows, theme.Fg("dim", msg))
	} else {
		selected := p.selectedIndex(items)
		start, end := VisibleWindow(len(items), selected, p.listRows())
		if start > 0 {
			rows = append(rows, theme.Fg("dim", "  ↑ "+strconv.Itoa(start)+" newer"))
		}
		for i := start; i < end; i++ {
			rows = append(rows, p.renderItem(items[i], i == selected, inner))
		}
		if end < len(items) {
			rows = append(rows, theme.Fg("dim", "  ↓ "+strconv.Itoa(len(items)-end)+" older"))
		}
	}
	sections := []FrameSection{{Lines: intro}, {Label: "your prompts", Lines: rows}}
	if len(items) > 0 {
		if c, ok := p.Selected(); ok {
			sections = append(sections, FrameSection{Label: "preview", Lines: p.renderPreview(c, inner)})
		}
	}
	sections = append(sections, FrameSection{Lines: []string{theme.Fg("dim", "↑↓ choose · enter select · type to filter · esc close")}})
	return RenderFrame(theme, width, title, sections)
}

// padEnd is String.prototype.padEnd with spaces (UTF-16 length).
func padEnd(s string, n int) string {
	return s + strings.Repeat(" ", max(0, n-jsstr.Len16(s)))
}

func (p *RewindPicker) renderItem(c Checkpoint, active bool, width int) string {
	theme := p.o.Theme
	marker := "  "
	if active {
		marker = theme.Fg("accent", "› ")
	}
	age := theme.Fg("muted", padEnd(RelativeAge(c.Timestamp, p.o.Now(), p.o.Location), ageWidth))
	var title string
	switch {
	case active:
		title = theme.Fg("accent", chrome.BoldText(theme, c.Title))
	case c.OnPath:
		title = theme.Fg("text", c.Title)
	default:
		title = theme.Fg("muted", c.Title)
	}
	var meta []string
	if c.Label != "" {
		meta = append(meta, theme.Fg("accent", "#"+c.Label))
	}
	if c.IsCurrent {
		meta = append(meta, theme.Fg("success", "you are here"))
	} else if !c.OnPath {
		meta = append(meta, theme.Fg("warning", "⑂ alternate"))
	}
	if c.Edits > 0 {
		meta = append(meta, theme.Fg("dim", chrome.Plural(c.Edits, "edit")))
	} else if c.Tools > 0 {
		meta = append(meta, theme.Fg("dim", chrome.Plural(c.Tools, "tool")))
	}
	return SplitRow(marker+age+title, strings.Join(meta, theme.Fg("dim", " · ")), width)
}

func (p *RewindPicker) renderPreview(c Checkpoint, width int) []string {
	theme := p.o.Theme
	body := max(1, width-5)
	prompt := CleanPromptTitle(c.Text)
	if prompt == "" {
		prompt = "(empty prompt)"
	}
	reply := c.Reply
	if reply == "" {
		reply = "(no answer yet)"
	}
	var lines []string
	for i, line := range WrapLimited(prompt, body, 2) {
		lead := "you  "
		if i > 0 {
			lead = "     "
		}
		lines = append(lines, theme.Fg("accent", lead)+line)
	}
	for i, line := range WrapLimited(reply, body, 2) {
		lead := "pi   "
		if i > 0 {
			lead = "     "
		}
		lines = append(lines, theme.Fg("muted", lead)+theme.Fg("muted", line))
	}
	return lines
}

func (p *RewindPicker) renderActions(width int) []string {
	theme := p.o.Theme
	inner := InnerWidth(width)
	c, ok := p.Selected()
	if !ok {
		return p.renderList(width)
	}
	options := RewindOptions(c)
	p.actionIndex = min(p.actionIndex, len(options)-1)
	heading := "Rewind to “" + c.Title + "”"
	when := RelativeAgeLong(c.Timestamp, p.o.Now(), p.o.Location)
	rows := make([]string, len(options))
	for i, option := range options {
		active := i == p.actionIndex
		marker := "  "
		label := option.Label
		if active {
			marker = theme.Fg("accent", "› ")
			label = theme.Fg("accent", chrome.BoldText(theme, option.Label))
		}
		rows[i] = marker + theme.Fg("dim", strconv.Itoa(i+1)+" ") + label
	}
	var description []string
	for _, line := range WrapLimited(options[p.actionIndex].Description, inner, 3) {
		description = append(description, theme.Fg("muted", line))
	}
	return RenderFrame(theme, width, "▎ REWIND", []FrameSection{
		{Lines: []string{SplitRow(theme.Fg("text", heading), theme.Fg("dim", when), inner)}},
		{Label: "what to do", Lines: rows},
		{Lines: description},
		{Lines: []string{theme.Fg("dim", "↑↓ choose · enter confirm · esc back")}},
	})
}
