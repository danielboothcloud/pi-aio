// Package statusline is the Go port of status-line/: the aio.statusLine
// settings, the footer status row, the working message, and the provider
// usage (quota) fetcher. The PiG wiring is in go/aio/statusline.go.
package statusline

import (
	"bytes"
	"encoding/json"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Segments is STATUS_LINE_SEGMENTS.
var Segments = []string{"mode", "path", "git", "context", "effort", "statuses", "cursor", "quota", "model", "tokens", "cost"}

// UsageMapping is ProviderUsageMapping: dotted paths into the response.
type UsageMapping struct {
	Used             string `json:"used,omitempty"`
	Limit            string `json:"limit,omitempty"`
	Remaining        string `json:"remaining,omitempty"`
	UsedPercent      string `json:"usedPercent,omitempty"`
	RemainingPercent string `json:"remainingPercent,omitempty"`
	RenewsAt         string `json:"renewsAt,omitempty"`
	Text             string `json:"text,omitempty"`
}

func (m UsageMapping) empty() bool { return m == UsageMapping{} }

// UsageWindow is ProviderUsageWindowConfig plus its name (the windows
// object keeps JavaScript key order in Go as a slice).
type UsageWindow struct {
	Name    string       `json:"name"`
	Label   string       `json:"label,omitempty"`
	Mapping UsageMapping `json:"mapping"`
}

// EndpointConfig is ProviderUsageEndpointConfig.
type EndpointConfig struct {
	Endpoint          string            `json:"endpoint"`
	Label             string            `json:"label,omitempty"`
	Headers           map[string]string `json:"headers"`
	Auth              string            `json:"auth,omitempty"`
	AuthAccount       string            `json:"authAccount,omitempty"`
	RefreshIntervalMs *float64          `json:"refreshIntervalMs,omitempty"`
	Mapping           *UsageMapping     `json:"mapping,omitempty"`
	Windows           []UsageWindow     `json:"windows,omitempty"`
}

// UsageConfig is ProviderUsageConfig.
type UsageConfig struct {
	RefreshIntervalMs float64                   `json:"refreshIntervalMs"`
	TimeoutMs         float64                   `json:"timeoutMs"`
	Providers         map[string]EndpointConfig `json:"providers"`
}

// Config is StatusLineConfig. StatusKeys nil is absent.
type Config struct {
	Enabled        bool         `json:"enabled"`
	Segments       []string     `json:"segments"`
	Path           string       `json:"path"`
	WorkingMessage string       `json:"workingMessage"`
	StatusKeys     []string     `json:"statusKeys,omitempty"`
	ProviderUsage  *UsageConfig `json:"providerUsage,omitempty"`
}

// HasSegment reports whether segment is configured.
func (c Config) HasSegment(segment string) bool {
	for _, s := range c.Segments {
		if s == segment {
			return true
		}
	}
	return false
}

// DefaultConfig returns DEFAULT_STATUS_LINE_CONFIG.
func DefaultConfig() Config {
	return Config{
		Enabled:        true,
		Segments:       []string{"mode", "path", "git", "context", "effort", "statuses", "cursor", "quota", "model"},
		Path:           "basename",
		WorkingMessage: "minimal",
	}
}

const (
	defaultUsageRefreshIntervalMs = 60_000
	defaultUsageTimeoutMs         = 5_000
)

var (
	validPath    = map[string]bool{"basename": true, "abbreviated": true, "full": true}
	validWorking = map[string]bool{"minimal": true, "verbose": true, "off": true}
)

func validSegment(s string) bool {
	for _, v := range Segments {
		if v == s {
			return true
		}
	}
	return false
}

// kv is one key of a JSON object in JavaScript key order.
type kv struct {
	key   string
	value json.RawMessage
}

// orderedObject decodes a JSON object with its keys in JavaScript
// property order (integer keys ascending first, then insertion order; a
// repeated key keeps its first position with the last value). ok is false
// for a non-object.
func orderedObject(raw json.RawMessage) ([]kv, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, false
	}
	var out []kv
	index := map[string]int{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, false
		}
		if i, ok := index[key]; ok {
			out[i].value = value
			continue
		}
		index[key] = len(out)
		out = append(out, kv{key, value})
	}
	sort.SliceStable(out, func(i, j int) bool {
		ai, aok := arrayIndex(out[i].key)
		bi, bok := arrayIndex(out[j].key)
		if aok && bok {
			return ai < bi
		}
		return aok && !bok
	})
	return out, true
}

