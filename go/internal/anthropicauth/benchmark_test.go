package anthropicauth

import (
	"strings"
	"testing"
)

func BenchmarkShapePayload(b *testing.B) {
	prompt := PiDefaultPromptPrefix + "\n\n<tools>\n- read: Read files\n\n" + PiToolsFillerAnchor + ".\n</tools>\n\n<project_context>\n" + strings.Repeat("Project instructions 😀.\n", 4096) + "\n</project_context>"
	payload := map[string]any{"model": "test", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "Summarize this repository."}}, "system": []any{map[string]any{"type": "text", "text": prompt, "cache_control": map[string]any{"type": "ephemeral"}}}}
	b.ReportAllocs()
	b.SetBytes(int64(len(prompt)))
	b.ResetTimer()
	for range b.N {
		ShapePayload(payload, ClaudeCodeVersion, nil)
	}
}
