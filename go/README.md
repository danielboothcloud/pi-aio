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
The extension needs a `pig` whose SDK has `Context.SetSharedEnv` (PiG
divergence D234, after 0.7.0). Under PiG 0.7.0 the build fails in
`aio/permissionmodes.go`. It also needs `ModelRegistry.CompleteContext`
and `StreamSimpleContext` (PiG divergence D235), which abort a model call
when their `context.Context` is cancelled. Without them the build fails in
`aio/goals.go` and `aio/sessionnaming.go`.

The Go editors need the PiG fork (`danielboothcloud/PiG`, commit
f46b9ab2c): the user-bash editor (group 7) and the queue, frame, and
session-nav editor features (group 11) override editor methods, and
`pig` 0.7.0 crashes on the first key then (`PIG-LIMITS.md`, limit 2).
Groups 8 to 10 use overlays, not editors, and do not need the fix.
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
| 8 | pretty-tools, diff-tools, copy-widget | 11012 | Done, with the gaps below. Golden parity: jsdiff (289 line diffs, 1156 patches, 625 word diffs from the npm `diff` package), xxHash32 (469 hashes from `xxhash-wasm`), and diff-tools (30 `parseDiff` and 8 patch parses, 108 separator labels, 37 cascading replaces, 19 `replaceForPatch` cases, 20 Cursor argument sets, 6 `apply_patch` fixture scenarios with rollback, 8 encodings, 8 conflict files, 9 hashline files and 25 anchor edits, 36 mutation previews, 7 edit-guard calls, 5 config folders, a fixture git repository and 5 git parses, 16 tool executes, 156 tool-card renders, 160 split and unified renders, 12 review hunks, 3 preset renders, and 80 approval overlay and select cases with key sequences). The approval overlay replaces the permission-modes `ctx.Select` preview in the TUI. pretty-tools (13 background steps, icons and languages, 84 background fills, 52 grep-guard commands, 11 find globs, the rtk tool-routing helpers (7 truncations, 5 line limits, 6 exit checks), 12 autocomplete cases with a mock finder, 4 tool registrations, 15 lifecycle steps, 44 tool executes with scripted rtk runs and built-in tools, and 516 tool-card renders at 4 widths, collapsed, expanded, and error). copy-widget (43 Markdown samples through the real marked-based `parse.ts`, 8 labels, 84 preview renders of the pi-tui `Markdown` component, 14 picker scenarios with 63 key frames and 119 renders, and 11 `/pick` and `ctrl+p` flows with clipboard results). |
| 9 | ask-user-question | 5260 | Done, with the gaps below. Golden parity: rpiv-config (108 config loads over 8 fixture HOME folders and 9 `XDG_CONFIG_HOME` values, 16 guidance checks), tool metadata and schema (3 guidance configs), 6 sanitize and 12 validation cases, 8 answer segments, 7 response envelopes, 8 item lists, 27 collapse keys, 49 layout and 8 box cases, pi-tui `Input` (10 key scripts, 76 steps, 380 renders), 16 reducer cases, 21 questionnaire scenarios (172 key frames with actions and state, 573 renders at 2 to 5 terminal sizes from 160x50 to 12x10), 16 RPC dialog walks, 4 reconciles, and 24 tool executes through a mock host (64 overlay frames, events, terminal-input listener, collapse, notices). A Go test covers PiG's key routing (the overlay gets a key before the terminal-input listeners). |
| 10 | browser-search | 3377 | Done, with the gaps below. Golden parity: 21 environment sets and the main environment, 20 settings merges, 14 settings loads (7 folders, trusted and untrusted, V8 parse-error texts), 98 URL validations (WHATWG host parsing, IPv4 and IPv6 forms, IDNA), 13 DNS checks with a fixed resolver table, 26 challenge detections, 13 challenge-content checks, 19 SearXNG and 22 Exa searches against a local scripted server (requests, bodies, timeouts, odd JSON), 26 Camofox flows (requests, auth headers, sleeps, snapshot fallback, tab clean-up), 12 CloakBrowser worker runs with `test-fixture-cloak-worker.mjs` (crash output, timeout, output cap, descendants, missing Node), 21 `fetchSingleUrl` cases, tool registrations, 7 session-start and 4 dependency cases, and 36 tool executes with updates. The embedded `Readability.js` is checked against `@mozilla/readability`. |
| 11 | frame, status-line, queue, session-nav, ui | 5468 | Done, with the gaps below. Golden parity: frame (26 style specs, 98 format cases, 4 usage totals, 188 frame renders at 19 widths from 0 to 120, 24 border rules, 180 editor renders over 10 scripted base editors with autocomplete rows and viewport rules, 9 protocol steps, 7 git parses and 4 real `git` runs in a fixture repository, 37 Codex parse and route cases, 10 retry delays, 7 account ids, 11 quota collector runs over a mocked fetch, 8 registrar steps), status-line (49 settings loads, 90 row renders, 15 stats cases, 40 usage mappings, 11 environment templates, 7 `auth.json` reads, 9 fetches over a mocked fetch, 16 display cases), queue (19 mirror steps, 4 controller scenarios with 28 steps, 36 widget renders, 3 registrar runs, 6 restores, 2 editor key scripts with 28 steps through a real pi-tui editor, 70 shell editor renders), session-nav (30 text cases, 8 checkpoint trees, 21 session cases, 7 tail reads, 49 layout cases, 7 rewind scripts with 120 renders, 7 resume scripts with 72 renders, 10 settings loads, 11 launch argv cases, 4 registrar runs with double-Esc timing), ui (10 image spans, 13 viewport screens). Checked in the PiG fork in TUI, RPC, and JSON mode. |
| 12 | yaml-hooks | 6606 | Done, with the gaps below. Golden parity: 37 YAML values, 38 schema files (every validation error code), 2 override sets, 28 discoveries (trust, git worktree anchors, imports, cycles, depth cap, trust-anchor, global, and package boundaries, size caps), 1643 globs (a port of Node's `path.matchesGlob`), 11 condition sets, 22 redactions, stdin, UTF-8, and env helpers, 13 real bash runs (exit 2 blocking, timeout, truncation, allowlist, spawn failure), session state and 10 lineage reads, 10 runtime scenarios (dispatch, idle changes, async queues, budgets, debug logs), 5 scenarios through the real `registerYamlHooks` (lifecycle, UI actions, confirm, prompt context, `/hooks-*` commands), and 20 diagnostics renders. Unit tests cover dispatch queueing, async lanes, and the recursion guard. |

## Known gaps

Some gaps come from limits of PiG 0.7.0 and its Go SDK. See
`PIG-LIMITS.md` for each limit, its workaround, and how to check for a fix.

These gaps close when the related feature is ported:

- **permission-modes:** The approval prompts emit no agent-prompt event
  (notifications). The TUI uses the diff-tools overlay. RPC uses `ctx.Select`
  with the same plain diff preview as TypeScript.
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

- **effort:** Print-mode notices go through `ctx.Notify`, not
  stdout/stderr. The `reasoning_effort` override
  applies only to payloads that carry that field (as in TypeScript); OpenAI
  Codex responses use `reasoning.effort` and are unchanged.
- **notifications:** The terminal fallback (OSC 777/99 and the bell) writes
  to `/dev/tty`, because the Go extension's stdout is the wire to the PiG
  host. Go producers (permission prompts, goals) do not emit agent-prompt
  or goal events yet; Node producers on the shared event bus still do.
- **goals:** No AIO notification events (goal activity, "needs
  attention", "complete", agent prompts). The draft card is plain text
  without `ui/chrome`, and the footer status has no theme tone.
- **btw:** No AIO notification events. The box and the card have no theme
  colors.
- **subagents:** Children run `$PIG_HARNESS_BINARY` (pig). The parent's
  `-ne`/`-e` flags come from `PIG_HARNESS_ARGV_FILE`; a `-ne` child lists
  the Go extension directory (from the extension source info) instead of
  `index.ts`. Spawn errors use Node's text (`spawn <cmd> ENOENT`), and
  stderr arrives in 64 KB reads, so log entries can split differently.
- **subagents:** The inspector cannot be closed from outside. Tree
  navigation and a new session mark it closed, and the next key closes it.
  Inline images are not hidden under the overlay: only the pure helpers of
  `ui/overlay-images.ts` are ported, because a Go extension cannot reach
  the host's renderer.
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
- **diff-tools:** Highlighting uses the host's highlight.js port
  (`sdk.HighlightCode`), not Shiki. The Shiki themes (`DIFF_THEME`,
  `shikiTheme`, preset themes) have no effect. A language that highlight.js
  does not know gets the `mdCodeBlock` color, not plain text.
- **diff-tools:** Renderers are synchronous. A card shows its final diff at
  once, without the "rendering diff…" placeholder.
- **diff-tools:** A card row wider than the card is wrapped by PiG's Go
  wrap port. It splits a long run of spaces differently from pi-tui 1.2.0
  (CJK lines and the narrow edit header). The text before the wrap matches.
- **diff-tools:** File-system error texts are rebuilt in Node's format
  (`ENOENT: no such file or directory, open '<path>'`) for the common
  codes. Other errors use the Go text. A file that is not valid UTF-8 keeps
  its bytes; Node replaces them with U+FFFD.
- **diff-tools:** Relative tool paths resolve against the extension's
  process directory (pig's working directory), as `process.cwd()` does.
  Approval previews and the edit guard resolve them against the session
  cwd.
- **diff-tools:** There is no hunk-review overlay to port. The TypeScript
  review helpers (`review/git.ts`, `renderReviewHunkPreview`) and hashline
  have no caller there; the Go port keeps them as tested library code.

- **pretty-tools:** FFF (`@ff-labs/fff-node`) is not ported. The tools use
  the path TypeScript takes when FFF does not load: rtk first, then the
  host's built-in tool. `/fff-health` and `/fff-rescan` report "FFF not
  initialized". No FFF @-mention provider is added; the host's own file
  completion stays. The provider logic is kept as tested library code.
- **pretty-tools:** Highlighting uses the host's highlight.js port
  (`sdk.HighlightCode`), not Shiki. `PRETTY_THEME` and the settings theme
  have no effect. A language that highlight.js does not know gets the
  `mdCodeBlock` color, not plain text.
- **pretty-tools:** rtk runs through `ctx.ExecWithOptions` (Pi's `pi.exec`).
  TypeScript removes `RTK_DISABLED` from its own process first. The Go
  extension cannot change the host's environment.
- **pretty-tools:** Renderers are synchronous: an expanded `read` card shows
  the highlighted lines at once. A card row wider than the card is wrapped
  by PiG's Go wrap port, as for diff-tools (70 of the 516 golden renders
  compare the card text only).
- **pretty-tools:** The grep match highlight lowercases `İ` as JavaScript
  does. Other special lowercase rules (for example the final sigma) follow
  Go, so the highlight can differ for them.
- **pretty-tools:** Helpers that no TypeScript tool calls are not ported
  (`fffFormatGrepText`, the grep cursor store, `filterSearchNotices`,
  `countGrepMatchLines`, `compactSearchSummary`, `makeRenderCall`,
  `makeRenderResult`, `renderBashOutput`).
- **copy-widget:** Markdown is parsed with `github.com/yuin/goldmark`. The
  port rebuilds marked's results: one level of `>` markers is removed from
  the quote source, top-level paragraphs are unwrapped, and an empty
  backtick fence on the last line after a paragraph stays paragraph text.
  Other marked differences from CommonMark are not reproduced.
- **copy-widget:** The picker preview is a port of pi-tui's `Markdown`
  component. LaTeX (`$…$`) is not rendered. PiG's Go wrap port wraps a
  preview row. It places the style codes and the space after a full line
  differently from pi-tui 1.2.0 (4 of the 84 golden renders; the words
  match).
- **copy-widget:** `ctrl+p` is the model-cycle key in PiG and in Pi. The
  host skips the extension shortcut until `app.model.cycleForward` gets
  another key, as Pi does. `/pick` always works.

- **ask-user-question:** `@juicesharp/rpiv-i18n` cannot load in Go. All
  texts are the built-in English strings, and `locales/*.json` is not read.
  TypeScript shows the same English texts when the package is absent.
- **ask-user-question:** PiG sends a key to the focused overlay before the
  terminal-input listeners. The first collapse key therefore goes through
  `routeKey`, not the listener. The listener still expands a hidden
  overlay. The "hidden — press … to reopen" notice is also sent when the
  overlay hides itself, so it shows once, as in TypeScript.
- **ask-user-question:** `setHidden` and the collapse notice run on a
  goroutine. The handle reports the requested hidden state at once.
- **ask-user-question:** There is no lazily loaded session module. The
  `session_load_failed` and `stale_module_cache` errors and the startup
  pre-warm do not exist in Go.
- **ask-user-question:** If the host closes a shown overlay without a
  result, the tool returns the decline result. TypeScript's `custom()` never
  resolves in that case.
- **ask-user-question:** The pi-tui `Input` port finds word boundaries with
  an approximation of `Intl.Segmenter` (letters, digits, and `_`, joined
  across `.` and `'`). CJK runs are one word; ICU uses a dictionary.
- **ask-user-question:** Previews use the copy-widget Markdown port and the
  host's code highlighting (see copy-widget). LaTeX is not rendered.
- **ask-user-question:** A malformed config file gives the same warning,
  but the parse error text is Go's. The warning goes to the extension's
  stderr. The schema is the same JSON Schema, but its object keys are in
  Go map order.
- **ask-user-question:** Agent-prompt event ids come from a counter in
  `go/aio`. yaml-hooks has its own counter, and Node producers have theirs.

- **browser-search:** The CloakBrowser fallback starts the TypeScript
  Node worker (`browser-search/cloak-worker.mjs`), found above the
  extension's source directory. The worker runs `cloak-runtime.ts`, so the
  Node-side extraction (linkedom, turndown, Readability) and the challenge
  wait are the TypeScript code. Go has no port of `readability.ts`, and
  `go-readability` and `html-to-markdown` are not used. The worker needs
  Node and the repository's `node_modules`. Without the worker file, each
  fallback fails with a Go error text.
- **browser-search:** The worker's Node is `BROWSER_SEARCH_NODE_BINARY`,
  else `node` on `PATH`. TypeScript uses its own `process.execPath`.
- **browser-search:** Host names come from a Go port of the WHATWG URL
  host parser. Domain mapping uses `golang.org/x/net/idna` (UTS #46). Rare
  IDNA cases can differ from Node's parser. This module needs
  `go 1.26.0` in `go.mod`.
- **browser-search:** DNS uses the Go resolver. A missing host gives
  Node's `getaddrinfo ENOTFOUND <host>` text; other DNS errors use the Go
  text. An IPv4-mapped IPv6 answer is checked as IPv4.
- **browser-search:** `JSON.parse` error texts (settings files, the
  worker result line) follow V8 for the common errors. Rare forms can
  differ. A fetch that fails after the response headers gives `terminated`.
- **browser-search:** Tool details are Go maps, so their keys are in Go
  map order. The values are the same.

- **frame:** The frame protocol is package state that the Go features of
  this extension share. PiG's event bus carries JSON by value, so the
  `aio:minimal-frame-capability` probe is not answered on the bus. A
  standalone Zentui editor in another extension is invisible to
  `GetEditorComponent`, so the frame cannot detect it (`PIG-LIMITS.md`,
  limit 7).
- **frame:** `frame/menus.ts` is not ported: the SDK has no hook into the
  host's selector components. Host menus keep their native rules.
- **frame:** The SDK cannot repaint an installed editor. Out-of-band
  changes repaint through a change of the base editor's autocomplete size
  and back (limit 4). The run timer repaints once per second while the
  agent runs. The metadata (thinking level, context percent, session
  name, cost) is read on lifecycle events, not on every render.
- **frame:** The autocomplete rows are cut from the base editor's render
  (the rows after its bottom rule, without the editor padding). TypeScript
  captures the list's own rows. Trailing spaces of a row are removed; the
  framed row looks the same.
- **frame:** The Codex route check reads the provider's base URL from a
  registered provider override, else from the model, because PiG has no
  public provider object for a built-in provider (D78). The token comes
  from `ModelRegistry().GetApiKeyAndHeaders`. Requests use Go's `net/http`.
- **status-line:** The verbose working message refreshes on `turn_start`,
  `before_provider_request`, and once per second while the agent runs,
  not on every `message_update`. With the frame active (the normal TUI
  case) the working message is not set, as in TypeScript.
- **status-line:** A missing header variable is reported for the first
  header in name order; TypeScript uses the order of the settings file.
- **queue:** Pi's `onSubmit` cannot be wrapped from Go. The queue editor
  predicts the submitted text on the submit key and offers it to the
  intercepts first. With the autocomplete open, Enter on a partial
  command (for example `/res`) completes and runs the host's own command.
- **queue:** The empty-Enter interrupt sends the host's interrupt key
  through the base editor, because PiG's `ctx.Abort` keeps the queued
  messages (limit 6). Sends go out on a worker goroutine.
- **session-nav:** `/rewind` and `/sessions` from the editor (double
  Escape, `/resume`, the resume key, `--sessions`) run through the base
  editor's host submit handler, because `sendUserMessage` cannot run a
  command (limit 5). The command is then in the editor history. Without
  an AIO editor (for example in RPC mode) the `--sessions` picker does not
  open.
- **user-bash:** The `user-bash` status is sent only when it changes;
  TypeScript sets it after every key in-process.

These values are idle memory after 30 seconds in this repository, without
the `pi-lens` language servers:

| Setup | Memory |
|---|---|
| `pig` with the Go extension only | `pig` 58 MB + Go extension 10 MB |
| `pig` with the TypeScript AIO only | `pig` 72 MB + Node extension 240 MB |

Other TypeScript extensions (`pi-lens`, `context7`, `pi-anthropic-auth`)
still need a Node extension process.
