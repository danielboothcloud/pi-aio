package subagents

// Ordered JSON values. Child events and session entries are decoded with
// their key order, because the TypeScript reference prints tool arguments
// with JSON.stringify and picks "the first string value" in key order.

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Object is a decoded JSON object with its key order. Values are nil,
// bool, float64, string, []any, or *Object.
type Object struct {
	Keys   []string
	Values map[string]any
}

// Get returns the value of key, or nil.
func (o *Object) Get(key string) any {
	if o == nil {
		return nil
	}
	return o.Values[key]
}

// Has reports whether key is present (with any value, also null).
func (o *Object) Has(key string) bool {
	if o == nil {
		return false
	}
	_, ok := o.Values[key]
	return ok
}

// Set adds or replaces key, keeping its first position.
func (o *Object) Set(key string, value any) {
	if o.Values == nil {
		o.Values = map[string]any{}
	}
	if _, ok := o.Values[key]; !ok {
		o.Keys = append(o.Keys, key)
	}
	o.Values[key] = value
}

// NewObject builds an Object from alternating keys and values.
func NewObject(pairs ...any) *Object {
	o := &Object{Values: map[string]any{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}

// MarshalJSON keeps the key order.
func (o *Object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, key := range o.Keys {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(key)
		b.Write(k)
		b.WriteByte(':')
		v, err := json.Marshal(o.Values[key])
		if err != nil {
			return nil, err
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Decode parses JSON text into ordered values.
func Decode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errTrailing
	}
	return v, nil
}

type decodeError string

func (e decodeError) Error() string { return string(e) }

const errTrailing = decodeError("trailing data after JSON value")

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch v := tok.(type) {
	case json.Delim:
		if v == '{' {
			o := &Object{Values: map[string]any{}}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				value, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(keyTok.(string), value)
			}
			_, err := dec.Token()
			return o, err
		}
		list := []any{}
		for dec.More() {
			value, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		_, err := dec.Token()
		return list, err
	case json.Number:
		f, err := strconv.ParseFloat(v.String(), 64)
		if err != nil && !math.IsInf(f, 0) {
			return nil, err
		}
		return f, nil
	default:
		return v, nil
	}
}

// Stringify is JSON.stringify(value, null, indent) for ordered values.
func Stringify(value any, indent string) string {
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return jsstr.StringifyIndent(data, indent)
}

// jsString is String(value) for decoded JSON values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
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
	case *Object:
		return "[object Object]"
	}
	return ""
}

// jsNumber is Number(value) for decoded JSON values; NaN for non-numbers.
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		t := jsstr.Trim(x)
		if t == "" {
			return 0
		}
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsNumber(jsString(x[0]))
		}
	}
	return math.NaN()
}

// jsNumberOr is Number(value) || fallback.
func jsNumberOr(v any, fallback float64) float64 {
	n := jsNumber(v)
	if n == 0 || math.IsNaN(n) {
		return fallback
	}
	return n
}

// jsNumberOrZero is Number(value) || 0.
func jsNumberOrZero(v any) float64 { return jsNumberOr(v, 0) }
