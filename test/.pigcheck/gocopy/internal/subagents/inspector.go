package subagents

// Port of subagents/inspector.ts: the live inspector overlay (/subagents,
// alt+s). A list of every child of every run and a follow-tail detail view
// of one child's transcript. Rendering is pure over the registry; the caller
// holds the registry lock around every method. Every returned line fits the
// width and the overlay never exceeds GetMaxRows rows.

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const (
	// InspectorTickMs is the repaint interval for live updates.
	InspectorTickMs      = 500
	collapsedToolLines   = 6
	collapsedPromptLines = 4
	collapsedLogLines    = 3
	detailFixedRows      = 9
	listFixedRows        = 6
)

// Target is InspectorTarget.
type Target struct {
	Key   string
	Run   *Run
	Child *Child
}

// TargetKey is targetKey.
func TargetKey(run *Run, child *Child) string { return run.ID + ":" + strconv.Itoa(child.Index) }

// InspectorTargets is inspectorTargets: active runs first, newest first.
func InspectorTargets(runs []*Run) []Target {
	ordered := slices.Clone(runs)
	slices.SortStableFunc(ordered, func(a, b *Run) int {
		if d := boolInt(b.Active()) - boolInt(a.Active()); d != 0 {
			return d
		}
		return cmpDesc(a.StartedAt, b.StartedAt)
	})
	var out []Target
	for _, run := range ordered {
		for _, child := range run.Children {
			out = append(out, Target{Key: TargetKey(run, child), Run: run, Child: child})
		}
	}
	return out
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func childTone(c *Child, now float64) string {
	switch c.State {
	case "failed":
		return "error"
	case "stopped":
		return "warning"
	case "completed":
		return "success"
	case "queued":
		return "muted"
	}
	if FormatChildActivity(c, now).Stale {
		return "warning"
	}
	return "accent"
}

func stateGlyph(state string) string {
	switch state {
	case "running":
		return "◐"
	case "queued":
		return "◌"
	case "completed":
		return "✓"
	case "failed":
		return "✗"
	}
	return "■"
}

func firstLine(text string, max int) string {
	flat := jsstr.Trim(jsstr.CollapseSpace(text))
	if jsstr.Len16(flat) > max {
		return jsstr.Slice16(flat, max-1) + "…"
	}
	return flat
}

// DescribeChild is describeChild.
func DescribeChild(c *Child, now float64) string {
	if c.State == "running" {
		return FormatChildActivity(c, now).Text
	}
	if c.State == "queued" {
		return "queued · waiting for a worker slot"
	}
	parts := []string{c.State}
	if c.StartedAt != nil {
		end := now
		if c.EndedAt != nil {
			end = *c.EndedAt
		}
		parts = append(parts, FormatDuration(end-*c.StartedAt))
	}
	if c.Attempts != nil && *c.Attempts > 1 {
		parts = append(parts, strconv.Itoa(*c.Attempts)+" attempts")
	}
	if c.Error != "" {
		parts = append(parts, firstLine(c.Error, 80))
	}
	return strings.Join(parts, " · ")
}

// RenderOptions is TranscriptRenderOptions.
type RenderOptions struct {
	ExpandTools  bool
	ShowThinking bool
	Now          float64
}

func wrapLines(text string, width, indent int, color func(string) string) []string {
	pad := strings.Repeat(" ", indent)
	inner := max(1, width-indent)
	var out []string
	for _, line := range chrome.Wrap(text, inner) {
		out = append(out, chrome.FitLine(pad+color(line), width))
	}
	return out
}

func collapse(lines []string, limit int, expanded bool, theme chrome.Theme, width, indent int) []string {
	if expanded || len(lines) <= limit {
		return lines
	}
	hidden := len(lines) - limit
	return append(slices.Clone(lines[:limit]), chrome.Hint(theme, "… "+chrome.Plural(hidden, "more line")+" · o expands", width, indent))
}

var trailingNewlines = regexp.MustCompile(`\n+$`)

func toolHeader(e *Entry, theme chrome.Theme, width int, now float64) string {
	icon := theme.Fg("success", "✓")
	switch e.Status {
	case "running":
		icon = theme.Fg("accent", "◐")
	case "error":
		icon = theme.Fg("error", "✗")
	}
	name := theme.Fg("toolTitle", chrome.BoldText(theme, e.Name))
	summary := ""
	if e.Summary != "" {
		summary = " " + theme.Fg("muted", e.Summary)
	}
	timing := ""
	if e.Status == "running" {
		timing = "running " + FormatDuration(now-e.At)
	} else if e.DurationMs != nil {
		timing = FormatDuration(*e.DurationMs)
	}
	meta := ""
	if timing != "" {
		meta = theme.Fg("dim", " · "+timing)
	}
	return chrome.FitLine(icon+" "+name+summary+meta, width)
}

func entryBody(e *Entry, width int, theme chrome.Theme, o RenderOptions) []string {
	dim := func(line string) string { return theme.Fg("dim", line) }
	switch e.Kind {
	case "notice":
		if e.Tone == "muted" {
			return []string{chrome.Divider(theme, width, e.Text)}
		}
		glyph := "✗"
		if e.Tone == "success" {
			glyph = "✓"
		} else if e.Tone == "warning" {
			glyph = "⚠"
		}
		return wrapLines(glyph+" "+e.Text, width, 0, func(line string) string { return theme.Fg(e.Tone, line) })
	case "prompt":
		return append([]string{chrome.FitLine(theme.Fg("accent", "› prompt"), width)},
			collapse(wrapLines(e.Text, width, 2, dim), collapsedPromptLines, o.ExpandTools, theme, width, 2)...)
	case "thinking":
		if !o.ShowThinking {
			return []string{chrome.FitLine(dim("✻ thinking · "+chrome.Plural(jsstr.Len16(e.Text), "char")+" hidden · t shows"), width)}
		}
		streaming := ""
		if e.Streaming {
			streaming = " …"
		}
		color := func(line string) string { return theme.Fg("thinkingText", line) }
		lines := append([]string{chrome.FitLine(color("✻ thinking"+streaming), width)}, wrapLines(e.Text, width, 2, color)...)
		if e.Clipped > 0 {
			lines = append(lines, chrome.Hint(theme, "… "+strconv.Itoa(e.Clipped)+" more chars not captured", width, 2))
		}
		return lines
	case "text":
		streaming := ""
		if e.Streaming {
			streaming = " …"
		}
		lines := append([]string{chrome.FitLine(theme.Fg("accent", "● response"+streaming), width)},
			wrapLines(e.Text, width, 2, func(line string) string { return theme.Fg("text", line) })...)
		if e.Clipped > 0 {
			lines = append(lines, chrome.Hint(theme, "… "+strconv.Itoa(e.Clipped)+" more chars not captured", width, 2))
		}
		return lines
	case "log":
		return append([]string{chrome.FitLine(dim("≡ stderr"), width)},
			collapse(wrapLines(trailingNewlines.ReplaceAllString(e.Text, ""), width, 2, dim), collapsedLogLines, o.ExpandTools, theme, width, 2)...)
	case "tool":
		var lines []string
		if o.ExpandTools && e.Args != "" {
			lines = append(lines, chrome.Hint(theme, "args", width, 2))
			lines = append(lines, wrapLines(e.Args, width, 4, dim)...)
			lines = append(lines, chrome.Hint(theme, "output", width, 2))
		}
		if e.Output != "" {
			color := func(line string) string { return theme.Fg("toolOutput", line) }
			if e.Status == "error" {
				color = func(line string) string { return theme.Fg("error", line) }
			}
			lines = append(lines, collapse(wrapLines(trailingNewlines.ReplaceAllString(e.Output, ""), width, 4, color),
				collapsedToolLines, o.ExpandTools, theme, width, 4)...)
		} else if e.Status != "running" {
			lines = append(lines, chrome.Hint(theme, "(no output)", width, 4))
		}
		return lines
	}
	return nil
}

type bodyCacheItem struct {
	key   string
	lines []string
}

// BodyCache caches wrapped entry bodies by revision and options.
type BodyCache map[*Entry]bodyCacheItem

func renderEntry(e *Entry, width int, theme chrome.Theme, o RenderOptions, cache BodyCache) []string {
	key := strconv.Itoa(e.Rev) + "|" + strconv.Itoa(width) + "|" + strconv.FormatBool(o.ExpandTools) + "|" + strconv.FormatBool(o.ShowThinking)
	item, ok := cache[e]
	if cache == nil || !ok || item.key != key {
		item = bodyCacheItem{key, entryBody(e, width, theme, o)}
		if cache != nil {
			cache[e] = item
		}
	}
	if e.Kind == "tool" {
		return append([]string{toolHeader(e, theme, width, o.Now)}, item.lines...)
	}
	return item.lines
}

// RenderTranscriptLines is renderTranscriptLines. transcript overrides the
// child's own (a lazily loaded saved transcript).
func RenderTranscriptLines(c *Child, transcript *Transcript, width int, theme chrome.Theme, o RenderOptions, cache BodyCache) []string {
	if width <= 0 {
		return []string{}
	}
	lines := []string{}
	if transcript == nil {
		if c.State == "queued" {
			lines = append(lines, chrome.Hint(theme, "Queued — no activity until a worker slot frees up.", width, 0))
		} else {
			lines = append(lines, chrome.Hint(theme, "Transcript not retained for this run (only recent runs keep one).", width, 0))
		}
	} else {
		if transcript.Dropped > 0 {
			lines = append(lines, chrome.Hint(theme, "… "+chrome.PluralForm(transcript.Dropped, "earlier entry", "earlier entries")+" dropped to bound memory", width, 0))
		}
		var previous *Entry
		for _, e := range transcript.Entries {
			if previous != nil && e.Kind != "notice" && previous.Kind != "notice" {
				lines = append(lines, "")
			}
			lines = append(lines, renderEntry(e, width, theme, o, cache)...)
			previous = e
		}
		if len(transcript.Entries) == 0 {
			lines = append(lines, chrome.Hint(theme, "Waiting for the child's first event…", width, 0))
		}
	}
	if c.Output != nil && *c.Output != "" && c.State != "running" && c.State != "queued" {
		hasText := transcript != nil && slices.ContainsFunc(transcript.Entries, func(e *Entry) bool { return e.Kind == "text" })
		if !hasText {
			lines = append(lines, "", chrome.FitLine(theme.Fg("accent", "● result"), width))
			lines = append(lines, wrapLines(*c.Output, width, 2, func(line string) string { return theme.Fg("text", line) })...)
		}
	}
	if c.SessionFile != "" {
		lines = append(lines, "", chrome.Hint(theme, "session: "+c.SessionFile, width, 0))
	}
	return lines
}

// InspectorOptions is SubagentInspectorOptions.
type InspectorOptions struct {
	Theme             chrome.Theme
	GetRuns           func() []*Run
	GetMaxRows        func() int
	Done              func()
	ResumeChild       func(Target)
	ResumeUnavailable func(Target) string
	LoadTranscript    func(sessionFile string) *Transcript
	Now               func() float64
	// Matches is pi-tui matchesKey (key ids such as "escape", "ctrl+c").
	Matches func(data, key string) bool
}

// Inspector is SubagentInspector.
type Inspector struct {
	o               InspectorOptions
	loadedChild     *Child
	savedTranscript *Transcript
	closed          bool
	cache           BodyCache

	View           string
	SelectedKey    string
	ExpandTools    bool
	ShowThinking   bool
	scroll         int
	follow         bool
	lastMaxScroll  int
	lastBodyHeight int
	lastListHeight int
}

// NewInspector is the SubagentInspector constructor.
func NewInspector(o InspectorOptions) *Inspector {
	in := &Inspector{o: o, View: "list", ShowThinking: true, follow: true, lastBodyHeight: 1, lastListHeight: 1, cache: BodyCache{}}
	targets := in.targets()
	var running []Target
	for _, t := range targets {
		if t.Child.State == "running" {
			running = append(running, t)
		}
	}
	if len(running) > 0 {
		in.SelectedKey = running[0].Key
	} else if len(targets) > 0 {
		in.SelectedKey = targets[0].Key
	}
	if len(targets) == 1 || len(running) == 1 {
		in.View = "detail"
	}
	return in
}

func (in *Inspector) targets() []Target { return InspectorTargets(in.o.GetRuns()) }

func (in *Inspector) selectedIndex(targets []Target) int {
	for i, t := range targets {
		if t.Key == in.SelectedKey {
			return i
		}
	}
	return 0
}

func (in *Inspector) selectAt(targets []Target, index int) {
	if len(targets) == 0 {
		return
	}
	in.SelectedKey = targets[max(0, min(len(targets)-1, index))].Key
}

func (in *Inspector) cycle(delta int) {
	targets := in.targets()
	if len(targets) == 0 {
		return
	}
	index := (in.selectedIndex(targets) + delta + len(targets)) % len(targets)
	in.SelectedKey = targets[index].Key
	in.scroll = 0
	in.follow = true
}

func (in *Inspector) scrollBy(delta int) {
	in.scroll = max(0, min(in.lastMaxScroll, in.scroll+delta))
	in.follow = in.scroll >= in.lastMaxScroll
}

// Closed reports whether the inspector closed.
func (in *Inspector) Closed() bool { return in.closed }

// Close is close: dispose once and report done.
func (in *Inspector) Close() {
	if in.closed {
		return
	}
	in.closed = true
	in.Dispose()
	if in.o.Done != nil {
		in.o.Done()
	}
}

// Dispose releases the loaded saved transcript.
func (in *Inspector) Dispose() {
	in.loadedChild = nil
	in.savedTranscript = nil
	in.cache = BodyCache{}
}

// InspectRun follows a newly launched continuation.
func (in *Inspector) InspectRun(run *Run) {
	if in.closed || len(run.Children) == 0 {
		return
	}
	in.SelectedKey = TargetKey(run, run.Children[0])
	in.View = "detail"
	in.scroll = 0
	in.follow = true
}

func (in *Inspector) recoveryHint(t *Target) string {
	if in.o.ResumeChild == nil || t == nil || (t.Child.State != "failed" && t.Child.State != "stopped") {
		return ""
	}
	if in.o.ResumeUnavailable != nil {
		if reason := in.o.ResumeUnavailable(*t); reason != "" {
			return "resume unavailable: " + reason
		}
	}
	return "r resume saved session"
}

func (in *Inspector) is(data, key string) bool { return in.o.Matches != nil && in.o.Matches(data, key) }

// HandleInput is handleInput.
func (in *Inspector) HandleInput(data string) {
	if in.closed {
		return
	}
	if data == "q" || in.is(data, "ctrl+c") {
		in.Close()
		return
	}
	if data == "r" && in.o.ResumeChild != nil {
		targets := in.targets()
		if len(targets) > 0 {
			t := targets[in.selectedIndex(targets)]
			if t.Child.State == "failed" || t.Child.State == "stopped" {
				in.o.ResumeChild(t)
			}
		}
		return
	}
	if in.View == "list" {
		in.handleList(data)
	} else {
		in.handleDetail(data)
	}
}

func (in *Inspector) handleList(data string) {
	targets := in.targets()
	index := in.selectedIndex(targets)
	page := max(1, in.lastListHeight-1)
	switch {
	case in.is(data, "escape"):
		in.Close()
	case in.is(data, "up") || data == "k":
		in.selectAt(targets, index-1)
	case in.is(data, "down") || data == "j":
		in.selectAt(targets, index+1)
	case in.is(data, "pageUp") || in.is(data, "ctrl+u"):
		in.selectAt(targets, index-page)
	case in.is(data, "pageDown") || in.is(data, "ctrl+d"):
		in.selectAt(targets, index+page)
	case data == "g":
		in.selectAt(targets, 0)
	case data == "G":
		in.selectAt(targets, len(targets)-1)
	case (in.is(data, "enter") || in.is(data, "right") || data == "l") && len(targets) > 0:
		in.SelectedKey = targets[index].Key
		in.View = "detail"
		in.scroll = 0
		in.follow = true
	}
}

func (in *Inspector) handleDetail(data string) {
	page := max(1, in.lastBodyHeight-1)
	half := max(1, in.lastBodyHeight/2)
	switch {
	case in.is(data, "escape"):
		in.View = "list"
	case in.is(data, "down") || data == "j":
		in.scrollBy(1)
	case in.is(data, "up") || data == "k":
		in.scrollBy(-1)
	case in.is(data, "ctrl+d"):
		in.scrollBy(half)
	case in.is(data, "ctrl+u"):
		in.scrollBy(-half)
	case in.is(data, "pageDown") || data == " ":
		in.scrollBy(page)
	case in.is(data, "pageUp"):
		in.scrollBy(-page)
	case data == "g":
		in.scroll = 0
		in.follow = in.lastMaxScroll == 0
	case data == "G":
		in.follow = true
	case in.is(data, "tab") || data == "]" || data == "l" || in.is(data, "right"):
		in.cycle(1)
	case in.is(data, "shift+tab") || data == "[" || data == "h" || in.is(data, "left"):
		in.cycle(-1)
	case data == "o":
		in.ExpandTools = !in.ExpandTools
	case data == "t":
		in.ShowThinking = !in.ShowThinking
	}
}

// Render is render.
func (in *Inspector) Render(width int) []string {
	if width <= 0 {
		return []string{}
	}
	maxRows := max(1, in.o.GetMaxRows())
	targets := in.targets()
	if in.View == "detail" && len(targets) > 0 {
		return in.renderDetail(width, maxRows, targets, targets[in.selectedIndex(targets)])
	}
	return in.renderList(width, maxRows, targets)
}

func fitAll(lines []string, width int) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = chrome.FitLine(line, width)
	}
	return out
}

