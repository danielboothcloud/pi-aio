package rpivconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

type golden struct {
	Name  string                       `json:"name"`
	Homes map[string]map[string]string `json:"homes"`
	Loads []struct {
		Home     string   `json:"home"`
		Xdg      string   `json:"xdg"`
		XdgValue *string  `json:"xdgValue"`
		File     string   `json:"file"`
		Path     string   `json:"path"`
		Value    any      `json:"value"`
		Warnings []string `json:"warnings"`
	} `json:"loads"`
	Guidance []struct {
		Input any             `json:"input"`
		Out   json.RawMessage `json:"out"`
	} `json:"guidance"`
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

var goErrorTail = regexp.MustCompile(` — .*$`)

func TestLoadMatchesRpivConfig(t *testing.T) {
	g := loadGolden(t)
	root := t.TempDir()
	for home, tree := range g.Homes {
		for rel, content := range tree {
			full := filepath.Join(root, home, rel)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		_ = os.MkdirAll(filepath.Join(root, home), 0o755)
	}
	for _, c := range g.Loads {
		homeDir := filepath.Join(root, c.Home)
		env := Env{Home: homeDir, Getenv: func(key string) string {
			if key == "XDG_CONFIG_HOME" && c.XdgValue != nil {
				return strings.ReplaceAll(*c.XdgValue, "@@HOME@@", homeDir)
			}
			return ""
		}}
		var warnings []string
		got := LoadJSONConfigWithLegacyFallback(env, g.Name, c.File, func(s string) {
			warnings = append(warnings, goErrorTail.ReplaceAllString(strings.ReplaceAll(s, homeDir, "@@HOME@@"), " — "))
		})
		gotJSON, _ := json.Marshal(got)
		var gotValue any
		_ = json.Unmarshal(gotJSON, &gotValue)
		if !reflect.DeepEqual(gotValue, c.Value) {
			t.Errorf("%s/%s/%q: value %v want %v", c.Home, c.Xdg, c.File, gotValue, c.Value)
		}
		if warnings == nil {
			warnings = []string{}
		}
		if !reflect.DeepEqual(warnings, c.Warnings) {
			t.Errorf("%s/%s/%q: warnings %q want %q", c.Home, c.Xdg, c.File, warnings, c.Warnings)
		}
		if path := strings.ReplaceAll(ConfigPath(env, g.Name, c.File), homeDir, "@@HOME@@"); path != c.Path {
			t.Errorf("%s/%s/%q: path %q want %q", c.Home, c.Xdg, c.File, path, c.Path)
		}
	}
}

func TestValidateGuidanceFields(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Guidance {
		input := c.Input
		if input == "@@UNDEFINED@@" {
			input = nil
		}
		got, _ := json.Marshal(ValidateGuidanceFields(input))
		var a, b any
		_ = json.Unmarshal(got, &a)
		_ = json.Unmarshal(c.Out, &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("validateGuidanceFields(%v) = %s want %s", c.Input, got, c.Out)
		}
	}
}
