package browsersearch

// Runtime configuration (port of browser-search/config.ts and
// cloak-settings.ts): the environment constants and the aio.browserSearch
// section of Pi settings.

import (
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Env holds the module constants that config.ts and cloak-settings.ts read
// from the environment when they load.
type Env struct {
	SearxngBase        string `json:"searxngBase"`
	ExaBase            string `json:"exaBase"`
	CamofoxBase        string `json:"camofoxBase"`
	CamofoxAPIKey      string `json:"camofoxApiKey"`
	CamofoxUserID      string `json:"camofoxUserId"`
	CamofoxAutoRestart bool   `json:"camofoxAutoRestart"`
	CamofoxRestartCmd  string `json:"camofoxRestartCmd"`
	Debug              bool   `json:"debug"`
	CloakMaxChars      int    `json:"cloakMaxChars"`
	SearxngTimeoutMs   int    `json:"searxngTimeoutMs"`
	ExaTimeoutMs       int    `json:"exaTimeoutMs"`
	CamofoxTimeoutMs   int    `json:"camofoxTimeoutMs"`
	MaxInlineContent   int    `json:"maxInlineContent"`
	// NodeBinary is BROWSER_SEARCH_NODE_BINARY ("" when unset).
	NodeBinary string `json:"-"`
}

// LookupEnv is os.LookupEnv.
type LookupEnv func(string) (string, bool)

var enabledRE = regexp.MustCompile(`(?i)^(1|true|yes)$`)
var decimalRE = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsNumberString is Number(text) for a string.
func jsNumberString(text string) float64 {
	t := jsstr.Trim(text)
	if t == "" {
		return 0
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			digits := t[2:]
			f := 0.0
			for _, r := range digits {
				d, err := strconv.ParseInt(string(r), base, 64)
				if err != nil {
					return math.NaN()
				}
				f = f*float64(base) + float64(d)
			}
			return f
		}
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if !decimalRE.MatchString(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

const maxSafeInteger = 9007199254740991

func safePositive(n float64) bool {
	return n > 0 && n <= maxSafeInteger && n == math.Trunc(n)
}

// positiveInteger is config.ts positiveInteger.
func positiveInteger(value string, set bool, fallback int) int {
	if !set || jsstr.Trim(value) == "" {
		return fallback
	}
	if n := jsNumberString(value); safePositive(n) {
		return int(n)
	}
	return fallback
}

var trailingSlashes = regexp.MustCompile(`/+$`)

// endpoint is config.ts endpoint.
func endpoint(value string, set bool, fallback string) string {
	v := ""
	if set {
		v = jsstr.Trim(value)
	}
	if v == "" {
		v = fallback
	}
	return trailingSlashes.ReplaceAllString(v, "")
}

// LoadEnv reads the constants as config.ts and cloak-settings.ts do.
func LoadEnv(lookup LookupEnv) Env {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	first := func(keys ...string) (string, bool) {
		for _, k := range keys {
			if v, ok := lookup(k); ok {
				return v, true
			}
		}
		return "", false
	}
	var e Env
	v, ok := first("BROWSER_SEARCH_SEARXNG_BASE", "SEARXNG_BASE")
	e.SearxngBase = endpoint(v, ok, "http://localhost:8080")
	v, ok = lookup("BROWSER_SEARCH_EXA_BASE")
	e.ExaBase = endpoint(v, ok, "https://api.exa.ai")
	v, ok = first("BROWSER_SEARCH_CAMOFOX_BASE", "CAMOFOX_BASE")
	e.CamofoxBase = endpoint(v, ok, "http://localhost:9377")
	e.CamofoxAPIKey, _ = lookup("CAMOFOX_API_KEY")
	if v, ok := lookup("CAMOFOX_USER_ID"); ok {
		e.CamofoxUserID = v
	} else {
		e.CamofoxUserID = "pi-bot"
	}
	v, _ = lookup("BROWSER_SEARCH_CAMOFOX_AUTO_RESTART")
	e.CamofoxAutoRestart = enabledRE.MatchString(v)
	v, _ = lookup("BROWSER_SEARCH_CAMOFOX_RESTART_CMD")
	e.CamofoxRestartCmd = jsstr.Trim(v)
	v, _ = lookup("BROWSER_SEARCH_DEBUG")
	e.Debug = enabledRE.MatchString(v)
	e.CloakMaxChars = 100_000
	if v, ok := lookup("BROWSER_SEARCH_CLOAK_MAX_CHARS"); ok {
		if n := jsNumberString(v); safePositive(n) {
			e.CloakMaxChars = int(n)
		}
	}
	v, ok = lookup("BROWSER_SEARCH_SEARXNG_TIMEOUT_MS")
	e.SearxngTimeoutMs = positiveInteger(v, ok, 20_000)
	v, ok = lookup("BROWSER_SEARCH_EXA_TIMEOUT_MS")
	e.ExaTimeoutMs = positiveInteger(v, ok, 20_000)
	v, ok = lookup("BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS")
	e.CamofoxTimeoutMs = positiveInteger(v, ok, 30_000)
	v, ok = lookup("BROWSER_SEARCH_MAX_INLINE_CONTENT")
	e.MaxInlineContent = positiveInteger(v, ok, 40_000)
	e.NodeBinary, _ = lookup("BROWSER_SEARCH_NODE_BINARY")
	return e
}

// ProviderConfig is BrowserSearchConfig. Absent values are "".
type ProviderConfig struct {
	Provider string
	Searxng  struct{ BaseURL *string }
	Exa      struct {
		BaseURL               *string
		APIKeyEnv, SearchType string
	}
}

// MarshalJSON writes the shape JSON.stringify gives the TypeScript config.
func (c ProviderConfig) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	if c.Provider != "" {
		b.WriteString(`"provider":` + jsstr.QuoteJS(c.Provider) + ",")
	}
	b.WriteString(`"searxng":{`)
	if c.Searxng.BaseURL != nil {
		b.WriteString(`"baseUrl":` + jsstr.QuoteJS(*c.Searxng.BaseURL))
	}
	b.WriteString(`},"exa":{`)
	var parts []string
	if c.Exa.BaseURL != nil {
		parts = append(parts, `"baseUrl":`+jsstr.QuoteJS(*c.Exa.BaseURL))
	}
	for _, kv := range [][2]string{{"apiKeyEnv", c.Exa.APIKeyEnv}, {"searchType", c.Exa.SearchType}} {
		if kv[1] != "" {
			parts = append(parts, `"`+kv[0]+`":`+jsstr.QuoteJS(kv[1]))
		}
	}
	b.WriteString(strings.Join(parts, ","))
	b.WriteString("}}")
	return []byte(b.String()), nil
}

func plainObject(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func optionalString(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return jsstr.Trim(s)
}

func browserSearchSection(settings map[string]any) map[string]any {
	if m := plainObject(get(plainObject(settings["aio"]), "browserSearch")); m != nil {
		return m
	}
	return map[string]any{}
}

var validSearchTypes = map[string]bool{
	"auto": true, "keyword": true, "neural": true, "hybrid": true, "fast": true,
	"instant": true, "deep-lite": true, "deep": true, "deep-reasoning": true,
}

// ResolveConfig is resolveBrowserSearchConfig: project values override and
// extend global ones.
func ResolveConfig(global, project map[string]any) ProviderConfig {
	g, p := browserSearchSection(global), browserSearchSection(project)
	provider, ok := p["provider"]
	if !ok || provider == nil {
		provider = g["provider"]
	}
	merge := func(key string) map[string]any {
		out := map[string]any{}
		for k, v := range plainObject(g[key]) {
			out[k] = v
		}
		for k, v := range plainObject(p[key]) {
			out[k] = v
		}
		return out
	}
	searxng, exa := merge("searxng"), merge("exa")
	var c ProviderConfig
	if provider == "searxng" || provider == "exa" {
		c.Provider = provider.(string)
	}
	c.Searxng.BaseURL = baseURLSetting(searxng["baseUrl"])
	c.Exa.BaseURL = baseURLSetting(exa["baseUrl"])
	c.Exa.APIKeyEnv = optionalString(exa["apiKeyEnv"])
	if st := optionalString(exa["searchType"]); validSearchTypes[st] {
		c.Exa.SearchType = st
	}
	return c
}

// baseURLSetting is optionalString(value)?.replace(/\/+$/, ""): nil when
// unset, "" when the value was only slashes.
func baseURLSetting(v any) *string {
	s := optionalString(v)
	if s == "" {
		return nil
	}
	s = trailingSlashes.ReplaceAllString(s, "")
	return &s
}

// readSettings is config.ts readSettings: a missing file is {}, an invalid
// one is {} plus a stderr line.
func readSettings(path string, stderr io.Writer) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	v, err := parseJS(validUTF8(data))
	if err != nil {
		if stderr != nil {
			fmt.Fprintf(stderr, "[browser-search] Invalid Pi settings at %s: %s\n", path, err.Error())
		}
		return map[string]any{}
	}
	if m := plainObject(v); m != nil {
		return m
	}
	return map[string]any{}
}

// LoadConfig is loadBrowserSearchConfig: <agentDir>/settings.json plus the
// trusted project's <cwd>/<configDir>/settings.json.
func LoadConfig(agentDir, configDir, cwd string, projectTrusted bool, stderr io.Writer) ProviderConfig {
	global := readSettings(filepath.Join(agentDir, "settings.json"), stderr)
	project := map[string]any{}
	if projectTrusted {
		project = readSettings(filepath.Join(cwd, configDir, "settings.json"), stderr)
	}
	return ResolveConfig(global, project)
}