func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 32)
	if err != nil || n == math.MaxUint32 {
		return 0, false
	}
	return n, true
}

func lookup(obj []kv, key string) (json.RawMessage, bool) {
	for _, e := range obj {
		if e.key == key {
			return e.value, true
		}
	}
	return nil, false
}

func asString(raw json.RawMessage) (string, bool) {
	var s string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

func asNumber(raw json.RawMessage) (float64, bool) {
	var f float64
	if len(raw) == 0 || !(raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) || json.Unmarshal(raw, &f) != nil {
		return 0, false
	}
	return f, true
}

func asBool(raw json.RawMessage) (bool, bool) {
	switch string(raw) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

func asArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	return items, true
}

// isObject is `typeof value === "object" && value !== null` (arrays too).
func isObject(raw json.RawMessage) bool {
	return len(raw) > 0 && (raw[0] == '{' || raw[0] == '[')
}

func nonEmptyString(raw json.RawMessage) string {
	s, ok := asString(raw)
	if !ok {
		return ""
	}
	return jsstr.Trim(s)
}

// boundedNumber is boundedNumber: a finite number clamped and rounded.
func boundedNumber(raw json.RawMessage, minimum, maximum float64) *float64 {
	f, ok := asNumber(raw)
	if !ok || math.IsInf(f, 0) || math.IsNaN(f) {
		return nil
	}
	v := math.Min(maximum, math.Max(minimum, math.Floor(f+0.5)))
	return &v
}

var mappingKeys = []string{"used", "limit", "remaining", "usedPercent", "remainingPercent", "renewsAt", "text"}

func parseUsageMapping(raw json.RawMessage) *UsageMapping {
	obj, ok := orderedObject(raw)
	if !ok {
		return nil
	}
	var m UsageMapping
	fields := map[string]*string{"used": &m.Used, "limit": &m.Limit, "remaining": &m.Remaining, "usedPercent": &m.UsedPercent, "remainingPercent": &m.RemainingPercent, "renewsAt": &m.RenewsAt, "text": &m.Text}
	for _, key := range mappingKeys {
		value, _ := lookup(obj, key)
		if path := nonEmptyString(value); path != "" {
			*fields[key] = path
		}
	}
	if m.empty() {
		return nil
	}
	return &m
}

func validEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return scheme == "http" || scheme == "https"
}

type parsedUsage struct {
	refreshIntervalMs *float64
	timeoutMs         *float64
	providers         []kv // provider id → EndpointConfig JSON, in order
	parsed            map[string]EndpointConfig
}

