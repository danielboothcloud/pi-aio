package aio

// hypa wiring (port of hypa/index.ts and tools.ts; vendored from
// @hypabolic/pi-hypa 0.1.15, FSL-1.1-ALv2 — see hypa/LICENSE-FSL).
//
// Differences from TypeScript:
//   - The MCP proxy bridge (off by default) is not ported; when a config
//     turns it on, the session gets a warning.
//   - A broken hypa config file does not stop the extension from loading.
//     The session gets a warning and hypa uses the env and the defaults.
//   - The hypa_* tools have no custom TUI renderers; PiG draws its default
//     tool card.

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/hypa"
)

func init() { addRegistrar(OrderHypa, "hypa", registerHypa) }

type hypaState struct {
	mu          sync.Mutex
	config      hypa.Config
	configPath  string
	configErr   error
	resolved    string
	jsRuntime   string
	lastRewrite *hypa.Status
	loaded      *sdk.Context
}

func moduleDirs(ctx *sdk.Context) []string {
	var starts, dirs []string
	if ctx != nil {
		if info, ok := ctx.ExtensionSourceInfo(); ok {
			starts = append(starts, filepath.Dir(info.Path), info.BaseDir)
		}
	}
	seen := map[string]bool{}
	for _, start := range starts {
		for dir := start; dir != "" && dir != "."; dir = filepath.Dir(dir) {
			if nm := filepath.Join(dir, "node_modules"); !seen[nm] {
				seen[nm] = true
				dirs = append(dirs, nm)
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	return dirs
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// resolve finds the hypa binary (once the source path is known).
func (s *hypaState) resolve() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := hypa.Resolver{Exists: fileExists, ModuleDirs: moduleDirs(s.loaded), Path: os.Getenv("PATH"), GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
	s.resolved = r.ResolveBinary(s.config.Binary)
	return s.resolved
}

type hypaRun struct {
	stdout, stderr string
	code           int
	killed         bool
}

// runHypa runs the hypa binary; a timeout or a cancelled request kills it.
func (s *hypaState) runHypa(ctx sdk.Context, args []string, timeoutMs *float64) (hypaRun, error) {
	bin, argv := hypa.ExecArgs(s.resolve(), args, s.jsRuntime)
	run, cancel := context.WithCancel(context.Background())
	defer cancel()
	if timeoutMs != nil && *timeoutMs > 0 {
		var stop context.CancelFunc
		run, stop = context.WithTimeout(run, time.Duration(*timeoutMs*float64(time.Millisecond)))
		defer stop()
	}
	go func() {
		select {
		case <-ctx.Done():
			cancel()
		case <-run.Done():
		}
	}()
	cmd := exec.CommandContext(run, bin, argv...)
	cmd.Dir = ctx.Cwd()
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	result := hypaRun{stdout: stdout.String(), stderr: stderr.String(), killed: run.Err() != nil}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		result.code = exitErr.ExitCode()
	case !result.killed:
		return result, err
	}
	return result, nil
}

func (s *hypaState) toolResult(run hypaRun, command string, preferTail bool) (any, error) {
	text := hypa.BuildToolText(run.stdout, run.stderr, preferTail)
	details := map[string]any{"source": "hypa-cli", "command": command, "exitCode": run.code}
	path := ""
	if text.Truncation.Truncated {
		dir, err := os.MkdirTemp("", "pi-hypa-")
		if err != nil {
			return nil, err
		}
		path = filepath.Join(dir, "output.txt")
		if err := os.WriteFile(path, []byte(text.Combined), 0o600); err != nil {
			return nil, err
		}
		details["truncation"] = text.Truncation
		details["fullOutputPath"] = path
	}
	return sdk.ToolResult{Content: hypa.FinishText(text, path, run.code, run.killed), Details: details}, nil
}

// readImage is tryBuildImageReadResult: ok=false means "read it as text".
func readImage(ctx sdk.Context, path string) (any, bool) {
	home, _ := os.UserHomeDir()
	resolved := hypa.NormalizePath(path, home)
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(ctx.Cwd(), resolved)
	}
	f, err := os.Open(resolved)
	if err != nil {
		return nil, false
	}
	sniff := make([]byte, hypa.ImageSniffBytes)
	n, _ := f.Read(sniff)
	f.Close()
	sniff = sniff[:n]
	size := n
	if info, err := os.Stat(resolved); err == nil {
		size = int(info.Size())
	}
	mime := hypa.ImageMime(sniff)
	if mime == "" {
		if hypa.OpaqueBinary(sniff) {
			return sdk.ToolResult{Content: hypa.BinaryNote(path, size), Details: map[string]any{"source": "hypa-read-binary", "path": resolved, "size": size}}, true
		}
		return nil, false
	}
	nonVision := false
	if model, err := ctx.ModelRegistry().Find(ctx.ModelProvider(), ctx.Model()); err == nil && model != nil {
		if input, ok := model["input"].([]any); ok {
			nonVision = true
			for _, kind := range input {
				if kind == "image" {
					nonVision = false
				}
			}
		}
	}
	note, omitted := hypa.ImageNote(mime, size, nonVision)
	if omitted {
		return sdk.ToolResult{Content: note, Details: map[string]any{"source": "hypa-read-image", "mimeType": mime, "omitted": true, "size": size}}, true
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil, false
	}
	if full := hypa.ImageMime(data); full != "" {
		mime = full
	}
	return sdk.ToolResult{Content: note, Images: []sdk.ImageContent{{Data: base64.StdEncoding.EncodeToString(data), MimeType: mime}},
		Details: map[string]any{"source": "hypa-read-image", "mimeType": mime, "size": len(data)}}, true
}

func prop(kind, description string) map[string]any {
	return map[string]any{"type": kind, "description": description}
}

func registerHypa(e *sdk.Extension) {
	home, _ := os.UserHomeDir()
	env := func(key string) (string, bool) { return os.LookupEnv(key) }
	s := &hypaState{configPath: hypa.ConfigFilePath(env, home), jsRuntime: "node"}
	if node, err := exec.LookPath("node"); err == nil {
		s.jsRuntime = node
	}
	s.config, s.configErr = hypa.LoadConfig(env, s.configPath)
	if s.configErr != nil {
		// Fail open: the env and the defaults still apply.
		s.config, _ = hypa.LoadConfig(env, "")
	}
	e.OnLoaded(func(ctx sdk.Context) { s.loaded = &ctx })

	limits := " Output is truncated to 2000 lines or 50KB with full output saved when needed."
	tools := []struct {
		name, description, snippet string
		guidelines                 []string
		props                      map[string]any
		required                   []string
	}{
		{"hypa_shell", "Run shell commands through Hypa compression." + limits, "Run shell commands through Hypa compression",
			[]string{"Use hypa_shell for shell commands when compressed output is preferred.",
				"Use raw mode only for a simple executable and whitespace-separated arguments; omit it for shell syntax, quoting, or multiline commands.",
				"Do not use hypa_shell to read files; use hypa_read instead."},
			map[string]any{"command": prop("string", "Shell command to execute through Hypa compression"), "timeoutMs": prop("number", "Timeout in milliseconds (default: Hypa CLI default)"),
				"raw": prop("boolean", "Run a simple whitespace-tokenized command with hypa raw; omit for shell syntax, quoting, or multiline commands")}, []string{"command"}},
		{"hypa_read", "Read a file through Hypa compression. Supports text (offset/limit line slices) and images (png/jpeg/gif/webp via content sniffing → vision attachments). Text output is truncated to 2000 lines or 50KB with full output saved when needed.",
			"Read file contents through Hypa compression (text or images)",
			[]string{"Use hypa_read to inspect file contents instead of cat/head/tail via shell.", "Image files are returned as vision image attachments (magic-byte detection), not text dumps."},
			map[string]any{"path": prop("string", "Path to read, relative to Pi cwd or absolute"), "offset": prop("number", "Line number to start reading from (1-indexed)"),
				"limit": prop("number", "Maximum number of lines to read"), "maxTokens": prop("number", "Approximate maximum tokens to return after Hypa compression")}, []string{"path"}},
		{"hypa_grep", "Search file contents with ripgrep through Hypa compression." + limits, "Search file contents through Hypa compression", nil,
			map[string]any{"pattern": prop("string", "Search pattern"), "path": prop("string", "Directory or file to search (default: current directory)"), "glob": prop("string", "File glob filter, e.g. *.ts"),
				"ignoreCase": prop("boolean", "Case-insensitive search"), "literal": prop("boolean", "Treat pattern as a literal string"), "context": prop("number", "Lines of context around each match"),
				"limit": prop("number", "Maximum matches"), "timeoutMs": prop("number", "Timeout in milliseconds (default: Hypa CLI default)")}, []string{"pattern"}},
		{"hypa_find", "Find files through Hypa compression." + limits, "Find files through Hypa compression", nil,
			map[string]any{"pattern": prop("string", "File name/glob pattern (default: *)"), "path": prop("string", "Directory to search (default: current directory)"),
				"limit": prop("number", "Maximum paths to return"), "timeoutMs": prop("number", "Timeout in milliseconds (default: Hypa CLI default)")}, nil},
		{"hypa_ls", "List directory contents through Hypa compression." + limits, "List directory contents through Hypa compression", nil,
			map[string]any{"path": prop("string", "Directory to list (default: current directory)"), "all": prop("boolean", "Include dotfiles"), "long": prop("boolean", "Use long listing"),
				"timeoutMs": prop("number", "Timeout in milliseconds (default: Hypa CLI default)")}, nil},
	}
	for _, t := range tools {
		name := t.name
		schema := sdk.Schema{"type": "object", "properties": t.props, "additionalProperties": false}
		if t.required != nil {
			schema["required"] = t.required
		}
		e.RegisterTool(sdk.ToolDefinition{
			Name: name, Label: name, Description: t.description, PromptSnippet: t.snippet, PromptGuidelines: t.guidelines, Parameters: schema,
			Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
				if name == "hypa_read" {
					if path, ok := params["path"].(string); ok {
						if result, ok := readImage(ctx, path); ok {
							return result, nil
						}
					}
				}
				plan, err := hypa.ToolPlan(name, params, home)
				if err != nil {
					return nil, err
				}
				run, err := s.runHypa(ctx, plan.Args, plan.TimeoutMs)
				if err != nil {
					return nil, err
				}
				if name == "hypa_find" {
					run.stdout = hypa.LimitLines(run.stdout, plan.Limit)
				}
				return s.toolResult(run, plan.Command, plan.PreferTail)
			},
		})
	}

	if s.config.Mode == "replace" {
		e.OnEvent("before_agent_start", func(ctx sdk.Context, _ map[string]any) (any, error) {
			current, err := ctx.GetActiveTools()
			if err != nil {
				return nil, nil
			}
			if active := hypa.ReplaceFilter(current, s.config.Mode); len(active) != len(current) {
				ctx.SetActiveTools(active)
			}
			return nil, nil
		})
	}

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if s.configErr != nil {
			ctx.Notify("hypa: "+s.configErr.Error()+" — using env and defaults", "warning")
		}
		if s.config.McpProxyEnabled {
			ctx.Notify("hypa: the MCP proxy bridge is not ported to the Go extension; use pi for it", "warning")
		}
		return nil, nil
	})

	e.OnEvent("tool_call", func(ctx sdk.Context, data map[string]any) (any, error) {
		if data["toolName"] != "bash" {
			return nil, nil
		}
		input, _ := data["input"].(map[string]any)
		original, _ := input["command"].(string)
		record := func(status hypa.Status) {
			s.mu.Lock()
			s.lastRewrite = &status
			s.mu.Unlock()
		}
		// rtk precedence: rtk runs first; a command it claimed stays rtk's.
		if hypa.IsRtkClaimed(original) {
			record(hypa.Status{Kind: "skipped", Input: original, Reason: "command already claimed by rtk"})
			return nil, nil
		}
		var status hypa.Status
		if hypa.IsHypaCommand(original) {
			status = hypa.Status{Kind: "skipped", Input: original, Reason: "command already starts with hypa"}
		} else {
			timeout := float64(s.config.RewriteTimeoutMs)
			run, err := s.runHypa(ctx, []string{"rewrite", "--json", original}, &timeout)
			if err != nil {
				status = hypa.Status{Kind: "error", Input: original, Error: err.Error()}
			} else {
				status = hypa.RewriteOutcome(original, run.stdout, run.stderr, run.code, run.killed, s.config.RewriteTimeoutMs)
			}
		}
		record(status)
		apply := func() {
			var timeout *float64
			if v, ok := input["timeout"].(float64); ok {
				timeout = &v
			}
			s.mu.Lock()
			resolved := s.resolved
			s.mu.Unlock()
			input["command"] = hypa.Qualify(hypa.InjectTimeout(status.Command, timeout), resolved, s.jsRuntime)
		}
		switch status.Kind {
		case "rewritten":
			apply()
		case "deny":
			return map[string]any{"block": true, "reason": status.Reason}, nil
		case "ask":
			if ctx.HasUI() {
				ok, _ := ctx.Confirm("Hypa confirmation", status.Reason)
				if ok != true {
					return map[string]any{"block": true, "reason": "Blocked by user after Hypa confirmation request."}, nil
				}
				apply()
				return nil, nil
			}
			if s.config.AskNonInteractive == "allow" {
				apply()
				return nil, nil
			}
			return map[string]any{"block": true, "reason": status.Reason + " Non-interactive fallback is deny (set HYPA_PI_ASK_NON_INTERACTIVE=allow to allow)."}, nil
		}
		return nil, nil
	})

	e.Command("hypa", "Show Hypa Pi extension diagnostics", func(ctx sdk.Context, _ string) error {
		resolved := s.resolve()
		active := []string{}
		if tools, err := ctx.GetActiveTools(); err == nil {
			for _, t := range tools {
				if strings.HasPrefix(t, "hypa_") {
					active = append(active, t)
				}
			}
		}
		activeText := strings.Join(active, ", ")
		if activeText == "" {
			activeText = "none"
		}
		configPath := s.configPath
		if configPath == "" {
			configPath = "none"
		}
		mcpPath := s.config.PiMcpConfigPath
		if mcpPath == "" {
			mcpPath = "default"
		}
		proxy := "disabled"
		if s.config.McpProxyEnabled {
			proxy = "enabled"
		}
		s.mu.Lock()
		last := s.lastRewrite
		s.mu.Unlock()
		lines := []string{
			"Hypa Pi extension",
			"Mode: " + s.config.Mode,
			"Config file: " + configPath,
			"Binary: " + s.config.Binary,
			"Resolved binary: " + resolved,
			"Rewrite timeout: " + strconv.Itoa(s.config.RewriteTimeoutMs) + "ms",
			"Ask fallback (non-UI): " + s.config.AskNonInteractive,
			"MCP proxy discovery: " + proxy,
			"MCP proxy timeout: " + strconv.Itoa(s.config.McpProxyTimeoutMs) + "ms",
			"Pi MCP config for dedup: " + mcpPath,
			"Active Hypa tools: " + activeText,
			"Last rewrite: " + hypa.FormatStatus(last),
		}
		level := "info"
		if last != nil && last.Kind == "error" {
			level = "warning"
		}
		ctx.Notify(strings.Join(lines, "\n"), level)
		return nil
	})
}
