package btw

import (
	"encoding/json"
	"strings"
)

// MaxAnswerChars caps the sanitized answer.
const MaxAnswerChars = 2400

const maxErrorChars = 200

// ansiCodeLength is pi-tui's ansiCodeLength: the length in bytes of the
// CSI (to the first m/G/K/H/J), OSC, or APC (to BEL or ST) sequence at pos,
// or 0. All its delimiters are ASCII, so byte offsets match code units.
func ansiCodeLength(s string, pos int) int {
	if pos >= len(s) || s[pos] != 0x1b || pos+1 >= len(s) {
		return 0
	}
	switch s[pos+1] {
	case '[':
		for j := pos + 2; j < len(s); j++ {
			switch s[j] {
			case 'm', 'G', 'K', 'H', 'J':
				return j + 1 - pos
			}
		}
	case ']', '_':
		for j := pos + 2; j < len(s); j++ {
			if s[j] == 0x07 {
				return j + 1 - pos
			}
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
				return j + 2 - pos
			}
		}
	}
	return 0
}

// StripTerminalSequences is pi-tui's stripTerminalSequences.
func StripTerminalSequences(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if n := ansiCodeLength(s, i); n > 0 {
			i += n
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// SanitizeForTerminal strips ANSI/control sequences and caps the length
// (UTF-16 code units) before terminal display. Tabs stay; every other
// control code, carriage returns included, is dropped.
func SanitizeForTerminal(text string, max int) string {
	lines := strings.Split(StripTerminalSequences(text), "\n")
	for i, line := range lines {
		lines[i] = strings.Map(func(r rune) rune {
			if r == '\t' || (r >= 32 && r != 127) {
				return r
			}
			return -1
		}, line)
	}
	stripped := TrimEnd(strings.Join(lines, "\n"))
	if Len16(stripped) > max {
		return Slice16(stripped, max) + "…"
	}
	return stripped
}

// TextFromContent joins the text blocks of an assistant content array.
func TextFromContent(content any) string {
	blocks, ok := content.([]any)
	if !ok {
		return ""
	}
	var parts []string
	for _, item := range blocks {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := block["text"].(string); ok && block["type"] == "text" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

// Usage is the side call's token use and cost.
type Usage struct {
	InputTokens  float64 `json:"inputTokens"`
	OutputTokens float64 `json:"outputTokens"`
	CostTotal    float64 `json:"costTotal"`
}

func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	}
	return 0
}

func toUsage(v any) *Usage {
	usage, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := &Usage{InputTokens: number(usage["input"]), OutputTokens: number(usage["output"])}
	if cost, ok := usage["cost"].(map[string]any); ok {
		out.CostTotal = number(cost["total"])
	}
	return out
}

// Outcome is the result of one side question. Error is an infrastructure
// failure, never a verdict; "" means success.
type Outcome struct {
	Answer string
	Usage  *Usage
	Error  string
}

// CompleteFunc runs one completion and returns the assistant message
// (content, stopReason, errorMessage, usage). An error is a thrown call.
type CompleteFunc func(systemPrompt, prompt string) (map[string]any, error)

// RunSideQuestion runs one isolated side question. It never fails: failures
// come back as Outcome.Error. aborted reports the run's own cancellation.
func RunSideQuestion(prompt string, complete CompleteFunc, aborted func() bool) Outcome {
	response, err := complete(SystemPrompt, prompt)
	if err != nil {
		message := SanitizeForTerminal(err.Error(), maxErrorChars)
		if message == "" {
			message = "the side call failed"
		}
		return Outcome{Error: message}
	}
	if aborted != nil && aborted() {
		return Outcome{Error: "aborted"}
	}
	stop, _ := response["stopReason"].(string)
	if stop == "error" || stop == "aborted" {
		out := Outcome{Usage: toUsage(response["usage"]), Error: "aborted"}
		if stop == "error" {
			message := "the side call failed"
			if m, ok := response["errorMessage"].(string); ok {
				message = m
			}
			out.Error = SanitizeForTerminal(message, maxErrorChars)
		}
		return out
	}
	answer := SanitizeForTerminal(TextFromContent(response["content"]), MaxAnswerChars)
	if Trim(answer) == "" {
		return Outcome{Usage: toUsage(response["usage"]), Error: "the model returned an empty answer"}
	}
	return Outcome{Answer: answer, Usage: toUsage(response["usage"])}
}
