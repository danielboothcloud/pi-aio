package hypa

// The lazy `hypa_mcp_proxy` bridge (port of hypa/mcp-proxy-bridge.ts):
// discovery and invocation of the upstream MCP servers configured in Hypa,
// through `hypa mcp ...`. Off by default (mcpProxyEnabled /
// HYPA_PI_ENABLE_MCP_PROXY). Servers that Pi configures directly (its
// mcp.json) are hidden unless includeDuplicates is set.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// The bridge tool's registration.
const (
	McpProxyTool        = "hypa_mcp_proxy"
	McpProxyDescription = "Discover and invoke upstream MCP servers configured in Hypa via Hypa's proxy/passthrough service. This lazy bridge does not register every upstream MCP tool in Pi context."
	McpProxySnippet     = "Discover Hypa-configured upstream MCP connections and invoke selected tools on demand."
)

// McpProxyGuidelines are the bridge's prompt guidelines.
var McpProxyGuidelines = []string{
	"Use action=list or action=search first to discover Hypa upstream MCP connections compactly.",
	"Use action=schema only for a selected server/tool when details are needed.",
	"Prefer Pi's directly configured MCP tools when the server is marked as already configured in Pi.",
}

// McpProxySchema is bridgeSchema.
func McpProxySchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{"type": "string", "enum": []string{"list", "search", "schema", "invoke", "auth_check"},
				"description": "Proxy operation over upstream MCP servers configured in Hypa."},
			"query":     map[string]any{"type": "string", "description": "Search query for action=search."},
			"server":    map[string]any{"type": "string", "description": "Hypa upstream MCP server name for schema/invoke/auth_check."},
			"tool":      map[string]any{"type": "string", "description": "Upstream tool name for action=invoke."},
			"arguments": map[string]any{"description": "JSON object or JSON string of arguments for action=invoke."},
			"hint": map[string]any{"type": "string", "enum": []string{"raw", "summary", "structured"},
				"description": "Compression hint for action=invoke."},
			"includeDuplicates": map[string]any{"type": "boolean",
				"description": "Include Hypa upstream servers that appear to be configured directly in Pi. Default false."},
			"timeoutMs": map[string]any{"type": "number", "description": "Per-call timeout in milliseconds."},
		},
		"required":             []string{"action"},
		"additionalProperties": false,
	}
}

// McpRun is one `hypa mcp` process result (Pi's exec result).
type McpRun struct {
	Stdout, Stderr string
	Code           int
	Killed         bool
}

// McpRunner runs `hypa` with args ("mcp", ...) and a timeout in milliseconds.
type McpRunner func(args []string, timeoutMs int) (McpRun, error)

// McpResult is executeMcpProxyAction's result: the tool text and the data
// kept in the details.
type McpResult struct {
	Text string
	Data any
}

// typeError is a JavaScript TypeError the reference throws on odd JSON.
type typeError string

func (e typeError) Error() string { return string(e) }

// PiMcpServerNames is loadPiMcpServerNames: the lowercased server names in
// Pi's mcp.json (mcpServers, mcp_servers, or servers; an object's keys or
// an array's names). The default path is ~/.pi/agent/mcp.json.
func PiMcpServerNames(path, home string) map[string]bool {
	if path == "" {
		path = filepath.Join(home, ".pi", "agent", "mcp.json")
	}
	names := map[string]bool{}
	data, err := os.ReadFile(path)
	if err != nil {
		return names
	}
	var root any
	if json.Unmarshal(data, &root) != nil {
		return map[string]bool{}
	}
	obj, ok := root.(map[string]any)
	if !ok {
		// JSON.parse of a non-object: root.mcpServers is undefined (or a
		// null root throws, which the reference catches).
		return names
	}
	for _, key := range []string{"mcpServers", "mcp_servers", "servers"} {
		switch value := obj[key].(type) {
		case map[string]any:
			for name := range value {
				if trim(name) != "" {
					names[strings.ToLower(trim(name))] = true
				}
			}
		case []any:
			// Object.keys of an array: its indexes.
			for i, item := range value {
				names[fmt.Sprint(i)] = true
				if entry, ok := item.(map[string]any); ok {
					if name, ok := entry["name"].(string); ok && trim(name) != "" {
						names[strings.ToLower(trim(name))] = true
					}
				}
			}
		}
	}
	return names
}

func isDuplicateName(name string, names map[string]bool) bool {
	return names[strings.ToLower(trim(name))]
}

