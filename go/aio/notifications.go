package aio

// Notifications wiring (port of notifications/index.ts). Differences from
// TypeScript:
//   - The terminal fallback (OSC 777/99 and the bell) writes to /dev/tty.
//     The Go extension's stdout is the wire to the PiG host, so writing
//     escape sequences there would break the extension protocol.
//   - Producers in Go (permission prompts, goals) do not emit agent-prompt
//     or goal events yet; Node producers on the shared event bus still do.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	notify "github.com/danielboothcloud/pi-aio/go/internal/notifications"
)

func init() { addRegistrar(OrderNotifications, "notifications", registerNotifications) }

func runProgram(ctx context.Context, bin string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if len(out) > 64*1024 {
		out = out[:64*1024]
	}
	return string(out), err
}

func writeTTY(text string) {
	tty, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0)
	if err != nil {
		return
	}
	defer tty.Close()
	_, _ = tty.WriteString(text)
}

func envMap() map[string]string {
	env := map[string]string{}
	for _, key := range []string{"SSH_CONNECTION", "SSH_TTY", "KITTY_WINDOW_ID", "TMUX", "__CFBundleIdentifier", "TERM_PROGRAM"} {
		env[key] = os.Getenv(key)
	}
	return env
}

func nowMillis() float64 { return float64(time.Now().UnixMilli()) }

func decodeInto(data any, out any) bool {
	raw, err := json.Marshal(data)
	return err == nil && json.Unmarshal(raw, out) == nil
}

type notifyState struct {
	engine  *notify.Engine
	backend *notify.Backend
	mu      sync.Mutex
	cancel  context.CancelFunc
	base    context.Context
	loaded  *sdk.Context // long-lived context for late notices
}

func (s *notifyState) resetDeliveries() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	s.base, s.cancel = context.WithCancel(context.Background())
}

func subtitle(ctx sdk.Context) string {
	if name := ctx.SessionName(); name != "" {
		return name
	}
	return filepath.Base(ctx.Cwd())
}

// deliver runs one delivery in the background and reports its result.
// The subtitle is read by the caller while its request context is active.
func (s *notifyState) deliver(sub string, d notify.Delivery, delay time.Duration, done func(string)) {
	n := s.engine.Notification(d, sub)
	s.mu.Lock()
	base := s.base
	s.mu.Unlock()
	go func() {
		result := "skipped"
		defer func() {
			if done != nil {
				done(result)
			}
		}()
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-base.Done():
				return
			}
		}
		valid := func() bool { return base.Err() == nil && s.engine.Valid(d) }
		if !valid() || (s.engine.FocusSkip(d) && s.backend.Focused(base)) || !valid() {
			return
		}
		s.backend.Send(base, n, valid)
		if valid() {
			result = "dispatched"
		}
	}()
}

func registerNotifications(e *sdk.Extension) {
	if os.Getenv("AIO_SUBAGENT_CHILD") == "1" {
		return
	}
	agentDir, _ := sdk.AgentDir()
	settingsPath := notify.SettingsPath(agentDir)
	s := &notifyState{
		engine:  notify.NewEngine(notify.Load(settingsPath)),
		backend: notify.NewBackend(runtime.GOOS, envMap(), runProgram, writeTTY),
	}
	s.resetDeliveries()
	e.OnLoaded(func(ctx sdk.Context) { s.loaded = &ctx })

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		s.resetDeliveries()
		id, _ := ctx.SessionManager().GetSessionID()
		s.engine.SessionStart(id, ctx.Mode() == "tui" && ctx.HasUI(), notify.Load(settingsPath))
		return nil, nil
	})
	e.OnSessionShutdown(func(sdk.Context, map[string]any) (any, error) {
		s.engine.SessionShutdown()
		s.resetDeliveries()
		return nil, nil
	})
	e.OnEvent("agent_start", func(sdk.Context, map[string]any) (any, error) {
		s.engine.AgentStart(nowMillis())
		return nil, nil
	})
	e.OnEvent("message_end", func(_ sdk.Context, data map[string]any) (any, error) {
		message, _ := data["message"].(map[string]any)
		if message["role"] != "assistant" {
			return nil, nil
		}
		stop, _ := message["stopReason"].(string)
		var parts []string
		content, _ := message["content"].([]any)
		for _, raw := range content {
			if block, ok := raw.(map[string]any); ok && block["type"] == "text" {
				if text, ok := block["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		s.engine.MessageEnd(stop, strings.Join(parts, " "))
		return nil, nil
	})
	e.OnEvent("agent_settled", func(ctx sdk.Context, data map[string]any) (any, error) {
		if d, ok := s.engine.Settled(data["aborted"] == true, nowMillis()); ok {
			s.deliver(subtitle(ctx), d, 0, nil)
		}
		return nil, nil
	})

	bus := e.Events()
	_, _ = bus.On(notify.AgentPromptEvent, func(ctx sdk.Context, data any) error {
		var p notify.Prompt
		if !decodeInto(data, &p) {
			return nil
		}
		if d, ok := s.engine.PromptSignal(p); ok {
			sub := subtitle(ctx)
			// Deferred, like queueMicrotask: a dialog that closes at once
			// retires its marker first.
			go func() {
				time.Sleep(time.Millisecond)
				if s.engine.PromptStillOwned(d.Prompt) {
					s.deliver(sub, d, 0, nil)
				}
			}()
		}
		return nil
	})
	_, _ = bus.On(notify.GoalActivityEvent, func(_ sdk.Context, data any) error {
		var a struct {
			SessionID   string `json:"sessionId"`
			Active      bool   `json:"active"`
			QuietSettle bool   `json:"quietSettle"`
		}
		if decodeInto(data, &a) {
			s.engine.GoalActivity(a.SessionID, a.Active, a.QuietSettle)
		}
		return nil
	})
	_, _ = bus.On(notify.NotificationEvent, func(ctx sdk.Context, data any) error {
		var signal notify.Signal
		if !decodeInto(data, &signal) {
			return nil
		}
		if d, ok := s.engine.NotificationSignal(signal); ok {
			s.deliver(subtitle(ctx), d, 0, nil)
		}
		return nil
	})

	e.Command("notify", "Desktop notifications: on/off, focus, min, sound, preview, events, test [seconds], status", func(ctx sdk.Context, args string) error {
		out := s.engine.HandleCommand(args, ctx.Mode(), s.backend.Name(), func(settings notify.Settings) error {
			return notify.Save(settingsPath, settings)
		})
		for _, n := range out.Notices {
			ctx.Notify(n.Text, n.Level)
		}
		if len(out.Notices) == 1 && out.Notices[0].Text == "Notification settings saved." {
			s.resetDeliveries()
		}
		if out.Test != nil {
			later := s.loaded
			s.deliver(subtitle(ctx), *out.Test, time.Duration(out.TestDelay*float64(time.Second)), func(result string) {
				if n, ok := notify.TestOutcomeNotice(result, s.backend.Name()); ok && later != nil {
					later.Notify(n.Text, n.Level)
				}
			})
		}
		return nil
	})
}
