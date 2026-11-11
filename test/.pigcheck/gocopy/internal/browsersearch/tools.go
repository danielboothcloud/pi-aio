package browsersearch

// Tool definitions and executes (port of browser-search/index.ts
// registerBrowserSearch): web_search (registered only when a provider is
// configured) and fetch_content (always registered). The tool metadata is
// the TypeScript text. Go-only: the fetch progress names the Go tier chain,
// and an HTTP fallback result adds its warning to the text, the details,
// and one notice per URL and call.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// SearchFn is a search provider call.
type SearchFn func(ctx context.Context, query string, opts SearchOptions) (SearchOutcome, error)

// FetchFn fetches one URL in a format.
type FetchFn func(ctx context.Context, url, format string) (FetchResult, error)

// Update is one onUpdate payload: its text and details.
type Update struct {
	Text    string
	Details map[string]any
}

// Result is a tool result: its text and details.
type Result struct {
	Text    string
	Details map[string]any
}

// ToolSpec is the registered tool metadata.
type ToolSpec struct {
	Name             string
	Label            string
	Description      string
	PromptSnippet    string
	PromptGuidelines []string
	Parameters       map[string]any
}

// Tool is a spec with its execute function.
type Tool struct {
	Spec    ToolSpec
	Execute func(ctx context.Context, params map[string]any, onUpdate func(Update)) (Result, error)
}

func str(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func strArray(description string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": description}
}

func enum(values []string, description string) map[string]any {
	m := map[string]any{"type": "string", "enum": values}
	if description != "" {
		m["description"] = description
	}
	return m
}

var timeRanges = []string{"day", "week", "month", "year"}

func providerLabel(provider string) string {
	if provider == "exa" {
		return "Exa"
	}
	return "SearXNG"
}

// WebSearchSpec is the web_search registration for a provider.
func WebSearchSpec(provider string) ToolSpec {
	label := providerLabel(provider)
	return ToolSpec{
		Name:          "web_search",
		Label:         "Web Search",
		Description:   fmt.Sprintf("Search via the configured %s backend. Returns raw source hits rather than a provider-generated answer. Supports common pi-web-access query/provider/filter fields for call compatibility; the provider field does not override the backend selected in Pi settings. Set includeContent to browse returned hits through Camofox with CloakBrowser fallback.", label),
		PromptSnippet: fmt.Sprintf("Use for web research through configured %s. Prefer queries with 2-4 varied angles.", label),
		PromptGuidelines: []string{
			fmt.Sprintf("web_search uses the configured %s backend; use varied queries for broad research.", label),
			"Use includeContent only when the search snippets are insufficient because it launches a browser for each returned hit.",
			"Use fetch_content for specific result URLs that need full in-page extraction.",
		},
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":          str("Single search query. For research, prefer queries with several varied angles."),
				"queries":        strArray("Multiple queries searched sequentially."),
				"numResults":     map[string]any{"type": "integer", "minimum": 1, "maximum": 20, "description": "Maximum hits per query (default 5)."},
				"includeContent": map[string]any{"type": "boolean", "description": "Browse each returned hit and append extracted content."},
				"recencyFilter":  enum(timeRanges, ""),
				"domainFilter":   strArray("Limit to domains; prefix a domain with - to exclude it."),
				"provider": enum([]string{"auto", "searxng", "openai", "brave", "parallel", "tavily", "exa", "perplexity", "gemini"},
					"Accepted for pi-web-access compatibility; does not override the backend selected in Pi settings."),
				"workflow":   enum([]string{"none", "summary-review", "auto-summary"}, "Accepted for compatibility; self-hosted search returns raw hits without a curator workflow."),
				"lang":       str("SearXNG language code."),
				"categories": str("SearXNG categories CSV."),
				"timeRange":  enum(timeRanges, "SearXNG-native alias for recencyFilter."),
				"engines":    str("Restrict to SearXNG engines (CSV)."),
				"page":       map[string]any{"type": "integer", "minimum": 1, "description": "Result page."},
			},
		},
	}
}

