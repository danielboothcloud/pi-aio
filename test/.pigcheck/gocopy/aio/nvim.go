package aio

// /nvim wiring (port of nvim/index.ts). User-initiated only: no agent tool.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/nvim"
)

func init() { addRegistrar(OrderNvim, "nvim", registerNvim) }

// runLauncher runs a launcher command with a timeout and returns its exit code.
func runLauncher(cwd string, timeout time.Duration) nvim.Run {
	return func(bin string, args []string) (int, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, args...)
		cmd.Dir = cwd
		err := cmd.Run()
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return 0, err
	}
}

func launcherEnv() map[string]string {
	return map[string]string{"OTTY_PANE_ID": os.Getenv("OTTY_PANE_ID"), "TMUX": os.Getenv("TMUX")}
}

func notifyOrPrint(ctx sdk.Context, prefix, message, level string) {
	if ctx.HasUI() {
		ctx.Notify(message, level)
		return
	}
	fmt.Fprintf(os.Stderr, "[%s] %s\n", prefix, message)
}

func projectFiles(cwd string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "ls-files")
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var files []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			files = append(files, line)
		}
		if len(files) == 500 {
			break
		}
	}
	return files
}

func registerNvim(e *sdk.Extension) {
	var mu sync.Mutex
	var session []nvim.SessionFile
	cwd, _ := os.Getwd()
	e.OnToolResult(func(ctx sdk.Context, data map[string]any) (any, error) {
		tool, _ := data["toolName"].(string)
		input, _ := data["input"].(map[string]any)
		isError, _ := data["isError"].(bool)
		mu.Lock()
		defer mu.Unlock()
		cwd = ctx.Cwd()
		paths, edited := nvim.PathsFromToolResult(tool, input, isError)
		if len(paths) == 0 {
			return nil, nil
		}
		for i, p := range paths {
			if !filepath.IsAbs(p) {
				p = filepath.Join(cwd, p)
			}
			paths[i] = filepath.Clean(p)
		}
		session = nvim.Touch(session, paths, edited, float64(time.Now().UnixMilli()), nvim.SessionFileLimit)
		return nil, nil
	})
	e.RegisterCommand("nvim", sdk.CommandOptions{
		Description: "Open a file in Neovim in a new Otty pane beside this session",
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			mu.Lock()
			files, dir := append([]nvim.SessionFile{}, session...), cwd
			mu.Unlock()
			var items []sdk.AutocompleteItem
			for _, c := range nvim.Completions(prefix, files, projectFiles(dir), dir, 12) {
				items = append(items, sdk.AutocompleteItem{Value: c.Value, Label: c.Label, Description: c.Description})
			}
			return items, nil
		},
		Handler: func(ctx sdk.Context, args string) error {
			requests, help, warn := nvim.ParseCommand(args, ctx.Cwd())
			if help {
				level := "info"
				if warn {
					level = "warning"
				}
				notifyOrPrint(ctx, "aio nvim", nvim.Help, level)
				return nil
			}
			var outputs []string
			for _, r := range requests {
				timeout := 10 * time.Second
				outputs = append(outputs, nvim.Open(r, ctx.Cwd(), launcherEnv(), runtime.GOOS, runLauncher(ctx.Cwd(), timeout)))
			}
			notifyOrPrint(ctx, "aio nvim", strings.Join(outputs, "\n"), "info")
			return nil
		},
	})
	e.Command("nvim-open-help", "Show /nvim usage and launcher behavior", func(ctx sdk.Context, _ string) error {
		notifyOrPrint(ctx, "aio nvim", nvim.Help, "info")
		return nil
	})
}
