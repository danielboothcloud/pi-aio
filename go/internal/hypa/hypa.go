// Package hypa is the Go port of hypa/ (vendored from @hypabolic/pi-hypa
// 0.1.15, FSL-1.1-ALv2 — see hypa/LICENSE-FSL and hypa/UPSTREAM.md). It
// holds config parsing, rewrite mapping, timeout injection, binary
// resolution, the hypa_* command builders, image sniffing, and output
// truncation. It does not import the PiG SDK; go/aio registers the tools.
package hypa

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const jsSpace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func trim(s string) string { return strings.Trim(s, jsSpace) }

// Config is HypaPiConfig.
type Config struct {
	Mode              string `json:"mode"` // "additive" or "replace"
	Binary            string `json:"binary"`
	RewriteTimeoutMs  int    `json:"rewriteTimeoutMs"`
	AskNonInteractive string `json:"askNonInteractive"` // "deny" or "allow"
	McpProxyEnabled   bool   `json:"mcpProxyEnabled"`
	McpProxyTimeoutMs int    `json:"mcpProxyTimeoutMs"`
	PiMcpConfigPath   string `json:"piMcpConfigPath,omitempty"`
}

// ParseMode is "replace" or "additive".
func ParseMode(v string) string {
	if strings.ToLower(trim(v)) == "replace" {
		return "replace"
	}
	return "additive"
}

// ParseAsk is "allow" or "deny".
func ParseAsk(v string) string {
	if strings.ToLower(trim(v)) == "allow" {
		return "allow"
	}
	return "deny"
}

var (
	decimalRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
	radixRe   = regexp.MustCompile(`^0([xXoObB])([0-9a-fA-F]+)$`)
)

// jsNumber is JavaScript's Number(string).
func jsNumber(s string) float64 {
	t := trim(s)
	switch {
	case t == "":
		return 0
	case t == "Infinity" || t == "+Infinity":
		return math.Inf(1)
	case t == "-Infinity":
		return math.Inf(-1)
	case decimalRe.MatchString(t):
		f, err := strconv.ParseFloat(t, 64)
		if err == nil {
			return f
		}
	case radixRe.MatchString(t):
		m := radixRe.FindStringSubmatch(t)
		base := map[string]int{"x": 16, "o": 8, "b": 2}[strings.ToLower(m[1])]
		if n, err := strconv.ParseUint(m[2], base, 64); err == nil {
			return float64(n)
		}
	}
	return math.NaN()
}

// ParsePositiveInteger is parsePositiveInteger.
func ParsePositiveInteger(v string, fallback int) int {
	if v == "" {
		return fallback
	}
	n := jsNumber(v)
	if n == math.Trunc(n) && !math.IsInf(n, 0) && n > 0 && n < 1<<62 {
		return int(n)
	}
	return fallback
}

