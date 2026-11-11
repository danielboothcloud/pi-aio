package copywidget

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/chrome"
)

type goldenFile map[string]json.RawMessage

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func section[T any](t *testing.T, g goldenFile, name string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(g[name], &v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

func TestParseMatchesMarked(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct {
		Markdown  string
		All, Code []Block
	}](t, g, "parseCases") {
		if got := ExtractCopyableBlocks(c.Markdown); !reflect.DeepEqual(got, c.All) {
			t.Errorf("extractCopyableBlocks(%q):\n got %+v\nwant %+v", c.Markdown, got, c.All)
		}
		if got := ExtractFencedCodeBlocks(c.Markdown); !reflect.DeepEqual(got, c.Code) {
			t.Errorf("extractFencedCodeBlocks(%q):\n got %+v\nwant %+v", c.Markdown, got, c.Code)
		}
	}
}

func mdTheme(codes map[string]int, hyperlinks bool) MarkdownTheme {
	fg := func(role string) func(string) string {
		return func(s string) string { return "\x1b[" + strconv.Itoa(codes[role]) + "m" + s + "\x1b[39m" }
	}
	return MarkdownTheme{
		Heading: fg("mdHeading"), Link: fg("mdLink"), LinkURL: fg("mdLinkUrl"), Code: fg("mdCode"),
		CodeBlock: fg("mdCodeBlock"), CodeBlockBorder: fg("mdCodeBlockBorder"), Quote: fg("mdQuote"),
		QuoteBorder: fg("mdQuoteBorder"), Hr: fg("mdHr"), ListBullet: fg("mdListBullet"),
		Bold:          func(s string) string { return "\x1b[1m" + s + "\x1b[22m" },
		Italic:        func(s string) string { return "\x1b[3m" + s + "\x1b[23m" },
		Underline:     func(s string) string { return "\x1b[4m" + s + "\x1b[24m" },
		Strikethrough: func(s string) string { return "\x1b[9m" + s + "\x1b[29m" },
		HighlightCode: func(code, lang string) []string {
			lines := strings.Split(code, "\n")
			for i, l := range lines {
				if lang == "ts" {
					lines[i] = "\x1b[38;2;200;120;50m" + l + "\x1b[39m"
				} else {
					lines[i] = fg("mdCodeBlock")(l)
				}
			}
			return lines
		},
		Hyperlinks: hyperlinks,
	}
}

// keyMatcher matches the legacy sequences the generator sends.
func keyMatcher(keys map[string]string) func(data, id string) bool {
	ids := map[string]string{"escape": "escape", "ctrl+c": "ctrlC", "enter": "enter", "up": "up", "down": "down", "pageUp": "pageUp", "pageDown": "pageDown", "ctrl+u": "ctrlU", "ctrl+d": "ctrlD"}
	return func(data, id string) bool { return keys[ids[id]] == data }
}

func TestLabelsAndMarkdown(t *testing.T) {
	g := loadGolden(t)
	for _, c := range section[[]struct {
		Block Block
		Out   string
	}](t, g, "labels") {
		if got := BlockLabel(c.Block); got != c.Out {
			t.Errorf("blockLabel(%+v) = %q want %q", c.Block, got, c.Out)
		}
	}
	codes := section[map[string]int](t, g, "mdCodes")
	fails, wrapDiffs := 0, 0
	for _, c := range section[[]struct {
		Source     string
		Width      int
		Hyperlinks bool
		Out        []string
	}](t, g, "markdownCases") {
		got := RenderMarkdown(c.Source, 1, 0, c.Width, mdTheme(codes, c.Hyperlinks))
		if !reflect.DeepEqual(got, c.Out) && sameWords(got, c.Out) {
			// pi-tui 1.2.0 moves the style codes and the space after a word
			// that ends a line to the next line; PiG's Go wrap port
			// (tuiwidth) keeps them on the line. The words match.
			wrapDiffs++
			continue
		}
		if !reflect.DeepEqual(got, c.Out) {
			fails++
			if fails < 12 {
				t.Errorf("markdown %q width %d links %v:\n got %q\nwant %q", c.Source, c.Width, c.Hyperlinks, got, c.Out)
			}
		}
	}
	if fails > 0 {
		t.Errorf("%d markdown failures", fails)
	}
	if wrapDiffs != 4 {
		t.Errorf("%d wrap-only differences, want 4", wrapDiffs)
	}
}

func TestPickerMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	md := mdTheme(section[map[string]int](t, g, "mdCodes"), false)
	keys := section[map[string]string](t, g, "keys")
	many := section[[]Block](t, g, "manyBlocks")
	if got := ExtractCopyableBlocks(section[string](t, g, "pickerSource")); !reflect.DeepEqual(got, many) {
		t.Fatalf("picker blocks:\n got %+v\nwant %+v", got, many)
	}
	for _, s := range section[[]struct {
		Blocks  string
		MaxRows int
		Widths  []int
		Frames  []struct {
			Key     *string
			Done    any
			Renders int
			Lines   [][]string
		}
	}](t, g, "pickerCases") {
		blocks := many
		switch s.Blocks {
		case "few":
			blocks = many[:3]
		case "empty":
			blocks = []Block{}
		}
		renders := 0
		maxRows := s.MaxRows
		p := NewPicker(PickerOptions{Blocks: blocks, Theme: theme, MaxRows: func() int { return maxRows }, Matches: keyMatcher(keys), Markdown: md, RequestRender: func() { renders++ }})
		for fi, f := range s.Frames {
			if f.Key != nil {
				p.HandleInput(keys[*f.Key])
			}
			var done any = "pending"
			if b, ok := p.Done(); ok {
				done = nil
				if b != nil {
					done = float64(b.Ordinal)
				}
			}
			if !reflect.DeepEqual(done, f.Done) || renders != f.Renders {
				t.Errorf("picker %s/%d frame %d: done %v renders %d want %v %d", s.Blocks, s.MaxRows, fi, done, renders, f.Done, f.Renders)
			}
			for wi, w := range s.Widths {
				if got := p.Render(w); !reflect.DeepEqual(got, f.Lines[wi]) {
					t.Errorf("picker %s/%d frame %d width %d:\n got %q\nwant %q", s.Blocks, s.MaxRows, fi, w, got, f.Lines[wi])
				}
			}
		}
	}
}

func TestOpenFlowMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	theme := chrome.GoldenTheme{Codes: section[map[string]int](t, g, "roleCodes")}
	md := mdTheme(section[map[string]int](t, g, "mdCodes"), false)
	keys := section[map[string]string](t, g, "keys")
	branches := section[map[string][]json.RawMessage](t, g, "branches")
	commands := section[[]struct{ Name, Description string }](t, g, "commands")
	shortcuts := section[[]struct{ Key, Description string }](t, g, "shortcuts")
	if len(commands) != 1 || commands[0].Name != CommandName || commands[0].Description != CommandDescription {
		t.Errorf("commands %+v", commands)
	}
	if len(shortcuts) != 1 || shortcuts[0].Key != Shortcut || shortcuts[0].Description != ShortcutDescription {
		t.Errorf("shortcuts %+v", shortcuts)
	}
	for _, s := range section[[]struct {
		Trigger, Mode, Branch string
		Keys                  []string
		Notifications         []Notice
		CustomCalls           []struct {
			FirstFrame []string
		}
		Clipboard []string
	}](t, g, "registerCases") {
		var notices []Notice
		var clipboard []string
		customs := 0
		blocks, notice := OpenStep(s.Mode, branches[s.Branch])
		if notice != nil {
			notices = append(notices, *notice)
		} else {
			customs++
			p := NewPicker(PickerOptions{Blocks: blocks, Theme: theme, MaxRows: func() int { return 27 }, Matches: keyMatcher(keys), Markdown: md})
			if got := p.Render(80); !reflect.DeepEqual(got, s.CustomCalls[0].FirstFrame) {
				t.Errorf("%s/%s first frame:\n got %q\nwant %q", s.Mode, s.Branch, got, s.CustomCalls[0].FirstFrame)
			}
			for _, k := range s.Keys {
				p.HandleInput(keys[k])
			}
			if b, _ := p.Done(); b != nil {
				var err error
				if strings.Contains(b.Text, "FAIL") {
					err = errors.New("no clipboard tool")
				} else {
					clipboard = append(clipboard, b.Text)
				}
				notices = append(notices, CopyNotice(*b, err))
			}
		}
		if customs != len(s.CustomCalls) || !reflect.DeepEqual(notices, nilIfEmpty(s.Notifications)) || !reflect.DeepEqual(clipboard, nilIfEmptyStrings(s.Clipboard)) {
			t.Errorf("%s %s/%s: notices %+v clipboard %q customs %d\nwant %+v %q %d", s.Trigger, s.Mode, s.Branch, notices, clipboard, customs, s.Notifications, s.Clipboard, len(s.CustomCalls))
		}
	}
}

var sgrRe = regexp.MustCompile("\x1b\\[[0-9;]*m|\x1b\\]8;;[^\x1b]*\x1b\\\\")

// sameWords compares the visible words of two renders.
func sameWords(a, b []string) bool {
	words := func(lines []string) []string {
		return strings.Fields(sgrRe.ReplaceAllString(strings.Join(lines, " "), ""))
	}
	return reflect.DeepEqual(words(a), words(b))
}

func nilIfEmpty(n []Notice) []Notice {
	if len(n) == 0 {
		return nil
	}
	return n
}

func nilIfEmptyStrings(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return s
}
