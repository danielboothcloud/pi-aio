// Package notifications is the Go port of notifications/: desktop
// notifications for finished runs, agent prompts, and signals from other
// features. It owns no tools, gates, or model messages. This package does
// not import the PiG SDK; go/aio wires it to the host.
package notifications

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"
)

// Event bus channels and the settings file (shared with TypeScript).
const (
	NotificationEvent = "aio:notification"
	GoalActivityEvent = "aio:notification:goal-activity"
	AgentPromptEvent  = "aio:notification:agent-prompt"
	SettingsFileName  = "aio-notifications.settings.json"
	SettingsFileEnv   = "AIO_NOTIFY_SETTINGS_FILE"
)

// Categories are the notification categories, in settings order.
var Categories = []string{"core", "goal", "background", "critical"}

// Settings are the user's notification settings.
type Settings struct {
	Enabled    bool            `json:"enabled"`
	FocusSkip  bool            `json:"focusSkip"`
	MinSeconds float64         `json:"minSeconds"`
	Sound      string          `json:"sound"`
	Preview    bool            `json:"preview"`
	Categories map[string]bool `json:"categories"`
}

// MarshalJSON keeps the TypeScript key order (core, goal, background, critical).
func (s Settings) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteString("{")
	for i, c := range Categories {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, "%q:%t", c, s.Categories[c])
	}
	b.WriteString("}")
	type plain struct {
		Enabled    bool            `json:"enabled"`
		FocusSkip  bool            `json:"focusSkip"`
		MinSeconds float64         `json:"minSeconds"`
		Sound      string          `json:"sound"`
		Preview    bool            `json:"preview"`
		Categories json.RawMessage `json:"categories"`
	}
	return json.Marshal(plain{s.Enabled, s.FocusSkip, s.MinSeconds, s.Sound, s.Preview, json.RawMessage(b.String())})
}

// Defaults are the settings without a file.
func Defaults() Settings {
	return Settings{Enabled: true, FocusSkip: true, Sound: "Glass",
		Categories: map[string]bool{"core": true, "goal": true, "background": true, "critical": true}}
}

func (s Settings) clone() Settings {
	out := s
	out.Categories = map[string]bool{}
	for k, v := range s.Categories {
		out.Categories[k] = v
	}
	return out
}

var soundRe = regexp.MustCompile(`^[\w -]{1,64}$`)

// Normalize reads a decoded settings value; invalid fields keep their default.
func Normalize(raw any) Settings {
	result := Defaults()
	data, ok := raw.(map[string]any)
	if !ok {
		return result
	}
	if v, ok := data["enabled"].(bool); ok {
		result.Enabled = v
	}
	if v, ok := data["focusSkip"].(bool); ok {
		result.FocusSkip = v
	}
	if v, ok := data["preview"].(bool); ok {
		result.Preview = v
	}
	if v, ok := data["minSeconds"].(float64); ok && !math.IsInf(v, 0) && !math.IsNaN(v) && v >= 0 && v <= 86400 {
		result.MinSeconds = v
	}
	if v, ok := data["sound"].(string); ok && soundRe.MatchString(v) && utf16Len(v) <= 64 {
		result.Sound = v
	}
	if categories, ok := data["categories"].(map[string]any); ok {
		for _, key := range Categories {
			if v, ok := categories[key].(bool); ok {
				result.Categories[key] = v
			}
		}
	}
	return result
}

// SettingsPath is AIO_NOTIFY_SETTINGS_FILE, else <agentDir>/aio-notifications.settings.json.
func SettingsPath(agentDir string) string {
	if override := strings.TrimSpace(os.Getenv(SettingsFileEnv)); override != "" {
		return override
	}
	return filepath.Join(agentDir, SettingsFileName)
}

// Load reads the settings file; any failure gives the defaults.
func Load(path string) Settings {
	data, err := os.ReadFile(path)
	if err != nil {
		return Defaults()
	}
	var raw any
	if json.Unmarshal(data, &raw) != nil {
		return Defaults()
	}
	return Normalize(raw)
}

