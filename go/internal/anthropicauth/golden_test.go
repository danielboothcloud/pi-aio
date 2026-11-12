package anthropicauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func loadGolden(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g map[string]json.RawMessage
	if err = json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	return g
}
func decode[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func equalJSON(t *testing.T, got any, want any) {
	t.Helper()
	g, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	w, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var gv, wv any
	if err = json.Unmarshal(g, &gv); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(w, &wv); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gv, wv) {
		t.Fatalf("got %s\nwant %s", g, w)
	}
}

// The fixtures call exact v3.4.4 TypeScript functions. No expected payload is
// produced by the Go implementation (including sampled-surrogate hashes).
func TestUpstreamGoldenShaping(t *testing.T) {
	g := loadGolden(t)
	for i, c := range decode[[]struct {
		Input  string
		Chunks []PromptChunk
		Shaped string
	}](t, g["prompts"]) {
		t.Run(fmt.Sprintf("prompt-%d", i), func(t *testing.T) {
			chunks := ParseSystemPromptChunks(c.Input)
			equalJSON(t, chunks, c.Chunks)
			if got := RenderSystemPromptChunks(chunks); got != RenderSystemPromptChunks(c.Chunks) {
				t.Fatalf("parser render mismatch %q", got)
			}
			if got := ShapeSystemPrompt(c.Input, nil); got != c.Shaped {
				t.Fatalf("got %q\nwant %q", got, c.Shaped)
			}
		})
	}
	for i, c := range decode[[]struct {
		Input  string
		Result *string
	}](t, g["updates"]) {
		t.Run(fmt.Sprintf("update-%d", i), func(t *testing.T) {
			got, keep := ShapeSystemUpdateText(c.Input)
			if keep != (c.Result != nil) || (keep && got != *c.Result) {
				t.Fatalf("got %q/%v want %v", got, keep, c.Result)
			}
		})
	}
	for i, c := range decode[[]struct{ Text, Version, Result string }](t, g["billingCases"]) {
		t.Run(fmt.Sprintf("billing-%d", i), func(t *testing.T) {
			if got := BuildBillingHeaderValue(c.Text, c.Version); got != c.Result {
				t.Fatalf("got %q want %q", got, c.Result)
			}
		})
	}
	for i, c := range decode[[]struct{ Input, Result any }](t, g["payloads"]) {
		t.Run(fmt.Sprintf("payload-%d", i), func(t *testing.T) {
			before, _ := json.Marshal(c.Input)
			equalJSON(t, ShapePayload(c.Input, ClaudeCodeVersion, nil), c.Result)
			after, _ := json.Marshal(c.Input)
			if string(before) != string(after) {
				t.Fatal("mutated source payload")
			}
		})
	}
}
func TestUpstreamGoldenVersionsAndConfig(t *testing.T) {
	g := loadGolden(t)
	for _, c := range decode[[]struct{ Input, Result, Error string }](t, g["overrides"]) {
		got, err := ResolveClaudeCodeVersion(c.Input)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Fatalf("override %q: %v want %s", c.Input, err, c.Error)
			}
		} else if err != nil || got != c.Result {
			t.Fatalf("override %q: %q/%v", c.Input, got, err)
		}
	}
	for _, c := range decode[[]struct{ Input, Result string }](t, g["userAgents"]) {
		if got := ReadClaudeCliVersion(c.Input); got != c.Result {
			t.Errorf("UA %q got %q want %q", c.Input, got, c.Result)
		}
	}
	for _, c := range decode[[]struct{ Baseline, Candidate, Result string }](t, g["higher"]) {
		if got := HigherVersion(c.Baseline, c.Candidate); got != c.Result {
			t.Errorf("higher %s/%s got %s want %s", c.Baseline, c.Candidate, got, c.Result)
		}
	}
	for i, c := range decode[[]struct {
		Input  string
		Result LoadedConfig
	}](t, g["configs"]) {
		t.Run(fmt.Sprintf("config-%d", i), func(t *testing.T) { equalJSON(t, ParseConfig(c.Input, "/oracle/config.json"), c.Result) })
	}
	for i, c := range decode[[]struct {
		Input  string
		Result *struct {
			Required   string
			Hinted     any
			HintedText string
		}
	}](t, g["rejections"]) {
		t.Run(fmt.Sprintf("rejection-%d", i), func(t *testing.T) {
			r := ReadVersionRejection([]byte(c.Input))
			if c.Result == nil {
				if r != nil {
					t.Fatal("unexpected rejection")
				}
				return
			}
			if r == nil || r.RequiredVersion != c.Result.Required {
				t.Fatal("required floor mismatch")
			}
			equalJSON(t, decode[any](t, r.WithHint("independent hint")), c.Result.Hinted)
			if got := string(r.WithHint("independent hint")); got != c.Result.HintedText {
				t.Fatalf("hinted body bytes got %s want %s", got, c.Result.HintedText)
			}
		})
	}
	for _, c := range decode[[]struct {
		Input  RecoveryHintReason
		Result string
	}](t, g["hints"]) {
		if got := DescribeRecoveryHint(c.Input); got != c.Result {
			t.Fatalf("hint got %q want %q", got, c.Result)
		}
	}
}

