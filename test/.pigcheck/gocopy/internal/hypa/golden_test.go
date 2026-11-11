package hypa

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type golden struct {
	Numbers []struct {
		V string
		R int
	}
	Flags []struct {
		V string
		R bool
	}
	Files   map[string]string
	Configs []struct {
		File   string
		Env    map[string]string
		Config *Config
		Error  string
	}
	ConfigPaths []struct {
		Env map[string]string
		R   string
	}
	Rewrites []struct {
		Stdout    string
		Status    *Status
		Formatted string
		Error     string
	}
	OutcomeCases []struct {
		Stdout, Stderr string
		Code           int
		Killed         bool
		Formatted      string
	}
	Timeouts []struct {
		Command string
		T       any
		R       string
	}
	Qualifies   []struct{ Command, Resolved, R string }
	Resolutions []struct {
		Name     string
		Existing []string
		Path     string
		Binary   string
		R        string
	}
	ExecArgs []struct {
		Binary string
		Args   []string
		R      []any
	}
	Quotes []struct{ V, R string }
	Reads  []struct {
		Path          string
		Offset, Limit *float64
		R             string
	}
	Greps []struct {
		P map[string]any
		R string
	}
	Finds []struct {
		P map[string]any
		R string
	}
	Lss []struct {
		P map[string]any
		R string
	}
	Limits []struct {
		S string
		L *float64
		R string
	}
	Raws []struct {
		C     string
		R     []string
		Error string
	}
	ReplaceCases []struct {
		List []string
		Mode string
		R    []string
	}
	Images []struct {
		Name, Hex, Mime string
		Opaque          bool
	}
	ToolRuns []struct {
		Name, Tool string
		Params     map[string]any
		Result     struct {
			Stdout, Stderr string
			Code           int
			Killed         bool
		}
		Calls []struct {
			Bin  string
			Args []string
			Opts struct {
				Timeout *float64
			}
		}
		Text string
	}
}

func same[T any](a, b []T) bool { return (len(a) == 0 && len(b) == 0) || reflect.DeepEqual(a, b) }

