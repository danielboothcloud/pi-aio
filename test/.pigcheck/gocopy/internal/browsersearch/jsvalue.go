package browsersearch

// JavaScript value helpers: JSON.parse with V8's error texts, String(v), and
// truthiness for decoded JSON values. The TypeScript reference surfaces
// JSON.parse errors (settings files, the CloakBrowser worker line), so the
// texts must match V8.

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// parseJS is JSON.parse(text). Values are nil, bool, float64, string, []any,
// or map[string]any. The error text is V8's SyntaxError message.
func parseJS(text string) (any, error) {
	if msg := v8JSONError(text); msg != "" {
		return nil, syntaxError(msg)
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil, syntaxError(err.Error())
	}
	return v, nil
}

// syntaxError is a JavaScript SyntaxError; String(error) is "SyntaxError: <msg>".
type syntaxError string

func (e syntaxError) Error() string { return string(e) }

// v8JSONError returns V8's JSON.parse error message for text, or "" when
// text is valid JSON (jsstr.V8JSONError).
func v8JSONError(text string) string { return jsstr.V8JSONError(text) }

// jsString is String(v) for a decoded JSON value; undefined is "undefined"
// (pass undefinedValue).
func jsString(v any) string {
	switch x := v.(type) {
	case undefinedType:
		return "undefined"
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return jsstr.NumberJS(x)
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// undefinedType marks a missing value (JavaScript undefined).
type undefinedType struct{}

var undefinedValue = undefinedType{}

// get is value?.[key] on a decoded JSON value: undefinedValue when value is
// not an object or the key is missing.
func get(value any, key string) any {
	if m, ok := value.(map[string]any); ok {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return undefinedValue
}

// truthy is JavaScript truthiness (undefined is falsy).
func truthy(v any) bool {
	if _, ok := v.(undefinedType); ok {
		return false
	}
	return jsstr.Truthy(v)
}

// nullish reports v == null (null or undefined).
func nullish(v any) bool {
	if _, ok := v.(undefinedType); ok {
		return true
	}
	return v == nil
}

// stringifyRaw is JSON.stringify(JSON.parse(raw), null, indent).
func stringifyRaw(raw []byte, indent string) string {
	return jsstr.StringifyIndent(raw, indent)
}

// validUTF8 replaces invalid bytes with U+FFFD, as Node's utf8 decoding does.
func validUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}