type syncSpec struct {
	Name, UA, Override, Floor, Body string
	Record                          *bool
	Required                        []*string
	Other400, Opaque                bool
}
type syncCase struct {
	Spec                                      syncSpec
	Original                                  any
	Initial                                   string
	Sent                                      []string
	Status                                    int
	Text, Floor                               string
	RequestID, ContentLength, ContentEncoding *string
}

func versionError(required *string) string {
	message := "Model unsupported."
	if required != nil {
		message = "Claude Code 2.1.260 does not support this model; version " + *required + " or newer is required."
	}
	b, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": "invalid_request_error", "message": message, "details": map[string]any{"error_code": "claude_code_version_too_old"}}, "request_id": "req_oracle"})
	return string(b)
}
func TestUpstreamGoldenBillingVersionSync(t *testing.T) {
	for _, c := range decode[[]syncCase](t, loadGolden(t)["syncCases"]) {
		t.Run(c.Spec.Name, func(t *testing.T) {
			floor := &LearnedFloor{}
			floor.Learn(c.Spec.Floor)
			sent := []string{}
			closed := []*trackedBody{}
			fetch := func(req *http.Request) (*http.Response, error) {
				body, err := io.ReadAll(req.Body)
				if err != nil {
					return nil, err
				}
				req.Body.Close()
				value := string(body)
				if c.Spec.Opaque {
					value = "<opaque>"
				}
				sent = append(sent, value)
				status, text := 200, "streamed"
				headers := http.Header{}
				if len(sent) <= len(c.Spec.Required) {
					status = 400
					text = versionError(c.Spec.Required[len(sent)-1])
					headers.Set("request-id", "req_oracle")
					headers.Set("content-length", "123")
					headers.Set("content-encoding", "identity")
				} else if c.Spec.Other400 {
					status = 400
					text = "other400"
				}
				bodyReader := &trackedBody{Reader: strings.NewReader(text)}
				closed = append(closed, bodyReader)
				return &http.Response{StatusCode: status, Header: headers, Body: bodyReader}, nil
			}
			sync := NewBillingVersionSync(floor, fetch, func() string { return c.Spec.Override }, nil)
			if c.Spec.Record == nil || *c.Spec.Record {
				sync.RecordRequest(c.Original)
			}
			req, err := http.NewRequestWithContext(context.Background(), "POST", "https://oracle.invalid/messages", strings.NewReader(c.Initial))
			if err != nil {
				t.Fatal(err)
			}
			if c.Spec.Opaque {
				req.Body = io.NopCloser(strings.NewReader("\x01\x02\x03"))
				req.GetBody = nil
			}
			req.Header.Set("user-agent", c.Spec.UA)
			response, err := sync.Fetch(req)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			equalJSON(t, sent, c.Sent)
			if response.StatusCode != c.Status {
				t.Fatalf("status %d want %d", response.StatusCode, c.Status)
			}
			if json.Valid([]byte(c.Text)) {
				equalJSON(t, decode[any](t, data), decode[any](t, []byte(c.Text)))
			} else if string(data) != c.Text {
				t.Fatalf("body %s want %s", data, c.Text)
			}
			if got := floor.ApplyTo("1.0.0"); got != c.Floor {
				t.Fatalf("floor %s want %s", got, c.Floor)
			}
			for key, want := range map[string]*string{"request-id": c.RequestID, "content-length": c.ContentLength, "content-encoding": c.ContentEncoding} {
				expected := ""
				if want != nil {
					expected = *want
				}
				if response.Header.Get(key) != expected {
					t.Errorf("header %s mismatch", key)
				}
			}
			for _, b := range closed {
				if b.closes != 1 {
					t.Errorf("response body closed %d times", b.closes)
				}
			}
		})
	}
}