// FetchContentSpec is the fetch_content registration.
func FetchContentSpec() ToolSpec {
	return ToolSpec{
		Name:          "fetch_content",
		Label:         "Fetch Content",
		Description:   "Fetch HTTP(S) URL(s) with a self-hosted browser and return content inline. The initial URL is SSRF-validated, Camofox provides Readability or accessibility-snapshot extraction, and blocked/empty pages escalate to optional CloakBrowser. This lean backend does not support video frame analysis, repository cloning, response IDs, or get_search_content.",
		PromptSnippet: "Use to extract readable content from HTTP(S) URL(s) through Camofox with CloakBrowser fallback.",
		PromptGuidelines: []string{
			"fetch_content returns extracted content inline and does not provide get_search_content response IDs.",
			"fetch_content supports web pages only; do not request video frames or repository cloning from it.",
			"Use urls for several pages; the tool includes a bounded content section for every successful URL.",
		},
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":        str("Single HTTP(S) URL."),
				"urls":       strArray("Multiple HTTP(S) URLs fetched sequentially."),
				"prompt":     str("Accepted for pi-web-access call compatibility; ignored for web pages."),
				"format":     enum([]string{"markdown", "text", "html"}, "Output format (default markdown)."),
				"forceClone": map[string]any{"type": "boolean", "description": "Compatibility field; repository cloning is unsupported by this backend."},
				"timestamp":  str("Compatibility field; video timestamps are unsupported by this backend."),
				"frames":     map[string]any{"type": "integer", "minimum": 1, "maximum": 12, "description": "Compatibility field; video frames are unsupported by this backend."},
				"model":      str("Compatibility field; video model overrides are unsupported by this backend."),
			},
		},
	}
}

