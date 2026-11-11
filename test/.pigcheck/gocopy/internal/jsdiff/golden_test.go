package jsdiff

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type golden struct {
	LineCases []struct {
		A, B string
		Out  []*Change
	} `json:"lineCases"`
	PatchCases []struct {
		A, B       string
		Context    int
		Structured Patch
		Created    string
	} `json:"patchCases"`
	WordCases []struct {
		A, B string
		Out  []*Change
	} `json:"wordCases"`
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

func TestDiffLinesMatchesJsdiff(t *testing.T) {
	for _, c := range loadGolden(t).LineCases {
		if got := DiffLines(c.A, c.B); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("DiffLines(%q, %q):\n go %+v\n ts %+v", c.A, c.B, deref(got), deref(c.Out))
		}
	}
}

func TestPatchesMatchJsdiff(t *testing.T) {
	h1, before, after := "h1", "before", "after"
	for _, c := range loadGolden(t).PatchCases {
		got := StructuredPatch("old", "new", c.A, c.B, &h1, nil, c.Context)
		if !reflect.DeepEqual(got, c.Structured) {
			t.Errorf("StructuredPatch(%q, %q, %d):\n go %+v\n ts %+v", c.A, c.B, c.Context, got, c.Structured)
		}
		if created := CreatePatch("file.ts", c.A, c.B, &before, &after, c.Context); created != c.Created {
			t.Errorf("CreatePatch(%q, %q, %d):\n go %q\n ts %q", c.A, c.B, c.Context, created, c.Created)
		}
	}
}

func TestDiffWordsMatchesJsdiff(t *testing.T) {
	for _, c := range loadGolden(t).WordCases {
		if got := DiffWords(c.A, c.B); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("DiffWords(%q, %q):\n go %+v\n ts %+v", c.A, c.B, deref(got), deref(c.Out))
		}
	}
}

func deref(cs []*Change) []Change {
	out := make([]Change, len(cs))
	for i, c := range cs {
		out[i] = *c
	}
	return out
}