func (in *Inspector) renderDetail(width, maxRows int, targets []Target, t Target) []string {
	theme := in.o.Theme
	now := in.o.Now()
	run, child := t.Run, t.Child
	transcript := child.Transcript
	if transcript == nil && child.SessionFile != "" && in.o.LoadTranscript != nil {
		if in.loadedChild != child {
			in.loadedChild = child
			in.savedTranscript = in.o.LoadTranscript(child.SessionFile)
		}
		if in.savedTranscript != nil {
			transcript = in.savedTranscript
		}
	}
	framed := width > 24 && maxRows >= detailFixedRows+2
	inner := width
	if framed {
		inner = width - 4
	}
	row := func(text string) string {
		if framed {
			return chrome.FrameRow(theme, text, width)
		}
		return chrome.FitLine(text, width)
	}
	position := strconv.Itoa(in.selectedIndex(targets)+1) + "/" + strconv.Itoa(len(targets))
	runLabel := "run " + jsstr.Slice16(run.ID, 8)
	if run.Mode == "parallel" {
		runLabel += " #" + strconv.Itoa(child.Index+1) + "/" + strconv.Itoa(len(run.Children))
	}
	header := chrome.Header(theme, chrome.HeaderOptions{Title: "subagent", Meta: child.Agent + " · " + runLabel + " · " + position}, inner)
	statusParts := []string{DescribeChild(child, now)}
	if transcript != nil && transcript.Turns > 0 {
		statusParts = append(statusParts, chrome.Plural(transcript.Turns, "turn"))
	}
	tone := childTone(child, now)
	status := chrome.FitLine(theme.Fg(tone, stateGlyph(child.State))+" "+theme.Fg(tone, strings.Join(statusParts, " · ")), inner)
	thinking := child.Thinking
	if thinking == "" {
		thinking = "default"
	}
	effort := theme.Fg("muted", "[effort "+thinking+"]")
	modelWidth := max(0, inner-chrome.Width(effort)-1)
	modelText := child.Model
	if modelText == "" {
		modelText = "default (not reported)"
	}
	model := chrome.Header(theme, chrome.HeaderOptions{Title: "model", Meta: modelText}, modelWidth)
	configuration := chrome.FitLine(chrome.PadToWidth(model, modelWidth)+" "+effort, inner)
	task := chrome.Hint(theme, "task: "+firstLine(child.Task, 400), inner, 0)
	recovery := in.recoveryHint(&t)
	prefix := ""
	if recovery != "" {
		prefix = recovery + " · "
	}
	expandWord := "expand"
	if in.ExpandTools {
		expandWord = "collapse"
	}
	hint := chrome.Hint(theme, prefix+"j/k scroll · ^u/^d page · g/G top/follow · tab/⇧tab child · o "+expandWord+" · t thinking · esc list · q close", inner, 0)

	// Keep only entries still rendered in the cache.
	fresh := BodyCache{}
	body := RenderTranscriptLines(child, transcript, inner, theme, RenderOptions{ExpandTools: in.ExpandTools, ShowThinking: in.ShowThinking, Now: now}, in.cache)
	if transcript != nil {
		for _, e := range transcript.Entries {
			if item, ok := in.cache[e]; ok {
				fresh[e] = item
			}
		}
	}
	in.cache = fresh
	fixed := 3
	if framed {
		fixed = detailFixedRows
	}
	height := max(1, maxRows-fixed)
	in.lastBodyHeight = height
	in.lastMaxScroll = max(0, len(body)-height)
	if in.follow {
		in.scroll = in.lastMaxScroll
	}
	in.scroll = max(0, min(in.lastMaxScroll, in.scroll))
	visible := slices.Clone(body[in.scroll:min(len(body), in.scroll+height)])
	for len(visible) < height {
		visible = append(visible, "")
	}
	if !framed {
		lines := fitAll(append(append([]string{header, configuration}, visible...), hint), width)
		return lines[:min(len(lines), maxRows)]
	}
	rangeLabel := ""
	if len(body) > 0 {
		rangeLabel = strconv.Itoa(in.scroll+1) + "-" + strconv.Itoa(min(len(body), in.scroll+height)) + "/" + strconv.Itoa(len(body))
		if in.follow {
			rangeLabel += " · following"
		}
	}
	out := []string{chrome.FrameRule(theme, width, "top", ""), row(header), row(configuration), row(status), row(task),
		chrome.FrameRule(theme, width, "divider", "")}
	for _, line := range visible {
		out = append(out, row(line))
	}
	return append(out, chrome.FrameRule(theme, width, "divider", rangeLabel), row(hint), chrome.FrameRule(theme, width, "bottom", ""))
}

