package anthropicauth

import (
	"regexp"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const PiDefaultPromptPrefix = "You are an expert coding assistant operating inside pi, a coding agent harness."
const MinimalAnthropicOAuthPrompt = "You are an expert coding assistant.\nBe concise and helpful.\nUse the available tools to answer the user's request.\nShow file paths clearly when working with files."
const PiToolsFillerAnchor = "In addition to the tools above"
const PiDocsSectionAnchor = "Pi documentation (read only when the user asks about pi itself"
const replacementMatch = "Here is some useful information about the environment you are running in:"
const replacementText = "Environment context you are running in:"

type PromptChunk struct {
	Name *string `json:"name"`
	Raw  string  `json:"raw"`
	Body string  `json:"body"`
}

var sectionOpen = regexp.MustCompile(`^<([a-z][a-z0-9_-]*)>\n`)

func NamedSection(name, body string) PromptChunk {
	return PromptChunk{&name, "<" + name + ">\n" + body + "\n</" + name + ">", body}
}
func ParseSystemPromptChunks(text string) []PromptChunk {
	chunks := []PromptChunk{}
	untagged, search := 0, 0
	for search <= len(text) {
		start := findSectionStart(text, search)
		if start < 0 {
			break
		}
		chunk, end, ok := readSectionAt(text, start)
		if !ok {
			search = start + 1
			continue
		}
		if start > untagged {
			raw := text[untagged : start-2]
			chunks = append(chunks, PromptChunk{nil, raw, raw})
		}
		chunks = append(chunks, chunk)
		untagged = end + 2
		search = untagged
	}
	if untagged < len(text) {
		raw := text[untagged:]
		chunks = append(chunks, PromptChunk{nil, raw, raw})
	}
	return chunks
}
func findSectionStart(text string, from int) int {
	if sectionOpen.MatchString(text[from:]) {
		return from
	}
	for idx := from; idx <= len(text); {
		sep := strings.Index(text[idx:], "\n\n")
		if sep < 0 {
			return -1
		}
		sep += idx
		if sectionOpen.MatchString(text[sep+2:]) {
			return sep + 2
		}
		idx = sep + 1
	}
	return -1
}
func readSectionAt(text string, start int) (PromptChunk, int, bool) {
	open := sectionOpen.FindStringSubmatch(text[start:])
	if open == nil {
		return PromptChunk{}, 0, false
	}
	name := open[1]
	bodyStart := start + len(open[0])
	closeTag := "\n</" + name + ">"
	for search := bodyStart; search <= len(text); {
		closeIdx := strings.Index(text[search:], closeTag)
		if closeIdx < 0 {
			break
		}
		closeIdx += search
		end := closeIdx + len(closeTag)
		if end == len(text) || strings.HasPrefix(text[end:], "\n\n") {
			return PromptChunk{&name, text[start:end], text[bodyStart:closeIdx]}, end, true
		}
		search = closeIdx + 1
	}
	return PromptChunk{}, 0, false
}
func RenderSystemPromptChunks(chunks []PromptChunk) string {
	parts := make([]string, len(chunks))
	for i, c := range chunks {
		parts[i] = c.Raw
	}
	return strings.Join(parts, "\n\n")
}
func piOwned(name string) bool { return name == "tools" || name == "rules" || name == "docs" }

var paragraphsPattern = regexp.MustCompile(`\n\n+`)

type shapingReport struct {
	Dropped  []string `json:"droppedSections"`
	Replaced []string `json:"replacedSections"`
	Matches  []string `json:"replacementMatches"`
}

func newReport() *shapingReport { return &shapingReport{[]string{}, []string{}, []string{}} }
func decideSection(name, body string, report *shapingReport) (text string, drop bool) {
	if name != "preamble" && !piOwned(name) {
		return body, false
	}
	text = body
	if strings.Contains(text, replacementMatch) {
		report.Matches = append(report.Matches, replacementMatch)
	}
	text = strings.ReplaceAll(text, replacementMatch, replacementText)
	if name == "preamble" && strings.HasPrefix(text, PiDefaultPromptPrefix) {
		return MinimalAnthropicOAuthPrompt, false
	}
	if name == "docs" && strings.Contains(text, PiDocsSectionAnchor) {
		return "", true
	}
	if name == "tools" {
		paragraphs := paragraphsPattern.Split(text, -1)
		kept := []string{}
		for _, p := range paragraphs {
			if !strings.Contains(p, PiToolsFillerAnchor) {
				kept = append(kept, p)
			}
		}
		if len(kept) != len(paragraphs) {
			text = jsstr.Trim(strings.Join(kept, "\n\n"))
		}
	}
	return text, false
}
func ShapeSystemPrompt(text string, observer *Observer) string {
	chunks := ParseSystemPromptChunks(text)
	owned := false
	for _, c := range chunks {
		if c.Name != nil && piOwned(*c.Name) {
			owned = true
		}
	}
	if !owned {
		observer.warnUnstructured()
		return text
	}
	report := newReport()
	shaped := []PromptChunk{}
	names := []*string{}
	for i, c := range chunks {
		names = append(names, c.Name)
		name := ""
		if c.Name != nil {
			name = *c.Name
		} else if i == 0 {
			name = "preamble"
		} else {
			shaped = append(shaped, c)
			continue
		}
		body, drop := decideSection(name, c.Body, report)
		if drop {
			report.Dropped = append(report.Dropped, name)
			continue
		}
		if body != c.Body {
			report.Replaced = append(report.Replaced, name)
			if c.Name == nil {
				c = PromptChunk{nil, body, body}
			} else {
				c = NamedSection(*c.Name, body)
			}
		}
		shaped = append(shaped, c)
	}
	if !observer.toolOnly() || (len(report.Dropped) == 0 && len(report.Matches) > 0) {
		observer.debug("system-prompt-shaping", map[string]any{"mode": "sections", "originalLength": jsstr.Len16(text), "sectionNames": names, "droppedSections": report.Dropped, "replacedSections": report.Replaced, "replacementMatches": report.Matches})
	}
	return RenderSystemPromptChunks(shaped)
}

var updateFrame = regexp.MustCompile(`(?m)^(?:Updated system prompt section "([a-z][a-z0-9_-]*)":\n\n|Removed system prompt section "([a-z][a-z0-9_-]*)"\.$)`)

func ShapeSystemUpdateText(text string) (string, bool) {
	frames := updateFrame.FindAllStringSubmatchIndex(text, -1)
	if len(frames) == 0 {
		return text, true
	}
	parts := []string{}
	if leading := jsstr.Trim(text[:frames[0][0]]); leading != "" {
		parts = append(parts, leading)
	}
	for i, f := range frames {
		framing := text[f[0]:f[1]]
		if f[4] >= 0 {
			if text[f[4]:f[5]] != "docs" {
				parts = append(parts, framing)
			}
			continue
		}
		name := text[f[2]:f[3]]
		end := len(text)
		if i+1 < len(frames) {
			end = frames[i+1][0]
		}
		value := jsstr.TrimEnd(text[f[1]:end])
		chunks := ParseSystemPromptChunks(value)
		tagged := len(chunks) == 1 && chunks[0].Name != nil && *chunks[0].Name == name
		body := value
		if tagged {
			body = chunks[0].Body
		}
		shaped, drop := decideSection(name, body, newReport())
		if drop {
			continue
		}
		if tagged {
			shaped = NamedSection(name, shaped).Raw
		}
		parts = append(parts, framing+shaped)
	}
	return strings.Join(parts, "\n\n"), len(parts) > 0
}
