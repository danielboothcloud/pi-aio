package anthropicauth_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type exchange struct {
	Body   map[string]any
	Header http.Header
}

func success(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"fixture\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"auth-fixture\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"AUTH_OK\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
}
func fixture(t *testing.T, endpoint string) (string, []string) {
	t.Helper()
	binary := os.Getenv("AIO_ANTHROPIC_AUTH_PIG")
	if binary == "" {
		t.Skip("set AIO_ANTHROPIC_AUTH_PIG to the newly built local fork binary")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(filepath.Join(repo, "test/.anthropic-auth-work"), "integration-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	for _, name := range []string{"home", "agent", "pighome", "pihome", "tmp", "cwd"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "PIG_") || strings.HasPrefix(key, "PI_") || strings.HasPrefix(key, "ANTHROPIC_") || strings.HasPrefix(key, "AIO_AUTH_") || key == "HOME" || key == "TMPDIR" || key == "GOWORK" {
			continue
		}
		env = append(env, entry)
	}
	for key, value := range map[string]string{"HOME": "home", "PIG_HOME": "pighome", "PI_HOME": "pihome", "PIG_CODING_AGENT_DIR": "agent", "PI_CODING_AGENT_DIR": "agent", "TMPDIR": "tmp"} {
		env = append(env, key+"="+filepath.Join(root, value))
	}
	env = append(env, "AIO_AUTH_RESULT="+filepath.Join(root, "result.json"))
	write := func(name string, value any) {
		t.Helper()
		p := filepath.Join(root, "agent", name)
		os.MkdirAll(filepath.Dir(p), 0700)
		b, _ := json.Marshal(value)
		if err := os.WriteFile(p, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	providers := map[string]any{}
	for _, name := range []string{"anthropic", "anthropic-2", "anthropic-key"} {
		providers[name] = map[string]any{"api": "anthropic-messages", "baseUrl": endpoint, "models": []any{map[string]any{"id": "auth-fixture", "name": "Fixture", "reasoning": false, "input": []string{"text"}, "contextWindow": 200000, "maxTokens": 1024, "cost": map[string]int{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}}}
	}
	write("models.json", map[string]any{"providers": providers})
	write("auth.json", map[string]any{"anthropic": map[string]any{"type": "oauth", "access": "sk-ant-oat-fake-never-real", "refresh": "fake-refresh", "expires": time.Now().Add(time.Hour).UnixMilli()}, "anthropic-2": map[string]any{"type": "api_key", "key": "sk-ant-oat-fake-named"}, "anthropic-key": map[string]any{"type": "api_key", "key": "sk-ant-api-fake"}})
	write("extensions/pi-anthropic-auth/config.json", map[string]any{"providers": []string{"anthropic-2", "anthropic-key"}})
	return root, append(env, "AIO_TEST_BINARY="+binary)
}
func run(t *testing.T, root string, env []string, auth bool, aux string) map[string]any {
	t.Helper()
	var binary string
	for _, s := range env {
		if strings.HasPrefix(s, "AIO_TEST_BINARY=") {
			binary = strings.TrimPrefix(s, "AIO_TEST_BINARY=")
		}
	}
	repo, _ := filepath.Abs("../..")
	args := []string{"-ne", "-e", filepath.Join(repo, "go/anthropic-auth/testdata/driver")}
	if auth {
		args = append(args, "-e", filepath.Join(repo, "go/anthropic-auth"))
	}
	args = append(args, "--no-session", "--provider", "anthropic", "--model", "auth-fixture", "--mode", "json", "-p", "main abcdefghijklmnopqrstuvwxyz")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = filepath.Join(root, "cwd")
	cmd.Env = append(env, "AIO_AUTH_AUX="+aux)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("pig: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "AUTH_OK") {
		t.Fatalf("main prompt did not complete: %s", output)
	}
	b, err := os.ReadFile(filepath.Join(root, "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err = json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	if aux != "" && result["aux"] == nil {
		t.Fatalf("auxiliary requests did not complete: %s\n%s", b, output)
	}
	return result
}
func system(e exchange) string { b, _ := json.Marshal(e.Body["system"]); return string(b) }

// Upstream index.ts registers streamSimple without oauth/models. Both the main turn and ModelRegistry.complete must traverse it; a shared floor outlives either request.
func TestPiGMainAuxiliaryRetryAndCatalog(t *testing.T) {
	var mu sync.Mutex
	var requests []exchange
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		requests = append(requests, exchange{body, r.Header.Clone()})
		n := len(requests)
		mu.Unlock()
		if n == 2 {
			w.WriteHeader(400)
			// The rejection Anthropic sends for a gated model (upstream version-rejection.ts; the golden fixture's rejection()).
			fmt.Fprint(w, `{"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.280 does not support this model; version 9.9.9 or newer is required.","details":{"error_code":"claude_code_version_too_old"}},"request_id":"req_fixture"}`)
			return
		}
		success(w)
	}))
	defer server.Close()
	root, env := fixture(t, server.URL)
	before := run(t, root, env, false, "")
	after := run(t, root, env, true, "anthropic-2,anthropic-key,anthropic")
	if !reflect.DeepEqual(before["models"], after["models"]) || !reflect.DeepEqual(before["auth"], after["auth"]) {
		t.Fatal("wrapper changed builtin catalog or auth status")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 6 {
		t.Fatalf("want baseline + main/retry + 3 auxiliary exchanges; got %d", len(requests))
	}
	if strings.Contains(system(requests[0]), "x-anthropic-billing-header:") {
		t.Fatal("baseline unexpectedly shaped")
	}
	for _, i := range []int{1, 2, 3, 5} {
		s := system(requests[i])
		if !strings.Contains(s, "x-anthropic-billing-header:") || strings.Contains(s, "AUX_DOCS_REMOVE") {
			t.Fatalf("OAuth request %d not shaped: %s", i, s)
		}
	}
	for _, i := range []int{2, 3, 5} {
		if !strings.Contains(system(requests[i]), "cc_version=9.9.9.") {
			t.Fatalf("request %d did not retain learned floor: %s", i, system(requests[i]))
		}
	}
	if strings.Contains(system(requests[4]), "x-anthropic-billing-header:") || !strings.Contains(system(requests[4]), "AUX_DOCS_REMOVE") {
		t.Fatal("API-key request was shaped")
	}
	if requests[3].Header.Get("X-Caller-Option") != "retained" {
		t.Fatal("opaque caller headers lost")
	}
	for _, value := range after["aux"].([]any) {
		result := value.(map[string]any)["result"].(map[string]any)
		if result["stopReason"] != "stop" {
			t.Fatalf("auxiliary failed: %#v", result)
		}
	}
}

func TestPiGCallerCallbacks(t *testing.T) {
	var mu sync.Mutex
	var requests []exchange
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		requests = append(requests, exchange{body, r.Header.Clone()})
		mu.Unlock()
		success(w)
	}))
	defer server.Close()
	root, env := fixture(t, server.URL)
	result := run(t, root, append(env, "AIO_AUTH_CALLBACKS=1"), true, "anthropic-2,anthropic-key")
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 3 {
		t.Fatalf("got %d requests", len(requests))
	}
	for i, value := range result["aux"].([]any) {
		order := value.(map[string]any)["order"]
		if !reflect.DeepEqual(order, []any{"payload", "fetch", "response"}) {
			t.Fatalf("caller callbacks absent or out of order: %#v", order)
		}
		req := requests[i+1]
		if req.Header.Get("X-Caller-Fetch") != "retained" {
			t.Fatal("caller fetch lost")
		}
		b, _ := json.Marshal(req.Body["messages"])
		if !strings.Contains(string(b), "caller replacement text") {
			t.Fatal("caller replacement lost")
		}
		if i == 0 && (strings.Contains(system(req), "CALLER_DOCS_REMOVE") || !strings.Contains(system(req), "x-anthropic-billing-header:")) {
			t.Fatal("caller replacement was not shaped after callback")
		}
		if i == 1 && (!strings.Contains(system(req), "CALLER_DOCS_REMOVE") || strings.Contains(system(req), "x-anthropic-billing-header:")) {
			t.Fatal("API-key callback payload not passed through")
		}
	}
}
