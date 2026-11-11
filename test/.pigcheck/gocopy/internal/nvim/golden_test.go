package nvim

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/toolpaths"
)

type golden struct {
	Targets []struct {
		Target string
		Parsed struct {
			Path         string
			Line, Column int
		}
	}
	Strips []struct{ Token, Result string }
	Splits []struct {
		Args   string
		Result []string
	}
	Commands []struct {
		Request        Request
		Args           []string
		Command, Title string
	}
	Runs []struct {
		Env     map[string]string
		Succeed string
		Args    string
		Calls   [][]string
		Notes   []string
	}
	Tools []struct {
		Tool    string
		Input   map[string]any
		IsError bool
		Result  struct {
			Paths  []string
			Edited bool
		}
		Changes    []toolpaths.Change
		Structured []toolpaths.Change
	}
	Touches []struct {
		Paths   []string
		Edited  bool
		Now     float64
		Entries []SessionFile
	}
	Completions []struct {
		Prefix string
		Items  []Completion
	}
}

func same[T any](a, b []T) bool { return (len(a) == 0 && len(b) == 0) || reflect.DeepEqual(a, b) }

func TestMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Targets {
		path, line, column := ParseTarget(c.Target)
		if path != c.Parsed.Path || line != c.Parsed.Line || column != c.Parsed.Column {
			t.Errorf("ParseTarget(%q) = %q %d %d, TypeScript %+v", c.Target, path, line, column, c.Parsed)
		}
	}
	for _, c := range g.Strips {
		if got := StripAt(c.Token); got != c.Result {
			t.Errorf("StripAt(%q) = %q, TypeScript %q", c.Token, got, c.Result)
		}
	}
	for _, c := range g.Splits {
		if got := SplitTargets(c.Args); !same(got, c.Result) {
			t.Errorf("SplitTargets(%q) = %q, TypeScript %q", c.Args, got, c.Result)
		}
	}
	for _, c := range g.Commands {
		if !reflect.DeepEqual(Args(c.Request), c.Args) || Command(c.Request) != c.Command || Title(c.Request) != c.Title {
			t.Errorf("%+v: %q %q %q, TypeScript %q %q %q", c.Request, Args(c.Request), Command(c.Request), Title(c.Request), c.Args, c.Command, c.Title)
		}
	}
	for _, c := range g.Runs {
		var calls [][]string
		var notes []string
		requests, help, warn := ParseCommand(c.Args, "/r")
		switch {
		case help && warn:
			notes = append(notes, "warning:"+Help)
		case help:
			notes = append(notes, "info:"+Help)
		default:
			var outputs []string
			for _, r := range requests {
				outputs = append(outputs, Open(r, "/r", c.Env, "darwin", func(bin string, args []string) (int, error) {
					calls = append(calls, append([]string{bin}, args...))
					if bin == c.Succeed {
						return 0, nil
					}
					return 1, nil
				}))
			}
			notes = append(notes, "info:"+strings.Join(outputs, "\n"))
		}
		if !same(calls, c.Calls) || !same(notes, c.Notes) {
			t.Errorf("%v %s %q:\n go %q %q\n ts %q %q", c.Env, c.Succeed, c.Args, calls, notes, c.Calls, c.Notes)
		}
	}
	for _, c := range g.Tools {
		paths, edited := PathsFromToolResult(c.Tool, c.Input, c.IsError)
		if !same(paths, c.Result.Paths) || edited != c.Result.Edited {
			t.Errorf("%s %v: %q %v, TypeScript %+v", c.Tool, c.Input, paths, edited, c.Result)
		}
		if got := toolpaths.FileChanges(c.Tool, c.Input); !same(got, c.Changes) {
			t.Errorf("FileChanges %s %v:\n go %+v\n ts %+v", c.Tool, c.Input, got, c.Changes)
		}
		if got := toolpaths.StructuredChanges(c.Input); !same(got, c.Structured) {
			t.Errorf("StructuredChanges %v:\n go %+v\n ts %+v", c.Input, got, c.Structured)
		}
	}
	var entries []SessionFile
	for _, c := range g.Touches {
		entries = Touch(entries, c.Paths, c.Edited, c.Now, SessionFileLimit)
		if !same(entries, c.Entries) {
			t.Errorf("Touch %v:\n go %+v\n ts %+v", c.Paths, entries, c.Entries)
		}
	}
	session := []SessionFile{{"/r/src/a.ts", true, 1}, {"/r/b.ts", false, 1}, {"/other/x.ts", false, 1}}
	for _, c := range g.Completions {
		if got := Completions(c.Prefix, session, []string{"src/a.ts", "c.ts", "../up.ts"}, "/r", 3); !same(got, c.Items) {
			t.Errorf("Completions(%q):\n go %+v\n ts %+v", c.Prefix, got, c.Items)
		}
	}
}
