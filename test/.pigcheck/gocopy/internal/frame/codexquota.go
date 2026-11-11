package frame

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Codex (ChatGPT subscription) usage windows (port of frame/codex-quota.ts).

const (
	// CodexInterval is INTERVAL (ms).
	CodexInterval = 60_000
	// CodexTimeout is TIMEOUT.
	CodexTimeout = 10 * time.Second
	// CodexEndpoint is ENDPOINT.
	CodexEndpoint = "https://chatgpt.com/backend-api/wham/usage"
)

// CodexQuota is CodexQuota. LastSuccess is epoch milliseconds.
type CodexQuota struct {
	FiveHour    *int     `json:"fiveHour,omitempty"`
	Week        *int     `json:"week,omitempty"`
	LastSuccess *float64 `json:"lastSuccess,omitempty"`
	Stale       bool     `json:"stale,omitempty"`
}

func record(value any) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	return m, ok
}

// ParseCodexQuota is parseCodexQuota over a decoded JSON value.
func ParseCodexQuota(value any) *CodexQuota {
	root, _ := record(value)
	limits, ok := record(root["rate_limit"])
	if !ok {
		return nil
	}
	var result CodexQuota
	for _, raw := range []any{limits["primary_window"], limits["secondary_window"]} {
		window, ok := record(raw)
		if !ok {
			continue
		}
		used, ok := numberValue(window["used_percent"])
		if !ok || math.IsNaN(used) || math.IsInf(used, 0) || used < 0 || used > 100 {
			continue
		}
		seconds, _ := numberValue(window["limit_window_seconds"])
		remaining := int(jsRound(100 - used))
		switch {
		case seconds == 18_000 && isNumber(window["limit_window_seconds"]):
			result.FiveHour = &remaining
		case seconds == 604_800 && isNumber(window["limit_window_seconds"]):
			result.Week = &remaining
		}
	}
	if result.FiveHour == nil && result.Week == nil {
		return nil
	}
	return &result
}

func isNumber(v any) bool {
	_, ok := numberValue(v)
	return ok
}

// CodexQuotaText is codexQuotaText: `5h 88% | week 97%`.
func CodexQuotaText(q *CodexQuota) string {
	if q == nil {
		return ""
	}
	percent := func(v *int) string {
		if v == nil {
			return "--"
		}
		return strconv.Itoa(*v) + "%"
	}
	stale := ""
	if q.Stale {
		stale = " stale"
	}
	return "5h " + percent(q.FiveHour) + " | week " + percent(q.Week) + stale
}

// CodexQuotaRole is codexQuotaRole.
func CodexQuotaRole(q CodexQuota) string {
	remaining := 100
	if q.FiveHour != nil {
		remaining = *q.FiveHour
	}
	week := 100
	if q.Week != nil {
		week = *q.Week
	}
	remaining = min(remaining, week)
	if remaining <= 20 {
		return "error"
	}
	if q.Stale || remaining <= 50 {
		return "warning"
	}
	return "muted"
}

// IsNativeCodexURL is isNativeCodexUrl: an https://chatgpt.com origin
// without credentials.
func IsNativeCodexURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.User != nil {
		return false
	}
	host := strings.ToLower(u.Host)
	host = strings.TrimSuffix(host, ":443")
	return strings.ToLower(u.Scheme) == "https" && host == "chatgpt.com"
}

// CodexModel is the routed model's public routing (provider, api, baseUrl).
type CodexModel struct {
	Provider string `json:"provider"`
	API      string `json:"api"`
	BaseURL  string `json:"baseUrl"`
}

// CodexProvider is the registry's openai-codex provider.
type CodexProvider struct {
	ID      string `json:"id"`
	BaseURL string `json:"baseUrl"`
}

// HasNativeCodexRoute is hasNativeCodexRoute: the model and the registry's
// provider both route to chatgpt.com.
func HasNativeCodexRoute(model *CodexModel, provider *CodexProvider) bool {
	if model == nil || model.Provider != "openai-codex" || model.API != "openai-codex-responses" || !IsNativeCodexURL(model.BaseURL) {
		return false
	}
	return provider != nil && provider.ID == "openai-codex" && IsNativeCodexURL(provider.BaseURL)
}

var accountIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,256}$`)

// CodexAccountID is accountId: the unverified JWT claim used only for
// cache isolation.
func CodexAccountID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload := strings.TrimRight(parts[1], "=")
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return ""
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	auth, _ := record(claims["https://api.openai.com/auth"])
	id, _ := auth["chatgpt_account_id"].(string)
	if !accountIDPattern.MatchString(id) {
		return ""
	}
	return id
}

var retrySeconds = regexp.MustCompile(`^\d+(?:\.\d+)?$`)

// CodexRetryDelay is retryDelay (ms) for a Retry-After value at now (epoch
// ms); parseDate parses an HTTP date as Date.parse does.
func CodexRetryDelay(value string, now float64, parseDate func(string) (float64, bool)) float64 {
	if value == "" {
		return CodexInterval
	}
	var delay float64
	if retrySeconds.MatchString(value) {
		seconds, _ := strconv.ParseFloat(value, 64)
		delay = seconds * 1000
	} else {
		parsed, ok := parseDate(value)
		if !ok {
			return CodexInterval
		}
		delay = parsed - now
	}
	if math.IsNaN(delay) || math.IsInf(delay, 0) {
		return CodexInterval
	}
	return math.Max(CodexInterval, delay)
}

// ParseHTTPDate parses the date forms Date.parse accepts in Retry-After.
func ParseHTTPDate(value string) (float64, bool) {
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, time.RFC850, time.ANSIC, time.RFC3339, time.RFC3339Nano} {
		if t, err := time.Parse(layout, value); err == nil {
			return float64(t.UnixMilli()), true
		}
	}
	return 0, false
}

// CodexResponse is a fetch result.
type CodexResponse struct {
	Status     int
	RetryAfter string
	Body       []byte
}

// CodexDeps are the collector's host seams.
type CodexDeps struct {
	// Route reports whether the context has the native Codex route
	// (`context()` in TypeScript).
	Route func() bool
	// Token resolves the routed OAuth token ("" for none). An error is a
	// failed resolution.
	Token func(ctx context.Context) (string, error)
	// Fetch requests url with headers.
	Fetch func(ctx context.Context, url string, headers map[string]string) (CodexResponse, error)
	// Changed asks for a repaint.
	Changed func()
	// Now is Date.now().
	Now func() float64
	// After schedules fn after ms; it returns a stop function.
	After func(ms float64, fn func()) (stop func())
	// Go runs a refresh (default: a goroutine).
	Go func(func())
}

// CodexCollector is CodexQuotaCollector: one session-scoped poller.
type CodexCollector struct {
	deps CodexDeps

	mu          sync.Mutex
	active      bool
	stopTimer   func()
	cancel      context.CancelFunc
	generation  int
	identity    string
	value       CodexQuota
	nextRefresh float64
	requesting  bool
}

// NewCodexCollector returns a stopped collector.
func NewCodexCollector(deps CodexDeps) *CodexCollector {
	if deps.Go == nil {
		deps.Go = func(fn func()) { go fn() }
	}
	if deps.Now == nil {
		deps.Now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	if deps.After == nil {
		deps.After = func(ms float64, fn func()) func() {
			t := time.AfterFunc(time.Duration(ms)*time.Millisecond, fn)
			return func() { t.Stop() }
		}
	}
	if deps.Changed == nil {
		deps.Changed = func() {}
	}
	return &CodexCollector{deps: deps}
}

// Get is get(): nil while inactive.
func (c *CodexCollector) Get() *CodexQuota {
	if !c.deps.Route() {
		c.Stop()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.active {
		return nil
	}
	q := c.value
	q.Stale = q.Stale || (q.LastSuccess != nil && c.deps.Now()-*q.LastSuccess >= 2*CodexInterval)
	return &q
}

// Reconcile is reconcile(): start polling on the native route, stop off it.
func (c *CodexCollector) Reconcile() {
	if !c.deps.Route() {
		c.Stop()
		return
	}
	c.mu.Lock()
	if c.active {
		c.mu.Unlock()
		return
	}
	c.active = true
	c.mu.Unlock()
	c.deps.Go(c.refresh)
}

// Stop is stop().
func (c *CodexCollector) Stop() {
	c.mu.Lock()
	c.stopLocked()
	c.mu.Unlock()
}

func (c *CodexCollector) stopLocked() {
	c.active = false
	c.generation++
	if c.stopTimer != nil {
		c.stopTimer()
		c.stopTimer = nil
	}
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	c.requesting = false
	c.identity = ""
	c.value = CodexQuota{}
	c.nextRefresh = 0
}

var errCodexQuota = errors.New("quota unavailable")

func (c *CodexCollector) refresh() {
	if !c.deps.Route() {
		c.Stop()
		return
	}
	c.mu.Lock()
	if !c.active {
		c.stopLocked()
		c.mu.Unlock()
		return
	}
	if c.requesting {
		c.mu.Unlock()
		return
	}
	generation := c.generation
	ctx, cancel := context.WithTimeout(context.Background(), CodexTimeout)
	c.cancel = cancel
	c.requesting = true
	c.mu.Unlock()
	defer cancel()

	current := func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.active && generation == c.generation && ctx.Err() == nil
	}
	delay := float64(CodexInterval)
	authResolved := false
	c.deps.Changed()
	err := func() error {
		token, err := c.deps.Token(ctx)
		if err != nil {
			return err
		}
		if !current() {
			return nil
		}
		authResolved = true
		if token == "" {
			c.mu.Lock()
			c.identity, c.value = "", CodexQuota{}
			c.mu.Unlock()
			return nil
		}
		account := CodexAccountID(token)
		identity := "account:" + account
		if account == "" {
			sum := sha256.Sum256([]byte(token))
			identity = "token:" + hex.EncodeToString(sum[:])
		}
		c.mu.Lock()
		changed := identity != c.identity
		if changed {
			c.identity, c.value = identity, CodexQuota{}
		}
		c.mu.Unlock()
		if changed {
			c.deps.Changed()
		}
		headers := map[string]string{
			"Authorization": "Bearer " + token,
			"Accept":        "application/json",
			"originator":    "pi",
		}
		if account != "" {
			headers["ChatGPT-Account-Id"] = account
		}
		response, err := c.deps.Fetch(ctx, CodexEndpoint, headers)
		if err != nil {
			return err
		}
		if !current() {
			return nil
		}
		if response.Status == 401 || response.Status == 403 {
			c.mu.Lock()
			c.identity, c.value = "", CodexQuota{}
			c.mu.Unlock()
			return nil
		}
		if response.Status == 429 {
			delay = CodexRetryDelay(response.RetryAfter, c.deps.Now(), ParseHTTPDate)
		}
		if response.Status < 200 || response.Status > 299 {
			return errCodexQuota
		}
		var payload any
		if err := json.Unmarshal(response.Body, &payload); err != nil {
			return err
		}
		if !current() {
			return nil
		}
		parsed := ParseCodexQuota(payload)
		if parsed == nil {
			return errCodexQuota
		}
		now := c.deps.Now()
		parsed.LastSuccess = &now
		parsed.Stale = false
		c.mu.Lock()
		c.value = *parsed
		c.mu.Unlock()
		return nil
	}()
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	c.mu.Lock()
	if err != nil && generation == c.generation {
		if !authResolved && !timedOut {
			c.identity, c.value = "", CodexQuota{}
		} else {
			c.value.Stale = c.value.LastSuccess != nil
		}
	}
	if generation != c.generation {
		c.mu.Unlock()
		return
	}
	c.requesting = false
	c.cancel = nil
	c.mu.Unlock()
	if !c.deps.Route() {
		c.Stop()
		return
	}
	c.deps.Changed()
	c.mu.Lock()
	c.nextRefresh = c.deps.Now() + delay
	c.scheduleLocked(generation)
	c.mu.Unlock()
}

// NextRefresh is the epoch ms of the next poll (0 when none is scheduled).
func (c *CodexCollector) NextRefresh() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nextRefresh
}

func (c *CodexCollector) scheduleLocked(generation int) {
	wait := math.Min(CodexInterval, math.Max(0, c.nextRefresh-c.deps.Now()))
	c.stopTimer = c.deps.After(wait, func() {
		c.mu.Lock()
		if generation != c.generation {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		if !c.deps.Route() {
			c.Stop()
			return
		}
		c.deps.Changed()
		c.mu.Lock()
		due := c.deps.Now() >= c.nextRefresh
		if !due {
			c.scheduleLocked(generation)
		}
		c.mu.Unlock()
		if due {
			c.deps.Go(c.refresh)
		}
	})
}
