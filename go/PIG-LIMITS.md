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
| Go extension stderr is not shown | PiG divergence D56 | Notices that must be seen also go into the tool result or a session entry |
| No exit status in an older pig | `Context.ShutdownWithCode` is PiG divergence D236 | The recipe empty-scope stop falls back to `ctx.Shutdown()` |
| No terminal before the TUI starts | The extension's stdin and stdout are the wire to pig | The `.pi-recipe` trust question is a session select; the launcher asks on the terminal |

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
the tool result text and details. Recipes write the `/recipe status` text,
the `.pi-recipe` trust hint, and the empty-scope message to stderr in
print and JSON mode, as TypeScript does. The status report is also a
`recipe-status-report` session entry, which JSON mode prints as an
`entry_appended` event.

**Check:** Run `pig --mode json` with a Go extension that writes to
stderr. Look for the line on pig's stderr.

## 9. No exit status in an older pig

**Problem:** TypeScript recipes stop a scoped startup whose `--models`
scope matches no model with `process.exit(1)`, before any prompt reaches a
provider. `ctx.shutdown()` is not enough: print and JSON mode ignore it. A
Go extension cannot end the pig process. The PiG fork adds
`Context.ShutdownWithCode` (D236) for this, but the fork binary at
`test/.pigcheck/pigfork/pig` (commit f46b9ab2c) does not have it yet.

**Workaround:** `go/aio/recipes.go` (`exitWithCode`) calls
`ShutdownWithCode(1)` when the pig's SDK has it, and `ctx.Shutdown()`
otherwise. The extension builds against both SDKs.

**Reproduction:** In a folder with no `.pi-recipe`, run
`pig --mode json --recipe ghost --models nope/none -p hello` with a
recipe `ghost` whose `models` is `["nope/none"]` (scratch recipes file in
`AIO_RECIPES_FILE`). With `pigfork/pig`, the prompt runs. With a pig built
from the fork tree that has D236, pig exits with status 1 and sends no
model request. In RPC and TUI mode both stop.

## 10. No terminal before the TUI starts

**Problem:** TypeScript recipes ask the `.pi-recipe` trust question on the
terminal while extension factories load, before the TUI starts
(`promptRecipeTrust`). A just-trusted recipe can then still relaunch pi.
A Go extension's stdin and stdout are the connection to pig, and its
factory runs without a terminal.

**Workaround:** The Go recipes ask through the session UI at
`session_start` (a non-blocking select), as TypeScript does in RPC and in
a TUI whose launch could not ask. Without a UI they write the stderr hint.
`bin/aio-pig.mjs` asks on the terminal before pig starts and sets
`AIO_PIG_TRUST_ASKED=1`, so the session does not ask again.

**Reproduction:** Put a new `.pi-recipe` in a folder and start
`pig -ne -e go/aio` there without the launcher. The question appears as a
select in the TUI after startup, not as a terminal prompt.

## Limits addressed in the PiG fork

The PiG fork adds host calls for the limits below. Each one is a
numbered PiG divergence (`docs/parity/divergences/D<N>.md` in the fork)
and is documented in the fork's agent docs
(`internal/pigdocs/content/extension-api.md`). Fork commit `37aa2de0e`
has D234 and `b4007a7e0` has D235. D236 to D238, the re-entry docs and
the working-directory test are in the fork worktree and not committed
yet. Build `pig` from a fork tree that has them before you remove a
workaround.

