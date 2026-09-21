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
  which own the final bash behavior. `registerYamlHooks` runs LAST so its
  opt-in `user_bash` interception wraps the earlier gates.
- `pretty-tools/` overrides `read`, `bash`, `ls`, `find`, and `grep`;
  `diff-tools/` owns `write`, `edit`, and `apply_patch`; `permission-modes/` and
  `user-bash/` gate those mutations. Changes can cross feature boundaries.
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
- `hunk/` integrates the hunk terminal diff viewer (MIT, modem-dev — see
  `hunk/UPSTREAM.md`; no source vendored). It registers the `hunk` tool
  (TypeBox-validated wrapper over the non-interactive `hunk session *` CLI:
  inspect/navigate/reload, inline AI annotations via `comment_add`/`apply`,
  attention marks via `highlight_add`/`clear`) plus the `/hunk` command that
  opens the interactive review in a sibling terminal (tmux window, macOS
  Terminal.app via AppleScript, or the printed command). The bundled
  `hunk-review` skill is surfaced through `resources_discover`. Hunk is
  OPTIONAL: a missing binary must not prevent loading — skill discovery
  returns nothing, the tool classifies spawn failures, `/hunk` prints the
  command. `comment apply --stdin` batches are written to a mode-0600 temp
  file and redirected through `sh -c` (the shared exec surface has no
  stdin). Tests must use injected fake exec seams, never a live hunk
  daemon.
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
  `@juicesharp/rpiv-i18n`, `rtk`, CloakBrowser, or the `hypa` binary must not
  prevent the extension from loading (hypa resolves its bundled
  `@hypabolic/hypa` dependency and fails open on rewrite errors).
- Pi keeps the first tool registration by name. Loading pi-web-access before AIO
  prevents AIO's `web_search` and `fetch_content` from becoming active.
- Do not smoke-test with standalone packages that register the same tools or
  hooks (`rpiv-ask-user-question`, `pi-pretty`, `pi-diff`, `pi-subagents`,
  `pi-rtk`, or `@hypabolic/pi-hypa`); duplicate registrations change behavior.
