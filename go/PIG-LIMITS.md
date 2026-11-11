# PiG limits that affect the Go port

This document lists the limits of PiG 0.7.0 and its Go extension SDK that
change how the Go port of AIO works. Each limit has a workaround in the
port. When a later PiG version removes a limit, remove the workaround and
the related entry in the "Known gaps" section of `README.md`.

The PiG Go SDK is the module `github.com/MichaelKinsy/PiG/extensions/sdk`.
PiG stages a copy that matches the `pig` binary. Run `pig diagnose` to see
its path. With `PIG_HOME=~/.config/pi`, the path is
`~/.config/pi/state/pigsdk/sdk-<hash>`.

## Summary

| Limit | Source | Workaround in the port |
|---|---|---|
| No call to suspend the host TUI | The SDK has no equivalent of Pi's `tui.stop()` | `/tuicr` opens tuicr in a pane, then `/tuicr done` loads the comments |
| Crash on a custom Go editor | A bug in the `pig` host, not in the SDK API | The user-bash editor is off by default |
| Request context ends when the handler returns | SDK design | Background work uses the context from `OnLoaded` |

## 1. No call to suspend the host TUI

**Problem:** In Pi, an extension can call `ctx.ui.custom()`, then
`tui.stop()`. The extension then runs a program that uses the terminal
directly, and calls `tui.start()` when the program exits. The PiG Go SDK
has no call that stops and restarts the host TUI. `Context.Custom` only
shows a component inside the host TUI.

**Effect:** Go features cannot give the terminal to another program.

**Workaround:** `go/aio/tuicr.go` opens tuicr in a new pane. It uses the
`/nvim` launchers: Otty split, tmux, Otty tab, Terminal.app, or a printed
command. It records the comment IDs that exist before the review. The
command `/tuicr done` loads the new comments into the editor.

**When PiG adds the call:** Run tuicr in the foreground, as
`tuicr/runner.ts` does. Remove `/tuicr done` and the pane launcher code.

## 2. Crash on a custom Go editor

**Problem:** PiG 0.7.0 crashes with this message when a Go editor
component overrides any method:

```text
pig exiting due to uncaughtException:
autocomplete provider is no longer available
```

The crash is in `internal/codingagent/autocomplete_wrappers.go` of the
`pig` host. The tests gave these results:

- An editor that only embeds `*sdk.Editor` and overrides nothing works.
- An override of `HandleInput` that only calls the base method crashes on
  the first key.
- An override of `Render` or `SetText` crashes when the editor text starts
  with `!` (bash mode).

**Effect:** The Go port cannot install the user-bash editor safely. Other
features that need a custom editor have the same problem. Examples are
the queue editor, the frame editor, and the session-nav editor intercepts.

**Workaround:** `go/aio/userbash.go` installs the editor only when
`AIO_GO_USER_BASH_EDITOR=1` is set. The PiG native editor still runs `!`
and `!!` commands. The spacing and status logic runs in `Render`, not in
`HandleInput`.

**Check for a fix:**

1. Set `AIO_GO_USER_BASH_EDITOR=1`.
2. Start `pig -ne -e go/aio` in a terminal.
3. Type `!ls`, then other text.
4. Make sure that `pig` does not crash and the border shows `! bash`.

**When PiG fixes the bug:** Make the editor the default. Move the spacing
and status logic back to `HandleInput`, as `user-bash/bash-hint-editor.ts`
does.

**Report:** PiG records the crash. Run `/bug` in `pig` to report it.

## 3. Request context ends when the handler returns

**Problem:** Each handler gets an `sdk.Context` for one request. The SDK
cancels that context when the handler returns. A host call through that
context fails after the handler returned.

**Effect:** Work that continues after a handler cannot use the handler
context. Examples are a background model call, a delayed notification,
and an editor that outlives the session start handler.

**Workaround:** Register `OnLoaded` and keep its context. That context
has no request scope (`Context{ext: e}` in the SDK). These files use it:

- `go/aio/sessionnaming.go`: the background title request.
- `go/aio/notifications.go`: the follow-up notice after `/notify test`.
- `go/aio/rtk.go`: the warning when the `rtk` binary is missing.
- `go/aio/userbash.go`: the editor status updates.

Read values that need the request (for example the session name) while
the handler runs. Then pass them to the background work.

**Note:** This is SDK design, not a bug. It will likely stay. Keep the
workaround.

## Rules that come from these limits

- Set an environment value that a Node extension or Node provider reads
  (for example `PI_CURSOR_EXPOSE_BUILTIN_TOOLS`) with `ctx.SetSharedEnv`
  and `ctx.UnsetSharedEnv` (PiG divergence D234). The change does not
  reach this process's own environment, so keep the value you set in
  feature state. `os.LookupEnv` gives only the value pig inherited.
- Use the event bus (`pi.events`) for data that features must exchange,
  for example notification signals. It is shared between processes.
- Read pig's argv from `PIG_HARNESS_ARGV_FILE` (a JSON string array of the
  arguments after the binary), with `piargs.HarnessArgv()`. PiG sets it in
  every extension cell; a Go extension's own `os.Args` is its runner. The
  Go extension's working directory is pig's working directory. Subagent
  children must not inherit the variable (`ChildBaseEnv` drops
  `PIG_HARNESS_*` and `PIG_EXT_*`).
- Expect SDK callbacks and your own goroutines to run at the same time.
  TypeScript code that relies on one thread (for example the subagent
  runner's `onUpdate`) must serialize the calls in Go.
- Do not hold a feature mutex across a host call that sends an event back
  to this extension. For example, `SetThinkingLevel` sends
  `thinking_level_select`, and that handler then waits for the same mutex.
- Do not write terminal sequences to stdout. Stdout is the connection to
  the PiG host. Write them to `/dev/tty`.
- Do not stop `pig` processes that you did not start during tests.
