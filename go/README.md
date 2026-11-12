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
The extension needs a `pig` built from the PiG fork (`danielboothcloud/PiG`,
branch `feature/fork`, commit `0ac0afaaf` or later). It does not build
under PiG 0.7.0. `PIG-LIMITS.md` ("Use the fork") gives the build steps.
The extension uses these fork SDK calls:

- `Context.SetSharedEnv` and `UnsetSharedEnv` (PiG divergence D234), in
  `aio/permissionmodes.go`.
- `ModelRegistry.CompleteContext` and `StreamSimpleContext` (PiG
  divergence D235), in `aio/goals.go` and `aio/sessionnaming.go`. They
  abort a model call when their `context.Context` is cancelled.
- `Context.RunForeground` and `sdk.ForegroundOptions` (fork commit
  `5c9fdda0d`, no divergence number), in `aio/tuicr.go`. They give the
  terminal to tuicr and redraw the TUI when tuicr exits
  (`PIG-LIMITS.md`, limit 1).
- `Context.ShutdownWithCode` (PiG divergence D236), in `aio/recipes.go`.
  The call is optional: an older SDK gets `ctx.Shutdown()`.

The Go editors also need the fork's editor fix (commit `f46b9ab2c`).
The user-bash editor (group 7) and the queue, frame, and session-nav
editor features (group 11) override editor methods. `pig` 0.7.0 crashes
on the first key then (`PIG-LIMITS.md`, limit 2). Groups 8 to 10 use
overlays, not editors, and do not need the fix.
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

## Camoufox worker

browser-search fetches pages with a local Camoufox browser
(`internal/browsersearch/worker/camoufox_worker.py`). Go embeds the file,
writes it to a cache folder, and starts it once with
`uv run --script`. The file has PEP 723 metadata (`camoufox==0.5.9`, which
brings Playwright), so uv builds its environment. No repository virtual
environment is needed. The worker keeps the browser open. Go and the
worker exchange one JSON object per line over stdin and stdout. Go sends
its SSRF rule list in the first message. The worker blocks each browser
request to a private, loopback, link-local, or metadata address.
`session_shutdown` stops the worker and the browser. When the extension
exits, the worker reads end-of-file and closes the browser.

Environment variables:

- `BROWSER_SEARCH_UV` (`uv` on `PATH`): the uv binary.
- `BROWSER_SEARCH_PYTHON` (uv chooses): the Python interpreter that uv
  uses (`uv run --python`).
- `BROWSER_SEARCH_CAMOUFOX_HEADLESS` (`true`): set `0`, `false`, or `no`
  to show the browser window.
- `BROWSER_SEARCH_CAMOUFOX_STARTUP_TIMEOUT_MS` (`1800000`): the time limit
  for the start, which includes the first-use downloads. A cancelled tool
  call does not stop the start.
- `BROWSER_SEARCH_CAMOUFOX_PAGE_TIMEOUT_MS` (`30000`): the navigation time
  limit for each URL. Go stops the worker 20 seconds after this limit.
- `BROWSER_SEARCH_CAMOUFOX_PROXY` (none): a proxy server URL for the
  browser.
- `BROWSER_SEARCH_CAMOUFOX_WORKER_DIR` (`<user cache>/aio/browser-search`):
  the folder for the worker files.
- `BROWSER_SEARCH_HTTP_TIMEOUT_MS` (`20000`) and
  `BROWSER_SEARCH_HTTP_MAX_BYTES` (`5242880`): the limits of the HTTP
  fallback. It uses the proxy environment (`HTTP_PROXY`, `NO_PROXY`).
- `BROWSER_SEARCH_CLOAK_MAX_CHARS` (`100000`): the content limit of the
  Camoufox and HTTP tiers.
- `BROWSER_SEARCH_CAMOFOX_BASE`: set it to use the Camofox container
  before the local worker.

