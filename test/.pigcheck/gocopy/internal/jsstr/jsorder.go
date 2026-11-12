package jsstr

import (
	"bytes"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// JavaScript object semantics for raw JSON. JSON.parse keeps the last value
// of a repeated key at the key's first position, and an object lists its
// array-index keys ("0", "1", ...) first, in ascending order, then the other
// keys in insertion order. Code that copies parsed JSON back out with
// JSON.stringify (a `.pi-recipe` scaffold, hypa's MCP schemas) needs that
// order.

// Object is a decoded JSON object in JavaScript key order.
type Object struct {
	Keys   []string
	Values map[string]json.RawMessage
}

// arrayIndex reports whether key is a canonical array index (0 to 2^32-2).
func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	if err != nil || n >= 1<<32-1 {
		return 0, false
	}
	return n, true
}

// DecodeObject reads one raw JSON object in JavaScript key order. ok is
// false when raw is not an object.
func DecodeObject(raw json.RawMessage) (Object, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return Object{}, false
	}
	obj := Object{Values: map[string]json.RawMessage{}}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return Object{}, false
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return Object{}, false
		}
		if _, seen := obj.Values[key]; !seen {
			obj.Keys = append(obj.Keys, key)
		}
		obj.Values[key] = value
	}
	var indexed, named []string
	for _, key := range obj.Keys {
		if _, ok := arrayIndex(key); ok {
			indexed = append(indexed, key)
		} else {
			named = append(named, key)
		}
	}
	sort.SliceStable(indexed, func(i, j int) bool {
		a, _ := arrayIndex(indexed[i])
		b, _ := arrayIndex(indexed[j])
		return a < b
	})
	obj.Keys = append(indexed, named...)
	return obj, true
}

// CanonicalJSON is JSON.Stringify(JSON.parse(raw)) in compact form: every
// nested object in JavaScript key order.
func CanonicalJSON(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	switch {
	case len(trimmed) > 0 && trimmed[0] == '{':
		obj, ok := DecodeObject(trimmed)
		if !ok {
			return Stringify(trimmed)
		}
		return obj.Stringify(nil)
	case len(trimmed) > 0 && trimmed[0] == '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return Stringify(trimmed)
		}
		parts := make([]string, len(items))
		for i, item := range items {
			parts[i] = CanonicalJSON(item)
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		return Stringify(trimmed)
	}
}

// Stringify writes the object compactly; keep (when set) filters the keys.
func (o Object) Stringify(keep func(key string, value json.RawMessage) bool) string {
	var b strings.Builder
	b.WriteByte('{')
	first := true
	for _, key := range o.Keys {
		value := o.Values[key]
		if keep != nil && !keep(key, value) {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.WriteString(QuoteJS(key))
		b.WriteByte(':')
		b.WriteString(CanonicalJSON(value))
	}
	b.WriteByte('}')
	return b.String()
}

// IsJSONObject reports whether raw is a JSON object or array (typeof
// "object" and not null in JavaScript).
func IsJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[')
}
