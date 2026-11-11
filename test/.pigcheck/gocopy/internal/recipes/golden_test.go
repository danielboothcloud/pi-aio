package recipes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/danielboothcloud/pi-aio/go/internal/blocklist"
)

type goldenEntry struct {
	Pattern string `json:"pattern"`
	Regex   bool   `json:"regex"`
	Reason  string `json:"reason"`
	Command bool   `json:"command"`
}

type goldenDef struct {
	Name    string `json:"name"`
	Source  string `json:"source"`
	BaseDir string `json:"baseDir"`
	Config  struct {
		Config
		Blocklist []goldenEntry `json:"blocklist"`
	} `json:"config"`
}

type golden struct {
	Fixtures map[string]string `json:"fixtures"`
	Loads    []struct {
		Dir              string `json:"dir"`
		ProjectTrusted   bool   `json:"projectTrusted"`
		DirectoryTrusted bool   `json:"directoryTrusted"`
		Result           struct {
			Recipes       map[string]goldenDef `json:"recipes"`
			DefaultRecipe string               `json:"defaultRecipe"`
			DefaultSource string               `json:"defaultSource"`
			DirectoryFile string               `json:"directoryFile"`
		} `json:"result"`
	} `json:"loads"`
	Specs []struct {
		Spec   string `json:"spec"`
		Result struct {
			Model    string `json:"model"`
			Thinking string `json:"thinking"`
		} `json:"result"`
	} `json:"specs"`
	Branches []struct {
		Entries []map[string]any `json:"entries"`
		Result  struct {
			Name    string `json:"name"`
			Present bool   `json:"present"`
		} `json:"result"`
	} `json:"branches"`
	TrustStates []struct {
		Path  string `json:"path"`
		State string `json:"state"`
		Hash  string `json:"hash"`
	} `json:"trustStates"`
	Descriptions []struct {
		Path  string   `json:"path"`
		Lines []string `json:"lines"`
	} `json:"descriptions"`
	TrustStore string `json:"trustStore"`
}

// setup writes the fixtures, points the env at them, and returns the root.
func setup(t *testing.T) (string, golden) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(data), "@@ROOT@@", root)), &g); err != nil {
		t.Fatal(err)
	}
	for path, text := range g.Fixtures {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(FileEnv, filepath.Join(root, "agent", FileName))
	t.Setenv(TrustFileEnv, filepath.Join(root, "agent", TrustFileName))
	return root, g
}

func toGolden(entries []blocklist.Entry) []goldenEntry {
	var out []goldenEntry
	for _, e := range entries {
		out = append(out, goldenEntry{e.Pattern, e.Regex, e.Reason, e.Command})
	}
	return out
}

func TestLoadMatchesTypeScript(t *testing.T) {
	root, g := setup(t)
	paths := Paths{AgentDir: filepath.Join(root, "agent"), ConfigDirName: ".pi"} // the TS reference runs under Pi: CONFIG_DIR_NAME is ".pi"
	for _, c := range g.Loads {
		got := Load(paths, filepath.Join(root, c.Dir), c.ProjectTrusted, c.DirectoryTrusted)
		name := c.Dir + map[bool]string{true: " project", false: ""}[c.ProjectTrusted] + map[bool]string{true: " directory", false: ""}[c.DirectoryTrusted]
		if got.DefaultRecipe != c.Result.DefaultRecipe || got.DefaultSource != c.Result.DefaultSource || got.DirectoryFile != c.Result.DirectoryFile {
			t.Errorf("%s: default %q/%q file %q, TypeScript %q/%q %q", name, got.DefaultRecipe, got.DefaultSource, got.DirectoryFile,
				c.Result.DefaultRecipe, c.Result.DefaultSource, c.Result.DirectoryFile)
		}
		if len(got.Recipes) != len(c.Result.Recipes) {
			t.Errorf("%s: recipes %v, TypeScript %d", name, got.Names(), len(c.Result.Recipes))
			continue
		}
		for recipeName, want := range c.Result.Recipes {
			def := got.Recipes[recipeName]
			if def == nil {
				t.Errorf("%s: missing %q", name, recipeName)
				continue
			}
			wantConfig := want.Config.Config
			gotConfig := def.Config
			gotBlock := toGolden(gotConfig.Blocklist)
			gotConfig.Blocklist, wantConfig.Blocklist = nil, nil
			if def.Name != want.Name || def.Source != want.Source || def.BaseDir != want.BaseDir ||
				!reflect.DeepEqual(gotConfig, wantConfig) || !reflect.DeepEqual(gotBlock, want.Config.Blocklist) {
				t.Errorf("%s %q:\n go %+v %+v\n ts %+v %+v", name, recipeName, *def, gotBlock, want, want.Config.Blocklist)
			}
		}
	}
}

func TestHelpersMatchTypeScript(t *testing.T) {
	_, g := setup(t)
	for _, c := range g.Specs {
		model, thinking := ParseModelSpec(c.Spec)
		if model != c.Result.Model || thinking != c.Result.Thinking {
			t.Errorf("%q: %q %q, TypeScript %q %q", c.Spec, model, thinking, c.Result.Model, c.Result.Thinking)
		}
	}
	for _, c := range g.Branches {
		name, present := LatestPersisted(c.Entries)
		if name != c.Result.Name || present != c.Result.Present {
			t.Errorf("%v: %q %v, TypeScript %q %v", c.Entries, name, present, c.Result.Name, c.Result.Present)
		}
	}
}

func TestTrustStoreSharedWithTypeScript(t *testing.T) {
	root, g := setup(t)
	store := filepath.Join(root, "agent", TrustFileName)
	// Go reads the store that TypeScript wrote.
	if err := os.WriteFile(store, []byte(g.TrustStore), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.TrustStates {
		file := filepath.Join(root, c.Path)
		if got := FileTrust(file, store); got != c.State {
			t.Errorf("%s: %s, TypeScript %s", c.Path, got, c.State)
		}
		if got := HashFile(file); got != c.Hash {
			t.Errorf("%s hash: %s, TypeScript %s", c.Path, got, c.Hash)
		}
	}
	for _, c := range g.Descriptions {
		if got := DescribeFile(filepath.Join(root, c.Path)); !reflect.DeepEqual(got, c.Lines) {
			t.Errorf("%s:\n go %q\n ts %q", c.Path, got, c.Lines)
		}
	}
	// Go writes the same shape: record, then forget, an edit makes it unknown again.
	file := filepath.Join(root, "baddefault", ".pi-recipe")
	if err := RecordTrust(file, store, true); err != nil || FileTrust(file, store) != Trusted {
		t.Fatalf("record: %v %s", err, FileTrust(file, store))
	}
	var written map[string]any
	data, _ := os.ReadFile(store)
	if json.Unmarshal(data, &written) != nil || written["version"] != float64(1) {
		t.Fatalf("store = %s", data)
	}
	entry := written["files"].(map[string]any)[file].(map[string]any)
	if _, ok := entry["decidedAt"].(string); !ok || entry["trusted"] != true {
		t.Fatalf("entry = %v", entry)
	}
	if err := os.WriteFile(file, []byte(`{"recipes":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if FileTrust(file, store) != Unknown {
		t.Fatal("an edited file must be unknown")
	}
	if forgot, err := ForgetTrust(file, store); err != nil || !forgot || FileTrust(file, store) != Unknown {
		t.Fatalf("forget: %v %v", forgot, err)
	}
	if forgot, _ := ForgetTrust(file, store); forgot {
		t.Fatal("second forget must report nothing")
	}
}
