package styles

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type golden struct {
	Contexts []struct {
		Style, Mode, Content string
		Meta                 Metadata
	} `json:"contexts"`
	Parses []struct {
		Value, Result string
	} `json:"parses"`
	FilterCases []struct {
		Messages []any `json:"messages"`
		Style    string
		Result   []any `json:"result"`
	} `json:"filterCases"`
	Notices []string `json:"notices"`
}

func load(t *testing.T) golden {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestContextsMatchTypeScript(t *testing.T) {
	g := load(t)
	for _, c := range g.Contexts {
		if got := BuildContext(c.Style, c.Mode); got != c.Content {
			t.Errorf("%s/%s:\n go %q\n ts %q", c.Style, c.Mode, got, c.Content)
		}
		if got := StyleMetadata(c.Style); got != c.Meta {
			t.Errorf("%s meta: %+v, TypeScript %+v", c.Style, got, c.Meta)
		}
	}
}

func TestHelpersMatchTypeScript(t *testing.T) {
	g := load(t)
	for _, c := range g.Parses {
		got, ok := ParseStyle(c.Value)
		if !ok {
			got = ""
		}
		if got != c.Result {
			t.Errorf("ParseStyle(%q) = %q, TypeScript %q", c.Value, got, c.Result)
		}
	}
	for _, c := range g.FilterCases {
		got, changed := FilterContext(c.Messages, c.Style)
		if changed != (c.Result != nil) || (changed && !reflect.DeepEqual(got, c.Result)) {
			t.Errorf("%v %s: %v %v, TypeScript %v", c.Messages, c.Style, got, changed, c.Result)
		}
	}
	// The command notices: five switches, then an unknown name, then a bare /style without UI.
	want := g.Notices
	got := []string{Notice("ste"), Notice("concise"), Notice("collaborate"), Notice("tutor"), Notice("none"),
		UnknownNotice("bogus"), "Style: none"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("notices:\n go %q\n ts %q", got, want)
	}
}

func TestLatestPersisted(t *testing.T) {
	entry := func(style any) map[string]any {
		return map[string]any{"type": "custom", "customType": EntryType, "data": map[string]any{"style": style}}
	}
	cases := []struct {
		entries []map[string]any
		want    string
		ok      bool
	}{
		{nil, "", false},
		{[]map[string]any{entry("ste"), entry("mentor")}, "tutor", true},
		{[]map[string]any{entry("humanised")}, "ste", true},
		{[]map[string]any{entry("concise"), {"type": "message"}}, "concise", true},
		{[]map[string]any{entry("bogus")}, "none", true},
	}
	for _, c := range cases {
		if got, ok := LatestPersisted(c.entries); got != c.want || ok != c.ok {
			t.Errorf("%v: %q %v", c.entries, got, ok)
		}
	}
}