// normalizeStringList is index.ts normalizeStringList: trimmed, non-empty,
// unique strings in first-seen order.
func normalizeStringList(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, item := range list {
		s, ok := item.(string)
		if !ok {
			continue
		}
		if t := jsstr.Trim(s); t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// normalizeInputList is index.ts normalizeInputList.
func normalizeInputList(many, one any) []string {
	if list := normalizeStringList(many); len(list) > 0 {
		return list
	}
	if s, ok := one.(string); ok {
		if t := jsstr.Trim(s); t != "" {
			return []string{t}
		}
	}
	return nil
}

// formatSearchHits is index.ts formatSearchHits.
func formatSearchHits(query string, results []SearchResult) string {
	if len(results) == 0 {
		return `No results for "` + query + `".`
	}
	lines := []string{fmt.Sprintf("## \"%s\" — %d result(s)\n", query, len(results))}
	for i, r := range results {
		snippet := ""
		if truthy(r.Snippet) {
			snippet = "\n  " + jsString(r.Snippet)
		}
		var meta []string
		for _, v := range []any{r.Engine, r.PublishedDate} {
			if truthy(v) {
				meta = append(meta, jsString(v))
			}
		}
		suffix := ""
		if len(meta) > 0 {
			suffix = " _(" + strings.Join(meta, " · ") + ")_"
		}
		title := r.URL
		if !nullish(r.Title) {
			title = jsString(r.Title)
		}
		lines = append(lines, fmt.Sprintf("%d. [%s](%s)%s%s", i+1, title, r.URL, suffix, snippet))
	}
	return strings.Join(lines, "\n")
}

// truncateForInline is index.ts truncateForInline.
func truncateForInline(content string, limit int) (string, bool) {
	full := jsstr.Len16(content)
	if full <= limit {
		return content, false
	}
	return jsstr.Slice16(content, limit) + fmt.Sprintf("\n\n[… truncated at %d / %d chars]", limit, full), true
}

func hasContent(r FetchResult) bool  { return r.Content != "" }
func errorText(r FetchResult) string { return derefOr(r.Error, "no content") }

func derefOr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

func failed(r FetchResult) bool { return (r.Error != nil && *r.Error != "") || !hasContent(r) }

func headerOf(r FetchResult) string { return derefOr(r.Title, r.URL) }

func sourceLine(r FetchResult, sep string) string {
	if r.FinalURL != nil && *r.FinalURL != "" && *r.FinalURL != r.URL {
		return sep + "Source: " + *r.FinalURL
	}
	return ""
}

// formatFetchedSources is index.ts formatFetchedSources.
func formatFetchedSources(results []FetchResult, maxInline int) string {
	if len(results) == 0 {
		return ""
	}
	available := 0
	for _, r := range results {
		if hasContent(r) && !(r.Error != nil && *r.Error != "") {
			available++
		}
	}
	limit := maxInline / max(available, 1) / 2
	limit = max(1_000, limit)
	sections := make([]string, len(results))
	for i, r := range results {
		if failed(r) {
			sections[i] = "### " + r.URL + "\n\nFetch error: " + errorText(r)
			continue
		}
		text, _ := truncateForInline(r.Content, limit)
		sections[i] = "### " + headerOf(r) + sourceLine(r, "\n\n") + "\n\n" + warningLine(r) + text
	}
	return "\n\n## In-page content\n\n" + strings.Join(sections, "\n\n---\n\n")
}

// applyDomainFilters is index.ts applyDomainFilters (SearXNG site: terms).
func applyDomainFilters(query string, filters []string) string {
	if len(filters) == 0 {
		return query
	}
	var terms []string
	for _, f := range filters {
		t := jsstr.Trim(f)
		switch {
		case t == "":
		case strings.HasPrefix(t, "-"):
			terms = append(terms, "-site:"+t[1:])
		default:
			terms = append(terms, "site:"+t)
		}
	}
	return jsstr.Trim(query + " " + strings.Join(terms, " "))
}

// splitDomainFilters is index.ts splitDomainFilters (Exa domain lists).
func splitDomainFilters(filters []string) (include, exclude []string) {
	include, exclude = []string{}, []string{}
	for _, f := range filters {
		t := jsstr.Trim(f)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "-") {
			if d := jsstr.Trim(t[1:]); d != "" {
				exclude = append(exclude, d)
			}
		} else {
			include = append(include, t)
		}
	}
	return include, exclude
}

// ConfiguredSearch is index.ts configuredSearch.
func (rt *Runtime) ConfiguredSearch(provider string, cfg ProviderConfig) SearchFn {
	if provider == "exa" {
		exa := ExaConfig{BaseURL: cfg.Exa.BaseURL}
		if cfg.Exa.APIKeyEnv != "" {
			exa.APIKeyEnv = ptr(cfg.Exa.APIKeyEnv)
		}
		if cfg.Exa.SearchType != "" {
			exa.SearchType = ptr(cfg.Exa.SearchType)
		}
		return func(ctx context.Context, query string, opts SearchOptions) (SearchOutcome, error) {
			return rt.ExaSearch(ctx, query, opts, exa)
		}
	}
	return func(ctx context.Context, query string, opts SearchOptions) (SearchOutcome, error) {
		opts.BaseURL = cfg.Searxng.BaseURL
		return rt.SearxngSearch(ctx, query, opts)
	}
}

func stringParam(params map[string]any, key string) *string {
	if s, ok := params[key].(string); ok {
		return &s
	}
	return nil
}

func intParam(params map[string]any, key string) *int {
	if f, ok := params[key].(float64); ok {
		n := int(f)
		return &n
	}
	return nil
}

func errMessage(err error) string { return err.Error() }

type queryResult struct {
	query       string
	resultCount int
	results     []SearchResult
	fetched     []FetchResult
	err         *string
}

// WebSearchTool is the web_search tool for a provider.
func (rt *Runtime) WebSearchTool(provider string, search SearchFn, fetchURL FetchFn) Tool {
	label := providerLabel(provider)
	return Tool{Spec: WebSearchSpec(provider), Execute: func(ctx context.Context, params map[string]any, onUpdate func(Update)) (Result, error) {
		if err := aborted(ctx); err != nil {
			return Result{}, err
		}
		queries := normalizeInputList(params["queries"], params["query"])
		if len(queries) == 0 {
			return Result{}, errors.New("No query provided. Use query or queries.")
		}
		domainFilters := normalizeStringList(params["domainFilter"])
		include, exclude := splitDomainFilters(domainFilters)
		opts := SearchOptions{
			Lang:           stringParam(params, "lang"),
			Categories:     stringParam(params, "categories"),
			TimeRange:      stringParam(params, "recencyFilter"),
			Engines:        stringParam(params, "engines"),
			Page:           intParam(params, "page"),
			NumResults:     intParam(params, "numResults"),
			IncludeDomains: include,
			ExcludeDomains: exclude,
		}
		if opts.TimeRange == nil {
			opts.TimeRange = stringParam(params, "timeRange")
		}
		if opts.NumResults == nil {
			opts.NumResults = ptr(5)
		}
		includeContent := params["includeContent"] == true
		ctx, notices := rt.toolContext(ctx, onUpdate)
		var perQuery []queryResult
		for index, query := range queries {
			if err := aborted(ctx); err != nil {
				return Result{}, err
			}
			if onUpdate != nil {
				onUpdate(Update{
					Text:    fmt.Sprintf("Searching %s (%d/%d): %s", label, index+1, len(queries), query),
					Details: map[string]any{"phase": "search", "query": query, "index": index},
				})
			}
			q := query
			if provider == "searxng" {
				q = applyDomainFilters(query, domainFilters)
			}
			outcome, err := search(ctx, q, opts)
			if err != nil {
				if ctx.Err() != nil {
					return Result{}, ErrAborted
				}
				msg := errMessage(err)
				perQuery = append(perQuery, queryResult{query: query, err: &msg})
				continue
			}
			fetched := []FetchResult{}
			if includeContent {
				for hitIndex, hit := range outcome.Results {
					if err := aborted(ctx); err != nil {
						return Result{}, err
					}
					if onUpdate != nil {
						onUpdate(Update{
							Text:    fmt.Sprintf("Browsing hit %d/%d (query %d/%d): %s", hitIndex+1, len(outcome.Results), index+1, len(queries), hit.URL),
							Details: map[string]any{"phase": "fetch", "query": query, "url": hit.URL, "index": index, "hitIndex": hitIndex},
						})
					}
					r, err := fetchURL(ctx, hit.URL, "markdown")
					if err != nil {
						if ctx.Err() != nil {
							return Result{}, ErrAborted
						}
						r = failedFetch(hit.URL, "markdown", errMessage(err))
					}
					notices.result(r)
					fetched = append(fetched, r)
				}
			}
			perQuery = append(perQuery, queryResult{query: query, resultCount: outcome.ResultCount, results: outcome.Results, fetched: fetched})
		}
		successes := 0
		for _, r := range perQuery {
			if r.err == nil {
				successes++
			}
		}
		if successes == 0 {
			return Result{}, fmt.Errorf("%s search failed for all %d query(ies): %s", label, len(queries), *perQuery[0].err)
		}
		sections := make([]string, len(perQuery))
		totalHits := 0
		queryDetails := make([]any, len(perQuery))
		for i, r := range perQuery {
			if r.err != nil {
				sections[i] = fmt.Sprintf("## \"%s\" — error\n\n%s", r.query, *r.err)
			} else {
				sections[i] = formatSearchHits(r.query, r.results) + formatFetchedSources(r.fetched, rt.Env.MaxInlineContent)
			}
			totalHits += r.resultCount
			d := map[string]any{"query": r.query, "resultCount": r.resultCount, "fetched": len(r.fetched)}
			if r.err != nil && *r.err != "" {
				d["error"] = *r.err
			}
			var warnings []any
			for _, f := range r.fetched {
				if f.Warning != nil {
					warnings = append(warnings, *f.Warning)
				}
			}
			if len(warnings) > 0 {
				d["warnings"] = warnings
			}
			queryDetails[i] = d
		}
		text, truncated := truncateForInline(strings.Join(sections, "\n\n---\n\n"), rt.Env.MaxInlineContent)
		details := map[string]any{
			"tier": provider, "provider": provider, "queryCount": len(perQuery), "totalHits": totalHits,
			"includeContent": includeContent, "truncated": truncated, "queries": queryDetails,
		}
		if v, ok := params["provider"]; ok {
			details["requestedProvider"] = v
		}
		return Result{Text: text, Details: details}, nil
	}}
}

func fetchDetails(r FetchResult, truncated bool) map[string]any {
	d := map[string]any{"url": r.URL, "tier": r.Tier, "format": r.Format, "chars": r.Chars, "truncated": truncated}
	if r.FinalURL != nil {
		d["finalUrl"] = *r.FinalURL
	}
	if r.Title != nil {
		d["title"] = *r.Title
	}
	if r.ChallengeStrategy != nil {
		var v any
		if json.Unmarshal(r.ChallengeStrategy, &v) == nil {
			d["challengeStrategy"] = v
		}
	}
	if r.ChallengeResolved != nil {
		d["challengeResolved"] = *r.ChallengeResolved
	}
	if r.Warning != nil {
		d["warning"] = *r.Warning
	}
	return d
}

// FetchContentTool is the fetch_content tool.
func (rt *Runtime) FetchContentTool(fetchURL FetchFn) Tool {
	return Tool{Spec: FetchContentSpec(), Execute: func(ctx context.Context, params map[string]any, onUpdate func(Update)) (Result, error) {
		if err := aborted(ctx); err != nil {
			return Result{}, err
		}
		_, timestamp := params["timestamp"]
		_, frames := params["frames"]
		_, model := params["model"]
		if params["forceClone"] == true || timestamp || frames || model {
			return Result{}, errors.New("This self-hosted fetch_content backend supports web pages only; repository cloning and video analysis options are unavailable.")
		}
		urls := normalizeInputList(params["urls"], params["url"])
		if len(urls) == 0 {
			return Result{}, errors.New("No URL provided. Use url or urls.")
		}
		format := "markdown"
		if f, ok := params["format"].(string); ok {
			format = f
		}
		ctx, notices := rt.toolContext(ctx, onUpdate)
		if onUpdate != nil {
			onUpdate(Update{Text: fmt.Sprintf("Fetching %d URL(s) via %s…", len(urls), rt.chainLabel()), Details: map[string]any{"phase": "fetch", "urlCount": len(urls)}})
		}
		results := make([]FetchResult, 0, len(urls))
		for index, url := range urls {
			if err := aborted(ctx); err != nil {
				return Result{}, err
			}
			if onUpdate != nil {
				onUpdate(Update{Text: fmt.Sprintf("Fetching (%d/%d) %s", index+1, len(urls), url), Details: map[string]any{"phase": "fetch", "url": url, "index": index}})
			}
			r, err := fetchURL(ctx, url, format)
			if err != nil {
				if ctx.Err() != nil {
					return Result{}, ErrAborted
				}
				r = failedFetch(url, format, errMessage(err))
			}
			notices.result(r)
			results = append(results, r)
		}
		var successful []FetchResult
		for _, r := range results {
			if !failed(r) {
				successful = append(successful, r)
			}
		}
		if len(successful) == 0 {
			parts := make([]string, len(results))
			for i, r := range results {
				parts[i] = r.URL + ": " + errorText(r)
			}
			return Result{}, fmt.Errorf("Failed to fetch %d URL(s): %s", len(urls), strings.Join(parts, "; "))
		}
		if len(urls) == 1 {
			r := successful[0]
			text, truncated := truncateForInline(r.Content, rt.Env.MaxInlineContent)
			if text == "" {
				text = "(no content extracted)"
			}
			return Result{
				Text:    warningLine(r) + "## " + headerOf(r) + sourceLine(r, "\n") + "\n\n" + text,
				Details: fetchDetails(r, r.Truncated || truncated),
			}, nil
		}
		perURL := max(1_000, (rt.Env.MaxInlineContent-2_000)/max(len(successful), 1))
		sections := make([]string, len(results))
		anyTruncated := false
		resultDetails := make([]any, len(results))
		for i, r := range results {
			if failed(r) {
				sections[i] = "## " + r.URL + "\n\nError: " + errorText(r)
			} else {
				text, _ := truncateForInline(r.Content, perURL)
				sections[i] = "## " + headerOf(r) + sourceLine(r, "\n\n") + "\n\n" + warningLine(r) + text
			}
			anyTruncated = anyTruncated || r.Truncated
			d := fetchDetails(r, r.Truncated)
			if r.Error != nil && *r.Error != "" {
				d["error"] = *r.Error
			}
			resultDetails[i] = d
		}
		text, truncated := truncateForInline(strings.Join(sections, "\n\n---\n\n"), rt.Env.MaxInlineContent)
		return Result{Text: text, Details: map[string]any{
			"urlCount": len(urls), "successful": len(successful), "truncated": truncated || anyTruncated, "results": resultDetails,
		}}, nil
	}}
}

// Dependencies are BrowserSearchDependencies.
type Dependencies struct {
	Search     SearchFn
	FetchURL   FetchFn
	Provider   string
	Config     *ProviderConfig
	LoadConfig func(cwd string, projectTrusted bool) ProviderConfig
}

// Registration is the result of Register: Start is the session_start
// handler (nil when TypeScript registers none).
type Registration struct {
	Start func(cwd string, projectTrusted bool)
}

// Register is registerBrowserSearch: it calls register for each tool in
// TypeScript's order. web_search registers at most once.
func (rt *Runtime) Register(deps Dependencies, register func(Tool)) Registration {
	fetchURL := deps.FetchURL
	if fetchURL == nil {
		fetchURL = rt.FetchSingleURL
	}
	var registered atomic.Bool
	registerSearch := func(provider string, search SearchFn) {
		if registered.Swap(true) {
			return
		}
		register(rt.WebSearchTool(provider, search, fetchURL))
	}
	var reg Registration
	immediate := deps.Provider
	if immediate == "" && deps.Config != nil {
		immediate = deps.Config.Provider
	}
	if immediate == "" && deps.Search != nil {
		immediate = "searxng"
	}
	if immediate != "" {
		search := deps.Search
		if search == nil {
			cfg := ProviderConfig{}
			if deps.Config != nil {
				cfg = *deps.Config
			}
			search = rt.ConfiguredSearch(immediate, cfg)
		}
		registerSearch(immediate, search)
	} else if deps.Config == nil {
		load := deps.LoadConfig
		reg.Start = func(cwd string, trusted bool) {
			cfg := load(cwd, trusted)
			if cfg.Provider == "" {
				return
			}
			registerSearch(cfg.Provider, rt.ConfiguredSearch(cfg.Provider, cfg))
		}
	}
	register(rt.FetchContentTool(fetchURL))
	return reg
}
