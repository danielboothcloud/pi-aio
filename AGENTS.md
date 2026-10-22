# aio

Combined Pi extension package for recipes (named launch configurations),
structured questions, permission modes, subagents, enhanced built-in tools,
diff rendering, shell rewriting, and structural search.

> **Runtime user configuration lives in the agent directory.** Features read
> their user-facing config from `<agent-dir>` at runtime (`aio-recipes.json`,
> `aio-blocklist.json`, the goal/YSK settings files) — that is the shipped
> contract. The rule below is about *development work*: never let the agent
> place feature code, scratch state, or out-of-tree settings there during
> edits or tests.

> The inherited `/Users/danielbooth/CLAUDE.md` describes a different dotfiles
> repository. Its chezmoi, Homebrew, Fish, and Neovim instructions do not apply
> here.

> **All AIO work happens inside this repository, within this extension.** This
> package *is* the extension: features are its modules, registered from
> `index.ts`, and hosts load it through a `packages` reference (`git:…`, npm) or
> `pi -e .` from a checkout. Never write feature code, configuration, settings,
> or scratch state to home-directory or other out-of-repo locations (`~/.pi/`,
> `~/.config/pi/`, `/tmp`): the running session never reads files placed there,
> so the work is invisible at runtime and sits outside version control.

## Commands

- `npm ci` — install the locked dependency set.
- `npm test` — run all local Node tests, diff-tool Vitest tests, and retained
  upstream questionnaire tests.
- `npm run test:node` — run the fast local suites through `tsx --test`.
- `npm run test:diff` — run `diff-tools/**/*.test.ts` with
  `vitest.diff.config.ts`.
- `npm run test:upstream` — run `ask-user-question/**/*.upstream.test.ts` with
  the isolated test HOME from `test/setup.ts`.
- `npx tsx --test path/to/file.test.ts` — run one Node test file.
- `npx vitest run --config vitest.diff.config.ts path/to/file.test.ts` — run one
  diff Vitest file.
- `pi -e .` — load the package from this checkout for an interactive smoke test.
- `npm pack --dry-run --json` — verify the npm tarball allowlist before release
  or after adding files.

There is no separate build, lint, typecheck, deploy, or CI pipeline. Pi loads the
TypeScript entry point directly through jiti; do not introduce or depend on a
generated `dist/` tree without changing the package contract.

## Stack

- ESM TypeScript (`type: module`) managed with npm and `package-lock.json`.
- Pi extension APIs from `@earendil-works/pi-*`, TypeBox schemas, Pi TUI
  components, Shiki, FFF, and the bundled ast-grep CLI.
- Local regression tests primarily use `node:test`; diff and vendored
  questionnaire suites use Vitest.

## Architecture

- `index.ts` is the sole package entry point and composes feature-level
  registrars. Preserve registration order unless deliberately changing event
  interception: `registerRecipes` runs FIRST (its factory-time relaunch bridge
  decides before anything else starts, and session_start applies recipe state
  before other feature initialization); hypa
  must register after rtk (rtk precedence) but before queue and pretty tools,
  which own the final bash behavior. Blocklist gates run before
  permission-modes (loop blocks preempt mode checks; the hard
  blocklist wins over loop blocks). `registerFrameEditor` runs after queue,
  pretty-tools, and status-line so it can wrap the final editor and own
  the visual surfaces. Preloaded standalone Zentui editors are preserved by the
  user-bash and queue registrars rather than overwritten. `registerYamlHooks`
  runs LAST for agent tool-hook composition. AIO registers no `user_bash`
  interceptor: explicit !/!! commands use Pi's native shell path without AIO
  permission checks, blocklists, rewrites, or YAML evaluation.
