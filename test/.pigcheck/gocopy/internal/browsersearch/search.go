package browsersearch

// Search adapters: SearXNG (port of browser-search/searxng.ts
// searxngSearch) and Exa (port of browser-search/exa.ts exaSearch). Both
// return the shared normalized SearchOutcome.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// SearchOptions is types.ts SearchOptions. Nil pointers are undefined.
type SearchOptions struct {
	Lang           *string  `json:"lang,omitempty"`
	Categories     *string  `json:"categories,omitempty"`
	TimeRange      *string  `json:"timeRange,omitempty"`
	Engines        *string  `json:"engines,omitempty"`
	Page           *int     `json:"page,omitempty"`
	NumResults     *int     `json:"numResults,omitempty"`
	IncludeDomains []string `json:"includeDomains"`
	ExcludeDomains []string `json:"excludeDomains"`
	BaseURL        *string  `json:"baseUrl,omitempty"`
}

// SearchResult is one normalized hit. The optional fields keep the JSON
// value the backend sent (nil is null).
type SearchResult struct {
	Title         any    `json:"title"`
	URL           string `json:"url"`
	Snippet       any    `json:"snippet"`
	Engine        any    `json:"engine"`
	Category      any    `json:"category"`
	PublishedDate any    `json:"publishedDate"`
}

// SearchParameters is SearchOutcome.parameters.
type SearchParameters struct {
	Lang       *string `json:"lang"`
	Categories *string `json:"categories"`
	TimeRange  *string `json:"timeRange"`
	Engines    *string `json:"engines"`
	Page       int     `json:"page"`
}

// SearchOutcome is types.ts SearchOutcome.
type SearchOutcome struct {
	OK          bool             `json:"ok"`
	Query       string           `json:"query"`
	Parameters  SearchParameters `json:"parameters"`
	ResultCount int              `json:"resultCount"`
	Results     []SearchResult   `json:"results"`
}

func ptr[T any](v T) *T { return &v }

