# AIO Go port (PiG)

This directory contains the Go port of AIO for PiG, the Go version of Pi.
The TypeScript extension (`index.ts`) is still the implementation for
native Pi. Pi cannot load Go extensions.

> **Warning:** Do not delete the TypeScript code before the Go port reaches
> parity in `pig`. After you delete it, native `pi` has no AIO.

## Layout

- `go.mod`: one module, `github.com/danielboothcloud/pi-aio/go`.
- `aio/`: the PiG factory, `func Extension() *sdk.Extension`. The directory
  name gives the extension identity `aio`.
- `internal/<feature>/`: one package for each ported TypeScript feature
  directory. These packages do not import the SDK, so `go test` runs without
  PiG.

PiG resolves the SDK requirement (`v0.0.0`) to its staged SDK at build time.
Third-party modules (for example `regexp2`) are downloaded through
`GOPROXY` when PiG builds the extension.

Each feature file in `go/aio` registers itself from `init()` with
`addRegistrar(Order<Feature>, ...)`. The `Order*` constants in
`extension.go` follow the order of the `register*` calls in `index.ts`.

Background work after a handler returns must use the long-lived context
from `OnLoaded` (`Context{ext: e}` in the SDK). A request-scoped context
ends when its handler returns. Do not hold a feature mutex across a host
call that makes the host send an event back to this extension (for
example `SetThinkingLevel` sends `thinking_level_select`): the handler for
that event then waits for the same mutex.

## Run

1. Load the Go extension alone:

   ```sh
   pig -ne -e <repo>/go/aio
   ```

2. Run the tests:

   ```sh
   npm run test:go
   ```

   This command checks that the golden data is current, then runs
   `go vet` and `go test` on `internal/...`.

To type-check the `aio/` package locally, add a temporary `replace` for
`github.com/MichaelKinsy/PiG/extensions/sdk` that points to the staged SDK
(`pig diagnose` shows its path). Do not commit the `replace`.

## Parity rule

The TypeScript feature is the reference until its Go port replaces it.
Each port needs:

1. Golden data that the TypeScript code generates (see
   `internal/blocklist/testdata/gen-golden.ts`), with a `--check` mode in
   `npm run test:go`.
2. Go tests that reproduce every golden result.
3. A check in real `pig` (`pig -ne -e go/aio`).

Do not load the Go and TypeScript versions of the same feature in one
session when the feature registers tools, commands, or UI. PiG keeps the
first registration by name. Gates (`tool_call` blocks) can run twice
without harm.

## Status

| Order | Feature | TS lines | Status |
|---|---|---|---|
| 1 | blocklist | 1206 | Done. Golden parity on 297 commands and 3 rule sets, including JavaScript lookahead and backreference rules (`regexp2`, ECMAScript mode). The recipe tier comes from the active recipe, or from `AIO_RECIPE_BLOCKLIST` in subagent children. |
| 2 | permission-modes | 1860 | Done, with the gaps below. Golden parity on 80 commands, 7 plan messages, 8 `apply_patch` inputs, 13 workspace-guard cases, 392 gate cases (4 modes, with and without UI, 6 answer sets), the todo tool, and 8 mode contexts. |
| 3 | recipes (in-session part) | 3862 | Done, with the gaps below. Golden parity on 24 loads (6 folders, 4 trust combinations), model specs, branch scans, the shared trust store (Go reads what TypeScript writes), and trust prompt text. Selection precedence has unit tests. The launcher (`bin/aio-pig.mjs`) stays in Node; `AIO_PIG_EXTENSION=<repo>/go/aio` makes it load the Go extension. |
| 4 | styles, effort, notifications, session-naming | 1468 | Done, with the gaps below. Golden parity: styles (16 mode contexts, parsing, context filter, command notices), effort (30 parses, 144 payload overrides, 196 level reconciles, completions), notifications (33 text-cleaning cases, settings normalization, 6 backend delivery paths, 14 event scenarios including `/notify`), session-naming (15 titles, 10 eligibility and prompt flows). |
| 5 | goals, btw | 1905 | Not started. |
| 6 | subagents | 4288 | Not started. |
| 7 | rtk, hypa, user-bash, ast-grep, nvim, tuicr, init | 4220 | Done, with the gaps below. Golden parity: init (24 prompts), rtk and user-bash (16 commands, 12 editor texts), ast-grep (18 inputs, 12 summaries, 20 process outcomes, 3 results including truncation), nvim with the shared `toolpaths` package (45 command runs, 16 tool inputs, launcher argv), tuicr (7 fake worlds, 42 picker choices), hypa (18 configs, 14 timeout injections, binary resolution, command builders, image sniffing, 12 tool runs including UTF-16 truncation). |
| 8 | pretty-tools, diff-tools, copy-widget | 11012 | Not started. Needs a replacement for Shiki highlighting. |
| 9 | ask-user-question | 5260 | Not started. Vendored upstream code. |
| 10 | browser-search | 3377 | Not started. Needs replacements for Readability and linkedom. |
| 11 | frame, status-line, queue, session-nav, ui | 5468 | Not started. TUI surfaces. |
| 12 | yaml-hooks | 6606 | Not started. Ported upstream code. |