- `recipes/` owns `--recipe` and `/recipe`: named launch configurations from
  `<agentDir>/aio-recipes.json` (two-tier: trusted project
  `/.pi/aio-recipes.json` recipes override same-name globals; the global file
  is also replaced whole by `AIO_RECIPES_FILE` for tests — goal-settings
  contract — and is never written by AIO). Session-scoped keys (model plus
  `:thinking` spec suffix, thinking level, and MCP servers registered through
  `registerMcpServer`/`unregisterMcpServer` by this feature only)
  apply at `session_start` and on `/recipe` switches — the command refreshes
  the config itself so a mid-session file edit is honored. Restart-scoped
  keys (`extensions`, `models`) are applied by the relaunch bridge in the
  extension factory (`trampoline.ts`): a pure `decideRelaunch()` runs guards
  (subagent children, staged relaunches, subcommands, `--help`/`--version`/
  `--export`/`--list-models`, explicit user `-e`/`--models` flags, and it
  reads only the global recipes file since project trust is unresolved during
  factories), then `execRelaunch()` re-spawns pi once via pi's own argv
  (`-ne -e <aio> -e <ext> --models …`), stripping the `--recipe` token and
  handing the name over as `AIO_RECIPE_ACTIVE`; `AIO_RECIPE_STAGE=1` makes a
  loop impossible and a failed spawn falls back in-session with a warning
  (a later `close` after a spawn `error` must not kill that fallback). Compiled
  Bun's virtual argv entry (`/$bunfs/...` or `B:\\~BUN\\...`) is never forwarded
  as an executable argument; real Node/Bun script entries are retained. A
  recipe startup with an explicit model scope resolving to zero available
  models reports an error and exits 1 before any prompt (deferred shutdown
  requests are not reliable in print/JSON mode), rather than allowing Pi's
  empty-scope = all-models fallback. Validation is initial-startup-only, not
  reload after a deliberate in-session scope change. The opt-in
  `compiled-smoke.test.ts` exercises actual binary relaunch + single-model
  cycling + missing-scope rejection in RPC/JSON/text with local provider
  fixtures, no credentials/network/model calls;
  select the binary via `AIO_RECIPES_SMOKE_PI`. `pi list` describes saved
  package configuration, not the recipe child's loaded extension set.
  Selection precedence: flag > bridge env > session `recipe-state` entry
  (branch-pinned; off pins `name: null`) > `defaultRecipe` on fresh startups
  only. A launch-cwd `.pi-recipe` (or `.pi-recipe.json`; same JSON shape,
  no parent walk, `.pi-recipe` wins) is a third tier above
  `.pi/aio-recipes.json`. Folder trust never covers it: `trust.ts` requires
  explicit per-file trust stored in `<agentDir>/aio-recipe-trust.json`
  (`AIO_RECIPE_TRUST_FILE` for tests), keyed by realpath and pinned to a
  SHA-256 of the contents, so a new or edited file asks again; "never" is
  remembered per version, "not now" is not, `--no-approve` skips one run.
  The factory asks on the terminal (`promptRecipeTrust`, readline
  `terminal: false`, closed before pi's TUI starts) only when
  `canPromptAtLaunch` holds (interactive mode, both TTYs, no stage/child/
  subcommand/print-and-exit/--no-approve), so a just-trusted restart-scoped
  default still relaunches; otherwise session_start asks via a
  non-blocking `ctx.ui.select` (RPC) or writes a stderr hint (print/JSON),
  once per process (`directoryAsked`). A trusted directory default is
  bridged like `--recipe` on fresh starts (never on
  `-c`/`-r`/`--session`/`--session-id`/`--fork`) with
  `AIO_RECIPE_ORIGIN=directory`, which keeps it at default priority in the
  child so a `/resume`d session entry still wins. `/recipe init [name]`
  writes a `.pi-recipe` (exclusive create; always a full self-contained
  scaffold — blank, seeded with the live model/thinking, or a COPY of a home
  recipe chosen in a picker or via `--from`) and trusts it. The file is
  portable: its `defaultRecipe` resolves only against its own `recipes`
  (never global/project ones; otherwise ignored with a warning);
  `/recipe trust` / `/recipe untrust` record or forget the decision.
  Recipes support only description/model/thinkingLevel/models/mcpServers/extensions;
  unknown keys are ignored. Recipes literally named `init`/`trust`/`untrust` keep
  switching. Every process strips legacy `recipe-context` messages from model
  context, even while a recipe is active. Subagent children register only that
  cleanup filter and the status renderer (no recipe activation). Status is dual-channel (frame
  `recipe` pill beside the mode-style cluster, else a `statuses`-segment
  pill). `/recipe status [--json]` (unambiguous alias `/recipe-status`) uses
  `status.ts` to capture actual model/API/thinking/scope, launch extension
  policy and sources, tool/command source metadata, and registered provider
  IDs without a provider request or authentication refresh. Runtime facts and
  configured expectations are labeled separately; observed registrations are
  explicitly NOT a complete passive-extension inventory. An allowlisted,
  credential-redacted `recipe-status-report` custom entry persists outside
  model context and renders via shared chrome; RPC also notifies, while
  print/JSON emits stderr diagnostics (notify is a no-op there). A recipe
  actually named `status` keeps its old switching semantics. It owns no
  tools, gates nothing, and registers FIRST.
- `pretty-tools/` overrides `read`, `bash`, `ls`, `find`, and `grep`;
  `diff-tools/` owns `write`, `edit`, and `apply_patch`; `permission-modes/`
  gates agent mutations. `bash` and `hypa_shell` share permission and hard
  blocklist checks (`isShellTool`); never gate only one shell surface. The shell
  read-only allowlist is deliberately conservative: scripts, compound commands,
  execution-capable wrappers, and helper-capable Git diff/log/show require
  approval in default mode and are blocked in ask/plan. Auto stays permissive
  except for hard blocklists. `user-bash/` owns editor hints only. Changes can
  cross feature boundaries.
- `ui/chrome.ts` is the shared visual vocabulary for AIO-owned surfaces:
  theme-aware accent rails, headers, items, hints, dividers, pluralization, and
  ANSI-aware width fitting. Diff/approval, pretty tools, copy picker, queue,
  goals, and subagents should compose these primitives rather than inventing
  new chrome. Preserve each component's behavioral and row-count contracts;
  every returned line must fit its supplied width.
- `browser-search/` owns the `web_search` and `fetch_content` names. Search is
  opt-in through `aio.browserSearch` in Pi settings and routes to Exa or
  SearXNG; browsing uses Camofox and lazily loads optional CloakBrowser. Tests
  must use injected/mocked backends rather than live network services.
- `hypa/` is vendored from @hypabolic/pi-hypa (FSL-1.1-ALv2 — see
  `hypa/LICENSE-FSL` and `hypa/UPSTREAM.md`). It registers the `hypa_*`
  shell/file tools, bash rewrite interception, the optional `hypa_mcp_proxy`
  bridge (off by default), and the `/hypa` diagnostics command. Composition
  rule: it registers after rtk and never rewrites commands rtk already claimed
  (`rtk ...`) — rtk precedence, see `isRtkClaimedCommand`.
- `ask-user-question/` is vendored code. Follow
  `ask-user-question/UPSTREAM.md`: preserve its license, config/event
  namespaces, sequential execution, soft i18n peer, and
  `*.upstream.test.ts` coverage when syncing upstream.
- `goal-loop/` is vendored from pi-goal-list-loop-audit (MIT, DraconDev — see
  `goal-loop/LICENSE-glla`). Only the `/goal` command and its supporting
  modules are retained (`goal-loop-core`, `goal-loop-auditor`,
  `goal-loop-shield`, `goal-loop-display`, `goal-loop-backoff`,
  `goal-settings`, `quota-retry`); the `/list`, `/loop`, `/gla`, `/review`
  commands, the reviewer/stats/forever/repetition/subagents modules, and all
  loop/list state were stripped. It drives `agent_end` continuations (the
  Two-Driver Rule) and is inert in aio subagent child processes
  (`AIO_SUBAGENT_CHILD=1`) so a child never restores the parent's goal.
- `yaml-hooks/` is ported from pi-yaml-hooks (MIT, KristjanPikhof — see
  `yaml-hooks/LICENSE` and `yaml-hooks/UPSTREAM.md`). It owns the
  `hooks.yaml` automation surface: discovery + trust, bash/tool/notify/
  confirm/setStatus actions, `/hooks-*` commands, and prompt context injection.
  It registers LAST for agent tool-hook composition and owns no tool names.
  Explicit user !/!! commands are never intercepted; the legacy
  `PI_YAML_HOOKS_ENABLE_USER_BASH` name is retained but ignored. Failure
  semantics: prompt hooks fail-open, post-tool hooks fail-open, cleanup hooks
  are best-effort. All `PI_YAML_HOOKS_*` env names and YAML validation error
  codes are append-only contracts.
- `tuicr/` is ported from @joelazar/pi-tuicr v1.1.0 (MIT, joelazar — see
  `tuicr/UPSTREAM.md` and `tuicr/LICENSE`). It owns the `/tuicr` command and
  the `ctrl+shift+r` shortcut: pick a diff (working tree, branch-vs-base with
  base detection via origin/HEAD → origin/main → origin/master → main →
  master, last commit, commit selector, all tracked files, custom revset, PR),
  pi's TUI suspends, tuicr runs in the foreground with inherited stdio, and
  when it exits comments created during that session (ids snapshotted before,
  diffed after) are numbered and prefilled into the editor via
  `ctx.ui.setEditorText`. It registers no tools and owns no editor surface,
  so registration order is not load-bearing; it sits after status-line and
  before the frame. TUI-only (`ctx.mode !== "tui"` refuses). Exec goes
  through injected `Capture`/`ForegroundSpawn` seams (core/picker/runner/
  review split) — tests never shell out to live tuicr or git. Failure
  semantics: missing binary → "Could not start tuicr" notify, non-zero exit
  → status notify, both stop without prefilling a half-built prompt. tuicr
  is OPTIONAL: a missing binary must not prevent loading (registration is
  unconditional and probe-free).
- `frame/` is AIO's proprietary minimalist editor frame, vendored from
  pi-zentui (MIT — see `frame/LICENSE` and `frame/UPSTREAM.md`). It replaces
  the former bundled pi-zentui integration entirely: AIO wraps whatever
  editor factory exists at `session_start` (normally the QueueEditor chain)
  in `MinimalistFrameEditor`, which renders the base editor inside a labeled
  minimalist border with live metadata (model, thinking level, context
  percent, cost, git branch/dirty/ahead/behind, session name, timer).
  Registration order is load-bearing: it registers after queue,
  pretty-tools, and status-line so it wraps the final editor chain. Standalone Zentui
  factories (symbol `pi-zentui.editor-factory`) are never displaced; with no
  factory at all the frame stays out (Pi's built-in editor is unwrappable).
  Configuration is code-owned (`DEFAULT_FRAME_STYLE`) — there is no
  zentui.json and no seeding. The frame answers a synchronous capability
  probe (`frame/protocol.ts`, event `aio:minimal-frame-capability`) only
  after a TUI session installed it; effort and permission-modes suppress
  their duplicate footer statuses based on that probe. `frame/codex-quota.ts`
  (ported from pi-zentui) polls the native `openai-codex` usage endpoint for
  the 5h/weekly remaining windows and renders them beside the context percent
  — inert unless the routed model is the native Codex route, and it degrades
  to nothing rather than falling back to private credential storage. The
  queue feeds framed
  rows into the frame via `setQueuePanelLinesProvider` and suppresses its
  below-editor widget in any framed environment (AIO frame or standalone
  Zentui). Status-line's provider-quota surface renders as an above-editor
  widget when the probe reports support, and as a footer status otherwise.
  `frame/menus.ts` is the narrow TUI-only host-selector adapter: public
  selector render/mouse prototypes only, never Container/SelectList. It
  replaces native rule/spacer rows using `ui/chrome.ts` frame primitives, preserves
  row indices, translates mouse x/width, and tears down on shutdown. Unknown
  and already-rounded layouts stay native; RPC and standalone Zentui are
  untouched.
- `nvim/` opens files in Neovim in a new Otty pane beside the session
  (otty split anchored to `$OTTY_PANE_ID` → tmux → otty tab →
  Terminal.app → print). `/nvim <path>[:line[:col]]` (`-r` for
  read-only) parses the `path:line:col` shorthand; the pane runs `exec
  nvim` so it stays in the editor until `:q`, titled `nvim
  <basename>[:line]`. It is a user-initiated surface with NO agent tool:
  the agent cannot open panes on its own. No gating, no tool-name overlap;
  degrades silently when nvim or every launcher is missing (the command
  reports the exact command to run).
- `styles/` owns `/style` (`none | collaborate | tutor | concise | humanised`):
  opt-in interaction styles layered on top of permission modes. A style only injects a hidden
  per-turn `styles-context` instruction (mode-aware, e.g. no `TODO(human)`
  markers in ask/plan); it never gates tools, and it is NOT a permission mode
  (keep it out of `mode-access.ts`, Shift+Tab, and `--permission-mode`).
  Off by default: no flag or setting enables it; only `/style` does, and the
  choice persists as a `styles` session entry restored from the current
  branch. Tutor teaches in small explain → practice → feedback steps, waits
  for participation, and uses hands-on edits only with agreement; passive modes
  keep exercises in chat. The former `mentor` command and persisted name map to
  canonical `tutor` (not advertised as a separate style). Concise minimizes
  commentary without hiding warnings, skipping checks/approvals, or dropping
  the required plan format; user requests for detail override its brevity.
  Humanised covers all user-facing communication: build shared understanding
  before granular requirements/options, keep technical detail when useful, and
  avoid forced formality or slang without bypassing required questions,
  approvals, verification, or the plan contract.
  Its `context` handler
  keeps only the latest instruction and strips all of them once the style is
  `none`. In subagent children
  (`AIO_SUBAGENT_CHILD=1`) it registers only that stripping filter. Display:
  a `style` frame metadata contributor beside the mode, or a `style` footer
  status that status-line renders inside its mode segment.
- `subagents/` owns the `subagent` tool: configured child Pi agents run as
  spawned `pi --mode json -p` processes (fresh or forked context, bounded
  parallel group, background follow-up via `aio-subagent-complete`). Children
  always run with the parent's extension set — there is no bare/opt-out
  path, because extensions carry gates (blocklists, permission modes, hooks)
  and provider auth (e.g. an OAuth request shaper; without it Anthropic bills
  child requests as extra usage). `resolveChildExtensionLaunch` mirrors the
  parent's own argv: a `-ne` parent (e.g. a recipe relaunch) forwards
  `-ne -e <aio> -e <parent -e…>`; otherwise the child omits `-ne` and loads
  the same configured packages plus the parent's `-e` entries.
  `enforceChildExtensions` guarantees aio is listed whenever `-ne` is passed.
  `AIO_SUBAGENT_EXTRA_EXTENSIONS` can only add. Children always run in
  `auto` permission mode whatever the parent's mode (they are headless, so
  any other mode blocks every edit and non-read-only command): the runner
  passes `--permission-mode auto` and permission-modes pins `auto` under
  `AIO_SUBAGENT_CHILD=1`, overriding a forked transcript's persisted mode.
  Hard blocklists still apply in children. A child
  that dies from a provider stall, hard timeout, or crash is retried
  automatically (`RunnerDeps.maxAttempts`, default 2) by resuming the child's
  own session file with a continuation prompt — completed turns and usage
  survive the failed attempt; fork retries resume the forked session with
  `--session` (dropping `--fork`, which cannot combine with it). Final
  failures report the preserved session file so the parent can inspect or
  resume manually. Tool description and promptGuidelines steer the parent
  toward generous `timeoutMs` budgets (pi's own HTTP idle timeout is 300s by
  default, so budgets below that kill children mid-recovery). Completion is
  the child's `agent_settled` JSON event, NOT process exit: `pi -p` only exits
  once its event loop drains, so any inherited extension that leaves a live
  handle in the headless child would otherwise hang the parent tool until the
  hard timeout (then fail and retry finished work). After `agent_settled`
  the hard timeout is cancelled and the child gets `settleExitGraceMs`
  (default 10s) to exit before SIGTERM → SIGKILL; a reaped child counts as
  completed (`reapedAfterSettle`, noted in the result text). Live progress
  (`activity.ts`) folds the child's JSON events — turns, streaming phase,
  running tools with argument summaries, provider retries, compaction,
  settle — into `ChildRunStatus.activity`, rendered as one line per child in
  the foreground tool card (repainted every 1s), the above-editor widget
  (1s ticker that stops when no run is active; stall warning tone after
  120s without events outside a tool), and `subagent status`. Streaming
  deltas are throttled to one repaint per 250ms. The same events (plus
  child stderr) also fold into a bounded per-child `ChildRunStatus.transcript`
  (`transcript.ts`: thinking, responses, tool calls with args/results,
  logs, retry/compaction/attempt notices; ≤500 entries / 250k chars per
  child, blocks clipped head+tail; only the 10 most recent finished runs
  keep theirs). It is in-memory only — never in tool details, `publicRun`,
  or model context. `/subagents` and `ctrl+s` (TUI-only) open the
  `inspector.ts` overlay: a list of every child of every run (active runs
  first; parallel, queued, failed, stopped, background and foreground) and a
  live follow-tail detail view (`tab`/`shift+tab` cycles all children across
  runs, `o` expands tool output like ctrl+o, `t` hides thinking). It repaints
  on its own 500ms ticker over the registry and closes on shutdown.
- `you-should-know/` owns the YSK shadow auditor: successful
  `write`/`edit`/`apply_patch` tool results are debounced into one bounded,
  isolated `ctx.modelRegistry.complete()` audit (the sub-agent) whose findings
  surface through one shared path: a chrome-composed custom entry in the btw
  box idiom (`YOU SHOULD KNOW` label, severity-glyph head rows, wrapped
  details, one dim provenance line) — custom entries never enter LLM context
  — plus an above-editor findings card in the btw answer-card idiom (max 9
  rows, auto-hides after 30s, TUI-only, replaced by newer findings,
  test-overridable via `registerYouShouldKnow`'s `cardMs`); the critical-only
  toast contract is unchanged, and a clean audit renders nothing. Infra
  failures toast once then latch silent (reset by enable/model changes), but
  the latest failure is always recorded and reported by `/ysk status` (age
  + message); otherwise silence means clean audits, below-threshold
  findings, or deduped repeats. Off by default — `/ysk
  enable|disable|model|severity|tools|audit` persists to
  `~/.pi/agent/aio-you-should-know.settings.json` (goal-settings contract;
  `AIO_YSK_SETTINGS_FILE` overrides for tests). Subagent children resolve the
  same file mid-run, so a disabled parent audits nothing in its children
  either; children audit their own writes and mirror findings into a
  `you-should-know.jsonl` sidecar beside their runner-managed session file,
  which the parent consumes (and deletes) when the `subagent` tool result
  arrives. The state indicator is dual-channel: the minimalist frame's border
  via the frame metadata protocol (muted armed, accent while auditing) while
  a frame owns the surface, else the status row's `statuses` segment. It owns
  no tool and gates nothing; registration order is not load-bearing
  (registered late, before yaml-hooks).
- `btw/` owns the `/btw` command — "by the way" side questions: pi executes
  extension commands immediately even while streaming, so a mid-flow question
  runs its handler without interrupting, queuing, or steering the run, and
  nothing enters LLM context. One bounded, isolated `ctx.modelRegistry.complete()`
  call on the session model (the YSK engine seam) with its own AbortController
  — the main run's abort signal never touches it; a newer `/btw` replaces
  (last wins) and shutdown aborts. Context is bounded: a 40-message / 12k-char
  flow digest, a capped snapshot walk (excluded dirs, 2,500 files), and a 28k
  prompt. Surfaces: chrome-composed `by-the-way` custom entry (transcript box,
  never in context), above-editor card widget (pending → answered, answered
  auto-hides after 60s, test-overridable via `registerBtw` options), one-line
  arrival toast (warning toast on failure; no entry), and the transient
  `btw asking` pill — frame metadata protocol when a frame owns the surface,
  else footer status. No settings file, no tool names, no gating; registration
  order is not load-bearing (late, beside YSK, before yaml-hooks). Subagent
  children register no command but keep the entry renderer.
- `session-naming/` gives fresh unnamed parent sessions a native Pi title after
  their first successful `agent_end`, using one isolated, bounded background
  request on the session model. No model-context injection, tools, settings,
  or backfill. Existing/resumed/reloaded/forked sessions and manual names are
  preserved. Shutdown aborts work; session identity and name are rechecked
  before applying a late result. Subagent children register nothing.
- This is one npm package, not a monorepo; feature directories do not need
  nested `AGENTS.md` files.

## Conventions

- Keep `.js` suffixes on relative imports from `.ts` files; this is the
  repository's ESM convention.
- Match the existing formatting: tabs, double quotes, semicolons, and trailing
  commas in multiline structures.
- Runtime imports belong in `dependencies`, except packages the Pi host
  provides at load time. Host-provided packages — the `@earendil-works/pi-*`
  SDK, `@mariozechner/pi-*`, and `typebox`/`@sinclair/typebox` (aliased by the
  extension loader) — must be declared in `peerDependencies` with a `"*"` range
  and pinned in `devDependencies` for tests; Pi production installs omit dev
  dependencies. Declaring them in `dependencies` makes the host warn that
  installed copies "can bypass the extension loader and create duplicate
  runtime modules."
- Use `StringEnum` from `@earendil-works/pi-ai` for tool string enums. Throw from
  tool `execute` to produce an error result rather than returning an
  error-shaped success.
- Guard terminal-only behavior with `ctx.mode === "tui"`, broader dialogs with
  `ctx.hasUI`, and undo session-scoped UI/resources in `session_shutdown`.
- TUI renderers must keep every rendered line within the supplied width; use Pi
  TUI width/wrapping utilities and cover narrow-terminal behavior.
- The public `rpiv:*` event contract in `ask-user-question/events.ts` is
  append-only and JSON-safe; breaking changes require a new channel.

## Testing

- Add focused regression tests beside the feature. The `test:node` script uses
  explicit top-level globs and explicit questionnaire paths; update it when a
  new Node test is not covered, or `npm test` will silently skip the file.
- Run the focused runner while iterating, then `npm test` for changes to root
  wiring, tool names/schemas, permission gating, lifecycle hooks, TUI behavior,
  package metadata, or shared environment state.
- Preserve RPC/non-TUI fallbacks and restore mutated environment variables or
  module singletons in tests.

## Gotchas

- `package.json#files` is an explicit publication allowlist. A new feature
  directory must be wired into `index.ts`, included in `files`, and covered by
  a test command.
- Optional integrations must remain optional: missing
  `@juicesharp/rpiv-i18n`, `rtk`, CloakBrowser, the `hypa` binary, or the
  `tuicr` binary must not prevent the extension from loading (hypa resolves
  its bundled `@hypabolic/hypa` dependency and fails open on rewrite errors;
  tuicr only fails the run with a notify).
- Pi keeps the first tool registration by name. Loading pi-web-access before AIO
  prevents AIO's `web_search` and `fetch_content` from becoming active.
- Do not smoke-test with standalone packages that register the same tools,
  hooks, or UI owners (`rpiv-ask-user-question`, `pi-pretty`, `pi-diff`,
  `pi-subagents`, `pi-rtk`, `pi-zentui`, or `@hypabolic/pi-hypa`); duplicate
  registrations change behavior. AIO can skip a Zentui predecessor but cannot
  prevent a separately configured Zentui package from loading afterward.
