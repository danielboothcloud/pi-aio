package sessionnav

import (
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ResumePickerOptions is ResumePickerOptions. Go runs a load (default: a
// goroutine); loads report back under the picker's lock.
type ResumePickerOptions struct {
	Theme         chrome.Theme
	Keys          Keys
	Cwd           string
	CurrentPath   string
	LoadSessions  func(scope string) ([]Session, error)
	LoadPreview   func(path string) (LastExchange, error)
	MaxRows       func() int
	Done          func(path string)
	RequestRender func()
	Now           func() float64
	HomeDir       string
	Location      *time.Location
	Go            func(func())
}

type previewState struct {
	loading, failed bool
	value           LastExchange
}

// ResumePicker is ResumePicker: sessions grouped by day, a this-folder/all
// toggle, search, and a preview.
type ResumePicker struct {
	o            ResumePickerOptions
	mu           sync.Mutex
	closed       bool
	Scope        string
	Query        string
	lists        map[string][]Session
	listed       map[string]bool
	errors       map[string]string
	previews     map[string]*previewState
	selectedPath string
}

// NewResumePicker starts loading this folder's sessions.
func NewResumePicker(o ResumePickerOptions) *ResumePicker {
	if o.Location == nil {
		o.Location = time.Local
	}
	if o.Now == nil {
		o.Now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	if o.Go == nil {
		o.Go = func(fn func()) { go fn() }
	}
	p := &ResumePicker{o: o, Scope: "folder", lists: map[string][]Session{}, listed: map[string]bool{}, errors: map[string]string{}, previews: map[string]*previewState{}}
	p.mu.Lock()
	p.load("folder")
	p.mu.Unlock()
	return p
}

// load starts a list load. The caller holds p.mu.
func (p *ResumePicker) load(scope string) {
	if p.listed[scope] || p.errors[scope] != "" {
		return
	}
	p.listed[scope] = true // loading: TypeScript re-requests until it settles; one request suffices here
	p.o.Go(func() {
		sessions, err := p.o.LoadSessions(scope)
		p.mu.Lock()
		if err != nil {
			p.errors[scope] = err.Error()
		} else {
			if sessions == nil {
				sessions = []Session{}
			}
			p.lists[scope] = sessions
			if scope == p.Scope {
				p.keepSelectionVisible()
			}
		}
		p.mu.Unlock()
		p.o.RequestRender()
	})
}

func (p *ResumePicker) ordered() []Session {
	list, ok := p.lists[p.Scope]
	if !ok {
		return nil
	}
	var out []Session
	for _, g := range GroupSessions(FilterSessions(list, p.Query), p.o.Now(), p.o.Location) {
		out = append(out, g.Sessions...)
	}
	return out
}

func (p *ResumePicker) selectedIndex(items []Session) int {
	for i, s := range items {
		if s.Path == p.selectedPath {
			return i
		}
	}
	return 0
}

func (p *ResumePicker) selected() (Session, bool) {
	items := p.ordered()
	if len(items) == 0 {
		return Session{}, false
	}
	return items[p.selectedIndex(items)], true
}

// Selected is selected().
func (p *ResumePicker) Selected() (Session, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.selected()
}

func (p *ResumePicker) keepSelectionVisible() {
	items := p.ordered()
	for _, s := range items {
		if s.Path == p.selectedPath {
			return
		}
	}
	p.selectedPath = ""
	if len(items) > 0 {
		p.selectedPath = items[0].Path
	}
}

func (p *ResumePicker) move(delta int) {
	items := p.ordered()
	if len(items) == 0 {
		return
	}
	i := max(0, min(len(items)-1, p.selectedIndex(items)+delta))
	p.selectedPath = items[i].Path
}

// HandleInput is handleInput.
func (p *ResumePicker) HandleInput(data string) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	k := p.o.Keys
	page := max(1, p.listRows()-2)
	done, finished := "", false
	switch {
	case k.MatchesKey(data, "ctrl+c"):
		finished = true
	case k.MatchesKey(data, "escape"):
		if p.Query != "" {
			p.Query = ""
			p.keepSelectionVisible()
		} else {
			finished = true
		}
	case k.MatchesKey(data, "tab") || k.MatchesKey(data, "shift+tab"):
		if p.Scope == "folder" {
			p.Scope = "all"
		} else {
			p.Scope = "folder"
		}
		p.load(p.Scope)
		p.keepSelectionVisible()
	case k.MatchesKey(data, "up"):
		p.move(-1)
	case k.MatchesKey(data, "down"):
		p.move(1)
	case k.MatchesKey(data, "pageUp"):
		p.move(-page)
	case k.MatchesKey(data, "pageDown"):
		p.move(page)
	case k.MatchesKey(data, "enter"):
		if s, ok := p.selected(); ok {
			done, finished = s.Path, true
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
	if finished {
		p.closed = true
	}
	p.mu.Unlock()
	if finished {
		p.o.Done(done)
	}
	p.o.RequestRender()
}

func (p *ResumePicker) listRows() int { return max(4, p.o.MaxRows()-9) }

// Render is render.
func (p *ResumePicker) Render(width int) []string {
	if width <= 0 {
		return []string{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	theme := p.o.Theme
	inner := InnerWidth(width)
	folder := filepath.Base(p.o.Cwd)
	if p.o.Cwd == "" || folder == "." || folder == "/" {
		folder = p.o.Cwd
	}
	scope := theme.Fg("accent", "◉ this folder") + "  " + theme.Fg("dim", "○ all")
	if p.Scope == "all" {
		scope = theme.Fg("dim", "○ this folder") + "  " + theme.Fg("accent", "◉ all")
	}
	search := theme.Fg("dim", "type to search")
	if p.Query != "" {
		search = theme.Fg("accent", "search") + " " + p.Query + theme.Fg("accent", "▏")
	}
	sections := []FrameSection{{Lines: []string{SplitRow(search, scope, inner)}}}
	list, loaded := p.lists[p.Scope]
	session, hasSession := p.selected()
	switch {
	case p.errors[p.Scope] != "":
		sections = append(sections, FrameSection{Lines: []string{theme.Fg("error", "Could not list sessions: "+p.errors[p.Scope])}})
	case !loaded:
		sections = append(sections, FrameSection{Lines: []string{theme.Fg("dim", "Loading sessions…")}})
	default:
		_ = list
		sections = append(sections, FrameSection{Lines: p.renderRows(inner)})
		if hasSession {
			sections = append(sections, FrameSection{Label: "preview", Lines: p.renderPreview(session, inner)})
		}
	}
	sections = append(sections, FrameSection{Lines: []string{theme.Fg("dim", "↑↓ choose · enter open · tab this folder/all · esc close")}})
	return RenderFrame(theme, width, "▎ RESUME · "+folder, sections)
}

type resumeRow struct {
	group   string
	session *Session
}

func (p *ResumePicker) renderRows(width int) []string {
	theme := p.o.Theme
	groups := GroupSessions(FilterSessions(p.lists[p.Scope], p.Query), p.o.Now(), p.o.Location)
	if len(groups) == 0 {
		if p.Query != "" {
			return []string{theme.Fg("dim", "No sessions match the search.")}
		}
		return []string{theme.Fg("dim", "No saved sessions here yet. Press tab to see all folders.")}
	}
	var rows []resumeRow
	for _, g := range groups {
		rows = append(rows, resumeRow{group: g.Group})
		for i := range g.Sessions {
			rows = append(rows, resumeRow{session: &g.Sessions[i]})
		}
	}
	selected, _ := p.selected()
	selectedRow := 0
	for i, r := range rows {
		if r.session != nil && r.session.Path == selected.Path {
			selectedRow = i
			break
		}
	}
	start, end := VisibleWindow(len(rows), selectedRow, p.listRows())
	var lines []string
	if start > 0 && rows[start].session != nil {
		for i := start - 1; i >= 0; i-- {
			if rows[i].session == nil {
				lines = append(lines, theme.Fg("muted", rows[i].group))
				break
			}
		}
	}
	for i := start; i < end; i++ {
		if rows[i].session == nil {
			lines = append(lines, theme.Fg("muted", rows[i].group))
		} else {
			lines = append(lines, p.renderSession(*rows[i].session, rows[i].session.Path == selected.Path, width))
		}
	}
	below := 0
	for _, r := range rows[end:] {
		if r.session != nil {
			below++
		}
	}
	if below > 0 {
		lines = append(lines, theme.Fg("dim", "  ↓ "+chrome.Plural(below, "more session")))
	}
	return lines
}

func (p *ResumePicker) renderSession(s Session, active bool, width int) string {
	theme := p.o.Theme
	title := SessionTitle(s)
	marker, label := "  ", theme.Fg("text", title)
	if active {
		marker, label = theme.Fg("accent", "› "), theme.Fg("accent", chrome.BoldText(theme, title))
	}
	var meta []string
	if s.Path == p.o.CurrentPath && p.o.CurrentPath != "" {
		meta = append(meta, theme.Fg("success", "open now"))
	}
	if p.Scope == "all" && s.Cwd != "" {
		meta = append(meta, theme.Fg("muted", filepath.Base(s.Cwd)))
	}
	meta = append(meta, theme.Fg("dim", RelativeAge(s.Modified, p.o.Now(), p.o.Location)))
	meta = append(meta, theme.Fg("dim", chrome.Plural(s.MessageCount, "msg")))
	return SplitRow(marker+label, strings.Join(meta, theme.Fg("dim", " · ")), width)
}

func (p *ResumePicker) renderPreview(s Session, width int) []string {
	theme := p.o.Theme
	body := max(1, width-9)
	preview, ok := p.previews[s.Path]
	if !ok {
		preview = &previewState{loading: true}
		p.previews[s.Path] = preview
		path := s.Path
		p.o.Go(func() {
			value, err := p.o.LoadPreview(path)
			p.mu.Lock()
			if err != nil {
				p.previews[path] = &previewState{failed: true}
			} else {
				p.previews[path] = &previewState{value: value}
			}
			p.mu.Unlock()
			p.o.RequestRender()
		})
	}
	unnamed := s
	unnamed.Name = ""
	started := SessionTitle(unnamed)
	var last string
	switch {
	case preview.loading:
		last = "…"
	case preview.failed:
		last = "(could not read)"
	case preview.value.LastReply != nil:
		last = *preview.value.LastReply
	case preview.value.LastPrompt != nil:
		last = *preview.value.LastPrompt
	default:
		last = "(nothing yet)"
	}
	first := func(lines []string) string {
		if len(lines) == 0 {
			return ""
		}
		return lines[0]
	}
	lines := []string{
		theme.Fg("accent", "started  ") + first(WrapLimited(started, body, 1)),
		theme.Fg("muted", "last     ") + theme.Fg("muted", first(WrapLimited(last, body, 1))),
	}
	if p.Scope == "all" && s.Cwd != "" {
		where := s.Cwd
		if home := p.o.HomeDir; home != "" && strings.HasPrefix(s.Cwd, home) {
			where = "~" + s.Cwd[len(home):]
		}
		lines = append(lines, theme.Fg("muted", "folder   ")+theme.Fg("dim", where))
	}
	return lines
}
