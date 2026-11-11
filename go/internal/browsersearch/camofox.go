package browsersearch

// Camofox REST client (port of browser-search/camofox.ts): request,
// ensureBrowser, runOnTab, readability (Mozilla Readability evaluated in
// the page, with a snapshot fallback), and evaluateUrl.

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ReadabilitySource is @mozilla/readability 0.6.0 Readability.js
// (Apache-2.0, see readability/LICENSE.md). camofox.ts evaluates the same
// file in the page.
//
//go:embed readability/Readability.js
var ReadabilitySource string

// jsValue is a parsed Camofox response: JSON (V and Raw) or plain text.
type jsValue struct {
	V   any
	Raw json.RawMessage
}

// valueOf wraps a response body as camofox.ts request() returns it.
func valueOf(text string) jsValue {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err == nil {
		return jsValue{V: v, Raw: json.RawMessage(text)}
	}
	raw, _ := json.Marshal(text)
	return jsValue{V: text, Raw: raw}
}

// field returns value[key] with its raw JSON.
func (v jsValue) field(key string) jsValue {
	f := get(v.V, key)
	if _, ok := f.(undefinedType); ok {
		return jsValue{V: undefinedValue}
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(v.Raw, &m) == nil {
		return jsValue{V: f, Raw: m[key]}
	}
	return jsValue{V: f}
}

// MarshalJSON writes the value (undefined as null).
func (v jsValue) MarshalJSON() ([]byte, error) {
	if v.Raw == nil {
		return []byte("null"), nil
	}
	return v.Raw, nil
}

type camofoxRequest struct {
	body     [][2]any // ordered body fields; nil for none
	hasBody  bool
	deadline time.Duration // 0: the configured request timeout
}

func camofoxErr(msg string, status int) error {
	return &Error{Name: "CamofoxError", Message: msg, Status: status}
}

func isCamofoxErr(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) && e.Name == "CamofoxError" {
		return e, true
	}
	return nil, false
}

func jsonBody(fields [][2]any) []byte {
	parts := make([]string, len(fields))
	for i, kv := range fields {
		var v string
		switch x := kv[1].(type) {
		case string:
			v = jsstr.QuoteJS(x)
		default:
			data, _ := json.Marshal(x)
			v = string(data)
		}
		parts[i] = jsstr.QuoteJS(kv[0].(string)) + ":" + v
	}
	return []byte("{" + strings.Join(parts, ",") + "}")
}

