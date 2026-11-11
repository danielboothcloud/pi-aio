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
| 5 | goals, btw | 1905 | Done, with the gaps below. Golden parity: goals (8 branch reads, 12 argument parses, 6 completion sets, 16 review parses, 7 one-line texts, 16 status cases, 5 descriptions, 5 prompts, 9 latest-entry reads, 7 workspace snapshots, and 18 scenarios with 191 steps through the real `registerGoals`), btw (88 digests, 11 prompts, 11 sanitize cases, 10 outcomes, 70 box and card renders, 8 snapshots, 4 command scenarios). |
| 6 | subagents | 4288 | Done, with the gaps below. Golden parity: agent discovery (3 trees, 16 invalid files, embedded builtins checked against `subagents/agents`), child extension launch (7 argv cases, 3 enforce cases), activity (23 events, 420 formats, durations, argument summaries), transcripts (6 event scripts with budgets, clipping, sanitizing), history restore (19 branch entries, 50-run cap), 8 saved transcripts, 7 spawn specs, run results and progress, 16 widget renders, 40 transcript renders, 10 inspector scripts (72 frames with keys), and 11 real runner scenarios with `subagents/test-fixture-child.mjs` (retry, timeout, quota, settle reaping, spawn failure). Manual resume has a Go test. Shared packages: `chrome` (port of `ui/chrome.ts`, 900 renders), `piargs` (Pi's `parseArgs`, 57 argv cases), `tuiwidth` (copy of the SDK's pi-tui width code), `jsstr` (JavaScript string helpers, moved from btw). |
| 7 | rtk, hypa, user-bash, ast-grep, nvim, tuicr, init | 4220 | Done, with the gaps below. Golden parity: init (24 prompts), rtk and user-bash (16 commands, 12 editor texts), ast-grep (18 inputs, 12 summaries, 20 process outcomes, 3 results including truncation), nvim with the shared `toolpaths` package (45 command runs, 16 tool inputs, launcher argv), tuicr (7 fake worlds, 42 picker choices), hypa (18 configs, 14 timeout injections, binary resolution, command builders, image sniffing, 12 tool runs including UTF-16 truncation). |
| 8 | pretty-tools, diff-tools, copy-widget | 11012 | Not started. Needs a replacement for Shiki highlighting. |
| 9 | ask-user-question | 5260 | Not started. Vendored upstream code. |
| 10 | browser-search | 3377 | Not started. Needs replacements for Readability and linkedom. |
| 11 | frame, status-line, queue, session-nav, ui | 5468 | Not started. TUI surfaces. |
| 12 | yaml-hooks | 6606 | Done, with the gaps below. Golden parity: 37 YAML values, 38 schema files (every validation error code), 2 override sets, 28 discoveries (trust, git worktree anchors, imports, cycles, depth cap, trust-anchor, global, and package boundaries, size caps), 1643 globs (a port of Node's `path.matchesGlob`), 11 condition sets, 22 redactions, stdin, UTF-8, and env helpers, 13 real bash runs (exit 2 blocking, timeout, truncation, allowlist, spawn failure), session state and 10 lineage reads, 10 runtime scenarios (dispatch, idle changes, async queues, budgets, debug logs), 5 scenarios through the real `registerYamlHooks` (lifecycle, UI actions, confirm, prompt context, `/hooks-*` commands), and 20 diagnostics renders. Unit tests cover dispatch queueing, async lanes, and the recursion guard. |

## Known gaps

Some gaps come from limits of PiG 0.7.0 and its Go SDK. See
`PIG-LIMITS.md` for each limit, its workaround, and how to check for a fix.

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
- **recipes:** The launch notes that depend on argv and `--no-approve` are
  not read yet. A Go extension can read pig's argv from
  `PIG_HARNESS_ARGV_FILE` (`piargs.HarnessArgv`, used by subagents), so
  this gap can close. The empty-scope check uses the recipe's own
  `models`, and it stops pig with `ctx.Shutdown()`, not a process exit.
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
- **goals:** No AIO notification events (goal activity, "needs
  attention", "complete", agent prompts). The draft card is plain text
  without `ui/chrome`, and the footer status has no theme tone.
- **btw:** No AIO notification events and no frame "btw asking" pill; the
  `btw` footer status is used. The box and the card have no theme colors.
  A replaced or shut-down question cannot cancel its host model call; the
  late result is discarded.
- **session-naming:** The title request cannot be aborted from Go. A
  timeout (20 s), a new session, or a shutdown makes a late result void.
- **subagents:** Children run `$PIG_HARNESS_BINARY` (pig). The parent's
  `-ne`/`-e` flags come from `PIG_HARNESS_ARGV_FILE`; a `-ne` child lists
  the Go extension directory (from the extension source info) instead of
  `index.ts`. Spawn errors use Node's text (`spawn <cmd> ENOENT`), and
  stderr arrives in 64 KB reads, so log entries can split differently.
- **subagents:** The inspector cannot be closed from outside. Tree
  navigation and a new session mark it closed, and the next key closes it.
  Inline images are not hidden under the overlay (`ui/overlay-images.ts`
  is not ported).
- **subagents:** Agent frontmatter is parsed with `go.yaml.in/yaml/v3`.
  An invalid YAML block gets a Go error text, not the npm `yaml` one.
  Agent files sort as `localeCompare` approximately (case-insensitive).
- **yaml-hooks:** The YAML parser is `go.yaml.in/yaml/v3`. Invalid YAML
  gives the same `invalid_frontmatter` code, but the message is a Go
  error text, not the npm `yaml` text. All AIO validation codes and
  messages are the same. Scalars use the YAML 1.2 core schema, as in
  TypeScript.
- **yaml-hooks:** Event payloads arrive as Go maps. The `tool_args` object
  in the bash stdin payload therefore has sorted keys, not the key order
  of the model. Values are the same.
- **yaml-hooks:** A bare-specifier import
  (`PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1`) uses a simple `node_modules`
  lookup (file, `.js`/`.json`/`.node`, `package.json` `main`, index). It
  does not read `exports` maps. Directory imports sort as `localeCompare`
  approximately.
- **yaml-hooks:** Warn-once notices and `PI_YAML_HOOKS_DEBUG` logs go to
  the extension's stderr. The recursion guard follows one call chain.
  A host event that a tool action causes (for example the follow-up
  prompt) starts a new chain.
- **yaml-hooks:** The confirm action emits the agent-prompt event on the
  event bus, as TypeScript does. The `id` is a per-process counter, so it
  differs from the Node one.
- **yaml-hooks:** As in TypeScript, `/hooks-trust` does not clear the
  cached discovery result. The new trust applies after a change to a
  watched hooks path or after `/hooks-reload`.



These values are idle memory after 30 seconds in this repository, without
the `pi-lens` language servers:

| Setup | Memory |
|---|---|
| `pig` with the Go extension only | `pig` 58 MB + Go extension 10 MB |
| `pig` with the TypeScript AIO only | `pig` 72 MB + Node extension 240 MB |

Other TypeScript extensions (`pi-lens`, `context7`, `pi-anthropic-auth`)
still need a Node extension process.