// Save writes the settings atomically, tab-indented like TypeScript.
func Save(path string, settings Settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	text, err := json.MarshalIndent(settings, "", "\t")
	if err != nil {
		return err
	}
	staging := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(staging, append(text, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(staging, path)
}

// vtRe is Node's stripVTControlCharacters pattern.
var vtRe = regexp.MustCompile(`[\x{1b}\x{9b}][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\x{07}|\x{1b}\x{5c}|\x{9c}))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))`)

var (
	controlRe = regexp.MustCompile(`[\x{00}-\x{1f}\x{7f}-\x{9f};]`)
	spaceRe   = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// utf16Slice is String.prototype.slice(0, n).
func utf16Slice(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if n >= len(units) {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// CleanText strips terminal escapes and protocol delimiters from untrusted text.
func CleanText(text string, max int) string {
	text = vtRe.ReplaceAllString(text, "")
	text = controlRe.ReplaceAllString(text, " ")
	text = strings.Trim(spaceRe.ReplaceAllString(text, " "), jsSpace)
	return utf16Slice(text, max)
}

// Group is the notification group for a session and category ("prompt" for prompts).
func Group(sessionID, kind string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return "aio." + hex.EncodeToString(sum[:])[:16] + "." + kind
}

// Status is the /notify status line.
func Status(s Settings, backend string) string {
	var events []string
	for _, c := range Categories {
		if s.Categories[c] {
			events = append(events, c)
		}
	}
	return fmt.Sprintf("Notifications %s · %s · focus-skip=%t · min=%ss · sound=%s · preview=%t · events=%s",
		map[bool]string{true: "on", false: "off"}[s.Enabled], backend, s.FocusSkip, jsNumber(s.MinSeconds), s.Sound, s.Preview, strings.Join(events, ","))
}

// jsNumber formats a number like JavaScript's String(n) for the values used here.
func jsNumber(n float64) string {
	if n == math.Trunc(n) && math.Abs(n) < 1e21 {
		return fmt.Sprintf("%d", int64(n))
	}
	return fmt.Sprint(n)
}

// Usage is the /notify usage warning.
const Usage = "Usage: /notify [status|on|off|test [seconds]|focus on/off|preview on/off|min <seconds>|sound <name/off>|events core/goal/background/critical on/off]"

var (
	commandSoundRe = regexp.MustCompile(`^[\w-]{1,64}$`)
	splitRe        = spaceRe
)

// Command is a parsed /notify argument.
type Command struct {
	Kind string // "status", "test", "set", or "invalid"
	// TestSeconds is the delay for "test"; TestValid is false for a bad delay.
	TestSeconds float64
	TestValid   bool
	// Settings are the new settings for "set".
	Settings Settings
}

func isOnOff(s string) bool { return s == "on" || s == "off" }

// ParseCommand parses /notify arguments against the current settings.
func ParseCommand(args string, current Settings) Command {
	var words []string
	for _, w := range splitRe.Split(strings.Trim(args, jsSpace), -1) {
		if w != "" {
			words = append(words, w)
		}
	}
	at := func(i int) (string, bool) {
		if i < len(words) {
			return words[i], true
		}
		return "", false
	}
	command, _ := at(0)
	value, hasValue := at(1)
	flag, hasFlag := at(2)
	extra := len(words) > 3
	if command == "" || command == "status" {
		return Command{Kind: "status"}
	}
	if command == "test" {
		seconds := 0.0
		valid := true
		if hasValue {
			seconds = jsToNumber(value)
		}
		if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > 60 || hasFlag || extra {
			valid = false
		}
		return Command{Kind: "test", TestSeconds: seconds, TestValid: valid}
	}
	next := current.clone()
	valid := !extra
	switch {
	case (command == "on" || command == "off") && !hasValue:
		next.Enabled = command == "on"
	case (command == "focus" || command == "preview") && isOnOff(value) && !hasFlag:
		if command == "focus" {
			next.FocusSkip = value == "on"
		} else {
			next.Preview = value == "on"
		}
	case command == "min" && hasValue && !hasFlag && isMinValue(value):
		next.MinSeconds = jsToNumber(value)
	case command == "sound" && commandSoundRe.MatchString(value) && !hasFlag:
		next.Sound = value
	case command == "events" && hasCategory(value) && isOnOff(flag):
		next.Categories[value] = flag == "on"
	default:
		valid = false
	}
	if !valid {
		return Command{Kind: "invalid"}
	}
	return Command{Kind: "set", Settings: next}
}

func isMinValue(value string) bool {
	n := jsToNumber(value)
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 86400
}

func hasCategory(value string) bool {
	for _, c := range Categories {
		if c == value {
			return true
		}
	}
	return false
}

var (
	decimalRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
	hexRe     = regexp.MustCompile(`^0[xX][0-9a-fA-F]+$`)
	octRe     = regexp.MustCompile(`^0[oO][0-7]+$`)
	binRe     = regexp.MustCompile(`^0[bB][01]+$`)
)

// jsToNumber is JavaScript's Number(string) for one whitespace-free word.
func jsToNumber(s string) float64 {
	switch {
	case s == "":
		return 0
	case s == "Infinity" || s == "+Infinity":
		return math.Inf(1)
	case s == "-Infinity":
		return math.Inf(-1)
	case decimalRe.MatchString(s):
		var f float64
		if _, err := fmt.Sscan(s, &f); err == nil {
			return f
		}
	case hexRe.MatchString(s), octRe.MatchString(s), binRe.MatchString(s):
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		var n float64
		for _, c := range s[2:] {
			d := strings.IndexRune("0123456789abcdef", rune(strings.ToLower(string(c))[0]))
			n = n*float64(base) + float64(d)
		}
		return n
	}
	return math.NaN()
}
