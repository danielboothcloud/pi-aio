package browsersearch

// Plain HTTP fallback (Go-only). When the browser tiers fail, Go fetches
// the URL itself: GET with a browser-like User-Agent, at most 10 redirects
// (each target is validated again), a time limit, and a body limit. HTML is
// decoded with its charset and extracted with readeck go-readability v2;
// markdown comes from html-to-markdown. The same challenge detection as the
// browser tiers applies.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	nurl "net/url"
	"strings"
	"time"

	readability "codeberg.org/readeck/go-readability/v2"
	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// FallbackUserAgent is the User-Agent of the HTTP fallback (a current
// desktop Firefox, like the Camoufox tier).
const FallbackUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"

const maxRedirects = 10

// redirectError is a refused redirect; its text is the tool error.
type redirectError struct{ message string }

func (e *redirectError) Error() string { return e.message }

func (rt *Runtime) fallbackClient() *http.Client {
	transport := rt.FallbackTransport
	if transport == nil {
		transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return &redirectError{fmt.Sprintf("stopped after %d redirects", maxRedirects)}
			}
			if v := rt.validate(req.Context(), req.URL.String()); !v.Valid {
				return &redirectError{fmt.Sprintf("redirect to %s blocked: %s", req.URL, v.Reason)}
			}
			return nil
		},
	}
}

// contentKind classifies a Content-Type: "html", "text", or "" for types
// the fallback does not read.
func contentKind(contentType string, body []byte) string {
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil || media == "" {
		media, _, _ = mime.ParseMediaType(http.DetectContentType(body))
	}
	switch {
	case media == "text/html" || media == "application/xhtml+xml":
		return "html"
	case strings.HasPrefix(media, "text/"), media == "application/json", media == "application/xml",
		strings.HasSuffix(media, "+json"), strings.HasSuffix(media, "+xml"):
		return "text"
	}
	return ""
}

// decodeBody converts body to UTF-8 from the charset in contentType or the
// document (BOM, <meta>), as a browser would.
func decodeBody(body []byte, contentType string) string {
	reader, err := charset.NewReader(bytes.NewReader(body), contentType)
	if err != nil {
		return validUTF8(body)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		return validUTF8(body)
	}
	return validUTF8(decoded)
}

// documentTitle and bodyText read a parsed page without Readability.
func documentTitle(doc *html.Node) string {
	var title string
	var walk func(*html.Node) bool
	walk = func(n *html.Node) bool {
		if n.Type == html.ElementNode && n.Data == "title" {
			var b strings.Builder
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.TextNode {
					b.WriteString(c.Data)
				}
			}
			title = strings.Join(strings.Fields(b.String()), " ")
			return true
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if walk(c) {
				return true
			}
		}
		return false
	}
	walk(doc)
	return title
}

func bodyText(doc *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "script", "style", "noscript", "template", "head":
				return
			case "p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "pre", "blockquote":
				b.WriteString("\n")
			}
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	var lines []string
	for _, l := range strings.Split(b.String(), "\n") {
		if t := strings.Join(strings.Fields(l), " "); t != "" {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "\n")
}

func withTitle(title, body, format string) string {
	if title == "" {
		return body
	}
	if format == "text" {
		return title + "\n\n" + body
	}
	return "# " + title + "\n\n" + body
}

