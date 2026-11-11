package statusline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ProviderUsage is ProviderUsage. Optional numbers are pointers.
type ProviderUsage struct {
	Provider         string   `json:"provider"`
	Label            string   `json:"label"`
	Used             *float64 `json:"used,omitempty"`
	Limit            *float64 `json:"limit,omitempty"`
	Remaining        *float64 `json:"remaining,omitempty"`
	RemainingPercent *float64 `json:"remainingPercent,omitempty"`
	RenewsAt         string   `json:"renewsAt,omitempty"`
	Text             string   `json:"text,omitempty"`
}

// Windows is providerUsageWindows: the named windows, or the single
// mapping as "default".
func Windows(c EndpointConfig) []UsageWindow {
	if len(c.Windows) > 0 {
		out := make([]UsageWindow, len(c.Windows))
		for i, w := range c.Windows {
			label := w.Label
			if label == "" {
				label = c.Label
			}
			out[i] = UsageWindow{Name: w.Name, Label: label, Mapping: w.Mapping}
		}
		return out
	}
	if c.Mapping != nil {
		return []UsageWindow{{Name: "default", Label: c.Label, Mapping: *c.Mapping}}
	}
	return nil
}

// readScalarPath is readScalarPath over a decoded JSON value: own
// properties only (array indexes and length included).
func readScalarPath(value any, path string) any {
	current := value
	for _, part := range strings.Split(path, ".") {
		if part == "" || part == "__proto__" || part == "prototype" || part == "constructor" {
			return nil
		}
		switch v := current.(type) {
		case map[string]any:
			next, ok := v[part]
			if !ok {
				return nil
			}
			current = next
		case []any:
			if part == "length" {
				current = float64(len(v))
				continue
			}
			i, ok := arrayIndex(part)
			if !ok || int(i) >= len(v) {
				return nil
			}
			current = v[i]
		default:
			return nil
		}
	}
	switch current.(type) {
	case string, float64:
		return current
	}
	return nil
}