| Limit | PiG change | Port status |
|---|---|---|
| A Node provider cannot see an env value set by a Go extension | D234 `ctx.SetSharedEnv` / `ctx.UnsetSharedEnv` | Used by `go/aio/permissionmodes.go` |
| A model call cannot be cancelled | D235 `ModelRegistry.CompleteContext`, `StreamContext`, `StreamSimpleContext` | Used by btw, session naming and goals |
| No pig argv and no exit status | D236 `ctx.HostLaunch()` and `ctx.ShutdownWithCode(code)` | Limit 9: partly used; argv still comes from `PIG_HARNESS_ARGV_FILE` |
| Terminal sequences go to `/dev/tty` | D237 `ctx.WriteTerminal(data)` | Not used yet |
| A relaunch starts a second pig | D238 `ctx.Relaunch(sdk.RelaunchOptions{Args, Env})` | Limit 10: not used yet |
| Relative tool paths | No new call: the built-in tools use `ctx.Cwd()` | `workspace.go` comment is out of date |
| Host calls that re-enter the extension | Documented, behavior kept (it is Pi's) | Rule below |

### D236: pig's launch and exit status

`ctx.HostLaunch()` returns pig's arguments after the executable
(`Argv`, in order and unchanged), the run mode (`Mode`), and whether
pig's stdin and stdout were terminals at launch (`StdinIsTTY`,
`StdoutIsTTY`). It reads nothing from the environment.
`ctx.ShutdownWithCode(code)` ends pig with status `code` (0 to 255) in
every mode. Called in `session_start`, it stops before the command-line
prompt is sent.

**To remove the workaround (limit 9):**

1. In `go/aio/recipes.go`, call `ctx.ShutdownWithCode(1)` directly and
   delete the `ctx.Shutdown()` fallback in `exitWithCode`.
2. Read argv from `ctx.HostLaunch().Argv` in place of
   `piargs.HarnessArgv()`, and read the TTY state from its fields.
   Keep `ChildBaseEnv` dropping `PIG_HARNESS_*`.
3. Delete limit 9 and its summary row.

### D237: terminal sequences

`ctx.WriteTerminal(data)` writes BEL, OSC strings (except OSC 8
hyperlinks), and tmux passthroughs of those (at most 64 KiB) to the
terminal between TUI frames. The host refuses any other bytes, so the
next frame is drawn correctly. In print, JSON and RPC mode the call
writes nothing and returns an error that names the mode.

**To remove the workaround:**

1. In `go/aio/notifications.go`, replace `writeTTY` with a writer that
   calls `WriteTerminal` on the context from `OnLoaded` (`Backend.Send`
   runs after the handler returns). Pass it to `notify.NewBackend`.
   Every sequence that `internal/notifications/backend.go` builds is
   accepted: OSC 777, kitty's OSC 99, the tmux passthrough, and BEL.
2. Ignore or log the error in print, JSON and RPC mode.
3. Delete `writeTTY` and the `/dev/tty` notes in this file and in
   `README.md` "Known gaps" (notifications).

### D238: relaunch in the same process

`ctx.Relaunch(sdk.RelaunchOptions{Args, Env})` shuts the current runtime
down (`session_shutdown` with reason `quit`) and replaces the pig process
image with `pig <Args>`. The PID, terminal and stdio stay the same, so
only one pig runs. If `Args` chooses no session, the host adds
`--session <current file>` when that file exists. `Env` holds only the
changed keys; `nil` removes a key, and `PIG_EXT_*` and `PIG_HARNESS_*`
keys are refused. The call returns when the mode accepts or refuses the
request. It is refused on Windows, after pig has read piped stdin, in
RPC mode after pig started to read commands, and while pig shuts down.
The current runtime keeps running after a refusal.

**To remove the workaround (limit 10):**

1. In `go/internal/recipes/launch.go`, make `DecideLaunch` return the
   relaunch `Args` (`[...injected, ...bridgeable]`) and the changed
   `Env` keys (`AIO_RECIPE_STAGE=1`, `AIO_RECIPE_INJECTED_ARGS`,
   `AIO_RECIPE_ACTIVE`, `AIO_RECIPE_ORIGIN`, and `AIO_PIG_TRUST_ASKED`
   when it applies). Delete `PigRestartNote`, `PigLauncherMismatchNote`,
   `StartedByPigLauncher` and `PigLauncherEnv`.
2. In `go/aio/recipes.go` `sessionStart`, call `ctx.Relaunch` when the
   decision is a relaunch and return. Show the current note only when
   the call returns an error. Do the same for `resumeHint` on a resume.
3. In `recipes/pig-host.ts`, add `pigRelaunch(ctx, spec)` that calls
   `await ctx.relaunch({ args, env })` with only the changed AIO keys.
   Use it in `trampoline.ts`, `index.ts` and `resume.ts` in place of the
   launcher branches and the restart hint.
4. Remove `bin/aio-pig.mjs`, `recipes/pig-launch/`, any wrapper script
   for the launcher, and its `package.json` bin entry.
