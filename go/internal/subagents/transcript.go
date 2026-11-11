package subagents

// Port of subagents/transcript.ts: the bounded live transcript of one child
// for the inspector. It is in memory only: never in tool details or model
// context.

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const (
	MaxTranscriptEntries = 500
	MaxTranscriptChars   = 250_000
	maxBlockChars        = 8_000
	maxToolOutputChars   = 6_000
	maxToolArgsChars     = 2_000
	maxPromptChars       = 4_000
	maxLogChars          = 4_000
)

var (
	ansiPattern    = regexp.MustCompile(`[\x{1B}\x{9B}][\[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\x{07})|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`)
	controlPattern = regexp.MustCompile(`[\x00-\x08\x0B-\x1F\x7F]`)
	crlfPattern    = regexp.MustCompile(`\r\n?`)
)

// Entry is one transcript entry. Kind is notice, prompt, thinking, text,
// tool, or log; the fields of other kinds stay empty.
type Entry struct {
	Kind string  `json:"kind"`
	At   float64 `json:"at"`
	// Rev is bumped on every mutation so renderers can cache wrapped lines.
	Rev  int    `json:"rev"`
	Text string `json:"text,omitempty"`
	Tone string `json:"tone,omitempty"`
	// Blocks (thinking/text).
	Streaming bool `json:"streaming,omitempty"`
	Clipped   int  `json:"clipped,omitempty"`
	// Tools.
	ID         string   `json:"id,omitempty"`
	Name       string   `json:"name,omitempty"`
	Summary    string   `json:"summary,omitempty"`
	Args       string   `json:"args,omitempty"`
	Output     string   `json:"output,omitempty"`
	Status     string   `json:"status,omitempty"`
	DurationMs *float64 `json:"durationMs,omitempty"`
}

// Transcript is ChildTranscript.
type Transcript struct {
	Entries         []*Entry
	Dropped         int
	Chars           int
	Turns           int
	openBlocks      map[int]*Entry
	openOrder       []int
	streamedMessage bool
	tools           map[string]*Entry
	Revision        int
}

// NewTranscript is createTranscript.
func NewTranscript() *Transcript {
	return &Transcript{Entries: []*Entry{}, openBlocks: map[int]*Entry{}, tools: map[string]*Entry{}}
}

// Clone is a deep copy (structuredClone).
func (t *Transcript) Clone() *Transcript {
	out := &Transcript{Dropped: t.Dropped, Chars: t.Chars, Turns: t.Turns, streamedMessage: t.streamedMessage,
		Revision: t.Revision, openBlocks: map[int]*Entry{}, tools: map[string]*Entry{}}
	copies := map[*Entry]*Entry{}
	for _, e := range t.Entries {
		c := *e
		if e.DurationMs != nil {
			c.DurationMs = fptr(*e.DurationMs)
		}
		copies[e] = &c
		out.Entries = append(out.Entries, &c)
	}
	for _, index := range t.openOrder {
		if e, ok := copies[t.openBlocks[index]]; ok {
			out.openBlocks[index] = e
			out.openOrder = append(out.openOrder, index)
		}
	}
	for id, e := range t.tools {
		if c, ok := copies[e]; ok {
			out.tools[id] = c
		}
	}
	return out
}

// SanitizeText is sanitizeText.
func SanitizeText(text string) string {
	text = ansiPattern.ReplaceAllString(text, "")
	text = crlfPattern.ReplaceAllString(text, "\n")
	text = strings.ReplaceAll(text, "\t", "  ")
	return controlPattern.ReplaceAllString(text, "")
}

// ClipMiddle is clipMiddle: keep the head and tail (UTF-16 units).
func ClipMiddle(text string, max int) string {
	n := jsstr.Len16(text)
	if n <= max {
		return text
	}
	keep := int(math.Max(0, float64(max-40)))
	head := (keep + 1) / 2
	tail := keep - head
	omitted := n - head - tail
	out := jsstr.Slice16(text, head) + "\n… " + strconv.Itoa(omitted) + " chars omitted …\n"
	if tail > 0 {
		out += jsstr.SliceFrom(text, -tail)
	}
	return out
}

