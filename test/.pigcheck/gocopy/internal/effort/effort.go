// Package effort is the Go port of effort/: the /effort command parser,
// argument completions, and the on-the-fly capability override that lets a
// reasoning model receive xhigh/max even without an explicit
// thinkingLevelMap entry. This package does not import the PiG SDK.
package effort

import (
	"regexp"
	"strings"
)

// Levels are the thinking levels, in order.
var Levels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// StatusKey is the footer status key.
const StatusKey = "effort"

// UltracodeEvent is the event bus channel that /effort ultracode emits on.
const UltracodeEvent = "pandi-dynamic-workflows:ultracode-mode"

// IsLevel reports whether s is a thinking level.
func IsLevel(s string) bool {
	for _, level := range Levels {
		if level == s {
			return true
		}
	}
	return false
}

// Target is a parsed /effort argument.
type Target struct {
	Kind  string // "status", "level", "ultracode", or "invalid"
	Level string
	Value string // the raw value of an invalid target
}

var prefixWords = map[string]bool{"thinking": true, "think": true, "level": true, "effort": true}

var aliases = map[string]string{
	"0": "off", "false": "off", "no": "off", "none": "off", "off": "off", "disable": "off", "disabled": "off",
	"min": "minimal", "minimal": "minimal", "low": "low", "lo": "low",
	"medium": "medium", "med": "medium", "normal": "medium", "default": "medium",
	"high": "high", "hi": "high", "max": "max", "xhigh": "xhigh", "x-high": "xhigh", "extra": "xhigh",
}

var (
	separatorRe = regexp.MustCompile(`[=:,]`)
	spaceRe     = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func trim(s string) string { return strings.Trim(s, jsSpace) }

func meaningfulToken(value string) string {
	var tokens []string
	for _, token := range spaceRe.Split(separatorRe.ReplaceAllString(value, " "), -1) {
		if token != "" && !prefixWords[token] {
			tokens = append(tokens, token)
		}
	}
	if len(tokens) == 0 {
		return value
	}
	return tokens[len(tokens)-1]
}

// ParseTarget parses an /effort argument.
func ParseTarget(raw string) Target {
	value := strings.ToLower(trim(raw))
	switch value {
	case "", "status", "show", "current":
		return Target{Kind: "status"}
	case "ultracode", "ultra-code":
		return Target{Kind: "ultracode"}
	}
	if level, ok := aliases[meaningfulToken(value)]; ok {
		return Target{Kind: "level", Level: level}
	}
	return Target{Kind: "invalid", Value: trim(raw)}
}

// Model is the capability data of a model: its `reasoning` flag and its
// thinkingLevelMap (a nil value pins a level as unsupported).
type Model struct {
	Reasoning bool
	// LevelMap holds the explicit map; a key with a nil value is unsupported.
	LevelMap map[string]*string
}

// ModelFrom reads the capability data from a registry model object.
func ModelFrom(m map[string]any) *Model {
	if m == nil {
		return nil
	}
	reasoning, _ := m["reasoning"].(bool)
	model := &Model{Reasoning: reasoning}
	if raw, ok := m["thinkingLevelMap"].(map[string]any); ok {
		model.LevelMap = map[string]*string{}
		for level, value := range raw {
			switch v := value.(type) {
			case nil:
				model.LevelMap[level] = nil
			case string:
				model.LevelMap[level] = &v
			}
		}
	}
	return model
}

// ResolveValue is the effort string to send for a level, or ok=false when
// none may be forced (no reasoning, pinned unsupported, or off).
func ResolveValue(model *Model, level string) (string, bool) {
	if model == nil || !model.Reasoning {
		return "", false
	}
	if mapped, present := model.LevelMap[level]; present {
		if mapped == nil {
			return "", false
		}
		return *mapped, true
	}
	if level == "off" {
		return "", false
	}
	return level, true
}

// ApplyOverride rewrites `reasoning_effort` in a provider payload to the
// desired level when the model can take it. It returns ok=false when the
// payload stays as it is. Only a payload that already carries a string
// `reasoning_effort` is changed, so no unsupported parameter is added.
func ApplyOverride(model *Model, desired string, payload map[string]any) (map[string]any, bool) {
	if desired == "" || model == nil || !model.Reasoning || payload == nil {
		return nil, false
	}
	current, ok := payload["reasoning_effort"].(string)
	if !ok {
		return nil, false
	}
	value, ok := ResolveValue(model, desired)
	if !ok || value == current {
		return nil, false
	}
	out := make(map[string]any, len(payload))
	for k, v := range payload {
		out[k] = v
	}
	out["reasoning_effort"] = value
	return out, true
}

// EffectiveLevel reconciles the clamped host level with the level that is
// actually sent: an xhigh/max request that can still be sent wins.
func EffectiveLevel(model *Model, requested, clamped string) string {
	if clamped == requested {
		return requested
	}
	if requested == "xhigh" || requested == "max" {
		if _, ok := ResolveValue(model, requested); ok {
			return requested
		}
	}
	return clamped
}

// Option is one /effort menu option.
type Option struct {
	Value, Description, SelectLabel string
}

// Options are the canonical options, then the aliases (completions only).
var Options = []Option{
	{"off", "Disable model thinking effort", "off — disable thinking"},
	{"minimal", "Minimal effort", "minimal — minimal effort"},
	{"low", "Low effort", "low — low effort"},
	{"medium", "Medium effort", "medium — medium effort"},
	{"high", "High effort", "high — high effort"},
	{"xhigh", "Extra high effort", "xhigh — extra high effort"},
	{"max", "Maximum native effort", "max — maximum native effort"},
	{"ultracode", "Extra high effort + dynamic_workflow router", "ultracode — xhigh + dynamic_workflow router"},
	{"status", "Show current effort", ""},
	{"none", "Alias for off", ""},
	{"ultra-code", "Alias for ultracode", ""},
}

// Completions are the options whose value starts with the prefix.
func Completions(prefix string) []Option {
	wanted := strings.ToLower(trim(prefix))
	var out []Option
	for _, option := range Options {
		if strings.HasPrefix(strings.ToLower(option.Value), wanted) {
			out = append(out, option)
		}
	}
	return out
}

// SelectLabels are the picker labels, in order.
func SelectLabels() []string {
	var out []string
	for _, option := range Options[:9] {
		if option.SelectLabel != "" {
			out = append(out, option.SelectLabel)
		}
	}
	return out
}

// Usage is the status and usage line.
func Usage(current string) string {
	return "Current effort: " + current + ". Usage: /effort <off|minimal|low|medium|high|xhigh|max|ultracode>"
}

// SetNotice is the notification after a level change, and its level.
func SetNotice(requested, effective string) (string, string) {
	if effective == requested {
		return "Thinking effort set to " + effective + ".", "info"
	}
	return "Requested effort " + requested + "; active effort is " + effective + " (current model may limit thinking).", "warning"
}

// UltracodeNotice is the notification after /effort ultracode, and its level.
func UltracodeNotice(actual string, routerActive bool) (string, string) {
	if routerActive {
		return "Ultracode effort enabled (" + actual + "); dynamic_workflow router enabled.", "info"
	}
	return "Ultracode effort enabled (" + actual + "); dynamic_workflow router requested but not available in this session.", "warning"
}
