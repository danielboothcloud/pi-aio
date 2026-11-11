// Package yamlhooks is the Go port of yaml-hooks/ (ported from pi-yaml-hooks,
// MIT, KristjanPikhof): hooks.yaml discovery and trust, schema validation,
// imports and overrides, and the runtime that dispatches bash, tool, notify,
// confirm, and setStatus actions for agent tool calls, prompts, and session
// lifecycle events. It does not import the PiG SDK; go/aio/yamlhooks.go
// adapts sdk.Context to Host.
//
// The TypeScript feature stays the reference: testdata/gen-golden.ts drives
// the real TypeScript code and golden_test.go reproduces every result.
package yamlhooks

// Ordered JSON values. YAML mappings, hook tool args, and the bash stdin
// payload are written with JSON.stringify in TypeScript, which keeps the
// insertion order of object keys. Go maps have no order, so the port keeps
// objects as *Object.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Object is a JavaScript object with its key order. Values are nil, bool,
// float64, string, []any, or *Object.
type Object struct {
	Keys   []string
	Values map[string]any
}

// NewObject builds an Object from alternating keys and values.
func NewObject(pairs ...any) *Object {
	o := &Object{Values: map[string]any{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}

// Get returns the value of key, or nil.
func (o *Object) Get(key string) any {
	if o == nil {
		return nil
	}
	return o.Values[key]
}

// Has reports whether key is present (the `in` operator).
func (o *Object) Has(key string) bool {
	if o == nil {
		return false
	}
	_, ok := o.Values[key]
	return ok
}

// Set adds or replaces key. A new key goes last; an existing key keeps its
// place, as in JavaScript.
func (o *Object) Set(key string, value any) {
	if o.Values == nil {
		o.Values = map[string]any{}
	}
	if _, ok := o.Values[key]; !ok {
		o.Keys = append(o.Keys, key)
	}
	o.Values[key] = value
}

// Len is the number of keys.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.Keys)
}

// FromGo converts a decoded encoding/json value (map[string]any with sorted
// keys) to ordered values. Maps become *Object with sorted keys, which is the
// order Go's JSON encoder used when the host sent them.
func FromGo(v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := &Object{Values: make(map[string]any, len(x))}
		for _, k := range keys {
			o.Set(k, FromGo(x[k]))
		}
		return o
	case *Object:
		return x
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = FromGo(item)
		}
		return out
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case float32:
		return float64(x)
	}
	return v
}

// ToGo converts ordered values to plain Go values (map[string]any).
func ToGo(v any) any {
	switch x := v.(type) {
	case *Object:
		out := make(map[string]any, len(x.Keys))
		for _, k := range x.Keys {
			out[k] = ToGo(x.Values[k])
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = ToGo(item)
		}
		return out
	}
	return v
}

// Stringify is JSON.stringify(value) for ordered values. An undefined value
// does not exist in Go; callers drop absent keys before they stringify.
func Stringify(v any) string {
	var b strings.Builder
	writeJSON(&b, v, "", "")
	return b.String()
}

// StringifyIndent is JSON.stringify(value, null, indent).
func StringifyIndent(v any, indent string) string {
	var b strings.Builder
	writeJSON(&b, v, indent, "")
	return b.String()
}

func writeJSON(b *strings.Builder, v any, indent, prefix string) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(jsstr.NumberJS(x))
		}
	case int:
		b.WriteString(jsstr.NumberJS(float64(x)))
	case string:
		b.WriteString(jsstr.QuoteJS(x))
	case []string:
		items := make([]any, len(x))
		for i, s := range x {
			items[i] = s
		}
		writeJSON(b, items, indent, prefix)
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteByte('[')
		inner := prefix + indent
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			writeJSON(b, item, indent, inner)
		}
		if indent != "" {
			b.WriteString("\n" + prefix)
		}
		b.WriteByte(']')
	case *Object:
		if x == nil {
			b.WriteString("null")
			return
		}
		if len(x.Keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteByte('{')
		inner := prefix + indent
		for i, k := range x.Keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			b.WriteString(jsstr.QuoteJS(k))
			b.WriteByte(':')
			if indent != "" {
				b.WriteByte(' ')
			}
			writeJSON(b, x.Values[k], indent, inner)
		}
		if indent != "" {
			b.WriteString("\n" + prefix)
		}
		b.WriteByte('}')
	case map[string]any:
		writeJSON(b, FromGo(x), indent, prefix)
	default:
		b.WriteString("null")
	}
}

// isNonEmptyString is types.ts isNonEmptyString.
func isNonEmptyString(v any) bool {
	s, ok := v.(string)
	return ok && jsstr.Trim(s) != ""
}

// byteLength is Buffer.byteLength(s, "utf8").
func byteLength(s string) int { return len(s) }

// DecodeJSON parses JSON text into ordered values (JSON.parse).
func DecodeJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeJSONValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

func decodeJSONValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch v := tok.(type) {
	case json.Delim:
		if v == '{' {
			o := &Object{Values: map[string]any{}}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return nil, err
				}
				value, err := decodeJSONValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(key.(string), value)
			}
			_, err := dec.Token()
			return o, err
		}
		list := []any{}
		for dec.More() {
			value, err := decodeJSONValue(dec)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		_, err := dec.Token()
		return list, err
	case json.Number:
		return strconv.ParseFloat(v.String(), 64)
	}
	return tok, nil
}