func entrySize(e *Entry) int {
	if e.Kind == "tool" {
		return jsstr.Len16(e.Args) + jsstr.Len16(e.Output) + jsstr.Len16(e.Summary)
	}
	return jsstr.Len16(e.Text)
}

func (t *Transcript) deleteOpen(index int) {
	delete(t.openBlocks, index)
	t.openOrder = slices.DeleteFunc(t.openOrder, func(i int) bool { return i == index })
}

func (t *Transcript) setOpen(index int, e *Entry) {
	if _, ok := t.openBlocks[index]; !ok {
		t.openOrder = append(t.openOrder, index)
	}
	t.openBlocks[index] = e
}

func (t *Transcript) clearOpen() {
	t.openBlocks = map[int]*Entry{}
	t.openOrder = nil
}

func (t *Transcript) forget(e *Entry) {
	if e.Kind == "tool" && t.tools[e.ID] == e {
		delete(t.tools, e.ID)
	}
	if e.Kind == "thinking" || e.Kind == "text" {
		for _, index := range slices.Clone(t.openOrder) {
			if t.openBlocks[index] == e {
				t.deleteOpen(index)
			}
		}
	}
}

func (t *Transcript) enforceBudget() {
	for len(t.Entries) > 1 && (len(t.Entries) > MaxTranscriptEntries || t.Chars > MaxTranscriptChars) {
		oldest := t.Entries[0]
		t.Entries = t.Entries[1:]
		t.Chars -= entrySize(oldest)
		t.Dropped++
		t.forget(oldest)
	}
}

func (t *Transcript) contains(e *Entry) bool { return slices.Contains(t.Entries, e) }

func (t *Transcript) mutate(e *Entry, change func(*Entry)) {
	before := entrySize(e)
	change(e)
	e.Rev++
	t.Revision++
	if t.contains(e) {
		t.Chars += entrySize(e) - before
		t.enforceBudget()
	}
}

func (t *Transcript) push(e *Entry) *Entry {
	t.Entries = append(t.Entries, e)
	t.Chars += entrySize(e)
	t.Revision++
	t.enforceBudget()
	return e
}

func (t *Transcript) remove(e *Entry) {
	index := slices.Index(t.Entries, e)
	if index == -1 {
		return
	}
	t.Entries = slices.Delete(t.Entries, index, index+1)
	t.Chars -= entrySize(e)
	t.Revision++
	t.forget(e)
}

// PushNotice is pushTranscriptNotice.
func (t *Transcript) PushNotice(text, tone string, now float64) {
	if tone == "" {
		tone = "muted"
	}
	t.push(&Entry{Kind: "notice", Text: ClipMiddle(SanitizeText(text), maxPromptChars), Tone: tone, At: now})
}

// AppendLog is appendTranscriptLog: consecutive stderr chunks coalesce.
func (t *Transcript) AppendLog(chunk string, now float64) {
	text := SanitizeText(chunk)
	if jsstr.Trim(text) == "" {
		return
	}
	if n := len(t.Entries); n > 0 && t.Entries[n-1].Kind == "log" {
		t.mutate(t.Entries[n-1], func(e *Entry) { e.Text = ClipMiddle(e.Text+text, maxLogChars) })
		return
	}
	t.push(&Entry{Kind: "log", Text: ClipMiddle(text, maxLogChars), At: now})
}

func contentText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	list, ok := content.([]any)
	if !ok {
		return ""
	}
	var parts []string
	for _, part := range list {
		block, ok := part.(*Object)
		if !ok {
			continue
		}
		if block.Get("type") == "text" {
			if text, ok := block.Get("text").(string); ok {
				parts = append(parts, text)
			}
		} else if block.Get("type") == "image" {
			parts = append(parts, "[image]")
		}
	}
	return strings.Join(parts, "\n")
}

