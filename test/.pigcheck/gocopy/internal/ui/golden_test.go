package ui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMatchesTypeScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		InterceptedActions []string `json:"interceptedActions"`
		Spans              []struct {
			Line string
			Out  *struct{ Above, Below int }
		}
		Screens []struct {
			Lines  []string
			Height int
			Out    []string
		}
	}
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g.InterceptedActions, InterceptedActions) {
		t.Errorf("actions %q want %q", InterceptedActions, g.InterceptedActions)
	}
	if len(g.Spans) == 0 || len(g.Screens) == 0 {
		t.Fatal("empty golden")
	}
	for _, c := range g.Spans {
		above, below, ok := ImageRowSpan(c.Line)
		if ok != (c.Out != nil) || (ok && (above != c.Out.Above || below != c.Out.Below)) {
			t.Errorf("span %q: %d %d %v want %+v", c.Line, above, below, ok, c.Out)
		}
	}
	for _, c := range g.Screens {
		if got := HideViewportImages(c.Lines, c.Height); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("screen h%d %q: %q want %q", c.Height, c.Lines, got, c.Out)
		}
	}
}

func TestInterceptsRoundTrip(t *testing.T) {
	defer SetEditorIntercepts(nil)
	if EditorIntercepts().Escape != nil {
		t.Fatal("intercepts set at start")
	}
	SetEditorIntercepts(&Intercepts{Escape: func() bool { return true }})
	if e := EditorIntercepts().Escape; e == nil || !e() {
		t.Fatal("escape not registered")
	}
	SetEditorIntercepts(nil)
	if EditorIntercepts().Escape != nil {
		t.Fatal("not cleared")
	}
}
