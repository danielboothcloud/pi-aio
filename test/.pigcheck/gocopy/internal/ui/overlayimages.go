package ui

import (
	"regexp"
	"strconv"
	"strings"
)

// Port of ui/overlay-images.ts's pure helpers. The TypeScript module also
// patches the host TUI's compositeOverlays so that an AIO overlay hides
// inline images; a Go extension cannot reach the host's renderer, so only
// the row arithmetic is ported (see go/README.md).

const (
	kittyPrefix  = "\x1b_G"
	iterm2Prefix = "\x1b]1337;File="
)

var cursorUp = regexp.MustCompile(`\x1b\[(\d+)A`)

// ImageRowSpan is imageRowSpan: the rows an image line covers above and
// below itself; ok is false for a line without an image.
func ImageRowSpan(line string) (above, below int, ok bool) {
	kitty := strings.Index(line, kittyPrefix)
	iterm := strings.Index(line, iterm2Prefix)
	if kitty == -1 && iterm == -1 {
		return 0, 0, false
	}
	start := kitty
	if start == -1 || (iterm != -1 && iterm < start) {
		start = iterm
	}
	if m := cursorUp.FindStringSubmatch(line[:start]); m != nil {
		above, _ = strconv.Atoi(m[1])
	}
	if kitty != -1 {
		rest := line[kitty+len(kittyPrefix):]
		params := ""
		if end := strings.Index(rest, ";"); end != -1 {
			params = rest[:end]
		}
		for _, param := range strings.Split(params, ",") {
			key, value, _ := strings.Cut(param, "=")
			if rows, err := strconv.Atoi(value); key == "r" && err == nil && rows > 1 && isPlainInt(value) {
				below = rows - 1
			}
		}
	}
	return above, below, true
}

func isPlainInt(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// HideViewportImages is hideViewportImages: image lines whose rows reach
// the visible viewport become empty; the row count is kept.
func HideViewportImages(lines []string, termHeight int) []string {
	viewportStart := max(0, max(len(lines), termHeight)-termHeight)
	var result []string
	for i, line := range lines {
		_, below, ok := ImageRowSpan(line)
		if !ok || i+below < viewportStart {
			continue
		}
		if result == nil {
			result = append([]string(nil), lines...)
		}
		result[i] = ""
	}
	if result == nil {
		return lines
	}
	return result
}
