package aio

// /tuicr wiring (port of tuicr/index.ts, review.ts and runner.ts).
//
// The review runs in the foreground: ctx.RunForeground stops the host TUI,
// hands the terminal to tuicr, and redraws the TUI when tuicr exits, as
// runner.ts does with ctx.ui.custom, tui.stop() and tui.start(). Comments
// created during that session are loaded into the editor.

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/tuicr"
)

func init() { addRegistrar(OrderTuicr, "tuicr", registerTuicr) }

func captureCommand(command string, args []string, cwd string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func registerTuicr(e *sdk.Extension) {
	review := func(ctx sdk.Context) error {
		if ctx.Mode() != "tui" {
			ctx.Notify("tuicr needs an interactive terminal", "error")
			return nil
		}
		choices := tuicr.Choices(tuicr.BaseBranch(ctx.Cwd(), captureCommand))
		labels := make([]string, len(choices))
		for i, c := range choices {
			labels[i] = c.Label
		}
		label, ok := ctxUI{ctx}.Select(tuicr.PickerTitle, labels)
		if !ok {
			return nil
		}
		var args []string
		for _, c := range choices {
			if c.Label != label {
				continue
			}
			args = c.Args
			if c.Build != nil {
				answer, ok, err := ctx.Input(c.Prompt, c.Hint)
				text, _ := answer.(string)
				if err != nil || !ok || strings.TrimSpace(text) == "" {
					return nil
				}
				args = c.Build(strings.TrimSpace(text))
			}
		}
		// Snapshot existing comment IDs, so only this session's feedback comes back.
		existing, err := tuicr.AllComments(ctx.Cwd(), captureCommand)
		if err != nil {
			ctx.Notify(err.Error(), "error")
			return nil
		}
		seen := map[string]bool{}
		for _, c := range existing {
			seen[c.ID] = true
		}
		status, err := ctx.RunForeground(tuicr.Command, args, sdk.ForegroundOptions{Cwd: ctx.Cwd()})
		if err != nil {
			ctx.Notify("Could not start tuicr - is it on your PATH?", "error")
			return nil
		}
		if status != 0 {
			ctx.Notify(fmt.Sprintf("tuicr exited with status %d", status), "error")
			return nil
		}
		all, err := tuicr.AllComments(ctx.Cwd(), captureCommand)
		if err != nil {
			ctx.Notify(err.Error(), "error")
			return nil
		}
		fresh := tuicr.FreshComments(all, seen)
		if len(fresh) == 0 {
			ctx.Notify("No new review comments", "info")
			return nil
		}
		ctx.SetEditorText(tuicr.Format(fresh))
		ctx.Notify(tuicr.ReadyNotice(len(fresh)), "info")
		return nil
	}
	for _, name := range []string{"tuicr", "review"} {
		e.RegisterCommand(name, sdk.CommandOptions{
			Description: "Review a diff in tuicr, then load comments",
			Handler:     func(ctx sdk.Context, _ string) error { return review(ctx) },
		})
	}
	e.Shortcut("ctrl+shift+r", "Review a diff in tuicr", review)
}