type trackedBody struct {
	io.Reader
	closes int
}

func (b *trackedBody) Close() error { b.closes++; return nil }

func TestUpstreamGoldenOAuthWrapper(t *testing.T) {
	g := loadGolden(t)
	payloads := decode[[]struct{ Input any }](t, g["payloads"])
	base := payloads[3].Input
	for _, c := range decode[[]struct {
		Key, Action, Error string
		Result             any
		Calls              []string
		FetchWrapped       bool
	}](t, g["wrappers"]) {
		t.Run(c.Key+"/"+c.Action, func(t *testing.T) {
			calls := []string{}
			var captured StreamOptions
			delegate := func(model, transcript map[string]any, o StreamOptions) (string, error) {
				captured = o
				return "stream", nil
			}
			wrapper := WrapStreamSimple[string](delegate, nil, nil)
			originalFetch := FetchFunc(func(*http.Request) (*http.Response, error) { return nil, nil })
			options := StreamOptions{Values: map[string]any{"apiKey": c.Key, "onResponse": "opaque-callback", "unknown": 42}, Signal: context.Background(), Fetch: originalFetch}
			if c.Action != "none" {
				options.OnPayload = func(p any, _ map[string]any) (any, error) {
					calls = append(calls, "caller")
					switch c.Action {
					case "throw":
						return nil, errors.New("caller failed")
					case "mutate":
						record(p)["extra"] = "mutated"
						return nil, nil
					case "replace":
						copy := maps.Clone(record(p))
						copy["extra"] = "replaced"
						return copy, nil
					}
					return nil, nil
				}
			}
			if result, err := wrapper(map[string]any{"api": "anthropic-messages"}, map[string]any{}, options); err != nil || result != "stream" {
				t.Fatal(result, err)
			}
			input := decode[any](t, mustJSON(t, base))
			result, err := captured.OnPayload(input, map[string]any{})
			if c.Error != "" {
				if err == nil || err.Error() != c.Error {
					t.Fatalf("got %v want %s", err, c.Error)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				equalJSON(t, result, c.Result)
			}
			equalJSON(t, calls, c.Calls)
			equalJSON(t, captured.Values, options.Values)
			if captured.Signal != options.Signal {
				t.Fatal("signal lost")
			}
			wrapped := reflect.ValueOf(captured.Fetch).Pointer() != reflect.ValueOf(originalFetch).Pointer()
			if wrapped != c.FetchWrapped {
				t.Fatal("fetch wrapper OAuth gating mismatch")
			}
		})
	}
}
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func TestUpstreamGoldenAccountPrivacy(t *testing.T) {
	g := loadGolden(t)
	for _, c := range decode[[]struct {
		Text   string
		Result AccountLookup
	}](t, g["profileCases"]) {
		got, err := LookupProviderAccount(context.Background(), "anthropic-2", func(string) (string, error) { return "sk-ant-oat-fake", nil }, func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(c.Text))}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		equalJSON(t, got, c.Result)
	}
	body := decode[map[string]any](t, g["profileBody"])
	profile := ParseProfile(body)
	expected := decode[AccountLookup](t, g["profile"])
	equalJSON(t, profile, expected.Profile)
	d := Diagnostics{Version: "3.4.4", ModulePath: "/oracle/anthropic-auth", TransportResolved: true, ShapedProviders: []ShapedProvider{{"anthropic-2", "global"}, {"anthropic-3", "project"}}, ConfigWarnings: []string{"config warning"}}
	for _, c := range decode[[]struct {
		IncludeIdentity bool
		Result          string
	}](t, g["reports"]) {
		report := &AccountsReport{IncludeIdentity: c.IncludeIdentity, Accounts: []ProviderAccount{{"anthropic", expected}, {"anthropic-2", AccountLookup{Kind: "not-oauth"}}, {"anthropic-3", AccountLookup{Kind: "unavailable", Reason: "HTTP 401"}}}}
		if got := FormatDiagnosticsReport(d, report); got != c.Result {
			t.Fatalf("report got %q want %q", got, c.Result)
		}
		if !c.IncludeIdentity && (strings.Contains(c.Result, "personal@example.test") || strings.Contains(c.Result, "Personal Org")) {
			t.Fatal("identity leak")
		}
	}
	for _, c := range decode[[]struct {
		Input  string
		Result []ArgumentCompletion
	}](t, g["completions"]) {
		equalJSON(t, StatusArgumentCompletions(c.Input), c.Result)
	}
}
