package chrome

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type goldenCase struct {
	Fn    string          `json:"fn"`
	Theme string          `json:"theme"`
	Args  json.RawMessage `json:"args"`
	Width int             `json:"width"`
	Out   string          `json:"out"`
}

type caseArgs struct {
	Text, Label, Edge, Title, Meta, Tone, Icon, Marker string
	Indent                                             *int
	Active                                             bool
}

func TestChromeMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		RoleCodes map[string]int `json:"roleCodes"`
		Cases     []goldenCase   `json:"cases"`
		Plurals   []struct {
			Count            int
			Singular, Plural string
			Out              string
		} `json:"plurals"`
	}
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	themes := map[string]Theme{"ansi": GoldenTheme{g.RoleCodes}, "plain": PlainTheme{}}
	for i, c := range g.Cases {
		var a caseArgs
		if err := json.Unmarshal(c.Args, &a); err != nil {
			t.Fatal(err)
		}
		th := themes[c.Theme]
		indent := 0
		if a.Indent != nil {
			indent = *a.Indent
		}
		var got string
		switch c.Fn {
		case "fitLine":
			got = FitLine(a.Text, c.Width)
		case "fitLineEmpty":
			got = FitLineWith(a.Text, c.Width, "")
		case "padToWidth":
			got = PadToWidth(a.Text, c.Width)
		case "hint":
			got = Hint(th, a.Text, c.Width, indent)
		case "frameRow":
			got = FrameRow(th, a.Text, c.Width)
		case "divider":
			got = Divider(th, c.Width, a.Label)
		case "frameRule":
			got = FrameRule(th, c.Width, a.Edge, a.Label)
		case "header":
			got = Header(th, HeaderOptions{Title: a.Title, Meta: a.Meta, Tone: a.Tone, Icon: a.Icon, Indent: indent}, c.Width)
		case "item":
			got = Item(th, ItemOptions{Label: a.Label, Meta: a.Meta, Marker: a.Marker, Tone: a.Tone, Active: a.Active, Indent: a.Indent}, c.Width)
		default:
			t.Fatalf("unknown fn %q", c.Fn)
		}
		if got != c.Out {
			t.Errorf("case %d %s/%s width %d %s:\n got %q\nwant %q", i, c.Fn, c.Theme, c.Width, c.Args, got, c.Out)
		}
	}
	for _, p := range g.Plurals {
		got := Plural(p.Count, p.Singular)
		if p.Plural != "" {
			got = PluralForm(p.Count, p.Singular, p.Plural)
		}
		if got != p.Out {
			t.Errorf("plural %d %s: got %q want %q", p.Count, p.Singular, got, p.Out)
		}
	}
}
