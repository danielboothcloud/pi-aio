// Package btw is the Go port of btw/ (the /btw "by the way" side channel):
// the bounded context digest and workspace snapshot, the prompt, the
// one-shot side-question engine, and the plain-text display rows. It does
// not import the SDK; go/aio/btw.go wires it to PiG.
package btw

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Budgets (all enforced here, not at call sites).
const (
	// MaxQuestionChars caps the question text that reaches the prompt.
	MaxQuestionChars = 800
	// MaxFlowDigestChars is the character budget for the recent-flow digest.
	MaxFlowDigestChars = 12_000
	// MaxMessagesInDigest is the count of newest messages kept in the digest.
	MaxMessagesInDigest = 40
	// MaxPromptBytes is the hard cap for the side-question prompt (UTF-8 bytes).
	MaxPromptBytes = 28_000

	SnapshotMaxFiles    = 2500
	SnapshotMaxDirs     = 200
	SnapshotMaxDepth    = 8
	SnapshotRootEntries = 40
	SnapshotTopFiles    = 30

	SnapshotUnavailable = "(workspace snapshot unavailable)"
	FlowEmpty           = "(fresh session — no earlier messages yet)"
)

// SnapshotExcludeDirs are the directories the snapshot walk never enters.
var SnapshotExcludeDirs = map[string]bool{
	"node_modules": true, ".git": true, "dist": true, "build": true, "out": true, "vendor": true,
	"coverage": true, ".next": true, ".turbo": true, ".cache": true, "__pycache__": true, ".venv": true,
}

// SystemPrompt is the side-channel persona.
var SystemPrompt = strings.Join([]string{
	`You are "By The Way", a side channel of the pi coding agent. The user taps you with quick aside questions while the main agent keeps working. You have no tools and exactly one shot to answer.`,
	"",
	"You receive: a bounded workspace snapshot, a digest of the recent session flow, and the user's question. Answer directly and concisely:",
	"",
	"- Get to the point: no preamble, no restating the question, no offers of further help.",
	"- At most ~150 words, plain text; include short code, paths, or values only when they are the answer.",
	"- Ground the answer in the provided context; quote paths, sizes, names, and outputs from it when useful.",
	"- If the context does not answer it, say in one short line what is missing. Never invent paths, APIs, or results.",
	"- Never suggest running commands; the user is watching a live session and you cannot run anything.",
}, "\n")

// ============================================================
// Recent-flow digest
// ============================================================

// PerMessageChars are the per-kind caps for rendered message text.
type PerMessageChars struct {
	User, Assistant, ToolResult, ToolCall int
}

// DefaultPerMessageChars are the caps buildFlowDigest uses by default.
var DefaultPerMessageChars = PerMessageChars{User: 800, Assistant: 900, ToolResult: 400, ToolCall: 160}

// FlowDigestOptions bounds the digest. Zero values take the defaults.
type FlowDigestOptions struct {
	MaxChars    int
	MaxMessages int
	Caps        *PerMessageChars
}

