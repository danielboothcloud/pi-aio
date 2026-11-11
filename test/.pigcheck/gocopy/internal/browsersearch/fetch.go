package browsersearch

// fetchSingleUrl for the Go port. TypeScript tries the Camofox container,
// then the CloakBrowser Node worker. Go deliberately diverges:
//
//  1. The Camofox container (the port of camofox.ts), only when
//     BROWSER_SEARCH_CAMOFOX_BASE or CAMOFOX_BASE is set.
//  2. The local Camoufox worker (worker.go): Readability in the page, an
//     accessibility snapshot, or the page HTML.
//  3. A plain HTTP fetch with readeck go-readability v2 and html-to-markdown
//     (httpfetch.go). A result from it carries a Warning that names the
//     browser tiers that failed. It does not run when the worker reported
//     an SSRF block for the URL.
//
// Every tier result passes the same challenge detection.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// FetchResult is types.ts FetchResult. Warning is Go-only: it is set when
// the plain HTTP fallback produced the result.
type FetchResult struct {
	URL               string          `json:"url"`
	FinalURL          *string         `json:"finalUrl,omitempty"`
	Title             *string         `json:"title,omitempty"`
	Content           string          `json:"content"`
	Format            string          `json:"format"`
	Chars             float64         `json:"chars"`
	Truncated         bool            `json:"truncated"`
	Tier              string          `json:"tier"`
	ChallengeStrategy json.RawMessage `json:"challengeStrategy,omitempty"`
	ChallengeResolved *bool           `json:"challengeResolved,omitempty"`
	Error             *string         `json:"error,omitempty"`
	Warning           *string         `json:"warning,omitempty"`
}

func failedFetch(url, format, message string) FetchResult {
	return FetchResult{URL: url, Format: format, Tier: "none", Error: &message}
}

func optionalTitle(v any) *string {
	if nullish(v) {
		return nil
	}
	s := jsString(v)
	return &s
}

// articleToContent is index.ts articleToContent.
func articleToContent(a *Article, format string) string {
	text := ""
	if t := a.Text(); !nullish(t) {
		text = jsString(t)
	}
	if title := a.Title(); truthy(title) {
		if format == "text" {
			return jsString(title) + "\n\n" + text
		}
		return "# " + jsString(title) + "\n\n" + text
	}
	return text
}

// snapshotToText is index.ts snapshotToText.
func snapshotToText(v *jsValue) string {
	if s, ok := v.V.(string); ok {
		return s
	}
	return stringifyRaw(v.Raw, "  ")
}

func camofoxResult(url, content, format string, title *string) FetchResult {
	return FetchResult{URL: url, Title: title, Content: content, Format: format, Chars: float64(jsstr.Len16(content)), Tier: "camofox"}
}

// tierFailure is one browser tier that gave no usable content.
type tierFailure struct {
	tier    string
	message string
}

func reasonText(message string) string {
	return strings.TrimRight(jsstr.Trim(message), ".")
}

// fallbackWarning is the notice text for a result of the HTTP fallback.
func fallbackWarning(url string, failures []tierFailure) string {
	var b strings.Builder
	for i, f := range failures {
		if i == 0 {
			fmt.Fprintf(&b, "%s failed for %s: %s. ", f.tier, url, reasonText(f.message))
		} else {
			fmt.Fprintf(&b, "%s failed: %s. ", f.tier, reasonText(f.message))
		}
	}
	b.WriteString("Used the plain HTTP fallback.")
	return b.String()
}

// failureText joins every tier error of a URL that no tier could fetch.
func failureText(failures []tierFailure) string {
	parts := make([]string, len(failures))
	for i, f := range failures {
		parts[i] = f.tier + " failed: " + reasonText(f.message)
	}
	return strings.Join(parts, ". ")
}

// FetchSingleURL fetches one URL through the tier chain.
func (rt *Runtime) FetchSingleURL(ctx context.Context, url, format string) (FetchResult, error) {
	if err := aborted(ctx); err != nil {
		return FetchResult{}, err
	}
	validation := ValidateURLWithDNS(ctx, rt.Resolver, url)
	if err := aborted(ctx); err != nil {
		return FetchResult{}, err
	}
	if !validation.Valid {
		return FetchResult{}, errors.New("URL blocked: " + validation.Reason)
	}
	var failures []tierFailure
	if rt.Env.CamofoxExplicit {
		failure := "Camofox returned no usable content"
		result, done, err := rt.tryCamofox(ctx, url, format, &failure)
		if done {
			return result, nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return FetchResult{}, ErrAborted
			}
			failure = err.Error()
			if _, ok := isCamofoxErr(err); !ok && rt.Stderr != nil {
				fmt.Fprintf(rt.Stderr, "[browser-search] Camofox failed for %s: %s\n", url, failure)
			}
		}
		if err := aborted(ctx); err != nil {
			return FetchResult{}, err
		}
		failures = append(failures, tierFailure{"Camofox container", failure})
	}

	result, done, failure, err := rt.tryCamoufox(ctx, url, format)
	if done {
		return result, nil
	}
	if ctx.Err() != nil || errors.Is(err, ErrAborted) {
		return FetchResult{}, ErrAborted
	}
	failures = append(failures, tierFailure{"Camoufox", failure})
	if strings.HasPrefix(failure, "URL blocked:") {
		// The browser hit the SSRF policy (a redirect or a DNS answer):
		// never retry that URL without a browser.
		return failedFetch(url, format, failureText(failures)), nil
	}

	result, err = rt.HTTPFetch(ctx, url, format)
	if err == nil {
		warning := fallbackWarning(url, failures)
		result.Warning = &warning
		return result, nil
	}
	if ctx.Err() != nil {
		return FetchResult{}, ErrAborted
	}
	failures = append(failures, tierFailure{"HTTP fallback", err.Error()})
	return failedFetch(url, format, failureText(failures)), nil
}

