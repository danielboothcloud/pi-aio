package sessionnav

import (
	"math"
	"sort"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// TreeNode is TreeNodeLike (the SDK's SessionTreeNode).
type TreeNode struct {
	Entry    map[string]any `json:"entry"`
	Children []TreeNode     `json:"children"`
	Label    *string        `json:"label,omitempty"`
}

// Checkpoint is Checkpoint.
type Checkpoint struct {
	ID        string  `json:"id"`
	Text      string  `json:"text"`
	Title     string  `json:"title"`
	Timestamp float64 `json:"timestamp"`
	OnPath    bool    `json:"onPath"`
	IsCurrent bool    `json:"isCurrent"`
	EndID     string  `json:"endId"`
	EndIsLeaf bool    `json:"endIsLeaf"`
	Edits     int     `json:"edits"`
	Tools     int     `json:"tools"`
	Reply     string  `json:"reply"`
	Label     string  `json:"label,omitempty"`
}

var editTools = map[string]bool{"edit": true, "write": true, "apply_patch": true, "multi_edit": true, "multiedit": true}

func entryID(entry map[string]any) string {
	id, _ := entry["id"].(string)
	return id
}

func message(entry map[string]any) map[string]any {
	m, _ := entry["message"].(map[string]any)
	return m
}

func isUserMessage(entry map[string]any) bool {
	return entry["type"] == "message" && message(entry)["role"] == "user"
}

// ContentText is contentText: a string, or the text blocks joined.
func ContentText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, block := range c {
			m, ok := block.(map[string]any)
			if !ok || m["type"] != "text" {
				continue
			}
			if s, ok := m["text"].(string); ok {
				b.WriteString(s)
			}
		}
		return b.String()
	}
	return ""
}

func toolCalls(entry map[string]any) []string {
	msg := message(entry)
	if entry["type"] != "message" || msg["role"] != "assistant" {
		return nil
	}
	content, ok := msg["content"].([]any)
	if !ok {
		return nil
	}
	var names []string
	for _, block := range content {
		m, ok := block.(map[string]any)
		if !ok || m["type"] != "toolCall" {
			continue
		}
		name := "" // String(name ?? "")
		switch v := m["name"].(type) {
		case string:
			name = v
		case float64:
			name = jsstr.NumberJS(v)
		case bool:
			name = "false"
			if v {
				name = "true"
			}
		}
		names = append(names, name)
	}
	return names
}

func assistantText(entry map[string]any) string {
	msg := message(entry)
	if entry["type"] != "message" || msg["role"] != "assistant" {
		return ""
	}
	return jsstr.Trim(ContentText(msg["content"]))
}

// BuildCheckpoints is buildCheckpoints: every user prompt, newest first.
func BuildCheckpoints(roots []TreeNode, leafID string) []Checkpoint {
	parent := map[string]string{}
	hasParent := map[string]bool{}
	var nodes []*TreeNode
	stack := make([]*TreeNode, 0, len(roots))
	for i := range roots {
		stack = append(stack, &roots[i])
	}
	for len(stack) > 0 {
		node := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		nodes = append(nodes, node)
		for i := range node.Children {
			child := &node.Children[i]
			parent[entryID(child.Entry)] = entryID(node.Entry)
			hasParent[entryID(child.Entry)] = true
			stack = append(stack, child)
		}
	}
	onPath := map[string]bool{}
	for id := leafID; id != ""; {
		if onPath[id] {
			break
		}
		onPath[id] = true
		if !hasParent[id] {
			break
		}
		id = parent[id]
	}
	var checkpoints []Checkpoint
	for _, node := range nodes {
		if !isUserMessage(node.Entry) {
			continue
		}
		edits, tools, reply := 0, 0, ""
		end := node
		for len(end.Children) > 0 {
			next := &end.Children[len(end.Children)-1]
			for i := range end.Children {
				if onPath[entryID(end.Children[i].Entry)] {
					next = &end.Children[i]
					break
				}
			}
			if isUserMessage(next.Entry) {
				break
			}
			end = next
			for _, name := range toolCalls(end.Entry) {
				tools++
				if editTools[name] {
					edits++
				}
			}
			if text := assistantText(end.Entry); text != "" {
				reply = text
			}
		}
		text := ContentText(message(node.Entry)["content"])
		title := CleanPromptTitle(text)
		if title == "" {
			title = "(empty prompt)"
		}
		label := ""
		if node.Label != nil {
			label = *node.Label
		}
		id := entryID(node.Entry)
		checkpoints = append(checkpoints, Checkpoint{
			ID: id, Text: text, Title: title, Timestamp: ToMillis(node.Entry["timestamp"]),
			OnPath: onPath[id], EndID: entryID(end.Entry), EndIsLeaf: entryID(end.Entry) == leafID && leafID != "",
			Edits: edits, Tools: tools, Reply: reply, Label: label,
		})
	}
	zero := func(v float64) float64 {
		if math.IsNaN(v) {
			return 0
		}
		return v
	}
	sort.SliceStable(checkpoints, func(i, j int) bool {
		return zero(checkpoints[j].Timestamp)-zero(checkpoints[i].Timestamp) < 0
	})
	for i := range checkpoints {
		if checkpoints[i].OnPath {
			checkpoints[i].IsCurrent = true
			break
		}
	}
	return checkpoints
}

// RewindOption is RewindOption.
type RewindOption struct {
	Action      string `json:"action"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// RewindOptions is rewindOptions.
func RewindOptions(c Checkpoint) []RewindOption {
	options := []RewindOption{{
		Action:      "edit",
		Label:       "Edit and resend this prompt",
		Description: "Go back to just before this prompt and put it in the editor, so you can change it and send it again. Later messages are kept as an alternate branch.",
	}}
	if !c.EndIsLeaf {
		options = append(options, RewindOption{
			Action:      "after",
			Label:       "Go back to right after this answer",
			Description: "Continue the conversation from the point where pi finished answering this prompt. Later messages are kept as an alternate branch.",
		})
	}
	return append(options,
		RewindOption{
			Action:      "summary",
			Label:       "Rewind, keeping a summary of what came after",
			Description: "Same as edit and resend, but pi first writes a short summary of the later conversation, so the model keeps what was learned. This uses the model and takes a moment.",
		},
		RewindOption{
			Action:      "fork",
			Label:       "Start a new session from here",
			Description: "Open a new session with the conversation before this prompt, and put the prompt in the editor. This session is not changed.",
		},
	)
}
