# PiG limits that affect the Go port

This document lists the limits of PiG 0.7.0 and its Go extension SDK that
change how the Go port of AIO works. Each limit has a workaround in the
port. When a later PiG version removes a limit, remove the workaround and
the related entry in the "Known gaps" section of `README.md`.

The PiG fork (`danielboothcloud/PiG`) fixes limit 2. Build its binary with
`CGO_ENABLED=0 go build -buildvcs=false -trimpath -o <out>/pig ./cmd/pig`
in the fork checkout. The Go editors (user-bash, queue, frame, and the
session-nav editor intercepts) need the fork. Limits 4 to 7 are also in
the fork.

The PiG Go SDK is the module `github.com/MichaelKinsy/PiG/extensions/sdk`.
PiG stages a copy that matches the `pig` binary. Run `pig diagnose` to see
its path. With `PIG_HOME=~/.config/pi`, the path is
`~/.config/pi/state/pigsdk/sdk-<hash>`.

## Summary

| Limit | Source | Workaround in the port |
|---|---|---|
| No call to suspend the host TUI | The SDK has no equivalent of Pi's `tui.stop()` | `/tuicr` opens tuicr in a pane, then `/tuicr done` loads the comments |
| Crash on a custom Go editor | A bug in the `pig` 0.7.0 host, fixed in the PiG fork | None with the fork; PiG 0.7.0 crashes on the first key |
| Request context ends when the handler returns | SDK design | Background work uses the context from `OnLoaded` |
| No call to repaint an installed editor | The SDK renders an editor only after host events | The frame changes the base editor's autocomplete size and back |
| `sendUserMessage` drops `expandPromptTemplates` | The host bridge has no such option | Commands run through the base editor's host `onSubmit` |
| `ctx.Abort` is not Pi's TUI abort | The host keeps the queued messages and waits until idle | The queue sends the host's interrupt key through the base editor |
| JSON-only event bus, private editor factories | SDK design | The frame protocol is package state; no selector frames |
| Go extension stderr is not shown | PiG divergence D56 | Notices that must be seen also go into the tool result |

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
The PiG fork adds `ctx.RunForeground`; the tuicr port does not use it
yet.

## 2. Crash on a custom Go editor (fixed in the PiG fork)

**Problem:** PiG 0.7.0 crashes with this message when a Go editor
component overrides any method:

```text
pig exiting due to uncaughtException:
autocomplete provider is no longer available
```

The crash is in `internal/codingagent/autocomplete_wrappers.go` of the
`pig` host. An override of `HandleInput` crashes on the first key. An
override of `Render` or `SetText` crashes when the editor text starts
with `!`.