type rawBlock struct {
	Type      any             `json:"type"`
	Text      any             `json:"text"`
	Name      json.RawMessage `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type messageView struct {
	Role     any             `json:"role"`
	Content  json.RawMessage `json:"content"`
	ToolName json.RawMessage `json:"toolName"`
	IsError  any             `json:"isError"`
}

// entryMessage is the message of a `type: "message"` entry, or nil.
func entryMessage(entry json.RawMessage) *messageView {
	var record struct {
		Type    any             `json:"type"`
		Message json.RawMessage `json:"message"`
	}
	if json.Unmarshal(entry, &record) != nil || record.Type != "message" {
		return nil
	}
	if len(record.Message) == 0 || record.Message[0] != '{' {
		return nil
	}
	var message messageView
	if json.Unmarshal(record.Message, &message) != nil {
		return nil
	}
	return &message
}

func contentBlocks(content json.RawMessage) ([]json.RawMessage, bool) {
	if len(content) == 0 || content[0] != '[' {
		return nil, false
	}
	var blocks []json.RawMessage
	if json.Unmarshal(content, &blocks) != nil {
		return nil, false
	}
	return blocks, true
}

// blockTexts are the text blocks of a content array, or the raw string.
func blockTexts(content json.RawMessage) []string {
	var text string
	if len(content) > 0 && content[0] == '"' && json.Unmarshal(content, &text) == nil {
		return []string{text}
	}
	blocks, ok := contentBlocks(content)
	if !ok {
		return nil
	}
	var texts []string
	for _, raw := range blocks {
		if len(raw) == 0 || raw[0] != '{' {
			continue
		}
		var block rawBlock
		if json.Unmarshal(raw, &block) != nil {
			continue
		}
		if s, ok := block.Text.(string); ok && block.Type == "text" {
			texts = append(texts, s)
		}
	}
	return texts
}

type toolCall struct{ name, args string }

// jsString is String(value) for a raw JSON value (null/absent → fallback).
func jsString(raw json.RawMessage, fallback string) string {
	if len(raw) == 0 || string(raw) == "null" {
		return fallback
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return fallback
	}
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return jsstr.NumberJS(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			b, _ := json.Marshal(item)
			parts[i] = jsString(b, "")
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

func blockToolCalls(content json.RawMessage) []toolCall {
	blocks, ok := contentBlocks(content)
	if !ok {
		return nil
	}
	var calls []toolCall
	for _, raw := range blocks {
		if len(raw) == 0 || raw[0] != '{' {
			continue
		}
		var block rawBlock
		if json.Unmarshal(raw, &block) != nil || block.Type != "toolCall" {
			continue
		}
		args := "{}"
		if len(block.Arguments) > 0 && string(block.Arguments) != "null" {
			args = Stringify(block.Arguments)
		}
		calls = append(calls, toolCall{name: jsString(block.Name, "tool"), args: args})
	}
	return calls
}

// Clip cuts text to max UTF-16 code units and marks the cut.
func Clip(text string, max int) string {
	if Len16(text) <= max {
		return text
	}
	return Slice16(text, max) + "…[cut]"
}

func renderMessage(entry json.RawMessage, caps PerMessageChars) []string {
	message := entryMessage(entry)
	if message == nil {
		return nil
	}
	switch message.Role {
	case "user":
		text := Trim(strings.Join(blockTexts(message.Content), "\n"))
		if text == "" {
			return nil
		}
		return []string{"USER: " + Clip(text, caps.User)}
	case "assistant":
		text := Trim(strings.Join(blockTexts(message.Content), "\n"))
		var lines []string
		if text != "" {
			lines = append(lines, "ASSISTANT: "+Clip(text, caps.Assistant))
		}
		for _, call := range blockToolCalls(message.Content) {
			lines = append(lines, fmt.Sprintf("  → %s(%s)", call.name, Clip(call.args, caps.ToolCall)))
		}
		return lines
	case "toolResult":
		text := Trim(strings.Join(blockTexts(message.Content), "\n"))
		if text == "" {
			return nil
		}
		name := jsString(message.ToolName, "tool")
		prefix := "TOOL " + name + ": "
		if Truthy(message.IsError) {
			prefix = "TOOL " + name + " (failed): "
		}
		return []string{prefix + Clip(text, caps.ToolResult)}
	}
	return nil
}

func countMessages(branch []json.RawMessage, upto int) int {
	count := 0
	for i := 0; i <= upto; i++ {
		if entryMessage(branch[i]) != nil {
			count++
		}
	}
	return count
}

// BuildFlowDigest is the newest window of the session flow: user and
// assistant text, tool-call one-liners, and tool-result tails, oldest first,
// within a character budget. Once a message overflows, it and every older
// message are trimmed behind one `…[N messages trimmed]` marker.
func BuildFlowDigest(branch []json.RawMessage, options FlowDigestOptions) string {
	maxChars, maxMessages, caps := MaxFlowDigestChars, MaxMessagesInDigest, DefaultPerMessageChars
	if options.MaxChars > 0 {
		maxChars = options.MaxChars
	}
	if options.MaxMessages > 0 {
		maxMessages = options.MaxMessages
	}
	if options.Caps != nil {
		caps = *options.Caps
	}
	var parts []string // newest first
	used, kept, trimmed := 0, 0, 0
	for i := len(branch) - 1; i >= 0; i-- {
		lines := renderMessage(branch[i], caps)
		if len(lines) == 0 {
			continue
		}
		rendered := strings.Join(lines, "\n")
		size := Len16(rendered)
		if kept >= maxMessages || size > maxChars-used {
			trimmed += countMessages(branch, i)
			break
		}
		parts = append(parts, rendered)
		used += size
		kept++
	}
	if len(parts) == 0 {
		return ""
	}
	var rows []string
	if trimmed > 0 {
		noun := "messages"
		if trimmed == 1 {
			noun = "message"
		}
		rows = append(rows, fmt.Sprintf("…[%d %s trimmed]", trimmed, noun))
	}
	for i := len(parts) - 1; i >= 0; i-- {
		rows = append(rows, parts[i])
	}
	return strings.Join(rows, "\n")
}

// BranchFromEntries walks parentId links from leafID to the root and returns
// the branch root first, as SessionManager.getBranch does. The raw entries
// keep their JSON key order. An unknown leaf gives an empty branch.
func BranchFromEntries(entries []json.RawMessage, leafID string) []json.RawMessage {
	type link struct {
		raw    json.RawMessage
		parent string
	}
	byID := map[string]link{}
	for _, raw := range entries {
		var head struct {
			ID       string  `json:"id"`
			ParentID *string `json:"parentId"`
		}
		if json.Unmarshal(raw, &head) != nil || head.ID == "" {
			continue
		}
		parent := ""
		if head.ParentID != nil {
			parent = *head.ParentID
		}
		byID[head.ID] = link{raw, parent}
	}
	var reversed []json.RawMessage
	seen := map[string]bool{}
	for id := leafID; id != "" && !seen[id]; {
		seen[id] = true
		entry, ok := byID[id]
		if !ok {
			break
		}
		reversed = append(reversed, entry.raw)
		id = entry.parent
	}
	branch := make([]json.RawMessage, len(reversed))
	for i, raw := range reversed {
		branch[len(reversed)-1-i] = raw
	}
	return branch
}

// ============================================================
// Workspace snapshot
// ============================================================

// SnapshotOptions bounds the walk. Zero values take the defaults.
type SnapshotOptions struct {
	MaxFiles, MaxDirs, MaxDepth, RootEntries, TopFiles int
}

func orDefault(v, fallback int) int {
	if v > 0 {
		return v
	}
	return fallback
}

func describeRoot(entries []os.DirEntry, maxEntries int) string {
	var names []string
	for i, entry := range entries {
		if i >= maxEntries {
			break
		}
		if entry.IsDir() {
			names = append(names, entry.Name()+"/")
		} else {
			names = append(names, entry.Name())
		}
	}
	joined := "(empty)"
	if len(names) > 0 {
		joined = strings.Join(names, ", ")
	}
	if extras := len(entries) - len(names); extras > 0 {
		return fmt.Sprintf("%s, …(+%d more)", joined, extras)
	}
	return joined
}

// BuildProjectSnapshot is a bounded workspace view: the root listing plus the
// largest files by bytes. Entries are walked in name order (os.ReadDir). It
// never fails: an unreadable root gives SnapshotUnavailable, and other read
// errors mark the walk as partial.
func BuildProjectSnapshot(cwd string, options SnapshotOptions) string {
	maxFiles := orDefault(options.MaxFiles, SnapshotMaxFiles)
	maxDirs := orDefault(options.MaxDirs, SnapshotMaxDirs)
	maxDepth := orDefault(options.MaxDepth, SnapshotMaxDepth)
	maxRootEntries := orDefault(options.RootEntries, SnapshotRootEntries)
	topFiles := orDefault(options.TopFiles, SnapshotTopFiles)

	rootEntries, err := os.ReadDir(cwd)
	if err != nil {
		return SnapshotUnavailable
	}
	lines := []string{"WORKSPACE: " + cwd, "ROOT:"}
	var listed []os.DirEntry
	for _, entry := range rootEntries {
		if (entry.IsDir() && !SnapshotExcludeDirs[entry.Name()]) || entry.Type().IsRegular() {
			listed = append(listed, entry)
		}
	}
	lines = append(lines, "  "+describeRoot(listed, maxRootEntries))

	type file struct {
		rel  string
		size int64
	}
	var files []file
	partial := false
	dirsWalked := 0
	type item struct {
		dir   string
		depth int
	}
	queue := []item{{cwd, 0}}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		dirsWalked++
		entries, err := os.ReadDir(current.dir)
		if err != nil {
			partial = true
			continue
		}
		for _, entry := range entries {
			if len(files) >= maxFiles {
				break
			}
			if entry.IsDir() {
				if SnapshotExcludeDirs[entry.Name()] {
					continue
				}
				if current.depth+1 > maxDepth || dirsWalked+len(queue) > maxDirs {
					partial = true
					continue
				}
				queue = append(queue, item{filepath.Join(current.dir, entry.Name()), current.depth + 1})
				continue
			}
			if !entry.Type().IsRegular() {
				continue // symlinks and the like stay out
			}
			full := filepath.Join(current.dir, entry.Name())
			info, err := os.Stat(full)
			if err != nil {
				partial = true
				continue
			}
			rel, err := filepath.Rel(cwd, full)
			if err != nil || rel == "" {
				rel = entry.Name()
			}
			files = append(files, file{rel, info.Size()})
		}
		if len(files) >= maxFiles {
			partial = true
			break
		}
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].size > files[j].size })
	if len(files) > 0 {
		total := len(files)
		lines = append(lines, "LARGEST FILES (bytes):")
		for i, f := range files {
			if i >= topFiles {
				break
			}
			lines = append(lines, fmt.Sprintf("  %s — %d", f.rel, f.size))
		}
		if total > topFiles {
			lines = append(lines, fmt.Sprintf("  …+%d more files (%d walked)", total-topFiles, total))
		}
	}
	walked := fmt.Sprintf("FILES WALKED: %d", len(files))
	if partial {
		walked += " (partial — walk cap or read error hit)"
	}
	lines = append(lines, walked)
	return strings.Join(lines, "\n")
}

// ============================================================
// Prompt assembly
// ============================================================

// PromptInput is the side question with its context sections.
type PromptInput struct {
	Question        string
	FlowDigest      string
	ProjectSnapshot string
	// MaxPromptBytes overrides MaxPromptBytes when positive.
	MaxPromptBytes int
}

// utf8Len16 is Buffer.byteLength(s.slice(0, n), "utf8") over UTF-16 units:
// a pair is 4 bytes, a lone surrogate 3.
func byteLength16(units []uint16) int {
	n := 0
	for i := 0; i < len(units); i++ {
		u := units[i]
		switch {
		case u < 0x80:
			n++
		case u < 0x800:
			n += 2
		case u >= 0xD800 && u <= 0xDBFF && i+1 < len(units) && units[i+1] >= 0xDC00 && units[i+1] <= 0xDFFF:
			n += 4
			i++
		default:
			n += 3
		}
	}
	return n
}

// BuildPrompt packages the question with its context sections. Empty
// sections fall back to explicit notes, and the result fits the byte cap.
func BuildPrompt(input PromptInput) string {
	limit := MaxPromptBytes
	if input.MaxPromptBytes > 0 {
		limit = input.MaxPromptBytes
	}
	question := Clip(Trim(input.Question), MaxQuestionChars)
	digest := Trim(input.FlowDigest)
	snapshot := Trim(input.ProjectSnapshot)
	if snapshot == "" {
		snapshot = SnapshotUnavailable
	}
	if digest == "" {
		digest = FlowEmpty
	}
	prompt := strings.Join([]string{
		"CONTEXT — WORKSPACE SNAPSHOT",
		snapshot,
		"",
		"CONTEXT — RECENT SESSION FLOW (oldest first)",
		digest,
		"",
		"QUESTION",
		question,
	}, "\n")
	if len(prompt) <= limit {
		return prompt
	}
	units := utf16Units(prompt)
	cut := len(units)
	for cut > 0 && byteLength16(units[:cut]) > limit-64 {
		cut -= 1024
		if cut < 0 {
			cut = 0
		}
	}
	return Slice16(prompt, cut) + "\n…[truncated to fit the budget]"
}