type listRow struct {
	run    *Run
	target *Target
}

func listRows(targets []Target) []listRow {
	var rows []listRow
	var last *Run
	for i := range targets {
		if targets[i].Run != last {
			rows = append(rows, listRow{run: targets[i].Run})
			last = targets[i].Run
		}
		rows = append(rows, listRow{target: &targets[i]})
	}
	return rows
}

func (in *Inspector) renderListRow(r listRow, width int, now float64) string {
	theme := in.o.Theme
	if r.target == nil {
		run := r.run
		done, failed := 0, 0
		for _, c := range run.Children {
			if c.State == "completed" {
				done++
			} else if c.State == "failed" {
				failed++
			}
		}
		parts := []string{run.Mode, run.Context + " context", strconv.Itoa(done) + "/" + strconv.Itoa(len(run.Children)) + " done"}
		if failed > 0 {
			parts = append(parts, strconv.Itoa(failed)+" failed")
		}
		end := now
		if run.EndedAt != nil {
			end = *run.EndedAt
		}
		parts = append(parts, FormatDuration(end-run.StartedAt))
		tone := "muted"
		if run.State == "failed" {
			tone = "error"
		} else if run.Active() {
			tone = "accent"
		}
		return chrome.Item(theme, chrome.ItemOptions{Label: jsstr.Slice16(run.ID, 8), Meta: strings.Join(parts, " · "),
			Marker: stateGlyph(run.State), Tone: tone, Indent: chrome.Indent(0)}, width)
	}
	child := r.target.Child
	active := r.target.Key == in.SelectedKey
	marker, tone := stateGlyph(child.State), childTone(child, now)
	if active {
		marker, tone = "›", ""
	}
	return chrome.Item(theme, chrome.ItemOptions{Label: child.Agent, Meta: DescribeChild(child, now), Marker: marker,
		Tone: tone, Active: active, Indent: chrome.Indent(2)}, width)
}

