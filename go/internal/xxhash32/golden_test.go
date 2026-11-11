package xxhash32

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSumMatchesXxhashWasm(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []struct {
			Input string `json:"input"`
			Seed  uint32 `json:"seed"`
			Hash  uint32 `json:"hash"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range g.Cases {
		if got := Sum(c.Input, c.Seed); got != c.Hash {
			t.Errorf("Sum(%q, %d) = %d, want %d", c.Input, c.Seed, got, c.Hash)
		}
	}
}
