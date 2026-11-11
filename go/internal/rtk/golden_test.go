package rtk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/userbash"
)

type golden struct {
	Rewrites []struct {
		Command   string
		SentToRtk *string
		Result    *string
	}
	Bash []struct {
		Text   string
		State  userbash.State
		Spaced *string
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
	for _, c := range g.Rewrites {
		sent, ok := Prepare(c.Command)
		if ok != (c.SentToRtk != nil) || (ok && sent != *c.SentToRtk) {
			t.Errorf("%q: sent %q %v, TypeScript %v", c.Command, sent, ok, c.SentToRtk)
			continue
		}
		if !ok {
			continue
		}
		// The TS seam returns "rtk <cmd>" for git commands, else the input.
		stdout := sent
		if strings.HasPrefix(sent, "git") {
			stdout = "rtk " + sent
		}
		got, rewritten := Result(sent, stdout, 0, false)
		if rewritten != (c.Result != nil) || (rewritten && got != *c.Result) {
			t.Errorf("%q: result %q %v, TypeScript %v", c.Command, got, rewritten, c.Result)
		}
	}
	for _, c := range g.Bash {
		if got := userbash.Parse(c.Text); got != c.State {
			t.Errorf("Parse(%q) = %+v, TypeScript %+v", c.Text, got, c.State)
		}
		spaced, ok := userbash.EnsureSpacing(c.Text)
		if ok != (c.Spaced != nil) || (ok && spaced != *c.Spaced) {
			t.Errorf("EnsureSpacing(%q) = %q %v, TypeScript %v", c.Text, spaced, ok, c.Spaced)
		}
	}
	if got, ok := Result("x", "y\n", 3, false); !ok || got != "y" {
		t.Error("advisory exit 3 must rewrite")
	}
	for _, c := range []struct {
		code   int
		killed bool
	}{{1, false}, {0, true}, {2, false}} {
		if _, ok := Result("x", "y", c.code, c.killed); ok {
			t.Errorf("code %d killed %v must not rewrite", c.code, c.killed)
		}
	}
}