func (in *Inspector) renderList(width, maxRows int, targets []Target) []string {
	theme := in.o.Theme
	now := in.o.Now()
	framed := width > 24 && maxRows >= listFixedRows+1
	inner := width
	if framed {
		inner = width - 4
	}
	row := func(text string) string {
		if framed {
			return chrome.FrameRow(theme, text, width)
		}
		return chrome.FitLine(text, width)
	}
	runs := in.o.GetRuns()
	running := 0
	for _, t := range targets {
		if t.Child.State == "running" {
			running++
		}
	}
	header := chrome.Header(theme, chrome.HeaderOptions{Title: "subagents",
		Meta: chrome.Plural(len(runs), "run") + " · " + chrome.PluralForm(len(targets), "child", "children") + " · " + strconv.Itoa(running) + " running"}, inner)
	var selected *Target
	if len(targets) > 0 {
		selected = &targets[in.selectedIndex(targets)]
	}
	recovery := in.recoveryHint(selected)
	prefix := ""
	if recovery != "" {
		prefix = recovery + " · "
	}
	hint := chrome.Hint(theme, prefix+"j/k move · enter inspect · g/G ends · esc/q close", inner, 0)
	fixed := 2
	if framed {
		fixed = listFixedRows
	}
	height := max(1, maxRows-fixed)
	in.lastListHeight = height
	rows := listRows(targets)
	var lines []string
	offset := 0
	if len(rows) == 0 {
		lines = append(lines, chrome.Hint(theme, "No subagent runs in this session.", inner, 0))
	} else {
		if !slices.ContainsFunc(targets, func(t Target) bool { return t.Key == in.SelectedKey }) {
			in.SelectedKey = targets[0].Key
		}
		cursor := slices.IndexFunc(rows, func(r listRow) bool { return r.target != nil && r.target.Key == in.SelectedKey })
		anchor := max(0, cursor-1)
		offset = max(0, min(anchor, len(rows)-height))
		if cursor >= offset+height {
			offset = cursor - height + 1
		}
		for _, r := range rows[offset:min(len(rows), offset+height)] {
			lines = append(lines, in.renderListRow(r, inner, now))
		}
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	if !framed {
		all := fitAll(append(append([]string{header}, lines...), hint), width)
		return all[:min(len(all), maxRows)]
	}
	rangeLabel := ""
	if len(rows) > height {
		rangeLabel = strconv.Itoa(offset+1) + "-" + strconv.Itoa(min(len(rows), offset+height)) + "/" + strconv.Itoa(len(rows))
	}
	out := []string{chrome.FrameRule(theme, width, "top", ""), row(header), chrome.FrameRule(theme, width, "divider", "")}
	for _, line := range lines {
		out = append(out, row(line))
	}
	return append(out, chrome.FrameRule(theme, width, "divider", rangeLabel), row(hint), chrome.FrameRule(theme, width, "bottom", ""))
}