## Known gaps

These gaps close when the related feature is ported:

- **permission-modes:** The approval prompt uses `ctx.Select` with the same
  option labels. The preview lists the edit's old and new text, or the start
  of the written content. The TypeScript version shows a real file diff in an
  overlay (diff-tools).
- **permission-modes:** The mode shows as the `modes` footer status. There
  is no frame pill (frame) and no AIO UI-state event (notifications).
- **permission-modes:** The Cursor bridge switch
  (`PI_CURSOR_EXPOSE_BUILTIN_TOOLS`) is not set, because a Go process cannot
  change a Node provider's environment.
- **permission-modes:** Relative paths resolve against the session cwd only.
  The Go process's own working directory is not the host's tool base.

- **recipes:** `/recipe init`, `/recipe status`, and `/recipe-status` are
  not ported; they tell you to use them from pi.
- **recipes:** A new or changed `.pi-recipe` gets a "run /recipe trust" hint
  in the session, not a selector. The launcher still asks on the terminal.
- **recipes:** The Go extension cannot read pig's argv. So it does not see
  `--no-approve`, and it does not show the launch notes that depend on argv.
  The empty-scope check uses the recipe's own `models`, and it stops pig with
  `ctx.Shutdown()`, not a process exit.
- **recipes:** A live `/recipe` switch reports the recipe's `style` as not
  applied, because styles is not ported. The starting style is published but
  has no Go consumer yet.
- **recipes:** Name sorting approximates `localeCompare` (case-insensitive,
  then bytes). MCP servers register in name order.

- **styles:** No frame pill; the style shows as the `style` footer status.
- **effort:** No frame metadata or AIO UI-state event. Print-mode notices go
  through `ctx.Notify`, not stdout/stderr. The `reasoning_effort` override
  applies only to payloads that carry that field (as in TypeScript); OpenAI
  Codex responses use `reasoning.effort` and are unchanged.
- **notifications:** The terminal fallback (OSC 777/99 and the bell) writes
  to `/dev/tty`, because the Go extension's stdout is the wire to the PiG
  host. Go producers (permission prompts, goals) do not emit agent-prompt
  or goal events yet; Node producers on the shared event bus still do.
- **session-naming:** The title request cannot be aborted from Go. A
  timeout (20 s), a new session, or a shutdown makes a late result void.



These values are idle memory after 30 seconds in this repository, without
the `pi-lens` language servers:

| Setup | Memory |
|---|---|
| `pig` with the Go extension only | `pig` 58 MB + Go extension 10 MB |
| `pig` with the TypeScript AIO only | `pig` 72 MB + Node extension 240 MB |

Other TypeScript extensions (`pi-lens`, `context7`, `pi-anthropic-auth`)
still need a Node extension process.
