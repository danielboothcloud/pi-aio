package askuserquestion

// Port of pi-tui 1.2.0's Input component (components/input.js) with its
// KillRing, UndoStack, and word navigation, as the questionnaire uses it:
// a headless value for the inline "Type something." row and the notes
// field. Offsets are byte offsets into the UTF-8 value (pi-tui counts
// UTF-16 code units); every offset lands on the same grapheme boundary, so
// the rendered result is the same.
//
// Word navigation approximates Intl.Segmenter's word granularity: letters,
// digits, marks, and "_" form a word, joined across one "." or "'" (and ":"
// between letters) as ICU does; a run of horizontal spaces is one segment;
// any other character is its own segment. CJK text is one word per run
// (ICU uses a dictionary).

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/danielboothcloud/pi-aio/go/internal/tuiwidth"
)

// Input is pi-tui's Input with prompt "> " and no placeholder.
type Input struct {
	keys    Keys
	value   string
	cursor  int
	prompt  string
	focused bool

	pasteBuffer string
	isInPaste   bool
	killRing    []string
	lastAction  string
	undoStack   []inputSnapshot
}

type inputSnapshot struct {
	value  string
	cursor int
}

// NewInput is `new Input()`.
func NewInput(keys Keys) *Input { return &Input{keys: keys, prompt: "> "} }

// Value is getValue().
func (in *Input) Value() string { return in.value }

// Cursor is the private cursor field, a byte offset.
func (in *Input) Cursor() int { return in.cursor }

// SetValue is setValue(value): the cursor is clamped, not moved.
func (in *Input) SetValue(value string) {
	in.value = value
	in.cursor = min(in.cursor, len(value))
}

// SetFocused sets the focused flag.
func (in *Input) SetFocused(f bool) { in.focused = f }

func graphemes(s string) []string {
	var out []string
	for s != "" {
		var g string
		g, s = tuiwidth.FirstGrapheme(s)
		out = append(out, g)
	}
	return out
}

func firstGrapheme(s string) string {
	if s == "" {
		return ""
	}
	g, _ := tuiwidth.FirstGrapheme(s)
	return g
}

func lastGraphemeLen(s string) int {
	gs := graphemes(s)
	if len(gs) == 0 {
		return 1
	}
	return len(gs[len(gs)-1])
}

// HandleInput is handleInput(data).
func (in *Input) HandleInput(data string) {
	if strings.Contains(data, "\x1b[200~") {
		in.isInPaste = true
		in.pasteBuffer = ""
		data = strings.Replace(data, "\x1b[200~", "", 1)
	}
	if in.isInPaste {
		in.pasteBuffer += data
		if end := strings.Index(in.pasteBuffer, "\x1b[201~"); end != -1 {
			content := in.pasteBuffer[:end]
			in.handlePaste(content)
			in.isInPaste = false
			remaining := in.pasteBuffer[end+6:]
			in.pasteBuffer = ""
			if remaining != "" {
				in.HandleInput(remaining)
			}
		}
		return
	}
	kb := in.keys
	switch {
	case kb.Matches(data, "tui.select.cancel"):
		return
	case kb.Matches(data, "tui.editor.undo"):
		in.undo()
		return
	case kb.Matches(data, "tui.input.submit") || data == "\n":
		return
	case kb.Matches(data, "tui.editor.deleteCharBackward"):
		in.handleBackspace()
		return
	case kb.Matches(data, "tui.editor.deleteCharForward"):
		in.handleForwardDelete()
		return
	case kb.Matches(data, "tui.editor.deleteWordBackward"):
		in.deleteWordBackwards()
		return
	case kb.Matches(data, "tui.editor.deleteWordForward"):
		in.deleteWordForward()
		return
	case kb.Matches(data, "tui.editor.deleteToLineStart"):
		in.deleteToLineStart()
		return
	case kb.Matches(data, "tui.editor.deleteToLineEnd"):
		in.deleteToLineEnd()
		return
	case kb.Matches(data, "tui.editor.yank"):
		in.yank()
		return
	case kb.Matches(data, "tui.editor.yankPop"):
		in.yankPop()
		return
	case kb.Matches(data, "tui.editor.cursorLeft"):
		in.lastAction = ""
		if in.cursor > 0 {
			in.cursor -= lastGraphemeLen(in.value[:in.cursor])
		}
		return
	case kb.Matches(data, "tui.editor.cursorRight"):
		in.lastAction = ""
		if in.cursor < len(in.value) {
			g := firstGrapheme(in.value[in.cursor:])
			if g == "" {
				in.cursor++
			} else {
				in.cursor += len(g)
			}
		}
		return
	case kb.Matches(data, "tui.editor.cursorLineStart"):
		in.lastAction = ""
		in.cursor = 0
		return
	case kb.Matches(data, "tui.editor.cursorLineEnd"):
		in.lastAction = ""
		in.cursor = len(in.value)
		return
	case kb.Matches(data, "tui.editor.cursorWordLeft"):
		in.moveWordBackwards()
		return
	case kb.Matches(data, "tui.editor.cursorWordRight"):
		in.moveWordForwards()
		return
	}
	if printable, ok := kb.DecodeKittyPrintable(data); ok {
		in.insertCharacter(printable)
		return
	}
	for _, r := range data {
		if r < 32 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return
		}
	}
	in.insertCharacter(data)
}

