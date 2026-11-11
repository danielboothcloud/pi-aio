package btw

// The JavaScript string helpers moved to go/internal/jsstr. These names stay
// for btw and its importers (goals).

import (
	"encoding/json"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Len16 is String.prototype.length: the UTF-16 code unit count.
func Len16(s string) int { return jsstr.Len16(s) }

// Slice16 is s.slice(0, n) in UTF-16 code units.
func Slice16(s string, n int) string { return jsstr.Slice16(s, n) }

// IsJSSpace reports whether r is in JavaScript's \s class.
func IsJSSpace(r rune) bool { return jsstr.IsJSSpace(r) }

// Trim is String.prototype.trim.
func Trim(s string) string { return jsstr.Trim(s) }

// TrimEnd is String.prototype.trimEnd.
func TrimEnd(s string) string { return jsstr.TrimEnd(s) }

// ToFixed is Number.prototype.toFixed.
func ToFixed(x float64, digits int) string { return jsstr.ToFixed(x, digits) }

// NumberString is String(n) for integers and short decimals.
func NumberString(n float64) string { return jsstr.NumberString(n) }

// Stringify is JSON.stringify of a raw JSON value.
func Stringify(raw json.RawMessage) string { return jsstr.Stringify(raw) }

// QuoteJS quotes s as JSON.stringify does.
func QuoteJS(s string) string { return jsstr.QuoteJS(s) }

// Truthy is JavaScript truthiness of a decoded JSON value.
func Truthy(v any) bool { return jsstr.Truthy(v) }

func utf16Units(s string) []uint16 { return jsstr.Units(s) }
