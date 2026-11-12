// Package anthropicauth ports the SDK-independent behavior of
// @gotgenes/pi-anthropic-auth 3.4.4 (MIT, Chris Lasher).
// See ../../anthropic-auth/UPSTREAM.md for provenance and host limitations.
package anthropicauth

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const ClaudeCodeVersion = "2.1.280"
const ClaudeCodeVersionEnv = "PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION"

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
var cliVersionPattern = regexp.MustCompile(`(?:^|[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}])claude-cli/([0-9]+\.[0-9]+\.[0-9]+)(?:[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]|$)`)

func ResolveClaudeCodeVersion(override string) (string, error) {
	value := jsstr.Trim(override)
	if value == "" {
		return ClaudeCodeVersion, nil
	}
	if !versionPattern.MatchString(value) {
		return "", fmt.Errorf("%s must be a bare X.Y.Z version, received %s", ClaudeCodeVersionEnv, jsstr.QuoteJS(value))
	}
	return value, nil
}
func ReadClaudeCliVersion(userAgent string) string {
	match := cliVersionPattern.FindStringSubmatch(userAgent)
	if match == nil {
		return ""
	}
	return match[1]
}
func HigherVersion(baseline, candidate string) string {
	if !versionPattern.MatchString(candidate) {
		return baseline
	}
	bp, cp := strings.Split(baseline, "."), strings.Split(candidate, ".")
	for i := range cp {
		// TypeScript compares Number components, including rounded large integers.
		b, _ := strconv.ParseFloat(bp[i], 64)
		c, _ := strconv.ParseFloat(cp[i], 64)
		if b != c {
			if c > b {
				return candidate
			}
			return baseline
		}
	}
	return baseline
}

// LearnedFloor is shared by all requests and named providers of one wrapper.
type LearnedFloor struct {
	mu      sync.Mutex
	version string
}

func (f *LearnedFloor) Learn(version string) {
	if !versionPattern.MatchString(version) {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.version == "" {
		f.version = version
	} else {
		f.version = HigherVersion(f.version, version)
	}
}
func (f *LearnedFloor) ApplyTo(version string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return HigherVersion(version, f.version)
}
func IsAnthropicOAuthToken(key string) bool { return strings.Contains(key, "sk-ant-oat") }