func hasJSSpace(s string) bool { return strings.IndexFunc(s, tuiwidth.IsJSSpace) >= 0 }

func (in *Input) insertCharacter(char string) {
	if hasJSSpace(char) || in.lastAction != "type-word" {
		in.pushUndo()
	}
	in.lastAction = "type-word"
	in.value = in.value[:in.cursor] + char + in.value[in.cursor:]
	in.cursor += len(char)
}

func (in *Input) handleBackspace() {
	in.lastAction = ""
	if in.cursor > 0 {
		in.pushUndo()
		n := lastGraphemeLen(in.value[:in.cursor])
		in.value = in.value[:in.cursor-n] + in.value[in.cursor:]
		in.cursor -= n
	}
}

func (in *Input) handleForwardDelete() {
	in.lastAction = ""
	if in.cursor < len(in.value) {
		in.pushUndo()
		n := len(firstGrapheme(in.value[in.cursor:]))
		if n == 0 {
			n = 1
		}
		in.value = in.value[:in.cursor] + in.value[in.cursor+n:]
	}
}

func (in *Input) killPush(text string, prepend, accumulate bool) {
	if text == "" {
		return
	}
	if accumulate && len(in.killRing) > 0 {
		last := in.killRing[len(in.killRing)-1]
		if prepend {
			in.killRing[len(in.killRing)-1] = text + last
		} else {
			in.killRing[len(in.killRing)-1] = last + text
		}
		return
	}
	in.killRing = append(in.killRing, text)
}

func (in *Input) killPeek() string {
	if len(in.killRing) == 0 {
		return ""
	}
	return in.killRing[len(in.killRing)-1]
}

func (in *Input) deleteToLineStart() {
	if in.cursor == 0 {
		return
	}
	in.pushUndo()
	in.killPush(in.value[:in.cursor], true, in.lastAction == "kill")
	in.lastAction = "kill"
	in.value = in.value[in.cursor:]
	in.cursor = 0
}

func (in *Input) deleteToLineEnd() {
	if in.cursor >= len(in.value) {
		return
	}
	in.pushUndo()
	in.killPush(in.value[in.cursor:], false, in.lastAction == "kill")
	in.lastAction = "kill"
	in.value = in.value[:in.cursor]
}

func (in *Input) deleteWordBackwards() {
	if in.cursor == 0 {
		return
	}
	wasKill := in.lastAction == "kill"
	in.pushUndo()
	old := in.cursor
	in.moveWordBackwards()
	from := in.cursor
	in.cursor = old
	in.killPush(in.value[from:in.cursor], true, wasKill)
	in.lastAction = "kill"
	in.value = in.value[:from] + in.value[in.cursor:]
	in.cursor = from
}

