# aio

Combined Pi extension package for structured questions, permission modes,
subagents, enhanced built-in tools, diff rendering, shell rewriting, and
structural search.

> The inherited `/Users/danielbooth/CLAUDE.md` describes a different dotfiles
> repository. Its chezmoi, Homebrew, Fish, and Neovim instructions do not apply
> here.

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
  interception: `registerUserBash` must run before `registerRtk`, and hypa
  must register after rtk (rtk precedence) but before queue and pretty tools,
  which own the final bash behavior. `registerLoopPolice` sits between
  blocklist and permission-modes (loop blocks preempt mode checks; the hard
  blocklist wins over loop blocks). `registerAioZentui` runs after queue,
  pretty-tools, and status-line so it can wrap the final editor and own
  the visual surfaces. Preloaded standalone Zentui editors are preserved by the
  user-bash and queue registrars rather than overwritten. `registerYamlHooks`
  runs LAST so its opt-in `user_bash`
  interception wraps the earlier gates.
- `pretty-tools/` overrides `read`, `bash`, `ls`, `find`, and `grep`;
  `diff-tools/` owns `write`, `edit`, and `apply_patch`; `permission-modes/` and
  `user-bash/` gate those mutations. Changes can cross feature boundaries.
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
  confirm/setStatus actions, `/hooks-*` commands, prompt context injection,
  and the opt-in `PI_YAML_HOOKS_ENABLE_USER_BASH=1` interception. It
  registers LAST so its `user_bash` interception wraps the blocklist,
  permission-modes, and user-bash gates (the runner honors the first
  non-undefined `user_bash` result; the earlier gates win). It owns no tool
  names. Failure semantics: prompt hooks fail-open, post-tool hooks
  fail-open, user-bash interception fails closed, cleanup hooks are
  best-effort. All `PI_YAML_HOOKS_*` env names and YAML validation error
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
- `nvim/` opens files in Neovim in a new Otty pane beside the session
  (otty split anchored to `$OTTY_PANE_ID` → tmux → otty tab →
  Terminal.app → print). `/nvim <path>[:line[:col]]` (`-r` for
  read-only) parses the `path:line:col` shorthand; the pane runs `exec
  nvim` so it stays in the editor until `:q`, titled `nvim
  <basename>[:line]`. The `open_nvim` tool lets the agent hand the user a
  file at a line (typically after a write/edit, using the edit result's
  `firstChangedLine`); its guidance says to OFFER an open rather than
  opening files unprompted on every edit. No gating, no tool-name overlap;
  degrades silently when nvim or every launcher is missing (the tool
  returns the exact command to run).
- `loop-police/` is ported from pi-loop-police (MIT, sebaxzero — see
  `loop-police/LICENSE` and `loop-police/UPSTREAM.md`). It detects and
  breaks infinite reasoning/tool loops in real time: streaming tail +
  semantic detectors (abort via `ctx.abort()` from `message_update` —
  notify-only in the Pi SDK — sanitize via `message_end` same-role
  replacement, recovery via `before_agent_start` message injection),
  cross-turn stagnation + re-derived-reasoning scrubs (via the `context`
  event), and blocked-in-place tool gates (file ceiling, re-read window,
  search spiral — the recovery message is the block
  reason). REGISTRATION ORDER IS LOAD-BEARING: it sits between blocklist
  and permission-modes (loop block preempts mode checks; the hard
  blocklist wins over a loop block). Its context scrub composes with
  blocklist's context dedupe — it only touches assistant thinking blocks.
  Config lives at `getAgentDir()/aio-loop-police.json` (aio pattern),
  loads tolerant-and-fail-open, all `PI_*`-style config keys are
  append-only contracts. Detectors stay ACTIVE in
  `AIO_SUBAGENT_CHILD=1` processes; blocked calls never enter executed
  histories. Emits `loop-police:detection` on the shared event bus.
- This is one npm package, not a monorepo; feature directories do not need
  nested `AGENTS.md` files.

## Conventions

- Keep `.js` suffixes on relative imports from `.ts` files; this is the
  repository's ESM convention.
- Match the existing formatting: tabs, double quotes, semicolons, and trailing
  commas in multiline structures.
- Runtime imports belong in `dependencies`. Pi SDK packages stay in
  `peerDependencies` and are pinned in `devDependencies` for tests; Pi
  production installs omit dev dependencies.
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