func TestMatchesTypeScript(t *testing.T) {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(data), "@@HOME@@", home)), &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Numbers {
		if got := ParsePositiveInteger(c.V, 42); got != c.R {
			t.Errorf("ParsePositiveInteger(%q) = %d, TypeScript %d", c.V, got, c.R)
		}
	}
	for _, c := range g.Flags {
		if ParseBool(c.V) != c.R {
			t.Errorf("ParseBool(%q)", c.V)
		}
	}
	dir := t.TempDir()
	for name, text := range g.Files {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600)
	}
	for _, c := range g.Configs {
		env := func(k string) (string, bool) { v, ok := c.Env[k]; return v, ok }
		path := ""
		if c.File != "" {
			path = filepath.Join(dir, c.File)
		}
		got, err := LoadConfig(env, path)
		if c.Error != "" {
			if err == nil || !strings.HasPrefix(err.Error(), c.Error) {
				t.Errorf("%s %v: %v, TypeScript %q", c.File, c.Env, err, c.Error)
			}
			continue
		}
		if err != nil || got != *c.Config {
			t.Errorf("%s %v:\n go %+v %v\n ts %+v", c.File, c.Env, got, err, *c.Config)
		}
	}
	for _, c := range g.ConfigPaths {
		env := func(k string) (string, bool) { v, ok := c.Env[k]; return v, ok }
		if got := ConfigFilePath(env, home); got != c.R {
			t.Errorf("ConfigFilePath(%v) = %q, TypeScript %q", c.Env, got, c.R)
		}
	}
	for _, c := range g.Rewrites {
		got, err := ParseRewrite(c.Stdout)
		if c.Error != "" {
			if err == nil || !strings.HasPrefix(err.Error(), c.Error) {
				t.Errorf("ParseRewrite(%q) err %v, TypeScript %q", c.Stdout, err, c.Error)
			}
			continue
		}
		if err != nil || got != *c.Status || FormatStatus(&got) != c.Formatted {
			t.Errorf("ParseRewrite(%q) = %+v %v, TypeScript %+v", c.Stdout, got, err, *c.Status)
		}
	}
	for _, c := range g.OutcomeCases {
		s := RewriteOutcome("i", c.Stdout, c.Stderr, c.Code, c.Killed, 5000)
		if FormatStatus(&s) != c.Formatted {
			t.Errorf("RewriteOutcome %+v = %q, TypeScript %q", c, FormatStatus(&s), c.Formatted)
		}
	}
	for _, c := range g.Timeouts {
		var timeout *float64
		if f, ok := c.T.(float64); ok {
			timeout = &f
		}
		if got := InjectTimeout(c.Command, timeout); got != c.R {
			t.Errorf("InjectTimeout(%q, %v) = %q, TypeScript %q", c.Command, c.T, got, c.R)
		}
	}
	for _, c := range g.Qualifies {
		if got := Qualify(c.Command, c.Resolved, "/usr/bin/node"); got != c.R {
			t.Errorf("Qualify(%q, %q) = %q, TypeScript %q", c.Command, c.Resolved, got, c.R)
		}
	}
	for _, c := range g.Resolutions {
		r := Resolver{Exists: func(p string) bool {
			for _, e := range c.Existing {
				if e == p {
					return true
				}
			}
			return false
		}, ModuleDirs: []string{"/nm"}, Path: c.Path, GOOS: "darwin", GOARCH: "arm64"}
		if got := r.ResolveBinary(c.Binary); got != c.R {
			t.Errorf("resolve %s = %q, TypeScript %q", c.Name, got, c.R)
		}
	}
	for _, c := range g.ExecArgs {
		bin, args := ExecArgs(c.Binary, c.Args, "/usr/bin/node")
		raw, _ := json.Marshal([]any{bin, args})
		want, _ := json.Marshal(c.R)
		if string(raw) != string(want) {
			t.Errorf("ExecArgs %s = %s, TypeScript %s", c.Binary, raw, want)
		}
	}
	for _, c := range g.Quotes {
		if got := ShellQuote(c.V); got != c.R {
			t.Errorf("ShellQuote(%q) = %q, TypeScript %q", c.V, got, c.R)
		}
	}
	for _, c := range g.Reads {
		if got := ReadCommand(c.Path, home, c.Offset, c.Limit); got != c.R {
			t.Errorf("ReadCommand(%q) = %q, TypeScript %q", c.Path, got, c.R)
		}
	}
	for _, list := range [][]struct {
		P map[string]any
		R string
	}{g.Greps, g.Finds, g.Lss} {
		for _, c := range list {
			tool := "hypa_grep"
			if &list[0] == &g.Finds[0] {
				tool = "hypa_find"
			} else if &list[0] == &g.Lss[0] {
				tool = "hypa_ls"
			}
			plan, err := ToolPlan(tool, c.P, home)
			if err != nil || plan.Command != c.R {
				t.Errorf("%s %v = %q %v, TypeScript %q", tool, c.P, plan.Command, err, c.R)
			}
		}
	}
	for _, c := range g.Limits {
		if got := LimitLines(c.S, c.L); got != c.R {
			t.Errorf("LimitLines(%q) = %q, TypeScript %q", c.S, got, c.R)
		}
	}
	for _, c := range g.Raws {
		got, err := SplitRaw(c.C)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("SplitRaw(%q) err %v", c.C, err)
			}
			continue
		}
		if err != nil || !same(got, c.R) {
			t.Errorf("SplitRaw(%q) = %q %v, TypeScript %q", c.C, got, err, c.R)
		}
	}
	for _, c := range g.ReplaceCases {
		if got := ReplaceFilter(c.List, c.Mode); !same(got, c.R) {
			t.Errorf("ReplaceFilter(%v, %s) = %v, TypeScript %v", c.List, c.Mode, got, c.R)
		}
	}
	for _, c := range g.Images {
		b, _ := hex.DecodeString(c.Hex)
		if ImageMime(b) != c.Mime || OpaqueBinary(b) != c.Opaque {
			t.Errorf("image %s: %q %v, TypeScript %q %v", c.Name, ImageMime(b), OpaqueBinary(b), c.Mime, c.Opaque)
		}
	}
	for _, c := range g.ToolRuns {
		plan, err := ToolPlan(c.Tool, c.Params, home)
		if err != nil || len(c.Calls) != 1 {
			t.Errorf("%s: %v (calls %d)", c.Name, err, len(c.Calls))
			continue
		}
		bin, args := ExecArgs("/opt/hypa", plan.Args, "/usr/bin/node")
		call := c.Calls[0]
		timeoutOK := (plan.TimeoutMs == nil) == (call.Opts.Timeout == nil) && (plan.TimeoutMs == nil || *plan.TimeoutMs == *call.Opts.Timeout)
		if bin != call.Bin || !reflect.DeepEqual(args, call.Args) || !timeoutOK {
			t.Errorf("%s call: %s %q %v, TypeScript %s %q %v", c.Name, bin, args, plan.TimeoutMs, call.Bin, call.Args, call.Opts.Timeout)
		}
		stdout := c.Result.Stdout
		if c.Tool == "hypa_find" {
			stdout = LimitLines(stdout, plan.Limit)
		}
		text := BuildToolText(stdout, c.Result.Stderr, plan.PreferTail)
		if got := FinishText(text, "@@PATH@@", c.Result.Code, c.Result.Killed); got != c.Text {
			t.Errorf("%s text:\n go %q\n ts %q", c.Name, tail(got), tail(c.Text))
		}
	}
}

func tail(s string) string {
	if len(s) > 200 {
		return "…" + s[len(s)-200:]
	}
	return s
}