func (in *Input) deleteWordForward() {
	if in.cursor >= len(in.value) {
		return
	}
	wasKill := in.lastAction == "kill"
	in.pushUndo()
	old := in.cursor
	in.moveWordForwards()
	to := in.cursor
	in.cursor = old
	in.killPush(in.value[in.cursor:to], false, wasKill)
	in.lastAction = "kill"
	in.value = in.value[:in.cursor] + in.value[to:]
}

func (in *Input) yank() {
	text := in.killPeek()
	if text == "" {
		return
	}
	in.pushUndo()
	in.value = in.value[:in.cursor] + text + in.value[in.cursor:]
	in.cursor += len(text)
	in.lastAction = "yank"
}

func (in *Input) yankPop() {
	if in.lastAction != "yank" || len(in.killRing) <= 1 {
		return
	}
	in.pushUndo()
	prev := in.killPeek()
	in.value = in.value[:in.cursor-len(prev)] + in.value[in.cursor:]
	in.cursor -= len(prev)
	last := in.killRing[len(in.killRing)-1]
	in.killRing = append([]string{last}, in.killRing[:len(in.killRing)-1]...)
	text := in.killPeek()
	in.value = in.value[:in.cursor] + text + in.value[in.cursor:]
	in.cursor += len(text)
	in.lastAction = "yank"
}

func (in *Input) pushUndo() {
	in.undoStack = append(in.undoStack, inputSnapshot{in.value, in.cursor})
}

func (in *Input) undo() {
	if len(in.undoStack) == 0 {
		return
	}
	s := in.undoStack[len(in.undoStack)-1]
	in.undoStack = in.undoStack[:len(in.undoStack)-1]
	in.value, in.cursor = s.value, s.cursor
	in.lastAction = ""
}

func (in *Input) moveWordBackwards() {
	if in.cursor == 0 {
		return
	}
	in.lastAction = ""
	in.cursor = findWordBackward(in.value, in.cursor)
}

func (in *Input) moveWordForwards() {
	if in.cursor >= len(in.value) {
		return
	}
	in.lastAction = ""
	in.cursor = findWordForward(in.value, in.cursor)
}

func (in *Input) handlePaste(text string) {
	in.lastAction = ""
	in.pushUndo()
	clean := strings.NewReplacer("\r\n", "", "\r", "", "\n", "", "\t", "    ").Replace(text)
	in.value = in.value[:in.cursor] + clean + in.value[in.cursor:]
	in.cursor += len(clean)
}

// Render is render(width).
func (in *Input) Render(width int) []string {
	available := width - tuiwidth.VisibleWidth(in.prompt)
	if available <= 0 {
		return []string{tuiwidth.TruncateToWidth(in.prompt, width, "", false)}
	}
	visible := ""
	cursorDisplay := in.cursor
	total := tuiwidth.VisibleWidth(in.value)
	if total < available {
		visible = in.value
	} else {
		scrollWidth := available
		if in.cursor == len(in.value) {
			scrollWidth = available - 1
		}
		cursorCol := tuiwidth.VisibleWidth(in.value[:in.cursor])
		if scrollWidth > 0 {
			half := scrollWidth / 2
			start := 0
			switch {
			case cursorCol < half:
				start = 0
			case cursorCol > total-half:
				start = max(0, total-scrollWidth)
			default:
				start = max(0, cursorCol-half)
			}
			visible = tuiwidth.SliceByColumn(in.value, start, scrollWidth, true)
			cursorDisplay = len(tuiwidth.SliceByColumn(in.value, start, max(0, cursorCol-start), true))
		} else {
			visible = ""
			cursorDisplay = 0
		}
	}
	cursorDisplay = min(cursorDisplay, len(visible))
	at := firstGrapheme(visible[cursorDisplay:])
	if at == "" {
		at = " "
	}
	before := visible[:cursorDisplay]
	after := ""
	if cursorDisplay+len(at) <= len(visible) {
		after = visible[cursorDisplay+len(at):]
	}
	marker := ""
	if in.focused {
		marker = tuiwidth.CursorMarker
	}
	withCursor := before + marker + tuiwidth.RenderFakeCursor(at) + after
	pad := strings.Repeat(" ", max(0, available-tuiwidth.VisibleWidth(withCursor)))
	return []string{in.prompt + withCursor + pad}
}

