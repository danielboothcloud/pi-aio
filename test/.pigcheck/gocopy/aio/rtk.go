package aio

// rtk wiring (port of rtk/index.ts, rewrite.ts, command.ts). The rewrite
// runs `rtk rewrite` from this process (the TypeScript version uses
// pi.exec; both spawn the same binary from PATH). The tool_call handler
// registers after permission modes, so gates see the original command.

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/rtk"
)

func init() { addRegistrar(OrderRtk, "rtk", registerRtk) }

const rtkRewriteTimeout = 2 * time.Second

type rtkState struct {
	mu       sync.Mutex
	notified bool
	loaded   *sdk.Context
}

// unavailable classifies a start error: "missing", "unexecutable", or "".
func unavailable(err error) string {
	var execErr *exec.Error
	switch {
	case errors.As(err, &execErr) && errors.Is(execErr.Err, exec.ErrNotFound):
		return "missing"
	case errors.Is(err, fs.ErrNotExist):
		return "missing"
	case errors.Is(err, fs.ErrPermission):
		return "unexecutable"
	}
	return ""
}

// alert warns once per outage; a successful rewrite resets the gate.
func (s *rtkState) alert(ctx *sdk.Context, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.notified || ctx == nil || reason == "" {
		return
	}
	s.notified = true
	message := rtk.MissingMessage
	if reason == "unexecutable" {
		message = rtk.UnexecutableMessage
	}
	ctx.Notify(message, "warning")
}

func (s *rtkState) rewrite(command string) (string, bool) {
	_ = os.Unsetenv("RTK_DISABLED")
	prepared, ok := rtk.Prepare(command)
	if !ok {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), rtkRewriteTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "rtk", "rewrite", prepared).Output()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			s.alert(s.loaded, unavailable(err))
			return "", false
		}
		code = exitErr.ExitCode()
	}
	if code == 0 || code == 3 {
		s.mu.Lock()
		s.notified = false
		s.mu.Unlock()
	}
	return rtk.Result(prepared, string(out), code, ctx.Err() != nil)
}

func rtkBinaryText() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "rtk", "--version").Output()
	if err != nil && unavailable(err) != "" {
		return "rtk not detected on PATH"
	}
	version := strings.TrimSpace(string(out))
	if version == "" {
		version = "version unknown"
	}
	if path, err := exec.LookPath("rtk"); err == nil {
		return version + " at " + path
	}
	return version
}

func registerRtk(e *sdk.Extension) {
	s := &rtkState{}
	e.OnLoaded(func(ctx sdk.Context) { s.loaded = &ctx })
	e.RegisterCommand("rtk", sdk.CommandOptions{
		Description: "Show enforced aio-rtk routing status",
		GetArgumentCompletions: func(prefix string) ([]sdk.AutocompleteItem, error) {
			if strings.HasPrefix("status", prefix) {
				return []sdk.AutocompleteItem{{Value: "status", Label: "status"}}, nil
			}
			return nil, nil
		},
		Handler: func(ctx sdk.Context, args string) error {
			switch strings.TrimSpace(args) {
			case "", "status":
				ctx.Notify(rtk.StatusReport(rtkBinaryText()), "info")
			default:
				ctx.Notify(rtk.SubcommandError, "error")
			}
			return nil
		},
	})
	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		probe, cancel := context.WithTimeout(context.Background(), rtkRewriteTimeout)
		defer cancel()
		if err := exec.CommandContext(probe, "rtk", "--version").Run(); err != nil {
			s.alert(&ctx, unavailable(err))
		}
		return nil, nil
	})
	e.OnEvent("tool_call", func(_ sdk.Context, data map[string]any) (any, error) {
		if data["toolName"] != "bash" {
			return nil, nil
		}
		input, _ := data["input"].(map[string]any)
		command, ok := input["command"].(string)
		if !ok || strings.TrimSpace(command) == "" {
			return nil, nil
		}
		// RTK is an optimization: on any failure the original command runs.
		if rewritten, ok := s.rewrite(command); ok {
			input["command"] = rewritten
		}
		return nil, nil
	})
}
