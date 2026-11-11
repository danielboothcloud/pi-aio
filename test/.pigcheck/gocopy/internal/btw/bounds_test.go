package btw

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func userEntry(text string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": text}})
	return raw
}

func TestDigestKeepsAtMost40Messages(t *testing.T) {
	var branch []json.RawMessage
	for i := 0; i < 55; i++ {
		branch = append(branch, userEntry(fmt.Sprintf("m%d", i)))
	}
	digest := BuildFlowDigest(branch, FlowDigestOptions{})
	if got := strings.Count(digest, "USER: "); got != MaxMessagesInDigest {
		t.Fatalf("kept %d messages, want %d", got, MaxMessagesInDigest)
	}
	if !strings.HasPrefix(digest, "…[15 messages trimmed]") || !strings.HasSuffix(digest, "USER: m54") {
		t.Fatalf("digest head/tail wrong: %q … %q", digest[:30], digest[len(digest)-12:])
	}
}

func TestDigestStaysWithin12kChars(t *testing.T) {
	var branch []json.RawMessage
	for i := 0; i < 30; i++ {
		branch = append(branch, userEntry(strings.Repeat("x", 700)))
	}
	digest := BuildFlowDigest(branch, FlowDigestOptions{})
	body := digest[strings.Index(digest, "\n")+1:]
	if Len16(body) > MaxFlowDigestChars {
		t.Fatalf("digest body is %d chars", Len16(body))
	}
	// 706 chars per message: 16 fit in 12,000 and 14 are trimmed.
	if !strings.HasPrefix(digest, "…[14 messages trimmed]") {
		t.Fatalf("unexpected head %q", digest[:30])
	}
}

func TestPromptNeverExceeds28kBytes(t *testing.T) {
	for _, digest := range []string{strings.Repeat("a", 40_000), strings.Repeat("é", 40_000), strings.Repeat("🎉", 20_000)} {
		prompt := BuildPrompt(PromptInput{Question: "q", FlowDigest: digest})
		if len(prompt) > MaxPromptBytes {
			t.Fatalf("prompt is %d bytes", len(prompt))
		}
		if !strings.HasSuffix(prompt, "…[truncated to fit the budget]") {
			t.Fatal("missing truncation marker")
		}
	}
	short := BuildPrompt(PromptInput{Question: strings.Repeat("q", 2000)})
	if !strings.Contains(short, strings.Repeat("q", MaxQuestionChars)+"…[cut]") {
		t.Fatal("question not clipped to 800 chars")
	}
}

func TestSnapshotWalkStopsAt2500Files(t *testing.T) {
	root := t.TempDir()
	for d := 0; d < 6; d++ {
		dir := filepath.Join(root, fmt.Sprintf("d%d", d))
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for f := 0; f < 500; f++ {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d", f)), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	out := BuildProjectSnapshot(root, SnapshotOptions{})
	if !strings.HasSuffix(out, fmt.Sprintf("FILES WALKED: %d (partial — walk cap or read error hit)", SnapshotMaxFiles)) {
		t.Fatalf("unexpected tail: %q", out[len(out)-80:])
	}
	if !strings.Contains(out, fmt.Sprintf("…+%d more files (%d walked)", SnapshotMaxFiles-SnapshotTopFiles, SnapshotMaxFiles)) {
		t.Fatal("missing top-files overflow line")
	}
}

func TestNewerQuestionWins(t *testing.T) {
	r := NewRunner(plainLayout{}, -1)
	h := &recordingHost{l: plainLayout{}, hasUI: true, mode: "tui"}
	first := r.Command(h, "first", "p/m", false)
	second := r.Command(h, "second", "p/m", false)
	if r.Current(first) || !r.Current(second) {
		t.Fatal("the newer question must replace the older one")
	}
	h.log = nil
	r.Ask(h, first, AskInput{Branch: func() []json.RawMessage { return nil }, Cwd: t.TempDir(),
		Complete: func(string, string) (map[string]any, error) {
			t.Fatal("replaced run must not call the model")
			return nil, nil
		}})
	if len(h.log) != 0 {
		t.Fatalf("a replaced run showed %v", h.log)
	}
}
