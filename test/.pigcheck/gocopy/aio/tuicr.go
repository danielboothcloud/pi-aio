package aio

// /tuicr wiring (port of tuicr/index.ts and review.ts).
//
// Difference from TypeScript: the PiG Go SDK cannot suspend the host TUI,
// so tuicr cannot take over this terminal. /tuicr opens tuicr in a new pane
// (the /nvim launchers: Otty split, tmux, Otty tab, Terminal.app, or the
// printed command) and records the comments that exist now. When you
// finish the review, `/tuicr done` loads the new comments into the editor.

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

	"github.com/danielboothcloud/pi-aio/go/internal/nvim"
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

// launchTuicr opens tuicr with args in a new pane and returns the notice.
func launchTuicr(cwd string, args []string) (string, bool) {
	quoted := []string{tuicr.Command}
	for _, a := range args {
		quoted = append(quoted, nvim.Quote(a))
	}
	command := strings.Join(quoted, " ")
	run := runLauncher(cwd, 10*time.Second)
	env := launcherEnv()
	for _, attempt := range nvim.Plan(env, runtime.GOOS) {
		var launched bool
		switch attempt.Mode {
		case "otty-split", "otty-tab":
			var paneArgs []string
			if attempt.Mode == "otty-split" {
				paneArgs = []string{"pane", "split", "--direction", "right", "--size", "50"}
				if pane := env["OTTY_PANE_ID"]; pane != "" {
					paneArgs = append(paneArgs, "--pane", pane)
				}
			} else {
				paneArgs = []string{"tab", "new"}
			}
			paneArgs = append(paneArgs, "--cwd", cwd, "--command", "exec "+command, "--title", "tuicr", "--quiet")
			code, err := run("otty", paneArgs)
			launched = err == nil && code == 0
		case "tmux":
			code, err := run("tmux", []string{"new-window", "-c", cwd, command})
			launched = err == nil && code == 0
		case "macos":
			script := "tell application \"Terminal\"\n\tactivate\n\tdo script \"cd " + strings.ReplaceAll(cwd, `"`, `\"`) + " && " + strings.ReplaceAll(command, `"`, `\"`) + "\"\nend tell"
			code, err := run("osascript", []string{"-e", script})
			launched = err == nil && code == 0
		case "print":
			return "No terminal launcher is available. Run this command in another terminal, then run /tuicr done:\n  cd " + cwd + " && " + command, true
		}
		if launched {
			return "Opened tuicr (" + attempt.Reason + "). When you finish the review, run /tuicr done to load the comments.", true
		}
	}
	return "", false
}

func registerTuicr(e *sdk.Extension) {
	var mu sync.Mutex
	var seen map[string]bool // comment IDs before the open review; nil when none is open

	start := func(ctx sdk.Context) error {
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
		existing, err := tuicr.AllComments(ctx.Cwd(), captureCommand)
		if err != nil {
			ctx.Notify(err.Error(), "error")
			return nil
		}
		snapshot := map[string]bool{}
		for _, c := range existing {
			snapshot[c.ID] = true
		}
		notice, ok := launchTuicr(ctx.Cwd(), args)
		if !ok {
			ctx.Notify("Could not start tuicr - is it on your PATH?", "error")
			return nil
		}
		mu.Lock()
		seen = snapshot
		mu.Unlock()
		ctx.Notify(notice, "info")
		return nil
	}
	done := func(ctx sdk.Context) error {
		mu.Lock()
		snapshot := seen
		mu.Unlock()
		if snapshot == nil {
			ctx.Notify("No tuicr review is open. Run /tuicr first.", "warning")
			return nil
		}
		all, err := tuicr.AllComments(ctx.Cwd(), captureCommand)
		if err != nil {
			ctx.Notify(err.Error(), "error")
			return nil
		}
		fresh := tuicr.FreshComments(all, snapshot)
		if len(fresh) == 0 {
			ctx.Notify("No new review comments", "info")
			return nil
		}
		mu.Lock()
		seen = nil
		mu.Unlock()
		ctx.SetEditorText(tuicr.Format(fresh))
		ctx.Notify(tuicr.ReadyNotice(len(fresh)), "info")
		return nil
	}
	handler := func(ctx sdk.Context, args string) error {
		if strings.TrimSpace(args) == "done" {
			return done(ctx)
		}
		return start(ctx)
	}
	completions := func(prefix string) ([]sdk.AutocompleteItem, error) {
		if strings.HasPrefix("done", strings.TrimSpace(prefix)) {
			return []sdk.AutocompleteItem{{Value: "done", Label: "done", Description: "load the comments from the open tuicr review"}}, nil
		}
		return nil, nil
	}
	for _, name := range []string{"tuicr", "review"} {
		e.RegisterCommand(name, sdk.CommandOptions{
			Description:            "Review a diff in tuicr, then load comments (/" + name + " done loads them)",
			GetArgumentCompletions: completions,
			Handler:                handler,
		})
	}
	e.Shortcut("ctrl+shift+r", "Review a diff in tuicr", start)
}
