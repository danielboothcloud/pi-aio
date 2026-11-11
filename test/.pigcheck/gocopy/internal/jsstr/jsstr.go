// Package jsstr reproduces JavaScript string and JSON semantics for the Go
// port: UTF-16 lengths and slices, the \s class, trim, JSON.stringify, and
// number formatting. Moved from go/internal/btw so features share one copy.
package jsstr

// JavaScript string semantics. The TypeScript reference measures and slices
// strings in UTF-16 code units and trims JavaScript whitespace; these helpers
// reproduce that so lengths, cuts, and caps match byte for byte. A cut that
// splits a surrogate pair leaves a lone surrogate in JavaScript; Go strings
// cannot hold one, so it becomes U+FFFD (the same UTF-8 byte count).

import (
	"bytes"
	"encoding/json"
	"io"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Len16 is String.prototype.length: the UTF-16 code unit count.
func Len16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Units is the UTF-16 code units of s.
func Units(s string) []uint16 { return utf16Units(s) }

func utf16Units(s string) []uint16 { return utf16.Encode([]rune(s)) }

// Slice16 is s.slice(0, n) in UTF-16 code units.
func Slice16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	units := utf16Units(s)
	if n >= len(units) {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// IsJSSpace reports whether r is in JavaScript's \s class (WhiteSpace and
// LineTerminator), which String.prototype.trim also uses.
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Trim is String.prototype.trim.
func Trim(s string) string { return strings.TrimFunc(s, IsJSSpace) }

// TrimEnd is String.prototype.trimEnd.
func TrimEnd(s string) string { return strings.TrimRightFunc(s, IsJSSpace) }

// ToFixed is Number.prototype.toFixed for finite values below 1e21: the
// exact binary value rounds half away from zero (JavaScript picks the larger
// n on a tie), where strconv would round half to even.
func ToFixed(x float64, digits int) string {
	if x != x {
		return "NaN"
	}
	exact := new(big.Float).SetPrec(0).SetFloat64(x)
	text := exact.Text('f', 1100) // every finite float64 is exact in this many digits
	negative := strings.HasPrefix(text, "-")
	text = strings.TrimPrefix(text, "-")
	whole, frac, _ := strings.Cut(text, ".")
	for len(frac) < digits+1 {
		frac += "0"
	}
	keep := whole + frac[:digits]
	digitsOut := []byte(keep)
	if frac[digits] >= '5' {
		i := len(digitsOut) - 1
		for ; i >= 0; i-- {
			if digitsOut[i] == '9' {
				digitsOut[i] = '0'
				continue
			}
			digitsOut[i]++
			break
		}
		if i < 0 {
			digitsOut = append([]byte{'1'}, digitsOut...)
		}
	}
	out := string(digitsOut)
	intPart := out[:len(out)-digits]
	result := intPart
	if digits > 0 {
		result += "." + out[len(out)-digits:]
	}
	if negative && x != 0 {
		result = "-" + result
	}
	return result
}

// NumberString is String(n) for the numbers this port prints (integers and
// short decimals).
func NumberString(n float64) string {
	if n == float64(int64(n)) && n > -1e21 && n < 1e21 {
		return strconv.FormatInt(int64(n), 10)
	}
	return strconv.FormatFloat(n, 'g', -1, 64)
}

// Stringify is JSON.stringify of a raw JSON value: compact, key order kept,
// strings escaped as JavaScript does (only quotes, backslashes, and control
// characters; everything else literal). It returns "" for invalid JSON.
func Stringify(raw json.RawMessage) string { return StringifyIndent(raw, "") }

// StringifyIndent is JSON.stringify(value, null, indent) of a raw JSON value.
// An empty indent is the compact form. Empty objects and arrays print as {}
// and [] in both forms, as JavaScript does.
func StringifyIndent(raw json.RawMessage, indent string) string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var b strings.Builder
	w := &writer{b: &b, indent: indent}
	if err := w.value(dec, 0); err != nil {
		return ""
	}
	if _, err := dec.Token(); err != io.EOF {
		return ""
	}
	return b.String()
}

type writer struct {
	b      *strings.Builder
	indent string
}

func (w *writer) newline(depth int) {
	if w.indent == "" {
		return
	}
	w.b.WriteByte('\n')
	w.b.WriteString(strings.Repeat(w.indent, depth))
}

func (w *writer) value(dec *json.Decoder, depth int) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	b := w.b
	switch v := tok.(type) {
	case json.Delim:
		open, closing := byte('{'), byte('}')
		if v == '[' {
			open, closing = '[', ']'
		}
		b.WriteByte(open)
		first := true
		for dec.More() {
			if !first {
				b.WriteByte(',')
			}
			first = false
			w.newline(depth + 1)
			if open == '{' {
				key, err := dec.Token()
				if err != nil {
					return err
				}
				b.WriteString(QuoteJS(key.(string)))
				b.WriteByte(':')
				if w.indent != "" {
					b.WriteByte(' ')
				}
			}
			if err := w.value(dec, depth+1); err != nil {
				return err
			}
		}
		if _, err := dec.Token(); err != nil {
			return err
		}
		if !first {
			w.newline(depth)
		}
		b.WriteByte(closing)
	case string:
		b.WriteString(QuoteJS(v))
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			b.WriteString(v.String())
		} else {
			b.WriteString(jsNumber(f))
		}
	case bool:
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case nil:
		b.WriteString("null")
	}
	return nil
}

// NumberJS formats a number as JavaScript's Number::toString does.
func NumberJS(f float64) string { return jsNumber(f) }

// jsNumber formats a number as JavaScript's Number::toString does.
func jsNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	abs := f
	if abs < 0 {
		abs = -abs
	}
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		mantissa, exp, _ := strings.Cut(s, "e")
		sign := exp[0]
		exp = strings.TrimLeft(exp[1:], "0")
		return mantissa + "e" + string(sign) + exp
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// QuoteJS quotes s as JSON.stringify does.
func QuoteJS(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[r>>4])
				b.WriteByte("0123456789abcdef"[r&0xF])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// Truthy is JavaScript truthiness of a decoded JSON value.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && x == x
	case json.Number:
		f, err := x.Float64()
		return err != nil || (f != 0 && f == f)
	}
	return true
}

// Slice is s.slice(start, end) in UTF-16 code units, with JavaScript's
// negative-index and clamping rules. Pass end = Len16(s) for s.slice(start).
func Slice(s string, start, end int) string {
	units := utf16Units(s)
	n := len(units)
	clamp := func(i int) int {
		if i < 0 {
			i += n
			if i < 0 {
				return 0
			}
		}
		if i > n {
			return n
		}
		return i
	}
	start, end = clamp(start), clamp(end)
	if start >= end {
		return ""
	}
	return string(utf16.Decode(units[start:end]))
}

// SliceFrom is s.slice(start) in UTF-16 code units (negative counts from the end).
func SliceFrom(s string, start int) string { return Slice(s, start, Len16(s)) }

// CollapseSpace is s.replace(/\s+/g, " ").
func CollapseSpace(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if IsJSSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// IndexOf is s.indexOf(sub) in UTF-16 code units, or -1.
func IndexOf(s, sub string) int {
	i := strings.Index(s, sub)
	if i < 0 {
		return -1
	}
	return Len16(s[:i])
}
