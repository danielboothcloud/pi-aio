package prettytools

import (
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// jsS is JavaScript's \s as an RE2 class body.
const jsS = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// NormalizeLineEndings ports normalizeLineEndings.
func NormalizeLineEndings(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
}

// ShortPath ports shortPath: p relative to cwd when inside it, else p with
// the first occurrence of home replaced by "~". Relative paths resolve
// against cwd (TypeScript's process.cwd(), which is the same directory).
func ShortPath(cwd, home, p string) string {
	if p == "" {
		return ""
	}
	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(cwd, abs)
	}
	r, err := filepath.Rel(filepath.Clean(cwd), filepath.Clean(abs))
	if err == nil {
		if r == "." {
			r = ""
		}
		if !strings.HasPrefix(r, "..") && !strings.HasPrefix(r, "/") {
			return r
		}
	}
	return strings.Replace(p, home, "~", 1)
}

var exitStatusLineRe = regexp.MustCompile(`(?i)^Command exited with code \d+$`)

// StripBashExitStatusLine ports stripBashExitStatusLine.
func StripBashExitStatusLine(text string) string {
	lines := strings.Split(NormalizeLineEndings(text), "\n")
	kept := lines[:0:0]
	for _, line := range lines {
		if !exitStatusLineRe.MatchString(jsstr.Trim(line)) {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

// jsRound is Math.round.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// FormatElapsedMs ports formatElapsedMs; ok=false is a missing value.
func FormatElapsedMs(ms float64, ok bool) string {
	if !ok || math.IsNaN(ms) || math.IsInf(ms, 0) {
		return ""
	}
	if ms < 1000 {
		return jsstr.NumberJS(jsRound(ms)) + "ms"
	}
	s := ms / 1000
	if s < 10 {
		return jsstr.ToFixed(s, 1) + "s"
	}
	return jsstr.NumberJS(jsRound(s)) + "s"
}

// FormatCharCount ports formatCharCount; ok=false is a missing value.
func FormatCharCount(chars float64, ok bool) string {
	if !ok || math.IsNaN(chars) || math.IsInf(chars, 0) || chars <= 0 {
		return ""
	}
	if chars < 1000 {
		return jsstr.NumberJS(chars) + " chars"
	}
	if chars < 10_000 {
		return jsstr.ToFixed(chars/1000, 1) + "k chars"
	}
	return jsstr.NumberJS(jsRound(chars/1000)) + "k chars"
}

// Metric keys in a result's details.
const (
	ElapsedKey = "__prettyElapsedMs"
	CharsKey   = "__prettyOutputChars"
)

var exitCodeRe = regexp.MustCompile(`(?i)(?:exit code|exited with(?: code)?|exit status)[:` + jsS + `]*(\d+)`)

// InferBashExitCode ports inferBashExitCode; nil is null.
func InferBashExitCode(text string, fallback *int) *int {
	if m := exitCodeRe.FindStringSubmatch(text); m != nil {
		n, err := strconv.Atoi(m[1])
		if err != nil {
			n = math.MaxInt
		}
		return &n
	}
	if strings.Contains(text, "command not found") || strings.Contains(text, "No such file") {
		one := 1
		return &one
	}
	return fallback
}

// CompactErrorLines ports compactErrorLines: runs of blank lines collapse
// to one.
func CompactErrorLines(text string) []string {
	out := []string{}
	previousBlank := false
	for _, line := range strings.Split(jsstr.Trim(NormalizeLineEndings(text)), "\n") {
		blank := jsstr.Trim(line) == ""
		if blank && previousBlank {
			continue
		}
		out = append(out, line)
		previousBlank = blank
	}
	return out
}