// nameOf is `item.name ?? item.serverName ?? ""` as a string; ok is false
// when the value is not a string (the reference's .trim() throws).
func nameOf(item any, keys ...string) (string, error) {
	entry, _ := item.(map[string]any)
	var value any
	for _, key := range keys {
		if v, present := entry[key]; present && v != nil {
			value = v
			break
		}
	}
	if value == nil {
		if len(keys) == 1 {
			return "", typeError("Cannot read properties of undefined (reading 'trim')")
		}
		return "", nil
	}
	s, ok := value.(string)
	if !ok {
		return "", typeError("serverName.trim is not a function")
	}
	return s, nil
}

// filterServers is filterDuplicateServers on a decoded JSON array.
func filterServers(items any, names map[string]bool, includeDuplicates bool) (any, error) {
	if includeDuplicates {
		return items, nil
	}
	list, ok := items.([]any)
	if !ok {
		return nil, typeError("items.filter is not a function")
	}
	out := []any{}
	for _, item := range list {
		if item == nil {
			return nil, typeError("Cannot read properties of null (reading 'name')")
		}
		name, err := nameOf(item, "name", "serverName")
		if err != nil {
			return nil, err
		}
		if !isDuplicateName(name, names) {
			out = append(out, item)
		}
	}
	return out, nil
}

func iterate(items any, what string) ([]any, error) {
	list, ok := items.([]any)
	if !ok {
		return nil, typeError(what + " is not iterable")
	}
	return list, nil
}

// orText is `${value ?? fallback}`.
func orText(entry map[string]any, key, fallback string) string {
	value, present := entry[key]
	if !present || value == nil {
		return fallback
	}
	return jsValue(value)
}

// jsValue is String(value) for a template literal (numbers as JavaScript
// prints them).
func jsValue(value any) string {
	if f, ok := value.(float64); ok {
		return jsstr.NumberJS(f)
	}
	if value == nil {
		return "undefined"
	}
	return jsString(value)
}

func field(item any, key string) string {
	entry, _ := item.(map[string]any)
	value, present := entry[key]
	if !present {
		return "undefined"
	}
	if value == nil {
		return "null"
	}
	return jsValue(value)
}

func formatList(items any, names map[string]bool) (string, error) {
	list, err := iterate(items, "items")
	if err != nil {
		return "", err
	}
	if len(list) == 0 {
		return "No Hypa upstream MCP servers available after Pi deduplication.", nil
	}
	lines := []string{"Hypa upstream MCP servers:"}
	for _, item := range list {
		entry, _ := item.(map[string]any)
		name, err := nameOf(item, "name")
		if err != nil {
			return "", err
		}
		duplicate := ""
		if isDuplicateName(name, names) {
			duplicate = " [also configured directly in Pi]"
		}
		lines = append(lines, fmt.Sprintf("- %s%s: %s %s auth=%s", name, duplicate, orText(entry, "transport", "unknown"),
			orText(entry, "endpoint", "—"), orText(entry, "auth", "unknown")))
	}
	return strings.Join(lines, "\n"), nil
}

func formatSearch(results any) (string, error) {
	list, err := iterate(results, "results")
	if err != nil {
		return "", err
	}
	if len(list) == 0 {
		return "No matching Hypa upstream MCP tools after Pi deduplication.", nil
	}
	lines := []string{fmt.Sprintf("Found %d Hypa upstream MCP tool(s):", len(list))}
	for _, item := range list {
		entry, _ := item.(map[string]any)
		score := ""
		if value, present := entry["score"]; present {
			switch v := value.(type) {
			case float64:
				score = " score=" + jsstr.ToFixed(v, 2)
			case nil:
				return "", typeError("Cannot read properties of null (reading 'toFixed')")
			default:
				return "", typeError("r.score.toFixed is not a function")
			}
		}
		lines = append(lines, fmt.Sprintf("- %s/%s%s: %s", field(item, "serverName"), field(item, "toolName"), score, field(item, "description")))
	}
	return strings.Join(lines, "\n"), nil
}