// jsNumber is Number(string) for finite decimal, hex, octal, and binary
// forms; ok is false for NaN.
func jsNumber(s string) (float64, bool) {
	t := strings.TrimFunc(s, jsstr.IsJSSpace)
	if t == "" {
		return 0, true
	}
	lower := strings.ToLower(t)
	for prefix, base := range map[string]int{"0x": 16, "0o": 8, "0b": 2} {
		if strings.HasPrefix(lower, prefix) {
			n, err := strconv.ParseUint(t[2:], base, 64)
			if err != nil || strings.Contains(t, "_") {
				return 0, false
			}
			return float64(n), true
		}
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	}
	if strings.ContainsAny(lower, "_xpin") {
		return 0, false
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func finiteNumber(v any) *float64 {
	switch x := v.(type) {
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			return &x
		}
	case string:
		if jsstr.Trim(x) != "" {
			if f, ok := jsNumber(x); ok && !math.IsInf(f, 0) && !math.IsNaN(f) {
				return &f
			}
		}
	}
	return nil
}

func stringValue(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return jsstr.Trim(s)
}

var envTemplate = regexp.MustCompile(`\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)

// ResolveEnvironmentTemplate is resolveEnvironmentTemplate: $VAR and
// ${VAR}; ok is false when a variable is missing.
func ResolveEnvironmentTemplate(value string, getenv func(string) (string, bool)) (string, bool) {
	missing := false
	out := envTemplate.ReplaceAllStringFunc(value, func(match string) string {
		if match == "$$" {
			return "$"
		}
		m := envTemplate.FindStringSubmatch(match)
		name := m[1]
		if name == "" {
			name = m[2]
		}
		v, ok := getenv(name)
		if !ok {
			missing = true
			return ""
		}
		return v
	})
	return out, !missing
}

func roundPercent(v float64) *float64 {
	r := math.Max(0, math.Min(100, math.Floor(v+0.5)))
	return &r
}

// MapProviderUsage is mapProviderUsage; nil when the payload has none of
// the mapped values.
func MapProviderUsage(provider, label string, m UsageMapping, payload any) *ProviderUsage {
	read := func(path string) any {
		if path == "" {
			return nil
		}
		return readScalarPath(payload, path)
	}
	used := finiteNumber(read(m.Used))
	limit := finiteNumber(read(m.Limit))
	remaining := finiteNumber(read(m.Remaining))
	if remaining == nil && limit != nil && used != nil {
		r := *limit - *used
		remaining = &r
	}
	usedPercent := finiteNumber(read(m.UsedPercent))
	remainingPercentInput := finiteNumber(read(m.RemainingPercent))
	text := stringValue(read(m.Text))
	renewsAt := stringValue(read(m.RenewsAt))
	if used == nil && limit == nil && remaining == nil && usedPercent == nil && remainingPercentInput == nil && text == "" {
		return nil
	}
	var remainingPercent *float64
	switch {
	case remaining != nil && limit != nil && *limit > 0:
		remainingPercent = roundPercent(*remaining / *limit * 100)
	case remainingPercentInput != nil:
		remainingPercent = roundPercent(*remainingPercentInput)
	case usedPercent != nil:
		remainingPercent = roundPercent(100 - *usedPercent)
	}
	if label == "" {
		label = provider
	}
	return &ProviderUsage{Provider: provider, Label: label, Used: used, Limit: limit, Remaining: remaining, RemainingPercent: remainingPercent, RenewsAt: renewsAt, Text: text}
}

// ReadPiOAuthToken is readPiOAuthToken: the OAuth access token of account
// in <agentDir>/auth.json; "" for API keys and missing files.
func ReadPiOAuthToken(account, agentDir string) string {
	data, err := os.ReadFile(filepath.Join(agentDir, "auth.json"))
	if err != nil {
		return ""
	}
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return ""
	}
	entry, _ := raw[account].(map[string]any)
	if entry["type"] != "oauth" {
		return ""
	}
	token, _ := entry["access"].(string)
	if jsstr.Trim(token) == "" {
		return ""
	}
	return token
}

// Response is an HTTP response as fetchProviderUsage reads it.
type Response struct {
	Status int
	Body   []byte
}

// FetchDeps are fetchProviderUsage's seams: request (fetch), getenv, and
// the OAuth token resolver.
type FetchDeps struct {
	Request      func(ctx context.Context, method, url string, headers map[string]string) (Response, error)
	Getenv       func(string) (string, bool)
	ResolveToken func(account string) string
}

// FetchProviderUsage is fetchProviderUsage. Header names are iterated in
// sorted order for the missing-variable error (TypeScript uses insertion
// order).
func FetchProviderUsage(ctx context.Context, provider string, c EndpointConfig, timeoutMs float64, deps FetchDeps) ([]ProviderUsage, error) {
	headers := map[string]string{}
	for _, name := range sortedKeys(c.Headers) {
		value, ok := ResolveEnvironmentTemplate(c.Headers[name], deps.Getenv)
		if !ok {
			return nil, fmt.Errorf("Missing environment variable for provider usage header %s", name)
		}
		headers[name] = value
	}
	if c.Auth == "pi-oauth" {
		account := c.AuthAccount
		if account == "" {
			account = provider
		}
		token := deps.ResolveToken(account)
		if token == "" {
			return nil, fmt.Errorf("No pi OAuth token for provider %s", account)
		}
		if _, ok := headers["Authorization"]; !ok {
			headers["Authorization"] = "Bearer " + token
		}
		if _, ok := headers["anthropic-beta"]; !ok {
			headers["anthropic-beta"] = "oauth-2025-04-20"
		}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	response, err := deps.Request(ctx, "GET", c.Endpoint, headers)
	if err != nil {
		return nil, err
	}
	if response.Status < 200 || response.Status > 299 {
		return nil, fmt.Errorf("Provider usage request failed with HTTP %d", response.Status)
	}
	var payload any
	if err := json.Unmarshal(response.Body, &payload); err != nil {
		return nil, errors.New("invalid JSON")
	}
	var out []ProviderUsage
	for _, w := range Windows(c) {
		if u := MapProviderUsage(provider, w.Label, w.Mapping, payload); u != nil {
			out = append(out, *u)
		}
	}
	return out, nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

var whitespaceRun = regexp.MustCompile(`[\s\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

func sanitizeDisplayText(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r < 32 || (r >= 127 && r <= 159) {
			b.WriteByte(' ')
			continue
		}
		b.WriteRune(r)
	}
	return jsstr.Trim(whitespaceRun.ReplaceAllString(b.String(), " "))
}

// ParseDate is Date.parse for the ISO 8601 forms usage endpoints send.
func ParseDate(value string) (float64, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04Z07:00", time.RFC1123, time.RFC1123Z} {
		if t, err := time.Parse(layout, value); err == nil {
			return float64(t.UnixMilli()), true
		}
	}
	if t, err := time.Parse("2006-01-02", value); err == nil {
		return float64(t.UnixMilli()), true
	}
	return 0, false
}

func formatReset(renewsAt string, now float64) string {
	if renewsAt == "" {
		return ""
	}
	timestamp, ok := ParseDate(renewsAt)
	if !ok {
		return ""
	}
	remaining := timestamp - now
	if remaining <= 0 {
		return "→now"
	}
	minutes := math.Ceil(remaining / 60_000)
	if minutes < 60 {
		return "→" + strconv.Itoa(int(minutes)) + "m"
	}
	hours := math.Ceil(minutes / 60)
	if hours < 48 {
		return "→" + strconv.Itoa(int(hours)) + "h"
	}
	return "→" + strconv.Itoa(int(math.Ceil(hours/24))) + "d"
}

// FormatProviderUsage is formatProviderUsage at now (epoch ms).
func FormatProviderUsage(u ProviderUsage, now float64) string {
	var value string
	switch {
	case u.Text != "":
		value = sanitizeDisplayText(u.Text)
	case u.RemainingPercent != nil:
		value = jsstr.NumberJS(*u.RemainingPercent) + "%"
	case u.Remaining != nil:
		value = jsstr.NumberJS(*u.Remaining)
	case u.Used != nil && u.Limit != nil:
		value = jsstr.NumberJS(*u.Used) + "/" + jsstr.NumberJS(*u.Limit)
	case u.Used == nil:
		limit := "undefined"
		if u.Limit != nil {
			limit = jsstr.NumberJS(*u.Limit)
		}
		value = "limit " + limit
	default:
		value = jsstr.NumberJS(*u.Used) + " used"
	}
	out := sanitizeDisplayText(u.Label) + " " + value
	if reset := formatReset(u.RenewsAt, now); reset != "" {
		out += " " + reset
	}
	return out
}

// UsageLine is providerUsageLine: every window in one compact line and
// its theme role; ok is false for no windows.
func UsageLine(usages []ProviderUsage, now float64) (text, role string, ok bool) {
	if len(usages) == 0 {
		return "", "", false
	}
	var lowest *float64
	for _, u := range usages {
		if u.RemainingPercent != nil && (lowest == nil || *u.RemainingPercent < *lowest) {
			v := *u.RemainingPercent
			lowest = &v
		}
	}
	role = "muted"
	if lowest != nil && *lowest <= 20 {
		role = "error"
	} else if lowest != nil && *lowest <= 50 {
		role = "warning"
	}
	parts := make([]string, len(usages))
	for i, u := range usages {
		parts[i] = FormatProviderUsage(u, now)
	}
	return strings.Join(parts, " · "), role, true
}

// Now is Date.now() for the wiring.
func Now() float64 { return nowMs() }