// extractHTML turns a page into the requested format.
func extractHTML(page string, base *nurl.URL, format string) (title, content string) {
	if format == "html" {
		doc, err := html.Parse(strings.NewReader(page))
		if err == nil {
			title = documentTitle(doc)
		}
		return title, page
	}
	article, err := readability.FromReader(strings.NewReader(page), base)
	var text string
	if err == nil && article.Node != nil {
		var b strings.Builder
		if article.RenderText(&b) == nil {
			text = strings.TrimSpace(b.String())
		}
	}
	if text != "" {
		title = strings.TrimSpace(article.Title())
		if format == "text" {
			return title, withTitle(title, text, format)
		}
		var content strings.Builder
		if article.RenderHTML(&content) != nil {
			content.Reset()
		}
		md, err := htmltomarkdown.ConvertString(content.String(), converter.WithDomain(base.String()))
		if err != nil || strings.TrimSpace(md) == "" {
			md = text
		}
		return title, withTitle(title, strings.TrimSpace(md), format)
	}
	doc, perr := html.Parse(strings.NewReader(page))
	if perr != nil {
		return "", ""
	}
	title = documentTitle(doc)
	if format == "text" {
		return title, withTitle(title, bodyText(doc), format)
	}
	md, err := htmltomarkdown.ConvertString(page, converter.WithDomain(base.String()))
	if err != nil || strings.TrimSpace(md) == "" {
		md = bodyText(doc)
	}
	return title, withTitle(title, strings.TrimSpace(md), format)
}

// HTTPFetch is the plain HTTP fallback for one URL. The caller has
// validated the initial URL; redirects are validated here.
func (rt *Runtime) HTTPFetch(ctx context.Context, target, format string) (FetchResult, error) {
	if err := aborted(ctx); err != nil {
		return FetchResult{}, err
	}
	timeout := 20 * time.Second
	if rt.Env.HTTPTimeoutMs > 0 {
		timeout = time.Duration(rt.Env.HTTPTimeoutMs) * time.Millisecond
	}
	limit := rt.Env.HTTPMaxBytes
	if limit <= 0 {
		limit = 5 << 20
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, target, nil)
	if err != nil {
		return FetchResult{}, fmt.Errorf("invalid URL: %s", err)
	}
	req.Header.Set("User-Agent", FallbackUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5")
	req.Header.Set("Accept-Language", "en-US,en;q=0.5")
	res, err := rt.fallbackClient().Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return FetchResult{}, ErrAborted
		}
		var re *redirectError
		if errors.As(err, &re) {
			return FetchResult{}, re
		}
		if reqCtx.Err() != nil {
			return FetchResult{}, fmt.Errorf("timed out after %s", timeout)
		}
		var ue *nurl.Error
		if errors.As(err, &ue) {
			return FetchResult{}, fmt.Errorf("request failed: %s", ue.Err)
		}
		return FetchResult{}, fmt.Errorf("request failed: %s", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
	if err != nil {
		if ctx.Err() != nil {
			return FetchResult{}, ErrAborted
		}
		if reqCtx.Err() != nil {
			return FetchResult{}, fmt.Errorf("timed out after %s", timeout)
		}
		return FetchResult{}, fmt.Errorf("reading the response failed: %s", err)
	}
	truncated := len(body) > limit
	if truncated {
		body = body[:limit]
	}
	final := res.Request.URL
	contentType := res.Header.Get("Content-Type")
	kind := contentKind(contentType, body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		status := fmt.Sprintf("HTTP %s", res.Status)
		if kind != "" && IsLikelyChallengeContent(final.String(), nil, decodeBody(body, contentType)) {
			return FetchResult{}, fmt.Errorf("%s (anti-bot challenge)", status)
		}
		return FetchResult{}, errors.New(status)
	}
	if kind == "" {
		media, _, _ := mime.ParseMediaType(contentType)
		if media == "" {
			media = "unknown"
		}
		return FetchResult{}, fmt.Errorf("unsupported content type %s", media)
	}
	page := decodeBody(body, contentType)
	var title, content string
	if kind == "html" {
		title, content = extractHTML(page, final, format)
	} else {
		content = page
	}
	if jsstr.Trim(content) == "" {
		return FetchResult{}, errors.New("the page had no readable content")
	}
	var titlePtr *string
	if title != "" {
		titlePtr = &title
	}
	if IsLikelyChallengeContent(target, titlePtr, content) {
		return FetchResult{}, errors.New("the page is an anti-bot challenge")
	}
	result := FetchResult{URL: target, Title: titlePtr, Content: content, Format: format, Tier: "http", Truncated: truncated}
	if f := final.String(); f != target {
		result.FinalURL = &f
	}
	rt.capContent(&result)
	result.Truncated = result.Truncated || truncated
	return result, nil
}