func parseProviderUsage(raw json.RawMessage) *parsedUsage {
	block, ok := orderedObject(raw)
	if !ok {
		return nil
	}
	providersRaw, _ := lookup(block, "providers")
	if !isObject(providersRaw) {
		return nil
	}
	out := &parsedUsage{parsed: map[string]EndpointConfig{}}
	providers, _ := orderedObject(providersRaw)
	for _, p := range providers {
		id := jsstr.Trim(p.key)
		if id == "" || !isObject(p.value) {
			continue
		}
		entry, _ := orderedObject(p.value)
		endpointRaw, _ := lookup(entry, "endpoint")
		endpoint := nonEmptyString(endpointRaw)
		if endpoint == "" || !validEndpoint(endpoint) {
			continue
		}
		var windows []UsageWindow
		if windowsRaw, ok := lookup(entry, "windows"); ok && isObject(windowsRaw) {
			list, _ := orderedObject(windowsRaw)
			for _, w := range list {
				if jsstr.Trim(w.key) == "" || !isObject(w.value) {
					continue
				}
				window, _ := orderedObject(w.value)
				mappingRaw, _ := lookup(window, "mapping")
				mapping := parseUsageMapping(mappingRaw)
				if mapping == nil {
					continue
				}
				labelRaw, _ := lookup(window, "label")
				replaced := false
				for i := range windows {
					if windows[i].Name == w.key {
						windows[i] = UsageWindow{Name: w.key, Label: nonEmptyString(labelRaw), Mapping: *mapping}
						replaced = true
					}
				}
				if !replaced {
					windows = append(windows, UsageWindow{Name: w.key, Label: nonEmptyString(labelRaw), Mapping: *mapping})
				}
			}
		}
		var mapping *UsageMapping
		if len(windows) == 0 {
			mappingRaw, _ := lookup(entry, "mapping")
			mapping = parseUsageMapping(mappingRaw)
		}
		if mapping == nil && len(windows) == 0 {
			continue
		}
		headers := map[string]string{}
		if headersRaw, ok := lookup(entry, "headers"); ok && isObject(headersRaw) {
			list, _ := orderedObject(headersRaw)
			for _, h := range list {
				name := jsstr.Trim(h.key)
				if value := nonEmptyString(h.value); name != "" && value != "" {
					headers[name] = value
				}
			}
		}
		authRaw, _ := lookup(entry, "auth")
		auth := ""
		if s, _ := asString(authRaw); s == "pi-oauth" {
			auth = "pi-oauth"
		}
		accountRaw, _ := lookup(entry, "authAccount")
		refreshRaw, _ := lookup(entry, "refreshIntervalMs")
		labelRaw, _ := lookup(entry, "label")
		if _, exists := out.parsed[id]; !exists {
			out.providers = append(out.providers, kv{key: id})
		}
		out.parsed[id] = EndpointConfig{
			Endpoint:          endpoint,
			Label:             nonEmptyString(labelRaw),
			Headers:           headers,
			Auth:              auth,
			AuthAccount:       nonEmptyString(accountRaw),
			RefreshIntervalMs: boundedNumber(refreshRaw, 5_000, 86_400_000),
			Mapping:           mapping,
			Windows:           windows,
		}
	}
	refreshRaw, _ := lookup(block, "refreshIntervalMs")
	out.refreshIntervalMs = boundedNumber(refreshRaw, 5_000, 86_400_000)
	timeoutRaw, _ := lookup(block, "timeoutMs")
	out.timeoutMs = boundedNumber(timeoutRaw, 500, 30_000)
	return out
}

type parsedBlock struct {
	enabled        *bool
	segments       []string
	hasSegments    bool
	path           string
	workingMessage string
	statusKeys     []string
	hasStatusKeys  bool
	providerUsage  *parsedUsage
}

func normalizeSegments(items []json.RawMessage) []string {
	var segments []string
	for _, item := range items {
		if s, ok := asString(item); ok && validSegment(s) {
			segments = append(segments, s)
		}
	}
	if len(segments) == 0 {
		return DefaultConfig().Segments
	}
	return segments
}

func parseBlock(raw json.RawMessage) parsedBlock {
	var next parsedBlock
	block, ok := orderedObject(raw)
	if !ok {
		return next
	}
	if v, ok := lookup(block, "enabled"); ok {
		if b, ok := asBool(v); ok {
			next.enabled = &b
		}
	}
	if v, ok := lookup(block, "segments"); ok {
		if items, ok := asArray(v); ok {
			next.segments, next.hasSegments = normalizeSegments(items), true
		}
	}
	if v, ok := lookup(block, "path"); ok {
		if s, ok := asString(v); ok && validPath[s] {
			next.path = s
		}
	}
	if v, ok := lookup(block, "workingMessage"); ok {
		if s, ok := asString(v); ok && validWorking[s] {
			next.workingMessage = s
		}
	}
	if v, ok := lookup(block, "statusKeys"); ok {
		if items, ok := asArray(v); ok {
			next.statusKeys, next.hasStatusKeys = []string{}, true
			for _, item := range items {
				if s, ok := asString(item); ok && s != "" {
					next.statusKeys = append(next.statusKeys, s)
				}
			}
		}
	}
	if v, ok := lookup(block, "providerUsage"); ok {
		next.providerUsage = parseProviderUsage(v)
	}
	return next
}