// ParseBool is parseBooleanFlag.
func ParseBool(v string) bool {
	switch strings.ToLower(trim(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// Env is the environment lookup: value and whether it is set.
type Env func(key string) (string, bool)

// ConfigFilePath is resolveConfigFilePath ("" for none).
func ConfigFilePath(env Env, home string) string {
	if v, ok := env("HYPA_PI_CONFIG"); ok {
		v = trim(v)
		if v == "" || strings.ToLower(v) == "none" {
			return ""
		}
		return v
	}
	return filepath.Join(home, ".hypa-pi", "config.json")
}

// fileConfig holds the fields a config file set.
type fileConfig struct {
	mode, binary, ask, mcpPath string
	timeout, mcpTimeout        int
	mcpEnabled                 *bool
}

// LoadConfigFile is loadConfigFile. A missing file is empty; bad JSON is an error.
func loadConfigFile(path string) (fileConfig, error) {
	var fc fileConfig
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fc, nil
	}
	if err != nil {
		return fc, err
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fc, fmt.Errorf("Failed to parse config file %s: %v", path, err)
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return fc, nil
	}
	if v, ok := obj["mode"].(string); ok {
		fc.mode = ParseMode(v)
	}
	if v, ok := obj["binary"].(string); ok && trim(v) != "" {
		fc.binary = trim(v)
	}
	if v, ok := obj["rewriteTimeoutMs"].(float64); ok {
		fc.timeout = ParsePositiveInteger(strconv.FormatFloat(v, 'f', -1, 64), 0)
	}
	if v, ok := obj["askNonInteractive"].(string); ok {
		fc.ask = ParseAsk(v)
	}
	if v, ok := obj["mcpProxyEnabled"].(bool); ok {
		fc.mcpEnabled = &v
	}
	if v, ok := obj["mcpProxyTimeoutMs"].(float64); ok {
		fc.mcpTimeout = ParsePositiveInteger(strconv.FormatFloat(v, 'f', -1, 64), 0)
	}
	if v, ok := obj["piMcpConfigPath"].(string); ok && trim(v) != "" {
		fc.mcpPath = trim(v)
	}
	return fc, nil
}

// LoadConfig is loadConfig: env vars override the config file.
func LoadConfig(env Env, path string) (Config, error) {
	var fc fileConfig
	var err error
	if path != "" {
		fc, err = loadConfigFile(path)
		if err != nil {
			return Config{}, err
		}
	}
	or := func(a, b string) string {
		if a != "" {
			return a
		}
		return b
	}
	orInt := func(a, b int) int {
		if a > 0 {
			return a
		}
		return b
	}
	c := Config{Mode: or(fc.mode, "additive"), Binary: or(fc.binary, "hypa"), RewriteTimeoutMs: orInt(fc.timeout, 5000),
		AskNonInteractive: or(fc.ask, "deny"), McpProxyTimeoutMs: orInt(fc.mcpTimeout, 10000), PiMcpConfigPath: fc.mcpPath}
	if fc.mcpEnabled != nil {
		c.McpProxyEnabled = *fc.mcpEnabled
	}
	if v, ok := env("HYPA_PI_MODE"); ok {
		c.Mode = ParseMode(v)
	}
	if v, ok := env("HYPA_BIN"); ok && trim(v) != "" {
		c.Binary = trim(v)
	}
	if v, ok := env("HYPA_PI_REWRITE_TIMEOUT_MS"); ok {
		c.RewriteTimeoutMs = ParsePositiveInteger(v, 5000)
	}
	if v, ok := env("HYPA_PI_ASK_NON_INTERACTIVE"); ok {
		c.AskNonInteractive = ParseAsk(v)
	}
	flag, ok := env("HYPA_PI_ENABLE_MCP_PROXY")
	if !ok {
		flag, ok = env("HYPA_PI_ENABLE_MCP")
	}
	if ok {
		c.McpProxyEnabled = ParseBool(flag)
	}
	if v, ok := env("HYPA_PI_MCP_PROXY_TIMEOUT_MS"); ok {
		c.McpProxyTimeoutMs = ParsePositiveInteger(v, 10000)
	}
	if v, ok := env("HYPA_PI_MCP_CONFIG"); ok && trim(v) != "" {
		c.PiMcpConfigPath = trim(v)
	}
	return c, nil
}

// IsHypaCommand reports whether a command already starts with hypa.
func IsHypaCommand(command string) bool {
	t := strings.TrimLeft(command, jsSpace)
	return t == "hypa" || strings.HasPrefix(t, "hypa ")
}

// IsRtkClaimed reports whether rtk already rewrote the command.
func IsRtkClaimed(command string) bool {
	t := strings.TrimLeft(command, jsSpace)
	return t == "rtk" || strings.HasPrefix(t, "rtk ")
}

// Status is RewriteStatus.
type Status struct {
	Kind    string `json:"kind"` // rewritten, passthrough, deny, ask, skipped, error
	Outcome string `json:"outcome,omitempty"`
	Input   string `json:"input"`
	Command string `json:"command,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Error   string `json:"error,omitempty"`
}

var validOutcomes = map[string]bool{"Rewritten": true, "GenericWrapper": true, "Passthrough": true, "Deny": true, "Ask": true}

// ParseRewrite is parseRewriteJson + mapRewriteResult.
func ParseRewrite(stdout string) (Status, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(trim(stdout)), &payload); err != nil {
		return Status{}, fmt.Errorf("hypa rewrite produced invalid JSON: %v", err)
	}
	input, ok := payload["input"].(string)
	if !ok {
		return Status{}, errors.New("rewrite result missing string field: input")
	}
	outcome, ok := payload["outcome"].(string)
	if !ok || !validOutcomes[outcome] {
		return Status{}, fmt.Errorf("rewrite result has unknown outcome: %s", jsString(payload["outcome"]))
	}
	command, ok := payload["command"].(string)
	if !ok {
		return Status{}, errors.New("rewrite result missing string field: command")
	}
	switch outcome {
	case "Rewritten", "GenericWrapper":
		return Status{Kind: "rewritten", Outcome: outcome, Input: input, Command: command}, nil
	case "Passthrough":
		return Status{Kind: "passthrough", Outcome: outcome, Input: input, Command: command}, nil
	case "Deny":
		return Status{Kind: "deny", Input: input, Command: command, Reason: "Command blocked by Hypa policy: " + input}, nil
	}
	shown := command
	if shown == "" {
		shown = input
	}
	return Status{Kind: "ask", Input: input, Command: command, Reason: "Hypa requests confirmation before running: " + shown}, nil
}

// jsString is String(v) for JSON values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// RewriteOutcome interprets a `hypa rewrite --json` run.
func RewriteOutcome(input, stdout, stderr string, code int, killed bool, timeoutMs int) Status {
	if killed {
		return Status{Kind: "error", Input: input, Error: fmt.Sprintf("hypa rewrite timed out after %dms", timeoutMs)}
	}
	if trim(stdout) == "" {
		detail := trim(stderr)
		if detail == "" {
			detail = fmt.Sprintf("exit code %d", code)
		}
		return Status{Kind: "error", Input: input, Error: "hypa rewrite produced no JSON (" + detail + ")"}
	}
	status, err := ParseRewrite(stdout)
	if err != nil {
		return Status{Kind: "error", Input: input, Error: err.Error()}
	}
	return status
}

// FormatStatus is formatStatus.
func FormatStatus(s *Status) string {
	if s == nil {
		return "none"
	}
	switch s.Kind {
	case "rewritten":
		return s.Outcome + ": " + s.Input + " => " + s.Command
	case "passthrough":
		return "Passthrough: " + s.Input
	case "deny":
		return "Deny: " + s.Reason
	case "ask":
		return "Ask: " + s.Reason
	case "skipped":
		return "Skipped: " + s.Reason
	}
	return "Error: " + s.Error
}

const cliTimeoutMax = 2147483647

var (
	spaceIdxRe = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`)
	pathSepRe  = regexp.MustCompile(`[/\\]`)
)

// InjectTimeout is injectExecutionTimeout: Pi's bash timeout (seconds) as
// --timeout-ms after the leading hypa token. timeout is nil when absent.
func InjectTimeout(command string, timeout *float64) string {
	if timeout == nil || math.IsNaN(*timeout) || math.IsInf(*timeout, 0) || *timeout <= 0 {
		return command
	}
	ms := *timeout * 1000
	if ms != math.Trunc(ms) || ms <= 0 || ms > cliTimeoutMax {
		return command
	}
	body := strings.TrimLeft(command, jsSpace)
	prefix := command[:len(command)-len(body)]
	if body == "" {
		return command
	}
	var token, rest string
	if q := body[0]; q == '\'' || q == '"' {
		end := strings.IndexByte(body[1:], q)
		if end < 0 {
			return command
		}
		token, rest = body[:end+2], body[end+2:]
	} else if loc := spaceIdxRe.FindStringIndex(body); loc != nil {
		token, rest = body[:loc[0]], body[loc[0]:]
	} else {
		token = body
	}
	unquoted := token
	if len(token) >= 2 && ((token[0] == '\'' && token[len(token)-1] == '\'') || (token[0] == '"' && token[len(token)-1] == '"')) {
		unquoted = token[1 : len(token)-1]
	}
	parts := pathSepRe.Split(unquoted, -1)
	base := strings.ToLower(parts[len(parts)-1])
	if base != "hypa" && base != "hypa.exe" {
		return command
	}
	return prefix + token + " --timeout-ms " + strconv.FormatInt(int64(ms), 10) + rest
}

var posixSafeRe = regexp.MustCompile(`^[A-Za-z0-9_./:=@,+%^-]+$`)

// ShellQuote is the POSIX branch of shellQuote.
func ShellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if posixSafeRe.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

// Qualify is qualifyRewrittenHypaCommand: a leading bare `hypa` becomes the
// resolved binary path (or `<jsRuntime> <bin.js>`).
func Qualify(command, resolved, jsRuntime string) string {
	if resolved == "" || resolved == "hypa" {
		return command
	}
	if command != "hypa" && !strings.HasPrefix(command, "hypa ") {
		return command
	}
	lower := strings.ToLower(resolved)
	var prefix string
	switch {
	case strings.HasSuffix(lower, ".js"):
		prefix = ShellQuote(jsRuntime) + " " + ShellQuote(resolved)
	case strings.HasSuffix(lower, ".cmd"), strings.HasSuffix(lower, ".bat"):
		return command
	default:
		prefix = ShellQuote(resolved)
	}
	return prefix + command[len("hypa"):]
}

// ExecArgs is getExecArgs (POSIX): a .js entry runs with the JS runtime.
func ExecArgs(binary string, args []string, jsRuntime string) (string, []string) {
	if strings.HasSuffix(strings.ToLower(binary), ".js") {
		return jsRuntime, append([]string{binary}, args...)
	}
	return binary, args
}

var platformKeys = map[string]map[string]string{
	"linux":  {"amd64": "linux-x64", "arm64": "linux-arm64"},
	"darwin": {"amd64": "darwin-x64", "arm64": "darwin-arm64"},
}

// Resolver finds files for binary resolution.
type Resolver struct {
	Exists func(path string) bool
	// ModuleDirs are node_modules directories to search, nearest first.
	ModuleDirs []string
	Path       string // the PATH value
	GOOS       string
	GOARCH     string
}

func (r Resolver) native() string {
	key := platformKeys[r.GOOS][r.GOARCH]
	if key == "" {
		return ""
	}
	for _, dir := range r.ModuleDirs {
		if p := filepath.Join(dir, "@hypabolic", "hypa-"+key, "bin", "hypa"); r.Exists(p) {
			return p
		}
	}
	return ""
}

func (r Resolver) bundledJS() string {
	for _, dir := range r.ModuleDirs {
		if p := filepath.Join(dir, "@hypabolic", "hypa", "bin.js"); r.Exists(p) {
			return p
		}
	}
	return ""
}

// ResolveBinary is resolveHypaBinary (POSIX): an explicit path wins; then a
// non-JS PATH entry; then the bundled native binary; then a JS PATH entry;
// then bin.js; then the bare name.
func (r Resolver) ResolveBinary(binary string) string {
	if strings.ContainsAny(binary, `/\`) {
		return binary
	}
	var fromPath string
	for _, dir := range strings.Split(r.Path, ":") {
		if dir == "" {
			continue
		}
		if c := filepath.Join(dir, binary); r.Exists(c) {
			fromPath = c
			break
		}
	}
	if fromPath != "" && !strings.HasSuffix(strings.ToLower(fromPath), ".js") {
		return fromPath
	}
	if n := r.native(); n != "" {
		return n
	}
	if fromPath != "" {
		return fromPath
	}
	if binary == "hypa" {
		if js := r.bundledJS(); js != "" {
			return js
		}
	}
	return binary
}