func resultText(result any) string {
	if s, ok := result.(string); ok {
		return s
	}
	o, ok := result.(*Object)
	if !ok {
		return ""
	}
	return contentText(o.Get("content"))
}

func formatArgs(args any, present bool) string {
	if !present {
		return ""
	}
	return ClipMiddle(SanitizeText(Stringify(args, "  ")), maxToolArgsChars)
}

func (t *Transcript) openBlock(kind string, index int, now float64) *Entry {
	if existing, ok := t.openBlocks[index]; ok && existing.Kind == kind {
		return existing
	}
	e := t.push(&Entry{Kind: kind, Streaming: true, At: now})
	t.setOpen(index, e)
	t.streamedMessage = true
	return e
}

func (t *Transcript) closeBlock(e *Entry, content any) {
	authoritative, isString := content.(string)
	if isString {
		authoritative = SanitizeText(authoritative)
	}
	t.mutate(e, func(b *Entry) {
		if isString {
			b.Text = ClipMiddle(authoritative, maxBlockChars)
			b.Clipped = 0
		}
		b.Streaming = false
	})
	if jsstr.Trim(e.Text) == "" {
		t.remove(e)
	}
}

func (t *Transcript) applyMessageUpdate(inner *Object, now float64) {
	kindType := ""
	if v := inner.Get("type"); v != nil {
		kindType = jsString(v)
	}
	index := int(jsNumberOrZero(inner.Get("contentIndex")))
	kind := ""
	if strings.HasPrefix(kindType, "thinking_") {
		kind = "thinking"
	} else if strings.HasPrefix(kindType, "text_") {
		kind = "text"
	}
	if kind == "" {
		return
	}
	if strings.HasSuffix(kindType, "_start") {
		t.openBlock(kind, index, now)
		return
	}
	e := t.openBlock(kind, index, now)
	if strings.HasSuffix(kindType, "_delta") {
		delta := ""
		if s, ok := inner.Get("delta").(string); ok {
			delta = SanitizeText(s)
		}
		if delta == "" {
			return
		}
		t.mutate(e, func(b *Entry) {
			room := max(0, maxBlockChars-jsstr.Len16(b.Text))
			b.Text += jsstr.Slice16(delta, room)
			b.Clipped += max(0, jsstr.Len16(delta)-room)
		})
		return
	}
	if strings.HasSuffix(kindType, "_end") {
		t.closeBlock(e, inner.Get("content"))
		t.deleteOpen(index)
	}
}

func (t *Transcript) reconcileUnstreamed(message *Object, now float64) {
	content, ok := message.Get("content").([]any)
	if !ok {
		return
	}
	for _, part := range content {
		block, ok := part.(*Object)
		if !ok {
			continue
		}
		kind, field := "", ""
		switch block.Get("type") {
		case "thinking":
			kind, field = "thinking", "thinking"
		case "text":
			kind, field = "text", "text"
		}
		raw, isString := block.Get(field).(string)
		if kind == "" || !isString || jsstr.Trim(raw) == "" {
			continue
		}
		t.push(&Entry{Kind: kind, Text: ClipMiddle(SanitizeText(raw), maxBlockChars), At: now})
	}
}

