package effort

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type golden struct {
	Targets []struct {
		Raw    string
		Target struct{ Kind, Level, Value string }
	}
	Models []struct {
		Name  string
		Model map[string]any
	}
	Resolved []struct {
		Model, Level string
		Value        *string
	}
	Overrides []struct {
		Model   string
		Desired *string
		Payload any
		Changed bool
		Result  any
	}
	Effective   []struct{ Model, Requested, Clamped, Result string }
	Completions []struct {
		Prefix string
		Items  []struct{ Value, Label, Description string }
	}
}

func TestEffortMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Targets {
		got := ParseTarget(c.Raw)
		if got.Kind != c.Target.Kind || got.Level != c.Target.Level || got.Value != c.Target.Value {
			t.Errorf("%q: %+v, TypeScript %+v", c.Raw, got, c.Target)
		}
	}
	models := map[string]*Model{}
	for _, m := range g.Models {
		models[m.Name] = ModelFrom(m.Model)
	}
	for _, c := range g.Resolved {
		value, ok := ResolveValue(models[c.Model], c.Level)
		if ok != (c.Value != nil) || (ok && value != *c.Value) {
			t.Errorf("resolve %s %s: %q %v, TypeScript %v", c.Model, c.Level, value, ok, c.Value)
		}
	}
	for _, c := range g.Overrides {
		desired := ""
		if c.Desired != nil {
			desired = *c.Desired
		}
		payload, _ := c.Payload.(map[string]any)
		out, changed := ApplyOverride(models[c.Model], desired, payload)
		if changed != c.Changed || (changed && !reflect.DeepEqual(out, c.Result)) {
			t.Errorf("override %s %q %v: %v %v, TypeScript %v %v", c.Model, desired, c.Payload, out, changed, c.Result, c.Changed)
		}
	}
	for _, c := range g.Effective {
		if got := EffectiveLevel(models[c.Model], c.Requested, c.Clamped); got != c.Result {
			t.Errorf("effective %s %s/%s: %s, TypeScript %s", c.Model, c.Requested, c.Clamped, got, c.Result)
		}
	}
	for _, c := range g.Completions {
		got := Completions(c.Prefix)
		if len(got) != len(c.Items) {
			t.Errorf("completions %q: %d, TypeScript %d", c.Prefix, len(got), len(c.Items))
			continue
		}
		for i, item := range c.Items {
			if got[i].Value != item.Value || item.Label != item.Value || got[i].Description != item.Description {
				t.Errorf("completion %q %d: %+v, TypeScript %+v", c.Prefix, i, got[i], item)
			}
		}
	}
}

func TestNotices(t *testing.T) {
	if len(SelectLabels()) != 8 || SelectLabels()[7] != "ultracode — xhigh + dynamic_workflow router" {
		t.Errorf("select labels = %q", SelectLabels())
	}
	if text, level := SetNotice("max", "xhigh"); level != "warning" || text != "Requested effort max; active effort is xhigh (current model may limit thinking)." {
		t.Errorf("set notice = %q %s", text, level)
	}
	if text, _ := UltracodeNotice("xhigh", false); text != "Ultracode effort enabled (xhigh); dynamic_workflow router requested but not available in this session." {
		t.Errorf("ultracode notice = %q", text)
	}
}
