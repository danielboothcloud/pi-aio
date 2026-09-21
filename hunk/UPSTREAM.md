# Upstream

`hunk/` integrates [hunk](https://github.com/modem-dev/hunk)
(modem-dev, MIT — https://hunk.dev), a review-first terminal diff viewer for
agent-authored changesets. No Hunk source is vendored: this feature wraps
Hunk's public, documented surfaces — the non-interactive `hunk session *` CLI,
the `--agent-context` sidecar contract, and the bundled `hunk-review` skill —
and teaches the model those workflows through the `hunk` tool and Pi-native
skill discovery.

## What the integration does

- **`hunk` model tool** — the inline AI annotation surface: wraps
  `hunk session list/get/context/review/navigate/reload`, `comment
  add/apply/list/rm/clear`, and `highlight add/clear` with TypeBox-validated
  parameters. Batches for `comment apply --stdin` are written to a mode-0600
  temp file and redirected through `sh -c` (the shared exec surface has no
  stdin). Payloads are parsed into a named JSON domain type and returned in
  tool details.
- **`/hunk` command family** — opens the interactive review in a sibling
  terminal: inside tmux (new window), on macOS via AppleScript into
  Terminal.app, otherwise printing the exact command. The TUI belongs to the
  user, matching Hunk's agent workflow; Pi owns the current terminal and can
  never host a fullscreen OpenTUI app.
- **Skill discovery** — `hunk skill path` is resolved once at startup and fed
  into `resources_discover` so Pi loads the authoritative upstream
  `hunk-review` skill natively. A missing or broken hunk install contributes
  nothing (optional integration per the aio house rules).

## Contracts relied on

- `hunk session *` argument surface and JSON outputs (hunk 0.22 CLI;
  `--json` is supported by every session subcommand).
- `comment apply --stdin` batch items: `summary` plus either `replyTo` alone
  or `filePath` with exactly one of `hunk` / `hunkNumber` / `oldLine` /
  `newLine`; validation is all-or-nothing upstream.
- `highlight` offsets are `[start, end)` in UTF-16 code units into the line
  text, end exclusive.
- Failure semantics: "No active Hunk sessions" is classified so the tool
  result instructs the model to ask the user to open Hunk (for example via
  `/hunk`); "Multiple active sessions match" instructs explicit `sessionId`.

## Hunk is optional

Everything degrades silently when the `hunk` binary is absent: the skill
discovery returns no paths, the tool classifies spawn failures as
`not_found`, and `/hunk` falls back to printing the command. Keep it that
way — missing `hunk` must not prevent the extension from loading (aio house
rule).