// ApplyEvent is applyTranscriptEvent.
func (t *Transcript) ApplyEvent(event *Object, now float64) {
	switch event.Get("type") {
	case "turn_start":
		t.Turns++
		t.PushNotice("turn "+strconv.Itoa(t.Turns), "muted", now)
	case "message_start":
		if message, ok := event.Get("message").(*Object); ok && message.Get("role") == "assistant" {
			t.clearOpen()
			t.streamedMessage = false
		}
	case "message_update":
		if inner, ok := event.Get("assistantMessageEvent").(*Object); ok {
			t.applyMessageUpdate(inner, now)
		}
	case "message_end":
		message, ok := event.Get("message").(*Object)
		if !ok {
			return
		}
		if message.Get("role") == "user" {
			if text := jsstr.Trim(SanitizeText(contentText(message.Get("content")))); text != "" {
				t.push(&Entry{Kind: "prompt", Text: ClipMiddle(text, maxPromptChars), At: now})
			}
			return
		}
		if message.Get("role") != "assistant" {
			return
		}
		for _, index := range slices.Clone(t.openOrder) {
			if e, ok := t.openBlocks[index]; ok {
				t.closeBlock(e, nil)
			}
		}
		t.clearOpen()
		if !t.streamedMessage {
			t.reconcileUnstreamed(message, now)
		}
		t.streamedMessage = false
		if msg, ok := message.Get("errorMessage").(string); ok && msg != "" {
			t.PushNotice(msg, "error", now)
		}
	case "tool_execution_start":
		id := "tool-" + strconv.Itoa(len(t.tools))
		if v := event.Get("toolCallId"); v != nil {
			id = jsString(v)
		}
		name := "tool"
		if v := event.Get("toolName"); v != nil {
			name = jsString(v)
		}
		e := t.push(&Entry{Kind: "tool", ID: id, Name: name, Summary: SummarizeToolArgs(name, event.Get("args")),
			Args: formatArgs(event.Get("args"), event.Has("args") && event.Get("args") != nil || event.Has("args")), Status: "running", At: now})
		t.tools[id] = e
	case "tool_execution_update":
		e, ok := t.tools[stringOr(event.Get("toolCallId"))]
		if !ok {
			return
		}
		text := SanitizeText(resultText(event.Get("partialResult")))
		t.mutate(e, func(tool *Entry) { tool.Output = ClipMiddle(text, maxToolOutputChars) })
	case "tool_execution_end":
		id := stringOr(event.Get("toolCallId"))
		e, ok := t.tools[id]
		if !ok {
			return
		}
		text := SanitizeText(resultText(event.Get("result")))
		t.mutate(e, func(tool *Entry) {
			if text != "" || tool.Output == "" {
				tool.Output = ClipMiddle(text, maxToolOutputChars)
			}
			tool.Status = "done"
			if event.Get("isError") == true {
				tool.Status = "error"
			}
			if d, ok := event.Get("durationMs").(float64); ok {
				tool.DurationMs = fptr(d)
			} else {
				tool.DurationMs = fptr(math.Max(0, now-tool.At))
			}
		})
		delete(t.tools, id)
	case "auto_retry_start":
		attempt := jsNumberOr(event.Get("attempt"), 1)
		maxAttempts := jsNumberOr(event.Get("maxAttempts"), 1)
		suffix := ""
		if msg, ok := event.Get("errorMessage").(string); ok {
			suffix = ": " + msg
		}
		t.PushNotice("provider retry "+jsstr.NumberJS(attempt)+"/"+jsstr.NumberJS(maxAttempts)+suffix, "warning", now)
	case "auto_retry_end":
		if event.Get("success") == false {
			suffix := ""
			if msg, ok := event.Get("finalError").(string); ok {
				suffix = ": " + msg
			}
			t.PushNotice("provider retries exhausted"+suffix, "error", now)
		}
	case "compaction_start":
		suffix := ""
		if reason, ok := event.Get("reason").(string); ok {
			suffix = " (" + reason + ")"
		}
		t.PushNotice("compacting context"+suffix, "muted", now)
	case "compaction_end":
		if msg, ok := event.Get("errorMessage").(string); ok {
			t.PushNotice("compaction failed: "+msg, "error", now)
		} else {
			t.PushNotice("compaction finished", "muted", now)
		}
	case "agent_settled":
		if event.Get("aborted") == true {
			t.PushNotice("aborted", "warning", now)
		} else {
			t.PushNotice("settled", "success", now)
		}
	}
}

// stringOr is String(value ?? "").
func stringOr(v any) string {
	if v == nil {
		return ""
	}
	return jsString(v)
}
