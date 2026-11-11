package recipes

import "testing"

func TestSelectPrecedence(t *testing.T) {
	loaded := Loaded{Recipes: map[string]*Definition{"g": {}, "d": {}}, DefaultRecipe: "g", DefaultSource: "global"}
	dirLoaded := Loaded{Recipes: map[string]*Definition{"d": {}}, DefaultRecipe: "d", DefaultSource: "directory"}
	env := func(name, origin string) map[string]string {
		return map[string]string{ActiveEnv: name, OriginEnv: origin}
	}
	cases := []struct {
		name string
		in   Selection
		want Selected
	}{
		{"flag wins", Selection{Reason: "startup", Flag: " f ", Env: env("e", "flag"), PersistedName: "s", PersistedPresent: true, Loaded: loaded}, Selected{Name: "f", Source: "flag"}},
		{"bare flag falls through", Selection{Reason: "startup", Flag: true, Loaded: loaded}, Selected{Name: "g", Source: "default", BareFlag: true}},
		{"env beats session", Selection{Reason: "startup", Env: env("e", "flag"), PersistedName: "s", PersistedPresent: true, Loaded: loaded}, Selected{Name: "e", Source: "env"}},
		{"directory env is a default", Selection{Reason: "startup", Env: env("d", "directory"), PersistedName: "s", PersistedPresent: true, Loaded: loaded}, Selected{Name: "s", Source: "session"}},
		{"session origin never overrides", Selection{Reason: "startup", Env: env("e", "session"), Loaded: loaded}, Selected{Name: "g", Source: "default"}},
		{"session off pins off", Selection{Reason: "startup", PersistedPresent: true, Loaded: loaded}, Selected{Source: "session"}},
		{"directory env on startup", Selection{Reason: "startup", Env: env("d", "directory"), Loaded: loaded}, Selected{Name: "d", Source: "directory"}},
		{"directory default", Selection{Reason: "startup", Loaded: dirLoaded}, Selected{Name: "d", Source: "directory"}},
		{"resume ignores flag and env", Selection{Reason: "resume", Flag: "f", Env: env("e", "flag"), Loaded: loaded}, Selected{}},
		{"resume follows its branch", Selection{Reason: "resume", Flag: "f", PersistedName: "s", PersistedPresent: true, Loaded: loaded}, Selected{Name: "s", Source: "session"}},
		{"new reapplies only a directory default", Selection{Reason: "new", Loaded: dirLoaded}, Selected{Name: "d", Source: "directory"}},
		{"new ignores a global default", Selection{Reason: "new", Loaded: loaded}, Selected{}},
		{"new ignores a stale directory env", Selection{Reason: "new", Env: env("old", "directory"), Loaded: dirLoaded}, Selected{Name: "d", Source: "directory"}},
		{"reload has no default", Selection{Reason: "reload", Loaded: loaded}, Selected{}},
	}
	for _, c := range cases {
		if got := Select(c.in); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestBridgedAndLabels(t *testing.T) {
	if !Bridged(map[string]string{StageEnv: "1", ActiveEnv: " w "}, "w") || Bridged(map[string]string{ActiveEnv: "w"}, "w") {
		t.Error("Bridged")
	}
	defs := map[string]*Definition{
		"b": {Config: Config{Description: "a very long description that is longer than forty-two characters"}},
		"A": {},
	}
	names, labels := SelectionLabels(defs)
	if names[0] != "A" || labels[0] != "A" || labels[1] != "b — a very long description that is longer ..." {
		t.Errorf("labels = %q %q", names, labels)
	}
	if out, changed := FilterContext([]any{map[string]any{"customType": ContextType}, "x"}); !changed || len(out) != 1 {
		t.Error("FilterContext")
	}
}
