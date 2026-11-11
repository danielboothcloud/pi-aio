package yamlhooks

// Redaction: redactSensitiveContent (actions.ts) for log and block-reason
// text, and the tool_args key redaction and byte cap (session-state.ts).

import (
	"fmt"

	"github.com/dlclark/regexp2"
)

const redacted = "[REDACTED]"

// JavaScript's \s class, spelled out for regexp2 (its ECMAScript \s is
// ASCII only).
const (
	jsSpaceChars = `\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`
	jsS          = `[` + jsSpaceChars + `]`
	jsNotS       = `[^` + jsSpaceChars + `]`
	jsHSpace     = `[\t\v\f \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`
)

type redactRule struct {
	re   *regexp2.Regexp
	repl string
}

func rule(pattern, repl string, ignoreCase bool) redactRule {
	opts := regexp2.RegexOptions(regexp2.ECMAScript)
	if ignoreCase {
		opts |= regexp2.IgnoreCase
	}
	return redactRule{regexp2.MustCompile(pattern, opts), repl}
}

var redactRules = []redactRule{
	rule(`-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----`, redacted, false),
	rule(`\bgh[opusr]_[A-Za-z0-9]{20,255}\b`, redacted, false),
	rule(`\bgithub_pat_[A-Za-z0-9_]{20,255}\b`, redacted, false),
	rule(`\bglpat-[A-Za-z0-9_-]{20,255}\b`, redacted, false),
	rule(`\bxox[bpars]-[A-Za-z0-9-]{10,255}\b`, redacted, false),
	rule(`\b((?:https?|ftp|ssh|git|mongodb|postgres(?:ql)?|mysql|redis|amqp):\/\/)([^`+jsSpaceChars+`:/@]+):([^`+jsSpaceChars+`/@]+)@`, "$1$2:"+redacted+"@", true),
	rule(`\b(authorization`+jsS+`*:`+jsS+`*bearer`+jsS+`+)(`+jsNotS+`+)`, "$1"+redacted, true),
	rule(`(\b(?:api[-_ ]?key|token|secret|password|passwd|pwd)\b`+jsHSpace+`*[:=]`+jsHSpace+`*)([^`+jsSpaceChars+`,"'}\]`+"`"+`]+)`, "$1"+redacted, true),
	rule(`\b([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD))(`+jsS+`*[:=]`+jsS+`*)("?)([^`+jsSpaceChars+`,"'}\]`+"`"+`]+)\3`, "$1$2$3"+redacted+"$3", false),
	rule(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`, redacted, false),
}

// RedactSensitiveContent is actions.ts redactSensitiveContent.
func RedactSensitiveContent(value string) string {
	for _, r := range redactRules {
		out, err := r.re.Replace(value, r.repl, -1, -1)
		if err == nil {
			value = out
		}
	}
	return value
}

var sensitiveKeyRules = []*regexp2.Regexp{
	regexp2.MustCompile(`^password$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^token$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^api[_-]?key$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^secret$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^authorization$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^auth$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^private[_-]?key$`, regexp2.ECMAScript|regexp2.IgnoreCase),
	regexp2.MustCompile(`^bearer$`, regexp2.ECMAScript|regexp2.IgnoreCase),
}

func isSensitiveKey(key string) bool {
	for _, re := range sensitiveKeyRules {
		if ok, _ := re.MatchString(key); ok {
			return true
		}
	}
	return false
}

const (
	toolArgsMaxBytes        = 64 * 1024
	toolArgsTruncatedHolder = "[aio yaml hooks: tool_args truncated]"
	redactionDepthLimit     = 8
	contextValueDepthLimit  = 16
)

// toHookContextValue is session-state.ts toHookContextValue.
func toHookContextValue(v any, depth int) any {
	if depth > contextValueDepthLimit {
		return "[aio yaml hooks: value depth exceeded]"
	}
	switch x := v.(type) {
	case nil, string, float64, bool:
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = toHookContextValue(e, depth+1)
		}
		return out
	case *Object:
		o := &Object{Values: map[string]any{}}
		for _, k := range x.Keys {
			o.Set(k, toHookContextValue(x.Values[k], depth+1))
		}
		return o
	}
	return fmt.Sprint(v)
}

// redactSensitiveKeys is session-state.ts redactSensitiveKeys.
func redactSensitiveKeys(v any, depth int) any {
	if depth > redactionDepthLimit {
		return "[aio yaml hooks: redaction depth exceeded]"
	}
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = redactSensitiveKeys(e, depth+1)
		}
		return out
	case *Object:
		o := &Object{Values: map[string]any{}}
		for _, k := range x.Keys {
			if isSensitiveKey(k) {
				o.Set(k, redacted)
			} else {
				o.Set(k, redactSensitiveKeys(x.Values[k], depth+1))
			}
		}
		return o
	}
	return v
}

// SanitizeToolArgs is session-state.ts sanitizeToolArgsForSerialization.
// A nil args object stays nil (undefined).
func SanitizeToolArgs(args *Object) *Object {
	if args == nil {
		return nil
	}
	value, ok := redactSensitiveKeys(toHookContextValue(args, 0), 0).(*Object)
	if !ok {
		return NewObject("_aio_hooks_tool_args_unserializable", true)
	}
	serialized := Stringify(value)
	if n := byteLength(serialized); n > toolArgsMaxBytes {
		return NewObject(
			"_aio_hooks_tool_args_truncated", true,
			"_aio_hooks_tool_args_original_bytes", float64(n),
			"_aio_hooks_tool_args_placeholder", toolArgsTruncatedHolder,
		)
	}
	return value
}
