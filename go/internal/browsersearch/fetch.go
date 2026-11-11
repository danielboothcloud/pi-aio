package browsersearch

// fetchSingleUrl (port of browser-search/index.ts fetchSingleUrl): Camofox
// Readability, snapshot, or HTML first, then the CloakBrowser worker.

import (
	"context"
	"errors"
	"fmt"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

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

// FetchSingleURL is fetchSingleUrl.
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
	cloak, err := rt.CloakFetch(ctx, CloakRequest{URL: url, Format: format})
	if err != nil {
		if ctx.Err() != nil {
			return FetchResult{}, ErrAborted
		}
		return failedFetch(url, format, fmt.Sprintf("Camofox failed: %s. CloakBrowser failed: %s", failure, err.Error())), nil
	}
	return cloak, nil
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