// Word navigation (word-navigation.ts over an approximate word segmenter).

type wordSegment struct {
	text     string
	wordLike bool
}

var punctuation = regexp.MustCompile("[(){}\\[\\]<>.,;:'\"!?+\\-=*/\\\\|&%^$#@~`]")

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) || r == '_' || unicode.Is(unicode.Pc, r)
}

func isHorizontalSpace(r rune) bool {
	return r != '\n' && r != '\r' && r != 0x2028 && r != 0x2029 && r != '\v' && r != '\f' && tuiwidth.IsJSSpace(r)
}

// segmentWords approximates Intl.Segmenter(undefined, {granularity: "word"}).
func segmentWords(s string) []wordSegment {
	var out []wordSegment
	runes := []rune(s)
	for i := 0; i < len(runes); {
		r := runes[i]
		switch {
		case isWordRune(r):
			j := i + 1
			for j < len(runes) {
				if isWordRune(runes[j]) {
					j++
					continue
				}
				if (runes[j] == '.' || runes[j] == '\'' || runes[j] == 0x2019 || (runes[j] == ':' && unicode.IsLetter(runes[j-1]))) &&
					j+1 < len(runes) && isWordRune(runes[j+1]) {
					j += 2
					continue
				}
				break
			}
			out = append(out, wordSegment{string(runes[i:j]), true})
			i = j
		case isHorizontalSpace(r):
			j := i + 1
			for j < len(runes) && isHorizontalSpace(runes[j]) {
				j++
			}
			out = append(out, wordSegment{string(runes[i:j]), false})
			i = j
		case r == '\r' && i+1 < len(runes) && runes[i+1] == '\n':
			out = append(out, wordSegment{"\r\n", false})
			i += 2
		default:
			g := firstGrapheme(string(runes[i:]))
			n := len([]rune(g))
			if n == 0 {
				n = 1
			}
			out = append(out, wordSegment{string(runes[i : i+n]), false})
			i += n
		}
	}
	return out
}

// findWordBackward ports findWordBackward.
func findWordBackward(text string, cursor int) int {
	if cursor <= 0 {
		return 0
	}
	segments := segmentWords(text[:cursor])
	n := cursor
	for len(segments) > 0 && hasJSSpace(segments[len(segments)-1].text) {
		n -= len(segments[len(segments)-1].text)
		segments = segments[:len(segments)-1]
	}
	if len(segments) == 0 {
		return n
	}
	last := segments[len(segments)-1]
	if last.wordLike {
		matches := punctuation.FindAllStringIndex(last.text, -1)
		if len(matches) == 0 {
			n -= len(last.text)
		} else {
			n -= len(last.text) - matches[len(matches)-1][1]
		}
		return n
	}
	for len(segments) > 0 && !segments[len(segments)-1].wordLike && !hasJSSpace(segments[len(segments)-1].text) {
		n -= len(segments[len(segments)-1].text)
		segments = segments[:len(segments)-1]
	}
	return n
}

// findWordForward ports findWordForward.
func findWordForward(text string, cursor int) int {
	if cursor >= len(text) {
		return len(text)
	}
	segments := segmentWords(text[cursor:])
	n := cursor
	i := 0
	for i < len(segments) && hasJSSpace(segments[i].text) {
		n += len(segments[i].text)
		i++
	}
	if i >= len(segments) {
		return n
	}
	if segments[i].wordLike {
		if loc := punctuation.FindStringIndex(segments[i].text); loc != nil {
			return n + loc[0]
		}
		return n + len(segments[i].text)
	}
	for i < len(segments) && !segments[i].wordLike && !hasJSSpace(segments[i].text) {
		n += len(segments[i].text)
		i++
	}
	return n
}