**Fix:** The PiG fork fixes the host (commit f46b9ab2c, "fix autocomplete
crashing"). The Go port now installs the user-bash editor by default, as
TypeScript does. The spacing and status logic is in `HandleInput`, as in
`user-bash/bash-hint-editor.ts`. The queue editor extends it, and the
frame wraps the queue editor.

**Effect with PiG 0.7.0:** The extension still builds against the 0.7.0
SDK (`test/.pigcheck/mkcopy.sh` prints `build-ok`), but `pig` 0.7.0
crashes on the first key in the editor. Use the fork.

**Check the fix:**

1. Start `pig -ne -e go/aio` from the fork in a terminal.
2. Type `!ls`, then other text, then press Enter.
3. Make sure that `pig` does not crash, the frame's top border shows
   `! bash` and `Enter to run`, and the command runs.

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
- `go/aio/queue.go`, `go/aio/frame.go`: the editor components and the
  repaint worker. In a handler, the queue uses the handler's context: the
  long-lived context's calls wait behind each other.

Read values that need the request (for example the session name) while
the handler runs. Then pass them to the background work.

**Note:** This is SDK design, not a bug. It will likely stay. Keep the
workaround.

## 4. No call to repaint an installed editor

**Problem:** The SDK renders an installed editor component only after a
host event: a key, a mouse event, a text change, or a new editor state
(`ui.editor.configure`). An extension cannot ask for a new render. Pi's
TUI renders the whole tree again on every change.

**Effect:** The frame shows data that changes without a key: the git
branch, the run timer, a mode or style change, the quota, and the session
name. Without a repaint, the frame shows the old data until the next key.

**Workaround:** `go/aio/frame.go` changes the base editor's autocomplete
size by one and back (`SetAutocompleteMaxVisible`). The host then sends
its editor state again, and the SDK renders the frame. The popup size
does not change, because a popup keeps the size it had when it opened.
While the agent runs, the frame repaints once per second for the timer.

**Reproduction:** Remove the workaround, start a run, and look at the
frame timer. It stays at its first value until you press a key.

## 5. `sendUserMessage` drops `expandPromptTemplates`

**Problem:** Pi's `pi.sendUserMessage("/rewind", { expandPromptTemplates:
true })` runs the extension command `/rewind`. The PiG host bridge reads
only `deliverAs` (`SendUserMessageOptions` in
`coding/extension/host/subprocess/ui_bridge.go`), and the Go SDK sends
only `deliverAs`. The text goes to the model as a prompt.

**Reproduction:** From a Go handler, call
`ctx.SendUserMessage("/rewind", "")` on an idle session. The model gets
the text `/rewind`.

**Workaround:** Session-nav runs `/rewind` (double Escape) and
`/sessions` (`/resume`, the resume key, `--sessions`) through the base
editor's host submit handler (`sdk.Editor.OnSubmit`), as if the user
submitted the command. The command is then in the editor history.

## 6. `ctx.Abort` is not Pi's TUI abort

**Problem:** In Pi's TUI, an extension's `ctx.abort()` is
`restoreQueuedMessagesToEditor({ abort: true })`: the queued messages go
back to the editor, then the run aborts. In PiG the `abort` host action
only aborts the run and then waits until the session is idle. The host
keeps the queued steering messages and starts the next run with them.

**Reproduction:** Load `test/.pigcheck/ui-abort-ext.ts` (a command that
calls `ctx.abort()`) without AIO. Send a slow prompt, queue a message,
then run `/ui-abort`. PiG aborts and then sends the queued message.

**Effect:** The queue interrupt (Enter on an empty editor) depends on
Pi's behavior: it sends the next message itself. With `ctx.Abort`, the
message would be sent twice. Also, the long-lived context's calls wait
behind the abort call until the session is idle. In the check, a run that
the AIO handlers held this way never ended.

**Workaround:** The queue sends the host's interrupt key (`app.interrupt`)
through the base editor (`sdk.Editor.HandleInput`). That is the TUI path
that restores the queued messages, as in Pi. `ctx.Abort` is the fallback
when the key has no plain encoding.

## 7. JSON-only event bus and private editor factories

**Problem:** TypeScript features probe the frame with a synchronous
`pi.events` call (`aio:minimal-frame-capability`) that changes the
payload object. PiG's event bus carries JSON by value, so a listener
cannot answer. `GetEditorComponent` returns only this extension's own
factory, so a standalone Zentui editor in another extension is invisible.
The SDK also has no hook into the host's selector components.

**Workaround:** The Go features share the frame protocol as package state
(`go/internal/frame/protocol.go`). The frame wraps only this extension's
editor. `frame/menus.ts` (selector frames) is not ported.

## 8. Go extension stderr is not shown

**Problem:** PiG writes the stderr of a Go extension process to a
temporary log (`pig-packed-*.log` in the temporary folder). It keeps the
log only when a failure report refers to it. In JSON and print mode a Go
extension therefore has no visible channel for a notice: `ctx.Notify`
needs a UI, and stderr is not shown. Node extensions write to the
terminal.

**Workaround:** browser-search writes its fallback notice to stderr in
JSON and print mode and also puts the warning in
the tool result text and details.

**Check:** Run `pig --mode json` with a Go extension that writes to
stderr. Look for the line on pig's stderr.

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
