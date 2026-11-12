package anthropicauth

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// BillingVersionSync belongs to one request. RecordRequest completes before
// Fetch; only LearnedFloor is shared between concurrent requests.
type BillingVersionSync struct {
	firstUserText string
	floor         *LearnedFloor
	dispatch      FetchFunc
	override      func() string
	observer      *Observer
}

func NewBillingVersionSync(floor *LearnedFloor, base FetchFunc, override func() string, observer *Observer) *BillingVersionSync {
	if floor == nil {
		floor = &LearnedFloor{}
	}
	if base == nil {
		base = http.DefaultClient.Do
	}
	if override == nil {
		override = func() string { return "" }
	}
	return &BillingVersionSync{floor: floor, dispatch: base, override: override, observer: observer}
}
func (s *BillingVersionSync) RecordRequest(payload any) {
	messages, _ := record(payload)["messages"].([]any)
	s.firstUserText = GetFirstUserText(messages)
}
func (s *BillingVersionSync) rebuild(body, from, to string) (string, bool) {
	if s.firstUserText == "" {
		return "", false
	}
	fromHeader := BuildBillingHeaderValue(s.firstUserText, from)
	toHeader := BuildBillingHeaderValue(s.firstUserText, to)
	if !strings.Contains(body, fromHeader) {
		return "", false
	}
	return strings.Replace(body, fromHeader, toHeader, 1), true
}
func requestWithBody(req *http.Request, body string) *http.Request {
	copy := req.Clone(req.Context())
	copy.Body = io.NopCloser(strings.NewReader(body))
	copy.ContentLength = int64(len(body))
	copy.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(body)), nil }
	return copy
}

// readReplayableBody never consumes an opaque streaming request body. Native
// JSON requests are replayable; a caller-supplied non-replayable body stays so.
func readReplayableBody(req *http.Request) (string, bool, error) {
	if req.GetBody == nil {
		return "", false, nil
	}
	body, err := req.GetBody()
	if err != nil {
		return "", false, err
	}
	defer body.Close()
	data, err := io.ReadAll(body)
	return string(data), err == nil, err
}
func inspectRejection(response *http.Response) (*VersionRejection, error) {
	if response.StatusCode != 400 || response.Body == nil {
		return nil, nil
	}
	original := response.Body
	data, err := io.ReadAll(original)
	// The caller owns the original body until a retry/hint replaces it. Restore
	// the read bytes, including on read error, so unrelated 400s stay readable.
	response.Body = &replayedBody{Reader: io.MultiReader(bytes.NewReader(data), original), closer: original}
	if err != nil {
		return nil, err
	}
	return ReadVersionRejection(data), nil
}

type replayedBody struct {
	io.Reader
	closer io.Closer
}

func (b *replayedBody) Close() error { return b.closer.Close() }
func hintedResponse(response *http.Response, r *VersionRejection, reason RecoveryHintReason) (*http.Response, error) {
	if response.Body != nil {
		if err := response.Body.Close(); err != nil {
			return nil, err
		}
	}
	copy := new(http.Response)
	*copy = *response
	copy.Header = response.Header.Clone()
	copy.Header.Del("content-length")
	copy.Header.Del("content-encoding")
	data := r.WithHint(DescribeRecoveryHint(reason))
	copy.Body = io.NopCloser(bytes.NewReader(data))
	copy.ContentLength = -1
	return copy, nil
}
func (s *BillingVersionSync) plan(r *VersionRejection, body, sent string) (string, bool, RecoveryHintReason) {
	required := r.RequiredVersion
	if jsstr.Trim(s.override()) != "" {
		version, _ := ResolveClaudeCodeVersion(s.override())
		return "", false, RecoveryHintReason{Kind: "override", OverrideVersion: version, RequiredVersion: required}
	}
	hint := RecoveryHintReason{Kind: "set-override", RequiredVersion: required}
	if required == "" {
		return "", false, hint
	}
	s.floor.Learn(required)
	rebuilt, ok := s.rebuild(body, sent, required)
	if !ok {
		return "", false, hint
	}
	if HigherVersion(sent, required) == sent {
		return "", false, RecoveryHintReason{Kind: "upgrade-pi", SentVersion: sent}
	}
	return rebuilt, true, hint
}
func (s *BillingVersionSync) Fetch(req *http.Request) (*http.Response, error) {
	pinned, err := ResolveClaudeCodeVersion(s.override())
	if err != nil {
		return nil, err
	}
	target := pinned
	if jsstr.Trim(s.override()) == "" {
		target = s.floor.ApplyTo(HigherVersion(pinned, ReadClaudeCliVersion(req.Header.Get("user-agent"))))
	}
	body, replayable, err := readReplayableBody(req)
	if err != nil {
		return nil, err
	}
	sent := pinned
	outgoing := req
	if target != pinned && replayable {
		if upgraded, ok := s.rebuild(body, pinned, target); ok {
			body = upgraded
			outgoing = requestWithBody(req, body)
			// The HTTP client now owns the replacement body, not the caller's original.
			if req.Body != nil {
				defer req.Body.Close()
			}
			sent = target
		}
	}
	response, err := s.dispatch(outgoing)
	if err != nil {
		return nil, err
	}
	rejection, err := inspectRejection(response)
	if err != nil {
		response.Body.Close()
		return nil, fmt.Errorf("read version rejection: %w", err)
	}
	if rejection == nil {
		return response, nil
	}
	retryBody, retry, reason := s.plan(rejection, body, sent)
	if !retry {
		return hintedResponse(response, rejection, reason)
	}
	s.observer.debug("claude-code-version-recovery", map[string]any{"sentVersion": sent, "requiredVersion": rejection.RequiredVersion})
	if err := response.Body.Close(); err != nil {
		return nil, err
	}
	retried, err := s.dispatch(requestWithBody(outgoing, retryBody))
	if err != nil {
		return nil, err
	}
	second, err := inspectRejection(retried)
	if err != nil {
		retried.Body.Close()
		return nil, err
	}
	if second == nil {
		return retried, nil
	}
	_, again, reason := s.plan(second, retryBody, rejection.RequiredVersion)
	if again {
		reason = RecoveryHintReason{Kind: "set-override", RequiredVersion: second.RequiredVersion}
	}
	return hintedResponse(retried, second, reason)
}