// LoadOptions are loadStatusLineConfig's options. AgentDir replaces
// getAgentDir() (and globalDir); ConfigDirName is CONFIG_DIR_NAME.
type LoadOptions struct {
	ExcludeGlobal  bool
	ExcludeProject bool
	AgentDir       string
	ConfigDirName  string
}

func readSettings(path string) []kv {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if !json.Valid(data) {
		return nil
	}
	obj, _ := orderedObject(data)
	return obj
}

// Load is loadStatusLineConfig: aio.statusLine from the global settings,
// then the project settings (when included), merged.
func Load(cwd string, o LoadOptions) Config {
	var paths []string
	if !o.ExcludeGlobal {
		paths = append(paths, filepath.Join(o.AgentDir, "settings.json"))
	}
	if cwd != "" && !o.ExcludeProject {
		paths = append(paths, filepath.Join(cwd, o.ConfigDirName, "settings.json"))
	}
	config := DefaultConfig()
	var usage *parsedUsage
	for _, path := range paths {
		settings := readSettings(path)
		aioRaw, ok := lookup(settings, "aio")
		if !ok || !isObject(aioRaw) {
			continue
		}
		aio, _ := orderedObject(aioRaw)
		statusRaw, _ := lookup(aio, "statusLine")
		next := parseBlock(statusRaw)
		if next.enabled != nil {
			config.Enabled = *next.enabled
		}
		if next.hasSegments {
			config.Segments = next.segments
		}
		if next.path != "" {
			config.Path = next.path
		}
		if next.workingMessage != "" {
			config.WorkingMessage = next.workingMessage
		}
		if next.hasStatusKeys {
			config.StatusKeys = next.statusKeys
		}
		if p := next.providerUsage; p != nil {
			if usage == nil {
				usage = &parsedUsage{parsed: map[string]EndpointConfig{}}
			}
			if p.refreshIntervalMs != nil {
				usage.refreshIntervalMs = p.refreshIntervalMs
			}
			if p.timeoutMs != nil {
				usage.timeoutMs = p.timeoutMs
			}
			for _, id := range p.providers {
				if _, exists := usage.parsed[id.key]; !exists {
					usage.providers = append(usage.providers, id)
				}
				usage.parsed[id.key] = p.parsed[id.key]
			}
		}
	}
	if usage != nil {
		pu := &UsageConfig{RefreshIntervalMs: defaultUsageRefreshIntervalMs, TimeoutMs: defaultUsageTimeoutMs, Providers: usage.parsed}
		if usage.refreshIntervalMs != nil {
			pu.RefreshIntervalMs = *usage.refreshIntervalMs
		}
		if usage.timeoutMs != nil {
			pu.TimeoutMs = *usage.timeoutMs
		}
		config.ProviderUsage = pu
	}
	return config
}

// UnmarshalJSON reads a recorded EndpointConfig whose windows are a JSON
// object, keeping JavaScript key order.
func (c *EndpointConfig) UnmarshalJSON(data []byte) error {
	type plain EndpointConfig
	var aux struct {
		plain
		Windows json.RawMessage `json:"windows"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*c = EndpointConfig(aux.plain)
	c.Windows = nil
	if len(aux.Windows) > 0 && aux.Windows[0] == '[' {
		return json.Unmarshal(aux.Windows, &c.Windows)
	}
	list, _ := orderedObject(aux.Windows)
	for _, w := range list {
		var window UsageWindow
		if err := json.Unmarshal(w.value, &window); err != nil {
			return err
		}
		window.Name = w.key
		c.Windows = append(c.Windows, window)
	}
	return nil
}
