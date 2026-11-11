package blocklist

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// golden.json is produced by testdata/gen-golden.ts from the TypeScript
// blocklist, which stays the reference until the Go port replaces it.
type golden struct {
	RuleSets map[string]any `json:"ruleSets"`
	Segments []struct {
		Command  string `json:"command"`
		OK       bool   `json:"ok"`
		Reason   string `json:"reason"`
		Segments []struct {
			Full    string `json:"full"`
			Program string `json:"program"`
		} `json:"segments"`
		Argvs [][]string `json:"argvs"`
	} `json:"segments"`
	Evaluations map[string][]struct {
		Command string `json:"command"`
		Hit     *struct {
			Source        string `json:"source"`
			Pattern       string `json:"pattern"`
			Reason        string `json:"reason"`
			Match         string `json:"match"`
			Segment       string `json:"segment"`
			Unsegmentable string `json:"unsegmentable"`
		} `json:"hit"`
	} `json:"evaluations"`
}

func loadGolden(t *testing.T) golden {
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

func TestSegmentMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	if len(g.Segments) < 100 {
		t.Fatalf("golden corpus too small: %d", len(g.Segments))
	}
	for _, want := range g.Segments {
		segments, reason, ok := Segment(want.Command)
		if ok != want.OK {
			t.Errorf("%q: ok=%v (reason %q), TypeScript ok=%v (reason %q)", want.Command, ok, reason, want.OK, want.Reason)
			continue
		}
		if !ok {
			if reason != want.Reason {
				t.Errorf("%q: reason %q, TypeScript %q", want.Command, reason, want.Reason)
			}
			continue
		}
		if len(segments) != len(want.Segments) {
			t.Errorf("%q: %d segments %+v, TypeScript %d %+v", want.Command, len(segments), segments, len(want.Segments), want.Segments)
			continue
		}
		for i, s := range segments {
			if s.Full != want.Segments[i].Full || s.Program != want.Segments[i].Program {
				t.Errorf("%q segment %d: %+v, TypeScript %+v", want.Command, i, s, want.Segments[i])
			}
		}
		argvs, _ := Argvs(want.Command)
		if len(argvs) != len(want.Argvs) {
			t.Errorf("%q: argvs %q, TypeScript %q", want.Command, argvs, want.Argvs)
			continue
		}
		for i := range argvs {
			if !(len(argvs[i]) == 0 && len(want.Argvs[i]) == 0) && !reflect.DeepEqual(argvs[i], want.Argvs[i]) {
				t.Errorf("%q argv %d: %q, TypeScript %q", want.Command, i, argvs[i], want.Argvs[i])
			}
		}
	}
}

func TestEvaluateMatchesTypeScript(t *testing.T) {
	g := loadGolden(t)
	for name, config := range g.RuleSets {
		agent := t.TempDir()
		data, _ := json.Marshal(config)
		if err := os.WriteFile(filepath.Join(agent, FileName), data, 0o600); err != nil {
			t.Fatal(err)
		}
		rules, _ := Load(Paths{AgentDir: agent, ConfigDirName: ".pi"}, t.TempDir(), nil)
		for _, want := range g.Evaluations[name] {
			hit, blocked := Evaluate(want.Command, rules)
			if blocked != (want.Hit != nil) {
				t.Errorf("%s %q: blocked=%v (%+v), TypeScript blocked=%v", name, want.Command, blocked, hit, want.Hit != nil)
				continue
			}
			if !blocked {
				continue
			}
			wantMatch := "text"
			if hit.Command {
				wantMatch = "command"
			}
			got := [6]string{hit.Source, hit.Pattern, hit.Reason, wantMatch, hit.Segment, hit.Unsegmentable}
			exp := [6]string{want.Hit.Source, want.Hit.Pattern, want.Hit.Reason, want.Hit.Match, want.Hit.Segment, want.Hit.Unsegmentable}
			if got != exp {
				t.Errorf("%s %q:\n go %q\n ts %q", name, want.Command, got, exp)
			}
		}
	}
}
