// Package sessionnav is the Go port of session-nav/: the rewind picker on
// double-Esc (/rewind), the grouped resume picker (/sessions, /resume, the
// --sessions flag), and their pure models. The PiG wiring is in
// go/aio/sessionnav.go.
package sessionnav

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

var (
	skillBlock = regexp.MustCompile(`^\s*<skill\s+name="([^"]+)"[^>]*>[\s\S]*?</skill>\s*`)
	spaceRun   = regexp.MustCompile(`[\s\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
)

// CollapseSpace is text.replace(/\s+/g, " ").trim().
func CollapseSpace(text string) string { return jsstr.Trim(spaceRun.ReplaceAllString(text, " ")) }

// CleanPromptTitle is cleanPromptTitle: one readable line, with a skill
// block shown as "skill: name — text".
func CleanPromptTitle(raw string) string {
	text, prefix := raw, ""
	if m := skillBlock.FindStringSubmatchIndex(text); m != nil {
		prefix = "skill: " + text[m[2]:m[3]]
		text = text[m[1]:]
	}
	body := CollapseSpace(text)
	if prefix != "" {
		if body != "" {
			return prefix + " — " + body
		}
		return prefix
	}
	return body
}

// RelativeAge is relativeAge: "now", "4m", "3h", "2d", then "Mon D" in loc.
func RelativeAge(timestamp, now float64, loc *time.Location) string {
	if math.IsNaN(timestamp) || math.IsInf(timestamp, 0) {
		return ""
	}
	seconds := math.Max(0, math.Floor((now-timestamp)/1000+0.5))
	if seconds < 60 {
		return "now"
	}
	minutes := math.Floor(seconds / 60)
	if minutes < 60 {
		return strconv.Itoa(int(minutes)) + "m"
	}
	hours := math.Floor(minutes / 60)
	if hours < 24 {
		return strconv.Itoa(int(hours)) + "h"
	}
	days := math.Floor(hours / 24)
	if days < 7 {
		return strconv.Itoa(int(days)) + "d"
	}
	date := time.UnixMilli(int64(timestamp)).In(loc)
	return date.Month().String()[:3] + " " + strconv.Itoa(date.Day())
}

// RelativeAgeLong is relativeAgeLong: "22m ago", "just now".
func RelativeAgeLong(timestamp, now float64, loc *time.Location) string {
	short := RelativeAge(timestamp, now, loc)
	if short == "now" {
		return "just now"
	}
	if short != "" && short[0] >= '0' && short[0] <= '9' {
		return short + " ago"
	}
	return short
}

// ToMillis is toMillis: numbers pass, strings parse as Date.parse does for
// ISO 8601, anything else is NaN.
func ToMillis(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case time.Time:
		return float64(v.UnixMilli())
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z07:00"} {
			if t, err := time.Parse(layout, v); err == nil {
				return float64(t.UnixMilli())
			}
		}
	}
	return math.NaN()
}

// MatchesQuery is matchesQuery: every whitespace-separated term appears.
func MatchesQuery(query string, fields ...string) bool {
	terms := strings.Fields(strings.ToLower(query))
	if len(terms) == 0 {
		return true
	}
	var kept []string
	for _, f := range fields {
		if f != "" {
			kept = append(kept, f)
		}
	}
	haystack := strings.ToLower(strings.Join(kept, "\n"))
	for _, term := range terms {
		if !strings.Contains(haystack, term) {
			return false
		}
	}
	return true
}