func formatSchema(manifest json.RawMessage, names map[string]bool, includeDuplicates bool) (string, error) {
	obj, _ := jsstr.DecodeObject(manifest)
	raw, present := obj.Values["servers"]
	if !present || strings.TrimSpace(string(raw)) == "null" {
		raw = json.RawMessage("[]")
	}
	var rawServers []json.RawMessage
	if json.Unmarshal(raw, &rawServers) != nil {
		// Not an array: filter() or for-of fails as in JavaScript.
		if !includeDuplicates {
			return "", typeError("items.filter is not a function")
		}
		return "", typeError("servers is not iterable")
	}
	type server struct {
		item any
		raw  json.RawMessage
	}
	var visible []server
	for _, r := range rawServers {
		item := decode(r)
		if !includeDuplicates {
			if item == nil {
				return "", typeError("Cannot read properties of null (reading 'name')")
			}
			name, err := nameOf(item, "name", "serverName")
			if err != nil {
				return "", err
			}
			if isDuplicateName(name, names) {
				continue
			}
		}
		visible = append(visible, server{item, r})
	}
	if len(visible) == 0 {
		return "No Hypa upstream MCP schemas available after Pi deduplication.", nil
	}
	lines := []string{"Hypa upstream MCP schema:"}
	for _, s := range visible {
		name, err := nameOf(s.item, "serverName")
		if err != nil {
			return "", err
		}
		duplicate := ""
		if isDuplicateName(name, names) {
			duplicate = " [also configured directly in Pi]"
		}
		entry, _ := s.item.(map[string]any)
		toolsValue, hasTools := entry["tools"]
		tools, ok := toolsValue.([]any)
		if !ok {
			switch {
			case !hasTools:
				return "", typeError("Cannot read properties of undefined (reading 'length')")
			case toolsValue == nil:
				return "", typeError("Cannot read properties of null (reading 'length')")
			}
			return "", typeError("server.tools is not iterable")
		}
		lines = append(lines, fmt.Sprintf("- %s%s (%d tool(s))", name, duplicate, len(tools)))
		serverObj, _ := jsstr.DecodeObject(s.raw)
		var rawTools []json.RawMessage
		_ = json.Unmarshal(serverObj.Values["tools"], &rawTools)
		for i, tool := range tools {
			lines = append(lines, fmt.Sprintf("  - %s: %s", field(tool, "name"), field(tool, "description")))
			if i < len(rawTools) {
				toolObj, _ := jsstr.DecodeObject(rawTools[i])
				if schema, present := toolObj.Values["inputSchema"]; present {
					lines = append(lines, "    inputSchema: "+jsonText(schema))
				}
			}
		}
	}
	if errs, ok := obj.Values["errors"]; ok {
		var list []any
		if json.Unmarshal(errs, &list) == nil && len(list) > 0 {
			lines = append(lines, "Warnings:")
			for _, item := range list {
				lines = append(lines, fmt.Sprintf("- %s %s: %s", field(item, "serverName"), field(item, "code"), field(item, "message")))
			}
		}
	}
	return strings.Join(lines, "\n"), nil
}

// jsonText is JSON.stringify(value, null, 2) in JavaScript key order.
func jsonText(raw json.RawMessage) string {
	return jsstr.StringifyIndent([]byte(jsstr.CanonicalJSON(raw)), "  ")
}

func formatInvoke(result any) string {
	entry, _ := result.(map[string]any)
	if jsstr.Truthy(entry["isError"]) {
		code, message := "unknown", "Tool invocation failed."
		if e, ok := entry["error"].(map[string]any); ok {
			if v, present := e["code"]; present && v != nil {
				code = jsValue(v)
			}
			if v, present := e["message"]; present && v != nil {
				message = jsValue(v)
			}
		}
		return fmt.Sprintf("Hypa MCP proxy error for %s/%s: %s: %s", field(result, "serverName"), field(result, "toolName"), code, message)
	}
	if response, present := entry["compressedResponse"]; present && jsstr.Truthy(response) {
		return jsValue(response)
	}
	return fmt.Sprintf("(Hypa MCP proxy invocation %s/%s returned no content)", field(result, "serverName"), field(result, "toolName"))
}

// asJSONArgument is asJsonArgument on the ordered tool input's "arguments".
func asJSONArgument(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "{}"
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if t := trim(s); t != "" {
			return t
		}
		return "{}"
	}
	return jsstr.CanonicalJSON(raw)
}

// parseMcpJSON is parseJson: killed, empty, and invalid output are errors.
func parseMcpJSON(run McpRun, operation string) (json.RawMessage, error) {
	if run.Killed {
		return nil, fmt.Errorf("%s timed out or was killed", operation)
	}
	if trim(run.Stdout) == "" {
		detail := trim(run.Stderr)
		if detail == "" {
			detail = fmt.Sprintf("exit code %d", run.Code)
		}
		return nil, fmt.Errorf("%s produced no JSON (%s)", operation, detail)
	}
	if message := jsstr.V8JSONError(run.Stdout); message != "" {
		return nil, fmt.Errorf("%s produced invalid JSON: %s", operation, message)
	}
	return json.RawMessage(run.Stdout), nil
}

