package initcmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPromptMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []struct{ Cwd, Args, Prompt string }
	}
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Cases {
		if got := BuildPrompt(c.Cwd, c.Args); got != c.Prompt {
			t.Errorf("%q %q:\n go %q\n ts %q", c.Cwd, c.Args, got, c.Prompt)
		}
	}
}