5. Replace limit 10 with the two cases that stay: piped stdin cannot be
   bridged, and Windows refuses the relaunch.

### Relative tool paths: no new call

Pi's built-in `write` and `edit` resolve a relative path against
`ctx.cwd` (`dist/core/tools/write.js:31`, `edit.js:92`), not
`process.cwd()`. PiG does the same, so `ctx.Cwd()` is the base of the
built-in tools. The fork test
`TestBuiltinFileToolsResolveRelativePathsAgainstCtxCwd` starts pig in
one folder with a session from another and checks this. The
TypeScript guard also checks `process.cwd()` because AIO's own
`apply_patch` resolves against it (`diff-tools/index.ts:1603`).

The fork found one difference from Pi: PiG starts isolated and packed
extensions in the session cwd, but Pi's `process.cwd()` is the folder
pig started in. A Go extension's `os.Getwd()` is therefore the session
cwd. Only a fused extension sees pig's own folder.

**To update the port:**

1. In `go/internal/permissionmodes/workspace.go`, replace the
   "Difference from TypeScript" comment. Check a relative path against
   `ctx.Cwd()` and `os.Getwd()`, without duplicates, as
   `workspace-guard.ts` does.
2. Remove the permission-modes "relative paths" gap from `README.md`.
3. Correct the working-directory rule below if PiG changes where it
   starts extensions.

### Host calls that re-enter the extension

Some host calls run this extension's own handlers before they return,
as in Pi. The fork keeps this behavior and lists the calls in
`extension-api.md` ("Host calls that run your own handlers before they
return"). The fork test
`TestGoHostCallRunsTheCallersHandlersBeforeItReturns` checks the order.

| Call | Events this extension receives before the call returns |
|---|---|
| `SetThinkingLevel` | `thinking_level_select` (only when the level changes) |
| `SetModel` | `thinking_level_select`, then `model_select` |
| `SetSessionName` | `session_info_changed` |
| `NewSession`, `SwitchSession` | `session_before_switch`, then `session_shutdown` |
| `Fork` | `session_before_fork`, then `session_shutdown` |
| `NavigateTree` | `session_before_tree`, then `session_tree` |
| `Reload` | `session_shutdown` |
| `SendUserMessage` | `input` and `before_agent_start`; also `agent_start` in print and JSON mode |
| `SendMessage` with `triggerTurn` on an idle session | `before_agent_start` in RPC mode only |
| `ExecuteTool` | The nested tool's events and the tool itself |
| `Events().Emit` | This extension's own listeners |

`AppendEntry`, `SetLabel`, `SetActiveTools`, `Notify`, `Exec` and
`Compact` send nothing back before they return.

The fork found two open issues that are not fixed yet. In the
interactive mode, `ctx.Abort` waits until the session is idle, and a
call from a `turn_start` handler can hang the run (see limit 6). The
point where `SendUserMessage` and `SendMessage` return also differs by
mode in PiG, where Pi has one behavior.

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
  every extension cell; a Go extension's own `os.Args` is its runner.
  With a pig that has D236, use `ctx.HostLaunch().Argv`. Subagent
  children must not inherit the variable (`ChildBaseEnv` drops
  `PIG_HARNESS_*` and `PIG_EXT_*`).
- The Go extension's working directory is the session cwd when it
  starts (isolated and packed cells), not the folder pig started in.
  The built-in tools resolve relative paths against `ctx.Cwd()`.
- Expect SDK callbacks and your own goroutines to run at the same time.
  TypeScript code that relies on one thread (for example the subagent
  runner's `onUpdate`) must serialize the calls in Go.
- Do not hold a feature mutex across a host call that sends an event back
  to this extension. For example, `SetThinkingLevel` sends
  `thinking_level_select`, and that handler then waits for the same mutex.
  See "Host calls that re-enter the extension" for the full list. Release
  the lock before the call, or record the change and commit it after the
  call returns.
- Do not write terminal sequences to stdout. Stdout is the connection to
  the PiG host. With a pig that has D237, use `ctx.WriteTerminal`;
  otherwise write them to `/dev/tty`.
- Do not stop `pig` processes that you did not start during tests.
