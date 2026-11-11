package blocklist

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestTiersUnionAndFileGates(t *testing.T) {
	agent, project := t.TempDir(), t.TempDir()
	write(t, filepath.Join(agent, FileName), `{"entries":["global-cmd"]}`)
	write(t, filepath.Join(project, ".pig", FileName), `{"entries":[{"pattern":"project-cmd","reason":"not here"}]}`)
	recipe := &RecipeBlocklist{Recipe: "work", Entries: []Entry{{Pattern: "recipe-cmd"}}}
	rules, _ := Load(Paths{AgentDir: agent, ConfigDirName: ".pig"}, project, recipe)
	for command, label := range map[string]string{"global-cmd": "global", "project-cmd": "project", "recipe-cmd": "recipe:work"} {
		hit, blocked := Evaluate(command, rules)
		if !blocked || SourceLabel(hit.Source, hit.Recipe) != label {
			t.Errorf("%s: blocked=%v source=%q", command, blocked, SourceLabel(hit.Source, hit.Recipe))
		}
	}
	// enabled:false gates only its own file; bad JSON and arrays never disable the gate.
	write(t, filepath.Join(agent, FileName), `{"enabled":false,"entries":["global-cmd"]}`)
	write(t, filepath.Join(project, ".pig", FileName), `not json`)
	rules, _ = Load(Paths{AgentDir: agent, ConfigDirName: ".pig"}, project, recipe)
	if len(rules) != 1 || rules[0].Source != "recipe" {
		t.Fatalf("rules = %+v", rules)
	}
	if got := ReadFile(filepath.Join(agent, "missing.json")); !got.Enabled || len(got.Entries) != 0 {
		t.Fatalf("missing file = %+v", got)
	}
}

func TestSkippedRegexIsReported(t *testing.T) {
	agent := t.TempDir()
	write(t, filepath.Join(agent, FileName), `{"entries":[{"pattern":"([","regex":true},{"pattern":"ok","regex":true}]}`)
	rules, skipped := Load(Paths{AgentDir: agent}, t.TempDir(), nil)
	if len(rules) != 1 || len(skipped) != 1 || skipped[0].Pattern != "([" || skipped[0].Source != "global" {
		t.Fatalf("rules=%d skipped=%+v", len(rules), skipped)
	}
}

func TestRecipeEnvRoundTrip(t *testing.T) {
	in := RecipeBlocklist{Recipe: "work", Entries: []Entry{
		{Pattern: "a"},
		{Pattern: `^b\b`, Regex: true, Reason: "why", Command: true},
	}}
	out, ok := DecodeRecipe(EncodeRecipe(in))
	if !ok || out.Recipe != "work" || len(out.Entries) != 2 || out.Entries[1] != in.Entries[1] {
		t.Fatalf("round trip = %+v %v", out, ok)
	}
	// The TypeScript env value decodes too (entries carry "match":"command").
	ts := `{"recipe":"r","entries":["x",{"pattern":"^y","regex":true,"match":"command"}]}`
	out, ok = DecodeRecipe(ts)
	if !ok || !out.Entries[1].Command || !out.Entries[1].Regex {
		t.Fatalf("ts value = %+v", out)
	}
	for _, bad := range []string{"", "{", `{"entries":[]}`} {
		if _, ok := DecodeRecipe(bad); ok {
			t.Errorf("%q decoded", bad)
		}
	}
}

func TestBlockReason(t *testing.T) {
	hit := Hit{Source: "recipe", Recipe: "work", Reason: "Blocked by aio blocklist: no", Segment: strings.Repeat("x ", 100)}
	reason := BlockReason(hit, "x y")
	lines := strings.Split(reason, "\n")
	if lines[0] != "Blocked by aio blocklist: no (recipe:work)" || !strings.HasSuffix(lines[1], "…") ||
		len([]rune(strings.TrimPrefix(lines[1], "  Matched command: "))) != SegmentPreviewChars || lines[2] != "  Command: x y" {
		t.Fatalf("reason = %q", reason)
	}
	if !IsShellTool("bash") || !IsShellTool("hypa_shell") || IsShellTool("read") {
		t.Fatal("IsShellTool")
	}
}
