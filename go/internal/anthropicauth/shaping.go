package anthropicauth

import (
	"encoding/json"
	"fmt"
	"maps"
	"strings"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Observer owns the once-per-extension warning latch. Emit receives a warning
// or a debug line; callers must make it safe for simultaneous requests.
type Observer struct {
	DebugMode string
	Emit      func(string)
	warned    sync.Once
}

func (o *Observer) toolOnly() bool {
	if o == nil {
		return false
	}
	switch strings.ToLower(jsstr.Trim(o.DebugMode)) {
	case "tool", "tools", "tool-use", "tool_use":
		return true
	}
	return false
}
func (o *Observer) enabled() bool {
	if o == nil {
		return false
	}
	if o.toolOnly() {
		return true
	}
	switch strings.ToLower(jsstr.Trim(o.DebugMode)) {
	case "1", "true", "yes", "on", "debug", "all":
		return true
	}
	return false
}
func (o *Observer) debug(scope string, value any) {
	if !o.enabled() || o.Emit == nil {
		return
	}
	encoded, _ := json.Marshal(value)
	o.Emit(fmt.Sprintf("[pi-anthropic-auth][debug] %s %s", scope, jsstr.Stringify(encoded)))
}
func (o *Observer) warnUnstructured() {
	if o == nil {
		return
	}
	o.warned.Do(func() {
		if o.Emit != nil {
			o.Emit("[pi-anthropic-auth] Pi's system prompt carries none of its own sections; passing it through unshaped. Upstream Pi may have restructured its prompt — re-verify PI_OWNED_SECTIONS.")
		}
	})
}
func record(v any) map[string]any { m, _ := v.(map[string]any); return m }
func normalizeSystemBlock(v any) map[string]any {
	if text, ok := v.(string); ok {
		return map[string]any{"type": "text", "text": text}
	}
	if m := record(v); m != nil {
		if text, ok := m["text"].(string); ok {
			copy := maps.Clone(m)
			copy["type"] = "text"
			copy["text"] = text
			return copy
		}
	}
	return map[string]any{"type": "text", "text": ""}
}
func normalizeSystemBlocks(v any) []any {
	if blocks, ok := v.([]any); ok {
		out := make([]any, len(blocks))
		for i, b := range blocks {
			out[i] = normalizeSystemBlock(b)
		}
		return out
	}
	if v == nil {
		return []any{}
	}
	return []any{normalizeSystemBlock(v)}
}

// ShapePayload leaves signed assistant blocks and user messages untouched.
// The version is resolved by the caller; OAuth detection belongs in the wrapper.
func ShapePayload(payload any, version string, observer *Observer) any {
	p := record(payload)
	_, modelOK := p["model"].(string)
	_, streamOK := p["stream"].(bool)
	messages, messagesOK := p["messages"].([]any)
	if !modelOK || !streamOK || !messagesOK {
		return payload
	}
	normalized := make([]any, 0, len(messages))
	before, after, assistant := 0, 0, 0
	toolUses := []string{}
	for _, value := range messages {
		message := record(value)
		if message["role"] == "assistant" {
			assistant++
		}
		content, isBlocks := message["content"].([]any)
		for _, v := range content {
			b := record(v)
			if name, ok := b["name"].(string); ok && b["type"] == "tool_use" {
				toolUses = append(toolUses, name)
			}
		}
		if message["role"] != "system" {
			normalized = append(normalized, value)
			continue
		}
		before++
		if !isBlocks {
			normalized = append(normalized, value)
			after++
			continue
		}
		blocks := []any{}
		for _, b := range content {
			block := record(b)
			text, ok := block["text"].(string)
			if block["type"] != "text" || !ok {
				blocks = append(blocks, b)
				continue
			}
			shaped, keep := ShapeSystemUpdateText(text)
			if keep {
				copy := maps.Clone(block)
				copy["text"] = shaped
				blocks = append(blocks, copy)
			}
		}
		_, effort := message["output_config"]
		if len(blocks) > 0 || effort {
			copy := maps.Clone(message)
			copy["content"] = blocks
			normalized = append(normalized, copy)
			after++
		}
	}
	system := p["system"]
	if blocks, ok := system.([]any); ok {
		shaped := make([]any, len(blocks))
		for i, b := range blocks {
			shaped[i] = b
			block := record(b)
			text, ok := block["text"].(string)
			if block["type"] == "text" && ok && strings.Contains(text, PiDefaultPromptPrefix) {
				copy := maps.Clone(block)
				copy["text"] = ShapeSystemPrompt(text, observer)
				shaped[i] = copy
			}
		}
		system = shaped
	}
	if header := BuildBillingHeaderValue(GetFirstUserText(normalized), version); header != "" {
		blocks := normalizeSystemBlocks(system)
		exists := false
		for _, b := range blocks {
			if strings.Contains(record(b)["text"].(string), BillingHeaderMarker) {
				exists = true
			}
		}
		if !exists {
			blocks = append([]any{map[string]any{"type": "text", "text": header}}, blocks...)
		}
		system = blocks
	}
	if !observer.toolOnly() || len(toolUses) > 0 {
		toolNames := []string{}
		tools, _ := p["tools"].([]any)
		for _, v := range tools {
			if name, ok := record(v)["name"].(string); ok {
				toolNames = append(toolNames, name)
			}
		}
		beforeBlocks, _ := p["system"].([]any)
		afterBlocks, _ := system.([]any)
		observer.debug("before-provider-request", map[string]any{"model": p["model"], "systemBlockCountBefore": len(beforeBlocks), "systemBlockCountAfter": len(afterBlocks), "assistantMessages": assistant, "systemMessagesBefore": before, "systemMessagesAfter": after, "toolDefinitions": toolNames, "toolUseNames": toolUses})
	}
	copy := maps.Clone(p)
	copy["messages"] = normalized
	copy["system"] = system
	// An undefined system remains omitted on JSON serialization, unlike null.
	if _, present := p["system"]; !present && system == nil {
		delete(copy, "system")
	}
	return copy
}
