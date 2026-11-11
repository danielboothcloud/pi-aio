package sessionnaming

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type golden struct {
	Titles []struct{ Text, Title string }
	Flows  []struct {
		Name, Reason string
		Named        bool
		Header       map[string]any
		StartEntries []map[string]any `json:"startEntries"`
		Branch       []map[string]any
		Prompt       *string
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
	for _, c := range g.Titles {
		if got := CleanTitle(c.Text); got != c.Title {
			t.Errorf("CleanTitle(%q) = %q, TypeScript %q", c.Text, got, c.Title)
		}
	}
	for _, c := range g.Flows {
		var messages []map[string]any
		for _, entry := range c.Branch {
			if m, ok := entry["message"].(map[string]any); ok && entry["type"] == "message" {
				messages = append(messages, m)
			}
		}
		prompt, ok := "", false
		if Eligible(c.Reason, c.Named, c.Header, c.StartEntries) {
			prompt, ok = Prompt(messages)
		}
		if ok != (c.Prompt != nil) || (ok && prompt != *c.Prompt) {
			t.Errorf("%s: %v %q, TypeScript %v", c.Name, ok, prompt, c.Prompt)
		}
	}
}
