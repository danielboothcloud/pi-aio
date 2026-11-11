package astgrep

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type golden struct {
	Normalized []struct {
		Params  map[string]any
		Input   *Input
		Args    []string
		Command string
		Error   string
	}
	Summaries []struct {
		MaxResults int
		Matches    []Match
		Text       string
		ShownCount int
	}
	Parses []struct {
		Stdout, Mode, Error string
		Matches             []any
	}
	Outcomes []struct {
		Process Process
		Matches int
		Success bool
		Failure string
	}
	Results []struct {
		Name       string
		Params     map[string]any
		Matches    int
		Text       string
		ShownCount int
		Truncated  bool
	}
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

func TestNormalizeAndArgsMatchTypeScript(t *testing.T) {
	for _, c := range load(t).Normalized {
		in, err := Normalize(c.Params)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("%v: error %v, TypeScript %q", c.Params, err, c.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%v: unexpected error %v", c.Params, err)
			continue
		}
		if !reflect.DeepEqual(in, *c.Input) {
			t.Errorf("%v:\n go %+v\n ts %+v", c.Params, in, *c.Input)
		}
		args := BuildArgs(in)
		if !reflect.DeepEqual(args, c.Args) || FormatCommand("/bin/ast-grep", args) != c.Command {
			t.Errorf("%v args:\n go %q %q\n ts %q %q", c.Params, args, FormatCommand("/bin/ast-grep", args), c.Args, c.Command)
		}
	}
}

func TestOutputMatchesTypeScript(t *testing.T) {
	g := load(t)
	for _, c := range g.Summaries {
		in, _ := Normalize(map[string]any{"pattern": "x", "maxResults": float64(c.MaxResults)})
		text, shown := Summary(in, c.Matches)
		if text != c.Text || shown != c.ShownCount {
			t.Errorf("summary max=%d:\n go %q\n ts %q", c.MaxResults, text, c.Text)
		}
	}
	for _, c := range g.Parses {
		matches, err := ParseJSON(c.Stdout, c.Mode)
		if c.Error != "" {
			if err == nil || strings.Split(err.Error(), ":")[0] != c.Error {
				t.Errorf("parse %q: %v, TypeScript %q", c.Stdout, err, c.Error)
			}
			continue
		}
		if err != nil || len(matches) != len(c.Matches) {
			t.Errorf("parse %q: %v %v, TypeScript %v", c.Stdout, matches, err, c.Matches)
			continue
		}
		// A non-object item becomes an empty match; it formats like TypeScript's.
		for i, want := range c.Matches {
			if m, ok := want.(map[string]any); ok && !reflect.DeepEqual(matches[i], m) {
				t.Errorf("parse %q item %d: %v, TypeScript %v", c.Stdout, i, matches[i], m)
			}
		}
	}
	for _, c := range g.Outcomes {
		matches := make([]Match, c.Matches)
		if got := Success(c.Process, matches); got != c.Success {
			t.Errorf("success %+v %d: %v, TypeScript %v", c.Process, c.Matches, got, c.Success)
		}
		if got := FailureMessage(c.Process); got != c.Failure {
			t.Errorf("failure %+v:\n go %q\n ts %q", c.Process, got, c.Failure)
		}
	}
	for _, c := range g.Results {
		in, _ := Normalize(c.Params)
		var matches []Match
		if c.Name == "small" {
			matches = []Match{{"file": "src/a.ts", "range": map[string]any{"start": map[string]any{"line": 4.0, "column": 2.0}}, "text": "console.log(x)"}}
		}
		if c.Name == "big" {
			for i := 0; i < c.Matches; i++ {
				matches = append(matches, Match{"file": "f" + itoa(i) + ".ts", "range": map[string]any{"start": map[string]any{"line": float64(i), "column": 0.0}}, "text": "call(" + itoa(i) + ")"})
			}
		}
		stdout := map[string]string{"small": "[{}]", "raw": "  ", "big": "[]"}[c.Name]
		r := BuildResult(in, Process{Stdout: stdout}, matches)
		text := r.Text
		if r.Truncation.Truncated {
			text += TruncationNotice(r.Truncation, "@@PATH@@")
		}
		if text != c.Text || r.ShownCount != c.ShownCount || r.Truncation.Truncated != c.Truncated {
			t.Errorf("result %s:\n go %q\n ts %q", c.Name, tail(text), tail(c.Text))
		}
	}
}

func itoa(i int) string { return strings.TrimSpace(strings.Repeat(" ", 0) + jsNum(float64(i))) }

func tail(s string) string {
	if len(s) > 300 {
		return "…" + s[len(s)-300:]
	}
	return s
}
