package tuicr

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type golden struct {
	Worlds  map[string]map[string]*string
	Results map[string]struct {
		Base     *string
		Comments json.RawMessage
	}
	Formats []struct {
		Comments []Comment
		Text     string
	}
	Pickers []struct {
		Base   *string
		Label  string
		Answer *string
		Args   []string
	}
}

func capture(world map[string]*string) Capture {
	return func(command string, args []string, _ string) (string, bool) {
		out, ok := world[strings.Join(append([]string{command}, args...), " ")]
		if !ok || out == nil {
			return "", false
		}
		return *out, true
	}
}

func TestMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	for name, want := range g.Results {
		world := g.Worlds[name]
		base := BaseBranch("/w", capture(world))
		if (want.Base == nil && base != "") || (want.Base != nil && base != *want.Base) {
			t.Errorf("%s base %q, TypeScript %v", name, base, want.Base)
		}
		comments, err := AllComments("/w", capture(world))
		var wantErr struct{ Error string }
		if json.Unmarshal(want.Comments, &wantErr) == nil && wantErr.Error != "" {
			if err == nil || !strings.HasPrefix(err.Error(), wantErr.Error) {
				t.Errorf("%s error %v, TypeScript %q", name, err, wantErr.Error)
			}
			continue
		}
		var wantComments []Comment
		_ = json.Unmarshal(want.Comments, &wantComments)
		if err != nil || !((len(comments) == 0 && len(wantComments) == 0) || reflect.DeepEqual(comments, wantComments)) {
			t.Errorf("%s comments %+v %v, TypeScript %+v", name, comments, err, wantComments)
		}
	}
	for _, c := range g.Formats {
		if got := Format(c.Comments); got != c.Text {
			t.Errorf("Format:\n go %q\n ts %q", got, c.Text)
		}
	}
	for _, c := range g.Pickers {
		base := ""
		if c.Base != nil {
			base = *c.Base
		}
		var got []string
		found := false
		for _, choice := range Choices(base) {
			if choice.Label != c.Label {
				continue
			}
			found = true
			got = choice.Args
			if choice.Build != nil {
				got = nil
				if c.Answer != nil && strings.TrimSpace(*c.Answer) != "" {
					got = choice.Build(strings.TrimSpace(*c.Answer))
				}
			}
		}
		if !found || (got == nil) != (c.Args == nil) || (got != nil && !reflect.DeepEqual(got, c.Args)) {
			t.Errorf("picker %v %q %v: %q, TypeScript %q", c.Base, c.Label, c.Answer, got, c.Args)
		}
	}
}