func decode(raw json.RawMessage) any {
	var value any
	_ = json.Unmarshal(raw, &value)
	return value
}

// McpInput is the bridge call: the decoded params and the tool input as
// ordered JSON (for the invoke arguments).
type McpInput struct {
	Params map[string]any
	Raw    json.RawMessage
}

// ExecuteMcpProxy is executeMcpProxyAction.
func ExecuteMcpProxy(config Config, in McpInput, home string, run McpRunner) (McpResult, error) {
	params := in.Params
	action, _ := params["action"].(string)
	includeDuplicates := params["includeDuplicates"] == true
	names := PiMcpServerNames(config.PiMcpConfigPath, home)
	timeout := config.McpProxyTimeoutMs
	if t, ok := params["timeoutMs"].(float64); ok {
		timeout = int(math.Max(1, math.Floor(t)))
	}
	call := func(args ...string) (json.RawMessage, error) {
		result, err := run(append([]string{"mcp"}, args...), timeout)
		if err != nil {
			return nil, err
		}
		return parseMcpJSON(result, "hypa mcp "+strings.Join(args, " "))
	}
	str := func(key string) (string, bool) {
		s, ok := params[key].(string)
		return s, ok && trim(s) != ""
	}
	switch action {
	case "list":
		raw, err := call("list", "--json")
		if err != nil {
			return McpResult{}, err
		}
		visible, err := filterServers(decode(raw), names, includeDuplicates)
		if err != nil {
			return McpResult{}, err
		}
		text, err := formatList(visible, names)
		return McpResult{Text: text, Data: visible}, err
	case "search":
		query, ok := str("query")
		if !ok {
			return McpResult{}, fmt.Errorf("action=search requires query")
		}
		raw, err := call("search", "--query", query, "--json")
		if err != nil {
			return McpResult{}, err
		}
		visible, err := filterServers(decode(raw), names, includeDuplicates)
		if err != nil {
			return McpResult{}, err
		}
		text, err := formatSearch(visible)
		return McpResult{Text: text, Data: visible}, err
	case "schema":
		args := []string{"schema"}
		if server, ok := str("server"); ok {
			args = append(args, "--server", server)
		}
		raw, err := call(append(args, "--json")...)
		if err != nil {
			return McpResult{}, err
		}
		text, err := formatSchema(raw, names, includeDuplicates)
		return McpResult{Text: text, Data: decode(raw)}, err
	case "invoke":
		server, ok := str("server")
		if !ok {
			return McpResult{}, fmt.Errorf("action=invoke requires server")
		}
		tool, ok := str("tool")
		if !ok {
			return McpResult{}, fmt.Errorf("action=invoke requires tool")
		}
		if !includeDuplicates && isDuplicateName(server, names) {
			return McpResult{
				Text: fmt.Sprintf("Server '%s' appears to be configured directly in Pi. Use Pi's direct MCP tool or set includeDuplicates=true to invoke through Hypa anyway.", server),
				Data: map[string]any{"duplicate": true, "serverName": server},
			}, nil
		}
		var arguments json.RawMessage
		if obj, ok := jsstr.DecodeObject(in.Raw); ok {
			arguments = obj.Values["arguments"]
		}
		args := []string{"invoke", "--server", server, "--tool", tool, "--arguments", asJSONArgument(arguments), "--json"}
		if hint, ok := str("hint"); ok {
			args = append(args, "--hint", hint)
		}
		raw, err := call(args...)
		if err != nil {
			return McpResult{}, err
		}
		result := decode(raw)
		return McpResult{Text: formatInvoke(result), Data: result}, nil
	case "auth_check":
		server, ok := str("server")
		if !ok {
			return McpResult{}, fmt.Errorf("action=auth_check requires server")
		}
		raw, err := call("auth", "check", "--server", server, "--json")
		if err != nil {
			return McpResult{}, err
		}
		return McpResult{Text: jsonText(raw), Data: decode(raw)}, nil
	}
	return McpResult{}, fmt.Errorf("Unknown Hypa MCP proxy action: %s", jsValue(params["action"]))
}

// McpProxyResult is the bridge tool's execute: errors become a text result
// with the message, never a thrown tool error.
func McpProxyResult(action any, result McpResult, err error) (string, map[string]any) {
	details := map[string]any{"source": "hypa-mcp-proxy", "action": action}
	if err != nil {
		details["error"] = err.Error()
		return "Hypa MCP proxy bridge error: " + err.Error(), details
	}
	details["data"] = result.Data
	return result.Text, details
}
