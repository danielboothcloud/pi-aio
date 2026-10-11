# Upstream

`tuicr/` is a port of
[@joelazar/pi-tuicr](https://github.com/joelazar/pi-tuicr) v1.1.0
(joelazar, MIT — see `tuicr/LICENSE`). It reviews pi's changes in the
external `tuicr` terminal TUI and feeds the review comments straight back
into pi's editor.

## What was kept

- The full review loop, verbatim: `/tuicr` (and `ctrl+shift+r`) asks what
  to review, suspends pi's TUI, and opens tuicr on the chosen diff in the
  foreground with inherited stdio. When tuicr exits, comments created
  during that session are collected, numbered, and prefilled into the
  editor (`ctx.ui.setEditorText`) with a "press enter to send" notify.
- The picker contract: Uncommitted changes (`-w`), Branch vs base
  (`-r base..HEAD` with and without `-w`), Last commit
  (`-r HEAD~1..HEAD`), Pick commits (bare `tuicr`), Every tracked file
  (`-A`), Custom revset (`-r <revset>`), and Pull request (`pr <target>`).
  Base detection order and the hide-when-undetectable behavior are
  upstream's: origin/HEAD via `symbolic-ref`, then origin/main,
  origin/master, main, master — never the current branch, verified with
  `rev-parse --verify --quiet`, entries hidden when nothing verifies.
- The comment snapshot semantics: comment ids are snapshotted before the
  run and diffed after, so only comments created during the session just
  opened come back — an old review never resurfaces.
- The failure contract: a tuicr that cannot start or exits non-zero
  reports an error and stops rather than sending a half-built prompt.
- The prefill formatting: numbered `anchor [TYPE] - body` lines
  (`location` ?? `path`, uppercase type when present and not `none`,
  multiline bodies collapsed), under "I reviewed your changes. Please
  address these comments:".
- TUI-only gating (`ctx.mode !== "tui"` refuses with a notify).

## What was adapted to aio

- **Module split + seams**: upstream is a single `index.ts` calling
  `execFileSync`/`spawnSync` directly. The port splits core (CLI capture,
  comment collection, base detection, formatting), picker, runner (TUI
  suspend/resume + foreground spawn), review (orchestration), and the
  registrar, with injected `Capture`/`ForegroundSpawn` seams so tests
  never shell out to a live tuicr or git binary (aio house rule).
- **Malformed JSON surfaces a descriptive error**: `tuicr review *`
  output that does not parse throws an error naming the subcommand
  instead of a bare SyntaxError (upstream let JSON.parse throw).
- **Registration is unconditional and probe-free**: no binary check at
  load time — the same as upstream.

## Contracts relied on

- `tuicr review list --all` prints a JSON array of
  `{ path, comment_count }`.
- `tuicr review comments --session <path>` prints a JSON array of
  comments: `id`, optional `location` / `path` / `comment_type`, and
  `content`.
- `tuicr [-w]`, `tuicr -r <revset> [-w]`, `tuicr -A`, and
  `tuicr pr <target>` run the interactive review in the foreground.
- `ctx.ui.custom` suspends and restores the TUI around the foreground
  run (`tui.stop()` / `tui.start()` / `requestRender(true)`).

## tuicr is optional

Everything degrades when the `tuicr` binary is absent: registration adds
the command and shortcut unconditionally, the comment snapshot comes back
empty, and the run reports "Could not start tuicr - is it on your PATH?".
Missing `tuicr` must not prevent the extension from loading (aio house
rule).
