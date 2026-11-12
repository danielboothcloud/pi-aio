package hypa

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// mcpGolden is the hypa_mcp_proxy part of golden.json, written by the real
// registerHypaMcpProxyBridge with a scripted exec.
type mcpGolden struct {
	McpNames []struct {
		File  string   `json:"file"`
		Names []string `json:"names"`
	} `json:"mcpNames"`
	McpRuns []struct {
		Name      string         `json:"name"`
		Params    map[string]any `json:"params"`
		Input     string         `json:"input"`
		Replies   []McpReply     `json:"replies"`
		McpConfig string         `json:"mcpConfig"`
		Timeout   int            `json:"timeout"`
		Calls     []struct {
			Bin     string   `json:"bin"`
			Args    []string `json:"args"`
			Timeout *float64 `json:"timeout"`
		} `json:"calls"`
		Text    string          `json:"text"`
		Details json.RawMessage `json:"details"`
	} `json:"mcpRuns"`
	McpRegistration struct {
		DisabledRegisters int `json:"disabledRegisters"`
		Tool              struct {
			Name             string          `json:"name"`
			Label            string          `json:"label"`
			Description      string          `json:"description"`
			PromptSnippet    string          `json:"promptSnippet"`
			PromptGuidelines []string        `json:"promptGuidelines"`
			Parameters       json.RawMessage `json:"parameters"`
		} `json:"tool"`
		McpFiles map[string]string `json:"mcpFiles"`
	} `json:"mcpRegistration"`
}

// McpReply is one scripted exec result.
type McpReply struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Code   int    `json:"code"`
	Killed bool   `json:"killed"`
}

func loadMcpGolden(t *testing.T) (mcpGolden, string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g mcpGolden
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for name, text := range g.McpRegistration.McpFiles {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return g, dir
}

func sameJSONValue(t *testing.T, got any, want json.RawMessage) bool {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	_ = json.Unmarshal(data, &a)
	_ = json.Unmarshal(want, &b)
	return reflect.DeepEqual(a, b)
}

func TestMcpProxyMatchesTypeScript(t *testing.T) {
	g, dir := loadMcpGolden(t)
	for _, c := range g.McpNames {
		names := PiMcpServerNames(filepath.Join(dir, c.File), "")
		var got []string
		for name := range names {
			got = append(got, name)
		}
		sort.Strings(got)
		if !same(got, c.Names) {
			t.Errorf("PiMcpServerNames(%s) = %q, TypeScript %q", c.File, got, c.Names)
		}
	}
	if len(g.McpRuns) < 30 {
		t.Fatalf("MCP proxy corpus too small: %d", len(g.McpRuns))
	}
	for _, c := range g.McpRuns {
		config := Config{Mode: "additive", Binary: "/opt/hypa", RewriteTimeoutMs: 5000, AskNonInteractive: "deny", McpProxyEnabled: true,
			McpProxyTimeoutMs: c.Timeout, PiMcpConfigPath: filepath.Join(dir, c.McpConfig)}
		replies := append([]McpReply{}, c.Replies...)
		type call struct {
			bin     string
			args    []string
			timeout int
		}
		var calls []call
		run := func(args []string, timeoutMs int) (McpRun, error) {
			bin, argv := ExecArgs(config.Binary, args, "node")
			calls = append(calls, call{bin, argv, timeoutMs})
			reply := McpReply{}
			if len(replies) > 0 {
				reply, replies = replies[0], replies[1:]
			}
			return McpRun{Stdout: reply.Stdout, Stderr: reply.Stderr, Code: reply.Code, Killed: reply.Killed}, nil
		}
		result, err := ExecuteMcpProxy(config, McpInput{Params: c.Params, Raw: json.RawMessage(c.Input)}, "", run)
		text, details := McpProxyResult(c.Params["action"], result, err)
		if text != c.Text {
			t.Errorf("%s text:\n go %q\n ts %q", c.Name, text, c.Text)
		}
		if !sameJSONValue(t, details, c.Details) {
			got, _ := json.Marshal(details)
			t.Errorf("%s details:\n go %s\n ts %s", c.Name, got, c.Details)
		}
		if len(calls) != len(c.Calls) {
			t.Errorf("%s calls: %v, TypeScript %d", c.Name, calls, len(c.Calls))
			continue
		}
		for i, want := range c.Calls {
			got := calls[i]
			if got.bin != want.Bin || !reflect.DeepEqual(got.args, want.Args) || want.Timeout == nil || float64(got.timeout) != *want.Timeout {
				t.Errorf("%s call %d: %+v, TypeScript %+v", c.Name, i, got, want)
			}
		}
	}
	tool := g.McpRegistration.Tool
	if tool.Name != McpProxyTool || tool.Label != McpProxyTool || tool.Description != McpProxyDescription ||
		tool.PromptSnippet != McpProxySnippet || !reflect.DeepEqual(tool.PromptGuidelines, McpProxyGuidelines) {
		t.Errorf("registration: %+v", tool)
	}
	if !sameJSONValue(t, McpProxySchema(), tool.Parameters) {
		got, _ := json.Marshal(McpProxySchema())
		t.Errorf("schema:\n go %s\n ts %s", got, tool.Parameters)
	}
	if g.McpRegistration.DisabledRegisters != 0 {
		t.Error("a disabled bridge must register nothing")
	}
}