// camofoxRequest is camofox.ts request.
func (rt *Runtime) camofoxRequest(ctx context.Context, method, path string, r camofoxRequest) (jsValue, error) {
	if err := aborted(ctx); err != nil {
		return jsValue{}, err
	}
	base := rt.Env.CamofoxBase
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "://") || strings.Contains(path, `\`) {
		return jsValue{}, camofoxErr("Refusing unsafe Camofox path: "+path, 0)
	}
	baseURL, err := url.Parse(base)
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return jsValue{}, camofoxErr("Invalid CAMOFOX_BASE: "+base, 0)
	}
	fetchURL := base + path
	if method == "GET" && r.hasBody {
		params := queryParams{}
		userID := rt.Env.CamofoxUserID
		for _, kv := range r.body {
			if kv[0] == "userId" {
				userID = jsString(kv[1])
			}
		}
		params = append(params, [2]string{"userId", userID})
		for _, kv := range r.body {
			if kv[0] != "userId" {
				params = append(params, [2]string{kv[0].(string), jsString(kv[1])})
			}
		}
		fetchURL += "?" + params.String()
	}
	headers := map[string]string{}
	var body []byte
	if r.hasBody && method != "GET" {
		headers["content-type"] = "application/json"
		body = jsonBody(r.body)
	}
	key := rt.Env.CamofoxAPIKey
	if key != "" && ((strings.HasPrefix(path, "/tabs") && method == "POST" && strings.HasSuffix(path, "/evaluate")) ||
		strings.HasPrefix(path, "/sessions") || strings.HasPrefix(path, "/pressure")) {
		headers["authorization"] = "Bearer " + key
	}
	timeout := rt.Env.CamofoxTimeoutMs
	reqCtx := ctx
	if r.deadline > 0 {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), r.deadline)
		defer cancel()
	}
	if rt.Env.Debug && rt.Stderr != nil {
		fmt.Fprintf(rt.Stderr, "[camofox] %s %s\n", method, path)
	}
	res, err := rt.doFetch(reqCtx, method, escapePath(fetchURL), headers, body, timeout)
	var ff *fetchFailure
	if errors.As(err, &ff) {
		if ff.timedOut {
			what := "request"
			if ff.phase == phaseBody {
				what = "response"
			}
			return jsValue{}, camofoxErr(fmt.Sprintf("Camofox %s timed out after %dms: %s %s", what, timeout, method, path), 0)
		}
		if ff.phase == phaseBody {
			return jsValue{}, &Error{Name: "TypeError", Message: ff.message}
		}
		return jsValue{}, camofoxErr(fmt.Sprintf("Camofox unreachable at %s: %s", base, ff.message), 0)
	} else if err != nil {
		if r.deadline > 0 && ctx.Err() == nil {
			return jsValue{}, &Error{Name: "TimeoutError", Message: "The operation was aborted due to timeout"}
		}
		return jsValue{}, err
	}
	text := validUTF8(res.body)
	if !res.ok() {
		return jsValue{}, camofoxErr(fmt.Sprintf("%s %s → %d %s: %s", method, path, res.status, res.statusText, text), res.status)
	}
	return valueOf(text), nil
}

// escapePath percent-encodes the characters new URL() encodes in a path
// (spaces, quotes, angle brackets, backticks, braces, and non-ASCII).
func escapePath(target string) string {
	var b strings.Builder
	for _, c := range []byte(target) {
		switch {
		case c <= 0x20 || c >= 0x7f || c == '"' || c == '<' || c == '>' || c == '`' || c == '{' || c == '}':
			fmt.Fprintf(&b, "%%%02X", c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// tabPath is `/tabs/${tabId}` with String(tabId).
func tabPath(tabID any, suffix string) string { return "/tabs/" + jsString(tabID) + suffix }

func (rt *Runtime) camofoxHealth(ctx context.Context) (jsValue, error) {
	return rt.camofoxRequest(ctx, "GET", "/health", camofoxRequest{})
}

// CamofoxHealth is camofox.ts health.
func (rt *Runtime) CamofoxHealth(ctx context.Context) (any, error) {
	v, err := rt.camofoxHealth(ctx)
	if err != nil {
		return nil, err
	}
	return v, nil
}

func (rt *Runtime) camofoxEvaluate(ctx context.Context, tabID any, expression string) (jsValue, error) {
	return rt.camofoxRequest(ctx, "POST", tabPath(tabID, "/evaluate"), camofoxRequest{
		hasBody: true, body: [][2]any{{"userId", rt.Env.CamofoxUserID}, {"expression", expression}},
	})
}

// ensureBrowser is camofox.ts ensureBrowser: best-effort recovery only.
func (rt *Runtime) ensureBrowser(ctx context.Context) error {
	if err := aborted(ctx); err != nil {
		return err
	}
	_, err := rt.camofoxHealth(ctx)
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ErrAborted
	}
	ce, ok := isCamofoxErr(err)
	if !ok || ce.Status != 503 {
		return nil
	}
	if rt.Env.CamofoxAutoRestart {
		cmd := rt.Env.CamofoxRestartCmd
		if cmd == "" {
			cmd = "docker restart camofox-browser"
		}
		run := rt.RunRestart
		if run == nil {
			run = func(ctx context.Context, command string) error {
				return exec.CommandContext(ctx, "/bin/sh", "-c", command).Run()
			}
		}
		_ = run(ctx, cmd)
		if ctx.Err() != nil {
			return ErrAborted
		}
	}
	if err := aborted(ctx); err != nil {
		return err
	}
	if _, err := rt.camofoxRequest(ctx, "POST", "/start", camofoxRequest{}); err != nil && ctx.Err() != nil {
		return ErrAborted
	}
	return nil
}

// runOnTab is camofox.ts runOnTab: open a tab, wait, run fn, and always
// close the tab (bounded to 2 seconds).
func (rt *Runtime) runOnTab(ctx context.Context, target string, waitMs int, fn func(tabID any) error) error {
	if err := aborted(ctx); err != nil {
		return err
	}
	tab, err := rt.camofoxRequest(ctx, "POST", "/tabs", camofoxRequest{
		hasBody: true, body: [][2]any{{"userId", rt.Env.CamofoxUserID}, {"sessionKey", "default"}, {"url", target}},
	})
	if err != nil {
		return err
	}
	tabID, idErr := readProp(tab.V, "tabId")
	defer func() {
		if idErr == nil {
			_, _ = rt.camofoxRequest(ctx, "DELETE", tabPath(tabID, ""), camofoxRequest{
				hasBody: true, body: [][2]any{{"userId", rt.Env.CamofoxUserID}}, deadline: 2 * time.Second,
			})
		}
	}()
	if waitMs > 0 {
		if err := rt.sleep(ctx, waitMs); err != nil {
			return err
		}
	}
	if err := aborted(ctx); err != nil {
		return err
	}
	if idErr != nil {
		return idErr
	}
	return fn(tabID)
}

func (rt *Runtime) sleep(ctx context.Context, ms int) error {
	if rt.Sleep != nil {
		return rt.Sleep(ctx, ms)
	}
	return Sleep(ctx, ms)
}

// Article is the Readability result object: the keys the page returned
// (title, text, excerpt, length) plus htmlLength 0. Missing keys stay
// missing, as JSON.stringify drops undefined.
type Article struct {
	Values map[string]any
}

// Title returns article.title (undefinedValue when missing).
func (a *Article) Title() any { return valueOr(a.Values, "title") }

// Text returns article.text.
func (a *Article) Text() any { return valueOr(a.Values, "text") }

func valueOr(m map[string]any, key string) any {
	if v, ok := m[key]; ok {
		return v
	}
	return undefinedValue
}

// MarshalJSON writes the article.
func (a *Article) MarshalJSON() ([]byte, error) {
	out := map[string]any{"htmlLength": 0}
	for k, v := range a.Values {
		out[k] = v
	}
	return json.Marshal(out)
}

// ReadabilityPage is ReadabilityPageResult.
type ReadabilityPage struct {
	URL         string   `json:"url"`
	Readability *Article `json:"readability"`
	Snapshot    *jsValue `json:"snapshot"`
	Error       *string  `json:"error,omitempty"`
}

// readabilityRun is camofox.ts readabilityRun: JSON.parse(String(result)).
func (rt *Runtime) readabilityRun(ctx context.Context, tabID any) (any, error) {
	src := rt.ReadabilitySource
	expression := src + "; var a = new Readability(document.cloneNode(true)).parse();" +
		"JSON.stringify({title: a?.title || null, text: a?.textContent || null, excerpt: a?.excerpt || null, length: a?.length || 0})"
	res, err := rt.camofoxEvaluate(ctx, tabID, expression)
	if err != nil {
		return nil, err
	}
	result := get(res.V, "result")
	if !truthy(result) {
		return nil, nil
	}
	parsed, err := parseJS(jsString(result))
	if err != nil {
		return nil, nil
	}
	return parsed, nil
}

// CamofoxReadability is camofox.ts readability: two Readability attempts,
// then an accessibility snapshot, for each URL.
func (rt *Runtime) CamofoxReadability(ctx context.Context, urls []string) ([]ReadabilityPage, error) {
	if err := rt.ensureBrowser(ctx); err != nil {
		return nil, err
	}
	results := []ReadabilityPage{}
	for _, target := range urls {
		if err := aborted(ctx); err != nil {
			return nil, err
		}
		page := ReadabilityPage{URL: target}
		err := rt.runOnTab(ctx, target, 2000, func(tabID any) error {
			for attempt := 1; attempt <= 2; attempt++ {
				if err := aborted(ctx); err != nil {
					return err
				}
				res, err := rt.readabilityRun(ctx, tabID)
				if err != nil {
					return err
				}
				if truthy(get(res, "text")) {
					values := map[string]any{}
					for _, key := range []string{"title", "text", "excerpt", "length"} {
						if v := get(res, key); !isUndefined(v) {
							values[key] = v
						}
					}
					page.Readability = &Article{Values: values}
					break
				}
				if attempt < 2 {
					if err := rt.sleep(ctx, 1500); err != nil {
						return err
					}
				}
			}
			if page.Readability == nil {
				snap, err := rt.camofoxRequest(ctx, "GET", tabPath(tabID, "/snapshot"), camofoxRequest{
					hasBody: true, body: [][2]any{{"userId", rt.Env.CamofoxUserID}},
				})
				if err != nil {
					return err
				}
				page.Snapshot = &snap
			}
			return nil
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil, ErrAborted
			}
			msg := err.Error()
			page = ReadabilityPage{URL: target, Error: &msg}
		}
		results = append(results, page)
	}
	return results, nil
}

func isUndefined(v any) bool {
	_, ok := v.(undefinedType)
	return ok
}

// EvaluatePage is EvaluatePageResult.
type EvaluatePage struct {
	URL    string  `json:"url"`
	Result jsValue `json:"result"`
	Error  *string `json:"error,omitempty"`
}

// CamofoxEvaluateURL is camofox.ts evaluateUrl.
func (rt *Runtime) CamofoxEvaluateURL(ctx context.Context, target, expression string) (EvaluatePage, error) {
	if err := rt.ensureBrowser(ctx); err != nil {
		return EvaluatePage{}, err
	}
	var out jsValue
	err := rt.runOnTab(ctx, target, 1000, func(tabID any) error {
		res, err := rt.camofoxEvaluate(ctx, tabID, expression)
		if err != nil {
			return err
		}
		out = res.field("result")
		if nullish(out.V) {
			out = res
		}
		return nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return EvaluatePage{}, ErrAborted
		}
		msg := err.Error()
		return EvaluatePage{URL: target, Error: &msg}, nil
	}
	return EvaluatePage{URL: target, Result: out}, nil
}
