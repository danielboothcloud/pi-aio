package subagents

// Port of subagents/saved-transcript.ts: a bounded tail of a saved child
// session's selected branch, read lazily for historical inspection.

import (
	"bytes"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

// MaxSavedTranscriptBytes bounds the file read.
const MaxSavedTranscriptBytes = 1_000_000

// LoadSavedTranscript is loadSavedTranscript; nil when nothing is usable.
// now is the clock for the final notice.
func LoadSavedTranscript(sessionFile string, now float64) *Transcript {
	info, err := os.Stat(sessionFile)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	f, err := os.Open(sessionFile)
	if err != nil {
		return nil
	}
	defer f.Close()
	size := info.Size()
	start := max(0, size-MaxSavedTranscriptBytes)
	buffer := make([]byte, min(size, MaxSavedTranscriptBytes))
	read, err := f.ReadAt(buffer, start)
	if err != nil && err != io.EOF {
		return nil
	}
	text := decodeUTF8(buffer[:read])
	lines := strings.Split(text, "\n")
	if start > 0 {
		lines = lines[1:] // the first line may start inside UTF-8 or JSON
	}
	var entries []*Object
	for _, line := range lines {
		value, err := Decode([]byte(line))
		if err != nil {
			continue
		}
		if entry, ok := value.(*Object); ok {
			entries = append(entries, entry)
		}
	}
	branch := entries
	if len(entries) > 0 {
		leaf := entries[len(entries)-1]
		if _, ok := leaf.Get("id").(string); ok {
			byID := map[string]*Object{}
			for _, entry := range entries {
				if id, ok := entry.Get("id").(string); ok {
					byID[id] = entry
				}
			}
			branch = nil
			visited := map[string]bool{}
			current := leaf
			for current != nil {
				id, ok := current.Get("id").(string)
				if !ok || visited[id] {
					break
				}
				visited[id] = true
				branch = append(branch, current)
				parent, _ := current.Get("parentId").(string)
				if current.Get("parentId") == nil {
					parent = "undefined"
					if current.Has("parentId") {
						parent = "null"
					}
				}
				current = byID[parent]
			}
			for i, j := 0, len(branch)-1; i < j; i, j = i+1, j-1 {
				branch[i], branch[j] = branch[j], branch[i]
			}
		}
	}
	t := NewTranscript()
	for _, entry := range branch {
		message, ok := entry.Get("message").(*Object)
		if !ok {
			continue
		}
		at := 0.0
		if ts := parseTimestamp(entry.Get("timestamp")); ts != nil {
			at = *ts
		}
		if message.Get("role") == "toolResult" {
			id := stringOr(message.Get("toolCallId"))
			if _, open := t.tools[id]; !open {
				t.ApplyEvent(NewObject("type", "tool_execution_start", "toolCallId", message.Get("toolCallId"),
					"toolName", message.Get("toolName")), at)
			}
			t.ApplyEvent(NewObject("type", "tool_execution_end", "toolCallId", message.Get("toolCallId"),
				"result", message, "isError", message.Get("isError")), at)
			continue
		}
		if message.Get("role") == "assistant" {
			t.ApplyEvent(NewObject("type", "turn_start"), at)
		}
		t.ApplyEvent(NewObject("type", "message_end", "message", message), at)
		content, ok := message.Get("content").([]any)
		if message.Get("role") != "assistant" || !ok {
			continue
		}
		for _, raw := range content {
			block, ok := raw.(*Object)
			if !ok || block.Get("type") != "toolCall" {
				continue
			}
			start := NewObject("type", "tool_execution_start", "toolCallId", block.Get("id"), "toolName", block.Get("name"))
			if block.Has("arguments") {
				start.Set("args", block.Get("arguments"))
			}
			t.ApplyEvent(start, at)
		}
	}
	if len(t.Entries) == 0 {
		return nil
	}
	suffix := ""
	if start > 0 {
		suffix = " · bounded tail"
	}
	t.PushNotice("Restored from saved child session"+suffix, "muted", now)
	return t
}

// decodeUTF8 is Buffer.toString("utf8"): invalid sequences become U+FFFD.
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	return string(bytes.ToValidUTF8(b, []byte("\uFFFD")))
}
