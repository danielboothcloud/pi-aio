package aio

// ast_grep tool wiring (port of ast-grep/index.ts and cli.ts). The binary
// is the bundled @ast-grep/cli in the package's node_modules (found from
// the extension's source path), else `ast-grep` on PATH.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/astgrep"
)

func init() { addRegistrar(OrderAstGrep, "ast-grep", registerAstGrep) }

const astGrepMaxCapture = 64 * 1024 * 1024

func usableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func resolveAstGrep(ctx sdk.Context) string {
	var starts []string
	if info, ok := ctx.ExtensionSourceInfo(); ok {
		starts = append(starts, filepath.Dir(info.Path), info.BaseDir)
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, start := range starts {
		for dir := start; dir != "" && dir != "."; {
			for _, candidate := range []string{
				filepath.Join(dir, "node_modules", ".bin", "ast-grep"),
				filepath.Join(dir, "node_modules", "@ast-grep", "cli", "ast-grep"),
			} {
				if usableFile(candidate) {
					return candidate
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	// The long name: `sg` is a setgroups tool on many Linux systems.
	return "ast-grep"
}

// capped is an io.Writer that stops at a shared byte budget.
type capped struct {
	mu       *sync.Mutex
	total    *int
	buf      bytes.Buffer
	overflow func()
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	*c.total += len(p)
	if *c.total > astGrepMaxCapture {
		c.overflow()
		return len(p), nil
	}
	return c.buf.Write(p)
}

func runAstGrep(ctx sdk.Context, binary string, args []string, timeout time.Duration) (astgrep.Process, error) {
	p := astgrep.Process{Command: binary, Args: args, Cwd: ctx.Cwd()}
	run, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(run, binary, args...)
	cmd.Dir = ctx.Cwd()
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = time.Second // then SIGKILL, as the TypeScript runner does
	var mu sync.Mutex
	total := 0
	overflowed := false
	overflow := func() {
		if !overflowed {
			overflowed = true
			cancel()
		}
	}
	stdout := &capped{mu: &mu, total: &total, overflow: overflow}
	stderr := &capped{mu: &mu, total: &total, overflow: overflow}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		return p, fmt.Errorf("Failed to start ast-grep. Install this package's dependencies or put ast-grep on PATH. Cause: %w", err)
	}
	timer := time.AfterFunc(timeout, func() { mu.Lock(); p.TimedOut = true; mu.Unlock(); cancel() })
	defer timer.Stop()
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			mu.Lock()
			p.Aborted = true
			mu.Unlock()
			cancel()
		case <-done:
		}
	}()
	err := cmd.Wait()
	close(done)
	mu.Lock()
	defer mu.Unlock()
	if overflowed {
		return p, fmt.Errorf("ast-grep output exceeded %d bytes; narrow the paths/globs or lower maxResults.", astGrepMaxCapture)
	}
	p.Stdout, p.Stderr = stdout.buf.String(), stderr.buf.String()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		code := 0
		p.Code = &code
	case errors.As(err, &exitErr):
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			p.Signal = signalName(status.Signal())
		} else {
			code := exitErr.ExitCode()
			p.Code = &code
		}
	}
	return p, nil
}

func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	}
	return fmt.Sprintf("SIG%d", int(sig))
}