The first fetch shows "Downloading the Camoufox browser" as progress and
as a notice. To run the real worker test, use
`AIO_CAMOUFOX_E2E=1 go test -run CamoufoxEndToEnd ./internal/browsersearch`.

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
| 2 | permission-modes | 1860 | Done, with the gaps below. Golden parity on 80 commands, 7 plan messages, 8 `apply_patch` inputs, 13 workspace-guard cases, 392 gate cases (4 modes, with and without UI, 6 answer sets, and the 115 agent-prompt events of the approval prompts), the todo tool, and 8 mode contexts. The diff overlay and the plan prompts emit the same agent-prompt events. |
| 3 | recipes (in-session part) | 3862 | Done, with the gaps below. Golden parity on 24 loads (6 folders, 4 trust combinations), model specs, branch scans, the shared trust store (Go reads what TypeScript writes), and trust prompt text. Golden parity from the real `registerRecipes` handlers: 11 name suggestions, 13 `init` argument parses, 17 `.pi-recipe` scaffolds (byte for byte, in JavaScript key order), 22 `/recipe init` runs (blank, `--from`, picker, input, errors), 7 status reports with their text, JSON, and 56 chrome renders, 25 `/recipe status` and `/recipe-status` runs in 4 modes, 5 runs of recipes named like a subcommand, 7 session trust questions, 6 `--no-approve` trust reads, and 600 launch decisions (`decideRelaunch` in 6 environments). Selection precedence has unit tests. The launcher (`bin/aio-pig.mjs`) stays in Node; `AIO_PIG_EXTENSION=<repo>/go/aio` makes it load the Go extension. Checked in the PiG fork in JSON, RPC, and TUI mode. |
| 4 | styles, effort, notifications, session-naming | 1468 | Done, with the gaps below. Golden parity: styles (16 mode contexts, parsing, context filter, command notices), effort (30 parses, 144 payload overrides, 196 level reconciles, completions), notifications (33 text-cleaning cases, settings normalization, 6 backend delivery paths, 14 event scenarios including `/notify`), session-naming (15 titles, 10 eligibility and prompt flows). |
| 5 | goals, btw | 1905 | Done. Golden parity: goals (8 branch reads, 12 argument parses, 6 completion sets, 16 review parses, 7 one-line texts, 16 status cases, 5 descriptions, 5 prompts, 9 latest-entry reads, 7 workspace snapshots, and 18 scenarios with 191 steps through the real `registerGoals`, with their 210 notification events: goal activity, "needs attention", "complete", and the `goal_propose` agent prompt, and 15 draft card renders in the shared chrome), btw (88 digests, 11 prompts, 11 sanitize cases, 10 outcomes, 70 box and card renders and 24 more in the chrome colors, 8 snapshots, 4 command scenarios with their "Side answer ready" and "Side question failed" signals). |
| 6 | subagents | 4288 | Done, with the gaps below. Golden parity: agent discovery (3 trees, 16 invalid files, embedded builtins checked against `subagents/agents`), child extension launch (7 argv cases, 3 enforce cases), activity (23 events, 420 formats, durations, argument summaries), transcripts (6 event scripts with budgets, clipping, sanitizing), history restore (19 branch entries, 50-run cap), 8 saved transcripts, 7 spawn specs, run results and progress, 16 widget renders, 40 transcript renders, 10 inspector scripts (72 frames with keys), and 11 real runner scenarios with `subagents/test-fixture-child.mjs` (retry, timeout, quota, settle reaping, spawn failure). Manual resume has a Go test. Shared packages: `chrome` (port of `ui/chrome.ts`, 900 renders), `piargs` (Pi's `parseArgs`, 57 argv cases), `tuiwidth` (copy of the SDK's pi-tui width code), `jsstr` (JavaScript string helpers, moved from btw). |
| 7 | rtk, hypa, user-bash, ast-grep, nvim, tuicr, init | 4220 | Done, with the gaps below. Golden parity: init (24 prompts), rtk and user-bash (16 commands, 12 editor texts), ast-grep (18 inputs, 12 summaries, 20 process outcomes, 3 results including truncation), nvim with the shared `toolpaths` package (45 command runs, 16 tool inputs, launcher argv), tuicr (7 fake worlds, 42 picker choices), hypa (18 configs, 14 timeout injections, binary resolution, command builders, image sniffing, 12 tool runs including UTF-16 truncation, and the `hypa_mcp_proxy` bridge: 6 Pi `mcp.json` reads, 34 bridge runs through the real `registerHypaMcpProxyBridge` with a scripted exec, and its registration and schema). The bridge was checked in the PiG fork with a mock `hypa` binary. |
| 8 | pretty-tools, diff-tools, copy-widget | 11012 | Done, with the gaps below. Golden parity: jsdiff (289 line diffs, 1156 patches, 625 word diffs from the npm `diff` package), xxHash32 (469 hashes from `xxhash-wasm`), and diff-tools (30 `parseDiff` and 8 patch parses, 108 separator labels, 37 cascading replaces, 19 `replaceForPatch` cases, 20 Cursor argument sets, 6 `apply_patch` fixture scenarios with rollback, 8 encodings, 8 conflict files, 9 hashline files and 25 anchor edits, 36 mutation previews, 7 edit-guard calls, 5 config folders, a fixture git repository and 5 git parses, 16 tool executes, 156 tool-card renders, 160 split and unified renders, 12 review hunks, 3 preset renders, and 80 approval overlay and select cases with key sequences). The approval overlay replaces the permission-modes `ctx.Select` preview in the TUI. pretty-tools (13 background steps, icons and languages, 84 background fills, 52 grep-guard commands, 11 find globs, the rtk tool-routing helpers (7 truncations, 5 line limits, 6 exit checks), 12 autocomplete cases with a mock finder, 4 tool registrations, 15 lifecycle steps, 44 tool executes with scripted rtk runs and built-in tools, and 516 tool-card renders at 4 widths, collapsed, expanded, and error). copy-widget (43 Markdown samples through the real marked-based `parse.ts`, 8 labels, 84 preview renders of the pi-tui `Markdown` component, 14 picker scenarios with 63 key frames and 119 renders, and 11 `/pick` and `ctrl+p` flows with clipboard results). |
| 9 | ask-user-question | 5260 | Done, with the gaps below. Golden parity: rpiv-config (108 config loads over 8 fixture HOME folders and 9 `XDG_CONFIG_HOME` values, 16 guidance checks), tool metadata and schema (3 guidance configs), 6 sanitize and 12 validation cases, 8 answer segments, 7 response envelopes, 8 item lists, 27 collapse keys, 49 layout and 8 box cases, pi-tui `Input` (10 key scripts, 76 steps, 380 renders), 16 reducer cases, 21 questionnaire scenarios (172 key frames with actions and state, 573 renders at 2 to 5 terminal sizes from 160x50 to 12x10), 16 RPC dialog walks, 4 reconciles, and 24 tool executes through a mock host (64 overlay frames, events, terminal-input listener, collapse, notices). A Go test covers PiG's key routing (the overlay gets a key before the terminal-input listeners). |
| 10 | browser-search | 3377 | Done, with a deliberate divergence and the gaps below. Golden parity: 21 environment sets and the main environment, 20 settings merges, 14 settings loads (7 folders, trusted and untrusted, V8 parse-error texts), 98 URL validations (WHATWG host parsing, IPv4 and IPv6 forms, IDNA), 13 DNS checks with a fixed resolver table, 26 challenge detections, 13 challenge-content checks, 19 SearXNG and 22 Exa searches against a local scripted server (requests, bodies, timeouts, odd JSON), 26 Camofox flows (requests, auth headers, sleeps, snapshot fallback, tab clean-up), 12 `fetchSingleUrl` cases that end at the Camofox container, tool registrations, 7 session-start and 4 dependency cases, and 35 tool executes with updates. The embedded `Readability.js` is checked against `@mozilla/readability`. The fetch chain after the container is Go-only: a local Camoufox worker and a plain HTTP fallback replace CloakBrowser (see "Camoufox worker"). Go tests cover the worker protocol and lifecycle with a fake worker, the HTTP fallback against local servers, and the notices. The SSRF rule list is shared through `testdata/browser-policy.json`, which the Python unit tests read. An opt-in test (`AIO_CAMOUFOX_E2E=1`) runs the real worker against local pages. |
| 11 | frame, status-line, queue, session-nav, ui | 5468 | Done, with the gaps below. Golden parity: frame (26 style specs, 98 format cases, 4 usage totals, 188 frame renders at 19 widths from 0 to 120, 24 border rules, 180 editor renders over 10 scripted base editors with autocomplete rows and viewport rules, 9 protocol steps, 7 git parses and 4 real `git` runs in a fixture repository, 37 Codex parse and route cases, 10 retry delays, 7 account ids, 11 quota collector runs over a mocked fetch, 8 registrar steps), status-line (49 settings loads, 90 row renders, 15 stats cases, 40 usage mappings, 11 environment templates, 7 `auth.json` reads, 9 fetches over a mocked fetch, 16 display cases), queue (19 mirror steps, 4 controller scenarios with 28 steps, 36 widget renders, 3 registrar runs, 6 restores, 2 editor key scripts with 28 steps through a real pi-tui editor, 70 shell editor renders), session-nav (30 text cases, 8 checkpoint trees, 21 session cases, 7 tail reads, 49 layout cases, 7 rewind scripts with 120 renders, 7 resume scripts with 72 renders, 10 settings loads, 11 launch argv cases, 4 registrar runs with double-Esc timing), ui (10 image spans, 13 viewport screens). Checked in the PiG fork in TUI, RPC, and JSON mode. |
| 12 | yaml-hooks | 6606 | Done, with the gaps below. Golden parity: 37 YAML values, 38 schema files (every validation error code), 2 override sets, 28 discoveries (trust, git worktree anchors, imports, cycles, depth cap, trust-anchor, global, and package boundaries, size caps), 1643 globs (a port of Node's `path.matchesGlob`), 11 condition sets, 22 redactions, stdin, UTF-8, and env helpers, 13 real bash runs (exit 2 blocking, timeout, truncation, allowlist, spawn failure), session state and 10 lineage reads, 10 runtime scenarios (dispatch, idle changes, async queues, budgets, debug logs), 5 scenarios through the real `registerYamlHooks` (lifecycle, UI actions, confirm, prompt context, `/hooks-*` commands), and 20 diagnostics renders. Unit tests cover dispatch queueing, async lanes, and the recursion guard. |

## Known gaps

Some gaps come from limits of PiG 0.7.0 and its Go SDK. See
`PIG-LIMITS.md` for each limit, its workaround, and how to check for a fix.

These gaps close when the related feature is ported:

- **permission-modes:** Relative paths resolve against the session cwd only.
  The Go process's own working directory is not the host's tool base.

- **recipes:** A Go extension cannot read the terminal before pig's TUI
  starts, so a new or changed `.pi-recipe` is asked about in the session
  (a select), not on the terminal (`PIG-LIMITS.md`, limit 10). The
  `bin/aio-pig.mjs` launcher still asks on the terminal before pig starts.
- **recipes:** In print and JSON mode, the `/recipe status` text, the
  trust hint, and the empty-scope message go to the extension stderr,
  which PiG does not show (limit 8). The status report is still a session
  entry, and JSON mode prints it as `entry_appended`.
- **recipes:** The empty-scope stop exits with status 1 only in a pig
  whose SDK has `Context.ShutdownWithCode` (PiG D236). An older pig gets
  `ctx.Shutdown()`, which print and JSON mode ignore (limit 9).
- **recipes:** The `resumed recipe` launch note for `--continue`,
  `--session`, and `--session-id` reads the opened session's branch at
  session start. TypeScript resolves the session in the factory; the
  session is the same.
- **recipes:** Name sorting approximates `localeCompare` (base letters,
  then accents, then case, then bytes). MCP servers register in name
  order.

- **effort:** Print-mode notices go through `ctx.Notify`, not
  stdout/stderr. The `reasoning_effort` override
  applies only to payloads that carry that field (as in TypeScript); OpenAI
  Codex responses use `reasoning.effort` and are unchanged.
- **notifications:** The terminal fallback (OSC 777/99 and the bell) writes
  to `/dev/tty`, because the Go extension's stdout is the wire to the PiG
  host.
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
- **ask-user-question:** Agent-prompt event ids come from one counter in
  `go/aio` (ask-user-question, goals, permission and plan prompts).
  yaml-hooks has its own counter, and Node producers have theirs.

- **browser-search:** The fetch chain differs from TypeScript on purpose.
  Go tries the Camofox container only when `BROWSER_SEARCH_CAMOFOX_BASE`
  or `CAMOFOX_BASE` is set. Without it, Go never contacts
  `localhost:9377`. Then Go tries the local Camoufox worker, and then a
  plain HTTP fetch. TypeScript tries the container (default
  `localhost:9377`) and then the CloakBrowser Node worker. The Go port
  has no CloakBrowser worker and ignores `BROWSER_SEARCH_NODE_BINARY`.
  The result tiers are `camofox`, `camoufox`, and `http`.
- **browser-search:** The Camoufox tier needs Python 3.10 or later and
  `uv`. The first start installs the Python packages and downloads the
  Camoufox browser (several hundred MB). A missing `uv`, Python, or
  `camoufox` package never stops the extension from loading. The fetch
  then uses the HTTP fallback.
- **browser-search:** When the HTTP fallback gives the result, the tool
  shows a warning notice once for each URL in a call. The result text and
  the details also contain the warning. In JSON and print mode the notice
  goes to the extension stderr. PiG keeps the stderr of a Go extension in
  a temporary log only, so the notice is not visible there
  (`PIG-LIMITS.md`, limit 8). The result text still contains it.
- **browser-search:** The HTTP fallback extracts with
  `codeberg.org/readeck/go-readability/v2` and `html-to-markdown` v2. Its
  markdown keeps links. The browser tiers return the Readability text, as
  TypeScript does.
- **browser-search:** Playwright does not send redirect hops through route
  handlers. The worker checks each hop after the browser sends it. A hop
  to a blocked address fails the fetch, and no page content reaches the
  model, but the browser has sent that request. A URL that the worker
  blocks does not go to the HTTP fallback. The HTTP fallback checks
  each redirect target before it follows it. As in TypeScript, the
  browser resolves DNS again, so a DNS answer that changes after the
  check is not caught.
- **browser-search:** The tool descriptions are the TypeScript texts,
  which name Camofox and CloakBrowser. The fetch progress names the Go
  chain.
- **browser-search:** Host names come from a Go port of the WHATWG URL
  host parser. Domain mapping uses `golang.org/x/net/idna` (UTS #46). Rare
  IDNA cases can differ from Node's parser. This module needs
  `go 1.26.0` in `go.mod`.
- **browser-search:** DNS uses the Go resolver. A missing host gives
  Node's `getaddrinfo ENOTFOUND <host>` text; other DNS errors use the Go
  text. An IPv4-mapped IPv6 answer is checked as IPv4.
- **browser-search:** `JSON.parse` error texts (settings files) follow
  V8 for the common errors. Rare forms can
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
- **hypa:** The `hypa_mcp_proxy` details data is a Go map, so its keys
  are sorted. The tool text, the invoke arguments (read from
  `ctx.ToolInput()`), and the printed schemas keep the JavaScript order.
  The default Pi `mcp.json` for deduplication is `~/.pi/agent/mcp.json`,
  as in TypeScript.
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


## Separate Anthropic auth port

`anthropic-auth/` is a separate extension alongside `aio/`. It ports `@gotgenes/pi-anthropic-auth` 3.4.4, MIT by Christopher D. Lasher (gotgenes), at commit `fcc2003ca57df5b841edcdd27da58e428cded743`. AIO does not import or activate it.

It needs a `pig` built from the PiG fork with `sdk.AnthropicMessagesAPI` and the legacy provider callback bridge; PiG 0.7.0 cannot load it. Remove the TypeScript `npm:@gotgenes/pi-anthropic-auth`, then run `pig install ./go/anthropic-auth`. Real-pig tests prove the main turn, auxiliary `ModelRegistry` calls, the version retry and learned floor, API-key passthrough, and other extensions' request callbacks. [anthropic-auth/UPSTREAM.md](anthropic-auth/UPSTREAM.md) lists the evidence and the remaining gaps (compaction and the status command are not host-tested).

