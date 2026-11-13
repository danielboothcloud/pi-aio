# aio

Combined Pi extension package for recipes (named launch configurations),
structured questions, permission modes, subagents, enhanced built-in tools,
diff rendering, shell rewriting, and structural search.

> **Runtime user configuration lives in the agent directory.** Features read
> their user-facing config from `<agent-dir>` at runtime (`aio-recipes.json`,
> `aio-blocklist.json`, `aio-notifications.settings.json`) — that is the shipped
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
  is also replaced whole by `AIO_RECIPES_FILE` for tests, and is never
  written by AIO). Session-scoped keys (model plus
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
  (`-ne -e <aio> -e builtin:{mcp,codemode,tool-search} -e <ext> --models …`;
  `-ne` drops Pi's built-in extensions too, so those three are re-added
  unless global settings disable one with `-builtin:<name>` — subagents
  forward them from the parent argv), stripping the `--recipe` token and
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
  PiG (the Go Pi port) runs AIO in a Node helper process whose
  argv/execPath/stdio are not the `pig` CLI or the terminal, so a relaunch
  there starts a second pig on pipes while the first waits forever.
  `recipes/pig-host.ts` detects PiG (`PIG_HARNESS_BINARY` set AND
  `AI_AGENT=pig`; real Pi resets `AI_AGENT=pi`, so an inherited marker never
  misfires) and every relaunch path (factory, `--continue`, `/resume`)
  stands down: restart-scoped keys are reported as not applied and
  everything else applies in-session. Parity comes from the
  `bin/aio-pig.mjs` launcher (used in place of `pig`, e.g. a fish
  function): it runs the SAME bridge before pig starts — `continue.ts`,
  trust prompt, `loadRecipes`, `decideRelaunch` via `pig-launch/plan.ts` —
  and starts pig once with the relaunch args/env plus
  `AIO_PIG_LAUNCHER=1`, exiting with pig's status. Pi's package is absent
  there, so jiti aliases `@earendil-works/pi-coding-agent` to
  `pig-launch/pi-shim.ts`: a vendored `parseArgs` (MIT port, drift-tested
  against the pinned parser in `args.test.ts`), PiG's directory rules
  (`PIG_HOME`/`PIG_CODING_AGENT_DIR`/`PIG_USE_PI_DIRS`,
  `PIG_CODING_AGENT_SESSION_DIR`), and a read-only SessionManager slice
  checked against Pi's. Keep launch-time recipe modules free of other
  runtime Pi imports. Launcher-only: `--piglet <name>` aliases
  `--recipe` when that recipe exists (paths/real Piglets pass through),
  pig subcommands pass through, `AIO_PIG_BINARY` picks the binary,
  `AIO_PIG_DRY_RUN=1` prints the plan, and any planning error starts pig
  unchanged. Inside launcher-started pig, a still-relaunching decision
  becomes a "launcher did not apply" note (never a spawn); the native
  picker and `/resume` get a `pig --session <file>` restart hint; the
  launcher's trust question is not repeated (`AIO_PIG_TRUST_ASKED`).
  None of this is reachable under native Pi.
  Selection precedence: flag > bridge env > session `recipe-state` entry
  (branch-pinned; off pins `name: null`) > `defaultRecipe` on fresh startups.
  `/new` additionally applies and pins the current trusted directory default
  (not global/project defaults, the previous branch's off entry, or a stale
  directory bridge name). Its model/thinking/MCP/status reactivate; native Pi
  recreates the original launch extensions/scope, which are not reconciled to
  a different directory recipe here. Explicit launch recipes still win.
  A launch-cwd `.pi-recipe` (or `.pi-recipe.json`; same JSON shape,
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
  child so a `/resume`d session entry still wins. `continue.ts` resolves
  `--continue`/`-c` with Pi's own session selection and storage precedence:
  its branch-pinned recipe (not the directory default) can relaunch with
  model scope/extensions restored and `--session <exact-file>` in place of
  continue, marked `AIO_RECIPE_ORIGIN=session`. That marker never overrides
  session entries or re-pins them; explicit off remains off and explicit CLI
  model/extension flags still win. `/reload` never reapplies the launch scope.
  `continue.ts` also resolves direct `--session` paths/local IDs/prefixes and
  existing `--session-id`s, using the target cwd for recipe discovery.
  `resume.ts` handles the native CLI picker and TUI `/resume` after selection:
  public `ctx.ui.custom` → `tui.stop()` releases the terminal for the same
  relaunch; spawn failure restores the TUI. A deliberate `/resume` follows
  its target branch rather than the original launch's recipe flag/env.
  `AIO_RECIPE_INJECTED_ARGS` stores only the count of injected argv tokens:
  switches remove those tokens, obsolete fork/no-session/name flags, and old
  prompt/file args while retaining explicit user scope/extension overrides.
  Off/unscoped targets relaunch to the original user baseline when needed.
  Recipe-relative extension sources are absolutized against `def.baseDir`;
  explicit CLI paths remain untouched. An in-process RPC switch warns with
  an exact-file restart hint rather than spawning a competing JSONL reader;
  CLI RPC startup is safe before input attachment. Late print/JSON paths
  similarly avoid losing already-consumed piped input. Project-config recipes
  still never supply restart keys. The opt-in continue/resume smoke suites
  verify scopes/cycling, extension replacement, thinking/MCP registration,
  native pickers and /resume through a Python PTY, off/unscoped resets,
  explicit overrides, changed defaults, and empty-scope rejection offline.
  `/recipe init [name]` writes a `.pi-recipe` (exclusive create; always a full self-contained
  scaffold — blank, seeded with the live model/thinking, or a COPY of a home
  recipe chosen in a picker or via `--from`) and trusts it. The file is
  portable: its `defaultRecipe` resolves only against its own `recipes`
  (never global/project ones; otherwise ignored with a warning);
  `/recipe trust` / `/recipe untrust` record or forget the decision.
  Recipes support only description/model/thinkingLevel/models/mcpServers/extensions/blocklist/
  permissionMode/style/advisor; unknown keys are ignored. `advisor`
  (session-scoped; see `advisor/`) is published via `setRecipeAdvisor`;
  live switches/off call `getAdvisorAccess()?.followRecipe(ctx)`, which
  drops a `/advisor` session override. `permissionMode`
  (`default|ask|plan|auto`, alias `mode`) and `style` (the `/style` names,
  legacy aliases accepted) are session-scoped starting values: `applyRecipe`
  publishes them through `permission-modes/mode-access.ts` and
  `styles/style-access.ts`, and those features read them at their own
  session_start only when nothing more specific exists (an explicit
  `--permission-mode` flag or a saved `modes` entry; a `/style` entry on the
  branch). A live `/recipe` switch or just-trusted directory default
  (`live: true`) sets them immediately via the access handles (style switch is
  quiet). Deactivating clears only the starting values; the session keeps its
  current mode and style, like the model. `/recipe init` copies them only from
  a template, never into a blank scaffold. Subagent children never activate
  recipes, so they stay pinned to `auto`. `blocklist` (session-scoped, same shape as
  `aio-blocklist.json` or a bare entries array) is published by
  `applyRecipe`/`deactivateRecipe` through `setRecipeBlocklist` and unioned
  into the hard blocklist as source `recipe:<name>`; it can only add rules.
  It is mirrored into `AIO_RECIPE_BLOCKLIST` so subagent children (which never
  activate recipes) keep enforcing it; a top-level pi clears a stray copy at
  registration and reads the env only under `AIO_SUBAGENT_CHILD=1`. Recipes literally named `init`/`trust`/`untrust` keep
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
  cross feature boundaries. `permission-modes/workspace-guard.ts` makes
  edit/write/apply_patch targets outside `ctx.cwd` (and its subdirectories)
  require manual approval in default AND auto, blocked without UI (so
  subagent children cannot write outside their cwd). Targets come from the same
  parser the tools use (`resolveApplyPatchChanges`), resolve like Pi's
  `resolveToCwd`, are canonicalized via the nearest existing realpath
  (symlinks), and relative paths are checked against both `ctx.cwd` and
  `process.cwd()` (the tools' real base). "Allow this folder for the session"
  approvals are in-memory only and cleared on session_start/shutdown. The
  outside prompt keeps the approval dialog's three-row layout (middle option
  maps to `allowScope`). Shell tools are not covered by this guard.
- `blocklist/` is the hard blocklist: `config.ts` loads the global, project, and
  active-recipe tiers (union). Entries default to `match: "text"` (the
  historical whole-text test, which must stay byte-for-byte unchanged); a
  file-level `match` sets the default for that file's entries, and an entry's
  own `match` wins. `"command"` rules test each segment's `program`/`full`
  form from the pure, dependency-free `segments.ts` (wrappers live in the
  named `COMMAND_WRAPPERS` constant). A `null`/`ok: false` segmentation fails
  CLOSED: any active command-mode rule blocks the command outright. Never
  turn a parse failure into an allow. The rule list is not injected into
  model context. A blocked `bash` or `hypa_shell` call fails with that
  entry's configured reason.
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
- `goals/` owns `/goal` and the `goal_propose`, `goal_done`, and
  `goal_blocked` tools (AIO-owned; it replaced the vendored goal-loop).
  `/goal <text>` sends a visible draft message; the agent asks
  `ask_user_question` only when the request is unclear, then calls
  `goal_propose`, which the user confirms (auto-confirmed without UI) and
  the agent starts in the same run. The loop is driven ONLY by
  `agent_before_settle`: while the goal is active it returns a state entry
  plus one hidden continuation `custom_message` and `continue: true` — no
  timers, no `agent_end` polling. Stops: Esc (aborted runs skip that
  boundary; `agent_settled` pauses), an `error` outcome, `MAX_CONTINUATIONS`
  (50, reset by `/goal resume`), `goal_blocked`, `/goal pause`.
  `goal_done` runs one isolated `ctx.modelRegistry.complete()` review
  (bounded transcript digest from `btw/context.ts` plus `git status`/
  `git diff --stat`); approval finishes, rejection returns the reason and
  the loop continues, `MAX_REJECTIONS` (3) or a review failure pauses.
  State is session-bound: the newest `aio-goal` custom entry in the session
  file (`getEntries()`, not the branch) wins; nothing is read from or
  written to the project directory or the agent directory, and there are no
  settings files. Every `session_start` holds an active goal paused until
  `/goal resume`. The tools stay registered (dynamic activation would fight
  permission-modes' passive-mode tool snapshot) and throw when no draft or
  active goal applies. Subagent children register nothing.
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
- `styles/` owns `/style` (`none | collaborate | tutor | concise | ste`):
  opt-in interaction styles layered on top of permission modes. A style only injects a hidden
  per-turn `styles-context` instruction (mode-aware, e.g. no `TODO(human)`
  markers in ask/plan); it never gates tools, and it is NOT a permission mode
  (keep it out of `mode-access.ts`, Shift+Tab, and `--permission-mode`).
  Off by default: no flag or setting enables it; `/style` or an active
  recipe's `style` key does. A `/style` choice persists as a `styles`
  session entry restored from the current branch and beats the recipe's
  starting style. Tutor teaches in small explain → practice → feedback steps, waits
  for participation, and uses hands-on edits only with agreement; passive modes
  keep exercises in chat. The former `mentor` command and persisted name map to
  canonical `tutor` (not advertised as a separate style). Concise minimizes
  commentary without hiding warnings, skipping checks/approvals, or dropping
  the required plan format; user requests for detail override its brevity.
  STE applies ASD-STE100 Simplified Technical English writing principles to
  user-facing text and documentation: short sentences (20 words in instructions,
  25 in descriptions), one instruction per sentence, active voice, simple verbs,
  and consistent terms. Preserve exact code/commands/identifiers and technical
  detail, warnings, questions, approvals, verification, and the plan contract.
  This is guidance, not dictionary enforcement or certified compliance. The former
  `humanised` command and saved name map to canonical `ste`; menus, completions,
  and new entries use `ste`, with display label Simplified Technical English.
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
  `AIO_SUBAGENT_EXTRA_EXTENSIONS` can only add. The child binary is
  `AIO_SUBAGENT_PI_BINARY`, else `$PIG_HARNESS_BINARY` under PiG (children
  use PiG and its config like the parent; its JSON stream is Pi's), else
  `pi`. The child env drops PiG's per-cell `PIG_EXT_*`/`PIG_HARNESS_*`
  wiring. Children always run in
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
  resume manually. The guidelines deliberately do not push larger
  `timeoutMs` budgets (agent defaults plus automatic retry cover slow
  children; pi's own HTTP idle timeout is 300s, so budgets below that kill
  children mid-recovery). Background (`async`) results and inspector-resumed
  continuations are delivered as `steer` messages, so they reach the parent
  at its next turn boundary while it is still working (a `followUp` would
  wait until the parent finished, by which point it no longer uses them);
  a guideline tells the model to use `async` only when it has independent
  work to do meanwhile. Completion is
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
  or model context. `/subagents` and `alt+s` (TUI-only) open the
  `inspector.ts` overlay: a list of every child of every run (active runs
  first; parallel, queued, failed, stopped, background and foreground) and a
  live follow-tail detail view (`tab`/`shift+tab` cycles all children across
  runs, `o` expands tool output like ctrl+o, `t` hides thinking). It repaints
  on its own 500ms ticker over the registry and closes on shutdown. Its model
  row/effort pill and `r` resume action use the original child launch settings.
  `history.ts` restores the selected branch's latest 50 runs from legacy tool
  details/completion messages and versioned `aio-subagent-state` custom entries.
  Checkpoints persist launch/lifecycle changes, not streaming deltas; private
  agent/extension launch snapshots stay outside public details/model context
  (not encrypted). Reopened active records are interrupted, never auto-spawned;
  saved live PIDs block competing recovery. Legacy runs without original launch
  snapshots are inspectable only. `saved-transcript.ts` lazily reads a ≤1 MB
  tail of the child's selected branch for historical inspection (one overlay
  cache, still ≤500 entries/250k chars); missing files fall back to saved output.
  Tree reconciliation refreshes decoded records but preserves locally owned
  run/process identity. Canonical session-file ownership survives ancestor-row
  eviction. Detached lifecycle changes (including explicit stops) stay dirty,
  exempt from every pruning path, until reattachment checkpoints them on their
  own branch without stale follow-ups; session epochs guard replacements.
- `advisor/` is based on pi-advisor (MIT, RimuruW — see `advisor/LICENSE`
  and `advisor/UPSTREAM.md`). It owns the `advisor` tool and `/advisor`
  (`status | on [provider/model[:reasoning]] | off | reset`; no `ask` —
  `/btw` covers manual side questions). The active recipe's `advisor` key
  (string `provider/model[:reasoning]` or object with `maxUsesPerRun`/
  `maxTokens`/`maxContextMessages`) switches it: absent = off, set = on.
  Precedence: `/advisor` session override (an `advisor-state` branch entry)
  > recipe > inherited `AIO_ADVISOR` (children only) > off. The tool stays
  registered; `before_agent_start`/`session_start`/changes add or remove it
  from the active set (never fight permission-modes' snapshot). One
  isolated `ctx.modelRegistry.streamSimple` call per consultation, capped
  per agent run; failures throw. A top-level pi clears a stray
  `AIO_ADVISOR` at registration and mirrors its effective settings there;
  the subagent runner then adds `advisor` to agent `--tools` allowlists.
  Children register no command. Tests inject `complete`.
- `handoff/` is based on pi-handoff (MIT, jalbarrang — see `handoff/LICENSE`
  and `handoff/UPSTREAM.md`). It owns `/handoff <goal>`: one isolated
  `ctx.modelRegistry.complete()` call (session model, `cacheRetention:
  "none"`, TUI `BorderedLoader`, RPC without a loader) turns the branch —
  compaction-aware, branch summaries included, custom messages excluded,
  bounded to 60% of the context window — into an editable prompt with a
  previous-transcript link, then `ctx.newSession({ parentSession })`.
  Pi re-evaluates extensions for the replacement session (jiti
  `moduleCache: false`), so NOTHING crosses the switch in module memory:
  `setup` (which runs before the new session_start) copies the newest
  `recipe-state`/`advisor-state`/`styles` entries and writes an
  `aio-handoff` entry; the new instance's session_start (reason `new`, no
  messages yet) restores model + thinking. It registers after recipes so
  that model wins. Refuses while the agent is busy (newSession aborts the
  run). Permission mode is not carried. Children register only the
  `HANDOFF` entry renderer. Tests inject `complete`.
- `btw/` owns the `/btw` command — "by the way" side questions: pi executes
  extension commands immediately even while streaming, so a mid-flow question
  runs its handler without interrupting, queuing, or steering the run, and
  nothing enters LLM context. One bounded, isolated `ctx.modelRegistry.complete()`
  call on the session model with its own AbortController
  — the main run's abort signal never touches it; a newer `/btw` replaces
  (last wins) and shutdown aborts. Context is bounded: a 40-message / 12k-char
  flow digest, a capped snapshot walk (excluded dirs, 2,500 files), and a 28k
  prompt. Surfaces: chrome-composed `by-the-way` custom entry (transcript box,
  never in context), above-editor card widget (pending → answered, answered
  auto-hides after 60s, test-overridable via `registerBtw` options), one-line
  arrival toast (warning toast on failure; no entry), and the transient
  `btw asking` pill — frame metadata protocol when a frame owns the surface,
  else footer status. No settings file, no tool names, no gating; registration
  order is not load-bearing (late, before yaml-hooks). Subagent
  children register no command but keep the entry renderer.
- `git-commit/` owns `/commit`: a USER-ONLY commit helper. It registers a
  command and never a tool, so the agent cannot commit or push through it;
  subagent children register nothing. If nothing is staged it confirms
  `git add -A`; otherwise only the staged set is used. One isolated
  `ctx.modelRegistry.complete()` call (staged diff capped per file and in
  total, plus recent subjects) returns ONE plain-text
  `type(scope): description` message; `parseMessage` tolerates fences,
  quotes, labels, and JSON wrappers, and failures fall back to a template
  message with a notice. All instructions live in the USER message, not
  only the system prompt: Pi sends a reasoning model's system prompt as the
  `developer` role, which some OpenAI-compatible providers (Synthetic)
  silently drop. The `CommitView` overlay keys: `c` commit, `e`/Enter edit
  (`ctx.ui.editor`), `p` commit and push after a `ctx.ui.confirm` ("Are you
  sure you want to commit and push?"), `r` regenerate, Esc cancel. RPC uses
  an editor dialog plus a Commit / Commit and push / Cancel select.
  `commitStaged` is a plain `git commit -F -` of the real index (hooks run,
  partial staging kept). `resolvePushTarget` uses the upstream, else
  `push -u` to `origin` or the only remote, and refuses a detached HEAD; a
  push failure after a successful commit keeps the commit and reports it.
  Non-conventional subjects are marked, not blocked. It refuses during
  merge/cherry-pick/revert/rebase. Tests use scratch git repositories (a
  local bare remote for push) and an injected `complete`.
- `session-naming/` gives fresh unnamed parent sessions a native Pi title after
  their first successful `agent_end`, using one isolated, bounded background
  request on the session model. No model-context injection, tools, settings,
  or backfill. Existing/resumed/reloaded/forked sessions and manual names are
  preserved. Shutdown aborts work; session identity and name are rechecked
  before applying a late result. Subagent children register nothing.
- `session-nav/` owns `/rewind`, `/sessions`, and the `--sessions` flag:
  friendlier replacements for pi's checkpoint and resume menus. Double-Esc
  on an idle, empty editor opens `/rewind`: only the user's prompts are
  listed (tool calls and injected context fold into each turn), newest
  first, with relative age, edit/tool counts, "you are here" and
  "⑂ alternate" markers, type-to-filter, and a preview. Enter opens one
  plain-English action step mapped to public command-context APIs: edit
  and resend (`navigateTree(prompt)`), go back to right after the answer
  (`navigateTree(turn end)`, hidden at the leaf), rewind with a summary
  (`summarize: true`), and start a new session (`fork(..., before)`). It
  states that files on disk are not changed. `/resume` (exact text) and a
  bound `app.session.resume` key open `/sessions`: day-grouped sessions
  with clean titles (skill XML → `skill: name`), labeled age/message
  counts, a this-folder/all tab, search, and a lazy preview that reads at
  most a 256 KB tail of the file. Selection uses `ctx.switchSession`, so
  the recipe resume relaunch still applies. Pi's `pi --resume` picker runs
  before extensions load and cannot be replaced; `pi --sessions` starts pi
  and opens `/sessions` once. Interception goes through
  `ui/editor-intercepts.ts`, which the `QueueEditor` consults (Esc, wrapped
  `onSubmit`, app actions). Without the AIO editor (standalone Zentui),
  pi's native behavior is untouched. Editor-originated commands dispatch
  through `pi.sendUserMessage("/cmd", { expandPromptTemplates: true })` to
  get a command context. `doubleEscapeAction: "none"` (global, or trusted
  project settings) keeps double-Esc inert. Native `/tree`, `/fork` and
  `pi --resume` remain available. TUI-only; intercepts clear on shutdown.
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
