package copywidget

// Port of index.ts: the /pick command and ctrl+p shortcut flow, without the
// host calls.

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Command, shortcut, and notices of index.ts.
const (
	CommandName         = "pick"
	CommandDescription  = "Select a fenced code block or quote from the last assistant response and copy it"
	Shortcut            = "ctrl+p"
	ShortcutDescription = "Open the code block and quote picker"
	NoticeNotTUI        = "/pick is only available in interactive TUI mode"
	NoticeNoResponse    = "No assistant response is available to copy from"
	NoticeNoBlocks      = "The last assistant response has no fenced code blocks or quotes"
)

// LastAssistantText ports getLastAssistantText: the joined text blocks of
// the newest assistant message on the branch; ok=false when there is none.
func LastAssistantText(branch []json.RawMessage) (string, bool) {
	for i := len(branch) - 1; i >= 0; i-- {
		var entry struct {
			Type    string `json:"type"`
			Message *struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(branch[i], &entry) != nil || entry.Type != "message" || entry.Message == nil || entry.Message.Role != "assistant" {
			continue
		}
		var text []string
		for _, block := range entry.Message.Content {
			if block.Type == "text" {
				text = append(text, block.Text)
			}
		}
		return strings.Join(text, "\n"), true
	}
	return "", false
}

// Notice is one ctx.ui.notify call.
type Notice struct {
	Message string `json:"message"`
	Level   string `json:"level"`
}

// OpenStep ports openPicker up to the picker: the blocks to pick from, or
// the notice that ends the flow.
func OpenStep(mode string, branch []json.RawMessage) ([]Block, *Notice) {
	if mode != "tui" {
		return nil, &Notice{NoticeNotTUI, "warning"}
	}
	text, _ := LastAssistantText(branch)
	if text == "" {
		return nil, &Notice{NoticeNoResponse, "warning"}
	}
	blocks := ExtractCopyableBlocks(text)
	if len(blocks) == 0 {
		return nil, &Notice{NoticeNoBlocks, "warning"}
	}
	return blocks, nil
}

// CopyNotice ports the notice after the clipboard write (err nil is a
// successful copy).
func CopyNotice(b Block, err error) Notice {
	noun := "code block"
	if b.Kind == "quote" {
		noun = "quote"
	}
	if err != nil {
		return Notice{"Could not copy " + noun + ": " + err.Error(), "error"}
	}
	return Notice{"Copied " + noun + " #" + strconv.Itoa(b.Ordinal) + " to the clipboard", "info"}
}