func (rt *Runtime) tryCamofox(ctx context.Context, url, format string, failure *string) (FetchResult, bool, error) {
	if format == "html" {
		page, err := rt.CamofoxEvaluateURL(ctx, url, "document.documentElement?.outerHTML || ''")
		if err != nil {
			return FetchResult{}, false, err
		}
		if page.Error != nil {
			*failure = *page.Error
			return FetchResult{}, false, nil
		}
		html, ok := page.Result.V.(string)
		if !ok {
			html = jsstr.Stringify(page.Result.Raw)
		}
		if jsstr.Trim(html) != "" && !IsLikelyChallengeContent(url, nil, html) {
			return FetchResult{URL: url, Content: html, Format: "html", Chars: float64(jsstr.Len16(html)), Tier: "camofox"}, true, nil
		}
		if jsstr.Trim(html) != "" {
			*failure = "Camofox returned an anti-bot challenge"
		} else {
			*failure = "Camofox returned empty HTML"
		}
		return FetchResult{}, false, nil
	}
	pages, err := rt.CamofoxReadability(ctx, []string{url})
	if err != nil {
		return FetchResult{}, false, err
	}
	if len(pages) == 0 {
		return FetchResult{}, false, nil
	}
	page := pages[0]
	switch {
	case page.Error != nil:
		*failure = *page.Error
	case page.Readability != nil && truthy(page.Readability.Text()):
		content := articleToContent(page.Readability, format)
		title := optionalTitle(page.Readability.Title())
		if !IsLikelyChallengeContent(url, title, content) {
			return camofoxResult(url, content, format, title), true, nil
		}
		*failure = "Camofox returned an anti-bot challenge"
	case page.Snapshot != nil && truthy(page.Snapshot.V):
		content := snapshotToText(page.Snapshot)
		if jsstr.Trim(content) != "" && !IsLikelyChallengeContent(url, nil, content) {
			return camofoxResult(url, content, format, nil), true, nil
		}
		if jsstr.Trim(content) != "" {
			*failure = "Camofox snapshot contained an anti-bot challenge"
		} else {
			*failure = "Camofox snapshot was empty"
		}
	}
	return FetchResult{}, false, nil
}

// capContent applies the extraction cap (BROWSER_SEARCH_CLOAK_MAX_CHARS)
// as cloak-runtime.ts did for the tier these replace: chars is the full
// length.
func (rt *Runtime) capContent(r *FetchResult) {
	limit := rt.Env.CloakMaxChars
	full := jsstr.Len16(r.Content)
	r.Chars = float64(full)
	if limit > 0 && full > limit {
		r.Content = jsstr.Slice16(r.Content, limit) + "\n\n[truncated]"
		r.Truncated = true
	}
}

// tryCamoufox runs the local worker. It returns the result (done), or the
// failure text; err is set only for an abort.
func (rt *Runtime) tryCamoufox(ctx context.Context, url, format string) (FetchResult, bool, string, error) {
	if rt.Worker == nil {
		return FetchResult{}, false, "the local Camoufox worker is not configured", nil
	}
	timeout := rt.Env.CamoufoxPageTimeoutMs
	if timeout <= 0 {
		timeout = 30_000
	}
	resp, err := rt.Worker.Fetch(ctx, WorkerRequest{URL: url, Format: format, TimeoutMs: timeout}, reporterOf(ctx).progress)
	if err != nil {
		if errors.Is(err, ErrAborted) || ctx.Err() != nil {
			return FetchResult{}, false, "", ErrAborted
		}
		return FetchResult{}, false, err.Error(), nil
	}
	if !resp.OK {
		msg := resp.Error
		if msg == "" {
			msg = "Camoufox returned no usable content"
		}
		return FetchResult{}, false, msg, nil
	}
	base := FetchResult{URL: url, Format: format, Tier: "camoufox"}
	if resp.FinalURL != "" && resp.FinalURL != url {
		final := resp.FinalURL
		base.FinalURL = &final
	}
	if format == "html" {
		html := ""
		if resp.HTML != nil {
			html = *resp.HTML
		}
		if jsstr.Trim(html) == "" {
			return FetchResult{}, false, "Camoufox returned empty HTML", nil
		}
		if IsLikelyChallengeContent(url, nil, html) {
			return FetchResult{}, false, "Camoufox returned an anti-bot challenge", nil
		}
		base.Content = html
		rt.capContent(&base)
		return base, true, "", nil
	}
	if resp.Readability != nil {
		article := &Article{Values: map[string]any{}}
		for _, key := range []string{"title", "text", "excerpt", "length"} {
			if v, ok := resp.Readability[key]; ok {
				article.Values[key] = v
			}
		}
		if truthy(article.Text()) {
			content := articleToContent(article, format)
			title := optionalTitle(article.Title())
			if IsLikelyChallengeContent(url, title, content) {
				return FetchResult{}, false, "Camoufox returned an anti-bot challenge", nil
			}
			base.Title = title
			base.Content = content
			rt.capContent(&base)
			return base, true, "", nil
		}
	}
	snapshot := ""
	if resp.Snapshot != nil {
		snapshot = *resp.Snapshot
	}
	if jsstr.Trim(snapshot) == "" {
		return FetchResult{}, false, "Camoufox snapshot was empty", nil
	}
	if IsLikelyChallengeContent(url, nil, snapshot) {
		return FetchResult{}, false, "Camoufox snapshot contained an anti-bot challenge", nil
	}
	if resp.Title != "" {
		title := resp.Title
		base.Title = &title
	}
	base.Content = snapshot
	rt.capContent(&base)
	return base, true, "", nil
}