// formEncode is URLSearchParams serialization of one value.
func formEncode(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

type queryParams [][2]string

func (q queryParams) String() string {
	parts := make([]string, len(q))
	for i, kv := range q {
		parts[i] = formEncode(kv[0]) + "=" + formEncode(kv[1])
	}
	return strings.Join(parts, "&")
}

func nonEmpty(p *string) bool { return p != nil && *p != "" }

// iterate is `for (const x of value)` over a decoded JSON value: arrays give
// their items, strings their characters (as strings), other values fail.
func iterate(value any, name string) ([]any, error) {
	switch v := value.(type) {
	case []any:
		return v, nil
	case string:
		var out []any
		for _, r := range v {
			out = append(out, string(r))
		}
		return out, nil
	}
	if name != "" {
		return nil, &Error{Name: "TypeError", Message: name + " is not iterable"}
	}
	switch v := value.(type) {
	case float64:
		return nil, &Error{Name: "TypeError", Message: "number " + jsstr.NumberJS(v) + " is not iterable (cannot read property Symbol(Symbol.iterator))"}
	case bool:
		return nil, &Error{Name: "TypeError", Message: "boolean " + strconv.FormatBool(v) + " is not iterable (cannot read property Symbol(Symbol.iterator))"}
	}
	return nil, &Error{Name: "TypeError", Message: "object is not iterable (cannot read property Symbol(Symbol.iterator))"}
}

// readProp is value.key: a TypeError for null (undefined does not occur
// for a parsed body), undefinedValue for missing keys and primitives.
func readProp(value any, key string) (any, error) {
	if value == nil {
		return nil, &Error{Name: "TypeError", Message: "Cannot read properties of null (reading '" + key + "')"}
	}
	return get(value, key), nil
}

func orNull(v any) any {
	if nullish(v) {
		return nil
	}
	return v
}

// SearxngSearch is searxngSearch.
func (rt *Runtime) SearxngSearch(ctx context.Context, query string, opts SearchOptions) (SearchOutcome, error) {
	if err := aborted(ctx); err != nil {
		return SearchOutcome{}, err
	}
	baseURL := rt.Env.SearxngBase
	if opts.BaseURL != nil {
		baseURL = *opts.BaseURL
	}
	params := queryParams{{"q", query}, {"format", "json"}}
	if nonEmpty(opts.Lang) {
		params = append(params, [2]string{"language", *opts.Lang})
	}
	if nonEmpty(opts.Categories) {
		params = append(params, [2]string{"categories", *opts.Categories})
	}
	if nonEmpty(opts.TimeRange) {
		params = append(params, [2]string{"time_range", *opts.TimeRange})
	}
	if nonEmpty(opts.Engines) {
		params = append(params, [2]string{"engines", *opts.Engines})
	}
	if opts.Page != nil && *opts.Page != 0 {
		params = append(params, [2]string{"pageno", strconv.Itoa(*opts.Page)})
	}
	timeout := rt.Env.SearxngTimeoutMs
	res, err := rt.doFetch(ctx, "GET", baseURL+"/search?"+params.String(), nil, nil, timeout)
	var ff *fetchFailure
	if errors.As(err, &ff) {
		if ff.phase == phaseFetch {
			if ff.timedOut {
				return SearchOutcome{}, &Error{Name: "SearxngError", Message: fmt.Sprintf("SearXNG search timed out after %dms", timeout)}
			}
			return SearchOutcome{}, &Error{Name: "SearxngError", Message: fmt.Sprintf("Connection to SearXNG failed at %s: %s", baseURL, ff.message)}
		}
	} else if err != nil {
		return SearchOutcome{}, err
	}
	if ff == nil && !res.ok() {
		return SearchOutcome{}, &Error{Name: "SearxngError", Message: fmt.Sprintf("SearXNG returned HTTP %d", res.status), Status: res.status}
	}
	var data any
	if ff != nil {
		if ff.timedOut {
			return SearchOutcome{}, &Error{Name: "SearxngError", Message: fmt.Sprintf("SearXNG response timed out after %dms", timeout)}
		}
		return SearchOutcome{}, &Error{Name: "SearxngError", Message: "SearXNG returned non-JSON — is format=json enabled?"}
	}
	if err := json.Unmarshal(res.body, &data); err != nil {
		return SearchOutcome{}, &Error{Name: "SearxngError", Message: "SearXNG returned non-JSON — is format=json enabled?"}
	}
	rawResults, err := readProp(data, "results")
	if err != nil {
		return SearchOutcome{}, err
	}
	if nullish(rawResults) {
		rawResults = []any{}
	}
	items, err := iterate(rawResults, "raw")
	if err != nil {
		return SearchOutcome{}, err
	}
	results := []SearchResult{}
	for _, item := range items {
		u := get(item, "url")
		if !truthy(u) {
			continue
		}
		results = append(results, SearchResult{
			Title:         orNull(get(item, "title")),
			URL:           jsString(u),
			Snippet:       orNull(get(item, "content")),
			Engine:        orNull(get(item, "engine")),
			Category:      orNull(get(item, "category")),
			PublishedDate: orNull(get(item, "publishedDate")),
		})
	}
	limit := len(results)
	if opts.NumResults != nil && *opts.NumResults > 0 && *opts.NumResults < limit {
		limit = *opts.NumResults
	}
	results = results[:limit]
	outQuery := query
	if q := get(data, "query"); !nullish(q) {
		outQuery = jsString(q)
	}
	categories := opts.Categories
	if categories == nil {
		categories = ptr("general")
	}
	page := 1
	if opts.Page != nil {
		page = *opts.Page
	}
	return SearchOutcome{
		OK:    true,
		Query: outQuery,
		Parameters: SearchParameters{
			Lang: opts.Lang, Categories: categories, TimeRange: opts.TimeRange, Engines: opts.Engines, Page: page,
		},
		ResultCount: len(results),
		Results:     results,
	}, nil
}

// ExaConfig is ExaProviderConfig. Nil pointers are undefined.
type ExaConfig struct {
	BaseURL    *string `json:"baseUrl,omitempty"`
	APIKeyEnv  *string `json:"apiKeyEnv,omitempty"`
	SearchType *string `json:"searchType,omitempty"`
}

// startPublishedDate is exa.ts startPublishedDate.
func startPublishedDate(now time.Time, timeRange *string) string {
	if timeRange == nil {
		return ""
	}
	days := map[string]int{"day": 1, "week": 7, "month": 30, "year": 365}[*timeRange]
	if days == 0 {
		return ""
	}
	ms := now.UnixMilli() - int64(days)*86_400_000
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
}

// exaSnippet is exa.ts snippet.
func exaSnippet(result any) (any, error) {
	if h := get(result, "highlights"); !nullish(h) {
		list, ok := h.([]any)
		if !ok {
			return nil, &Error{Name: "TypeError", Message: "result.highlights?.filter is not a function"}
		}
		var parts []string
		for _, item := range list {
			if truthy(item) {
				parts = append(parts, jsString(item))
			}
		}
		if joined := jsstr.Trim(strings.Join(parts, " … ")); joined != "" {
			return joined, nil
		}
	}
	for _, key := range []string{"summary", "text"} {
		v := get(result, key)
		if nullish(v) {
			continue
		}
		s, ok := v.(string)
		if !ok {
			return nil, &Error{Name: "TypeError", Message: "result." + key + "?.trim is not a function"}
		}
		if t := jsstr.Trim(s); t != "" {
			if key == "text" {
				return jsstr.Slice16(t, 1_000), nil
			}
			return t, nil
		}
	}
	return nil, nil
}

// ExaSearch is exaSearch.
func (rt *Runtime) ExaSearch(ctx context.Context, query string, opts SearchOptions, cfg ExaConfig) (SearchOutcome, error) {
	if err := aborted(ctx); err != nil {
		return SearchOutcome{}, err
	}
	apiKeyEnv := "EXA_API_KEY"
	if cfg.APIKeyEnv != nil {
		apiKeyEnv = *cfg.APIKeyEnv
	}
	getenv := rt.Getenv
	if getenv == nil {
		getenv = func(string) (string, bool) { return "", false }
	}
	key, _ := getenv(apiKeyEnv)
	key = jsstr.Trim(key)
	if key == "" {
		return SearchOutcome{}, &Error{Name: "ExaError", Message: fmt.Sprintf("Exa API key is missing. Set %s or configure aio.browserSearch.exa.apiKeyEnv.", apiKeyEnv)}
	}
	searchType := "auto"
	if cfg.SearchType != nil {
		searchType = *cfg.SearchType
	}
	numResults := 5
	if opts.NumResults != nil {
		numResults = *opts.NumResults
	}
	var b strings.Builder
	b.WriteString(`{"query":` + jsstr.QuoteJS(query) + `,"type":` + jsstr.QuoteJS(searchType) + `,"numResults":` + strconv.Itoa(numResults) + `,"contents":{"highlights":{"maxCharacters":1000}}`)
	list := func(name string, items []string) {
		quoted := make([]string, len(items))
		for i, s := range items {
			quoted[i] = jsstr.QuoteJS(s)
		}
		b.WriteString(`,"` + name + `":[` + strings.Join(quoted, ",") + `]`)
	}
	if len(opts.IncludeDomains) > 0 {
		list("includeDomains", opts.IncludeDomains)
	}
	if len(opts.ExcludeDomains) > 0 {
		list("excludeDomains", opts.ExcludeDomains)
	}
	now := time.Now()
	if rt.Now != nil {
		now = rt.Now()
	}
	if after := startPublishedDate(now, opts.TimeRange); after != "" {
		b.WriteString(`,"startPublishedDate":` + jsstr.QuoteJS(after))
	}
	b.WriteString("}")
	base := rt.Env.ExaBase
	if cfg.BaseURL != nil {
		base = *cfg.BaseURL
	} else if opts.BaseURL != nil {
		base = *opts.BaseURL
	}
	failedAt := rt.Env.ExaBase
	if cfg.BaseURL != nil {
		failedAt = *cfg.BaseURL
	}
	timeout := rt.Env.ExaTimeoutMs
	res, err := rt.doFetch(ctx, "POST", base+"/search", map[string]string{"content-type": "application/json", "x-api-key": key}, []byte(b.String()), timeout)
	var ff *fetchFailure
	if errors.As(err, &ff) {
		if ff.phase == phaseFetch {
			if ff.timedOut {
				return SearchOutcome{}, &Error{Name: "ExaError", Message: fmt.Sprintf("Exa search timed out after %dms", timeout)}
			}
			return SearchOutcome{}, &Error{Name: "ExaError", Message: fmt.Sprintf("Connection to Exa failed at %s: %s", failedAt, ff.message)}
		}
	} else if err != nil {
		return SearchOutcome{}, err
	}
	if ff == nil && !res.ok() {
		return SearchOutcome{}, &Error{Name: "ExaError", Message: fmt.Sprintf("Exa returned HTTP %d", res.status), Status: res.status}
	}
	var data any
	if ff != nil {
		if ff.timedOut {
			return SearchOutcome{}, &Error{Name: "ExaError", Message: fmt.Sprintf("Exa response timed out after %dms", timeout)}
		}
		return SearchOutcome{}, &Error{Name: "ExaError", Message: "Exa returned a non-JSON response"}
	}
	if err := json.Unmarshal(res.body, &data); err != nil {
		return SearchOutcome{}, &Error{Name: "ExaError", Message: "Exa returned a non-JSON response"}
	}
	rawResults, err := readProp(data, "results")
	if err != nil {
		return SearchOutcome{}, err
	}
	if nullish(rawResults) {
		rawResults = []any{}
	}
	items, err := iterate(rawResults, "")
	if err != nil {
		return SearchOutcome{}, err
	}
	results := []SearchResult{}
	for _, item := range items {
		u, err := readProp(item, "url")
		if err != nil {
			return SearchOutcome{}, err
		}
		if !truthy(u) {
			continue
		}
		snippet, err := exaSnippet(item)
		if err != nil {
			return SearchOutcome{}, err
		}
		results = append(results, SearchResult{
			Title:         orNull(get(item, "title")),
			URL:           jsString(u),
			Snippet:       snippet,
			Engine:        "exa",
			Category:      nil,
			PublishedDate: orNull(get(item, "publishedDate")),
		})
	}
	return SearchOutcome{
		OK:          true,
		Query:       query,
		Parameters:  SearchParameters{TimeRange: opts.TimeRange, Page: 1},
		ResultCount: len(results),
		Results:     results,
	}, nil
}
