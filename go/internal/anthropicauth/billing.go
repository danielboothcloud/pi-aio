package anthropicauth

import (
	"crypto/sha256"
	"fmt"
	"unicode/utf16"
)

const BillingHeaderSalt = "59cf53e54c78"
const BillingHeaderMarker = "x-anthropic-billing-header:"
const ClaudeCodeEntrypoint = "sdk-cli"

func GetFirstUserText(messages []any) string {
	for _, value := range messages {
		message := record(value)
		if message["role"] != "user" {
			continue
		}
		if text, ok := message["content"].(string); ok {
			return text
		}
		blocks, _ := message["content"].([]any)
		for _, value := range blocks {
			block := record(value)
			if text, ok := block["text"].(string); ok && block["type"] == "text" {
				return text
			}
		}
		return ""
	}
	return ""
}

func BuildBillingHeaderValue(text, version string) string {
	if text == "" {
		return ""
	}
	units := utf16.Encode([]rune(text))
	sampled := make([]uint16, 0, 3)
	for _, index := range []int{4, 7, 20} {
		if index < len(units) {
			sampled = append(sampled, units[index])
		} else {
			sampled = append(sampled, '0')
		}
	}
	// Join UTF-16 units before UTF-8 encoding: isolated sampled surrogates become
	// U+FFFD, while a newly adjacent high/low pair is encoded as one scalar.
	suffix := sha256.Sum256([]byte(BillingHeaderSalt + string(utf16.Decode(sampled)) + version))
	cch := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%s cc_version=%s.%.3s; cc_entrypoint=%s; cch=%.5s;", BillingHeaderMarker, version, fmt.Sprintf("%x", suffix), ClaudeCodeEntrypoint, fmt.Sprintf("%x", cch))
}