func intSchema(description string, minimum, maximum int) map[string]any {
	return map[string]any{"type": "integer", "description": description, "minimum": minimum, "maximum": maximum}
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func registerAstGrep(e *sdk.Extension) {
	e.RegisterTool(sdk.ToolDefinition{
		Name:          "ast_grep",
		Label:         "ast-grep",
		Description:   "Run ast-grep structural search or rule scans. This read-only tool wraps the bundled @ast-grep/cli binary, returns a compact summary, truncates output to Pi defaults, and saves full output to a temp file when needed.",
		PromptSnippet: "Search code structurally with ast-grep patterns or ast-grep YAML rules.",
		PromptGuidelines: []string{
			"Use ast_grep for syntax-aware code searches when text grep is likely to produce false positives.",
			"Use ast_grep with command=run and pattern for ad-hoc structural queries; pass language when ast-grep cannot infer it from files.",
			"Use ast_grep with command=scan for ast-grep YAML rule files or project sgconfig.yml scanning.",
			"ast_grep is read-only; use read/edit/write only after inspecting matches and deciding on concrete file changes.",
		},
		Parameters: sdk.Schema{
			"type": "object",
			"properties": map[string]any{
				"command":     map[string]any{"type": "string", "enum": []string{"run", "scan"}},
				"pattern":     stringSchema("ast-grep pattern for command=run, for example: console.log($A)"),
				"kind":        stringSchema("AST node kind for command=run, for example: call_expression. Use instead of pattern."),
				"language":    stringSchema("Optional ast-grep language, for example ts, tsx, js, python, rust, go."),
				"paths":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": 1, "description": "Files or directories to search. Defaults to ['.']. A leading @ is stripped."},
				"globs":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Optional ast-grep --globs include/exclude patterns. Repeat entries are passed separately."},
				"config":      stringSchema("Optional sgconfig.yml path, passed as --config before the command."),
				"rule":        stringSchema("Rule file path for command=scan, passed as --rule. A leading @ is stripped."),
				"inlineRules": stringSchema("Inline ast-grep rule YAML for command=scan, passed as --inline-rules."),
				"selector":    stringSchema("Optional selector AST kind for command=run."),
				"strictness":  map[string]any{"type": "string", "enum": []string{"cst", "smart", "ast", "relaxed", "signature"}},
				"context":     intSchema("Context lines around each run-mode match. Mutually exclusive with before/after.", 0, 20),
				"before":      intSchema("Lines before each run-mode match.", 0, 20),
				"after":       intSchema("Lines after each run-mode match.", 0, 20),
				"json":        map[string]any{"type": "string", "enum": []string{"compact", "stream"}},
				"maxResults":  intSchema("Maximum number of matches included in the LLM-visible summary. Defaults to 200.", 0, 1000),
				"timeoutMs":   intSchema("Subprocess timeout in milliseconds. Defaults to 30000.", 1000, 300000),
				"includeRaw":  map[string]any{"type": "boolean", "description": "Append raw ast-grep JSON to the result. Defaults to false; output is still truncated."},
			},
		},
		Execute: func(ctx sdk.Context, params map[string]any) (any, error) {
			in, err := astgrep.Normalize(params)
			if err != nil {
				return nil, err
			}
			binary := resolveAstGrep(ctx)
			args := astgrep.BuildArgs(in)
			_ = ctx.OnUpdate(sdk.ToolResult{Content: "Running " + astgrep.FormatCommand(binary, args), Details: map[string]any{"command": in.Command, "argv": args}})
			p, err := runAstGrep(ctx, binary, args, time.Duration(in.TimeoutMs)*time.Millisecond)
			if err != nil {
				return nil, err
			}
			matches, parseErr := astgrep.ParseJSON(p.Stdout, in.JSON)
			if parseErr != nil {
				if !astgrep.Success(p, nil) {
					return nil, errors.New(astgrep.FailureMessage(p))
				}
				return nil, fmt.Errorf("Failed to parse ast-grep JSON output: %w", parseErr)
			}
			if !astgrep.Success(p, matches) {
				return nil, errors.New(astgrep.FailureMessage(p))
			}
			r := astgrep.BuildResult(in, p, matches)
			details := map[string]any{
				"command": in.Command, "argv": args, "cwd": p.Cwd, "exitCode": p.Code, "exitSignal": nilIfEmpty(p.Signal),
				"resultCount": len(matches), "shownCount": r.ShownCount, "jsonMode": in.JSON,
				"timedOut": p.TimedOut, "aborted": p.Aborted,
			}
			if stderr, ok := astgrep.Diagnostic(p.Stderr); ok {
				details["stderr"] = stderr
			}
			text := r.Text
			if r.Truncation.Truncated {
				dir, err := os.MkdirTemp("", "pi-ast-grep-")
				if err != nil {
					return nil, err
				}
				path := filepath.Join(dir, "output.txt")
				if err := os.WriteFile(path, []byte(r.FullText), 0o600); err != nil {
					return nil, err
				}
				details["truncation"] = r.Truncation
				details["fullOutputPath"] = path
				text += astgrep.TruncationNotice(r.Truncation, path)
			}
			return sdk.ToolResult{Content: text, Details: details}, nil
		},
	})
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
