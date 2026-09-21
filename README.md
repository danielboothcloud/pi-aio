# aio

Combined Pi extension: structured **`ask_user_question`** dialogs, a **`/pick`**
code picker, **`/init`** AGENTS.md bootstrap, **`/effort`** thinking control,
generic **subagent delegation**, configurable **`web_search`** and
**`fetch_content`**, **`!` bash shortcuts**, **Shift+Tab** permission modes,
enhanced built-in output with FFF-backed search, **rtk** shell-command rewriting,
and syntax-highlighted write/edit/patch diffs.

The questionnaire implementation is based on
[@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question),
with effort and permission modes based on
[@pandi-coding-agent/pandi-effort](https://www.npmjs.com/package/@pandi-coding-agent/pandi-effort)
and
[@aprimediet/permission-modes](https://www.npmjs.com/package/@aprimediet/permission-modes).

## Install

From this directory:

```bash
pi install /Users/danielbooth/projects/home/pi
```

Or one-off:

```bash
pi -e /Users/danielbooth/projects/home/pi
```

Project-local (after trusting the project):

```bash
pi install -l /Users/danielbooth/projects/home/pi
```

Pi normally binds Shift+Tab to thinking-level cycling. To let `aio` own that
shortcut, add this to `~/.pi/agent/keybindings.json`:

```json
{
  "app.thinking.cycle": []
}
```

Then run `/reload` or restart Pi. Use `/effort` when you want to change the
thinking level.

## `ask_user_question` tool

The model can present one to four structured questions instead of guessing when
requirements are ambiguous. Each question supports two to four options and always
includes a free-text fallback.

Features include:

- Tabbed multi-question dialogs with a final review/submit tab
- Single- and multi-select questions
- Markdown previews beside options, with responsive stacked rendering
- Per-option notes and custom text answers
- Sticky dialog chrome, scrolling, and overflow indicators
- RPC/ACP fallback using native select/input dialogs when custom TUI rendering is unavailable
- Runtime validation for duplicate questions, duplicate/reserved labels, and size limits
- Automatic removal of the tool in non-interactive sessions
- A stable `rpiv:ask-user:prompt` event for notification integrations

Typical tool input:

```ts
{
  questions: [
    {
      question: "Which implementation should we use?",
      header: "Approach",
      options: [
        {
          label: "Simple (Recommended)",
          description: "Use the smallest implementation",
          preview: "interface Config {}",
        },
        {
          label: "Flexible",
          description: "Add extension points for future use",
        },
      ],
    },
  ],
}
```

Press **Ctrl+]** to hide or reopen an active questionnaire. Override or disable
this shortcut in `~/.config/rpiv-ask-user-question/config.json`:

```json
{
  "collapseKey": "alt+o"
}
```

Use `"collapseKey": "off"` to disable it. The same config supports custom
`guidance.promptSnippet` and `guidance.promptGuidelines` values.

The questionnaire UI is English by default. Install
`@juicesharp/rpiv-i18n` alongside `aio` to enable its supported localized UI.

## `/pick` command

Run `/pick` to select a fenced code block from the latest assistant
response and copy its contents to the system clipboard. The centered TUI
overlay provides a rendered preview of the selected block.

- **Up/Down** or **j/k** — move between code blocks
- **Page Up/Page Down** or **Ctrl+d/Ctrl+u** — jump through longer lists
- **g/G** — jump to the first or last block
- **Enter** — copy the selected block without its Markdown fences
- **Escape/Ctrl+C/q** — close without copying

The command only searches the latest assistant response and ignores inline or
indented code. Pi does not expose focusable renderers for existing assistant
transcript entries, so selection happens in the overlay rather than directly in
the transcript. Pi's existing Ctrl+X whole-message copy remains unchanged.

## `/effort` command

Set model thinking effort:

```text
/effort off|minimal|low|medium|high|xhigh|max|ultracode
```

- Run `/effort` with no args to open a selector (TUI) or show current level.
- `ultracode` sets xhigh effort and enables the `dynamic_workflow` tool if available.
- Current effort appears in the status bar as `effort:<level>`.

## `/init` command

Analyze the codebase and create or update `AGENTS.md` for Pi and other coding agents:

```text
/init
/init force
/init dry-run
```

- Detects build systems, test frameworks, CI, and repo conventions from manifests and config files.
- Writes a concise root `AGENTS.md` with commands, stack, conventions, and gotchas agents cannot infer reliably.
- Propagates nested `AGENTS.md` files in monorepo subprojects when they need stack-specific guidance.
- `force` regenerates even when `AGENTS.md` already exists; `dry-run` shows the proposed content without writing files.
- Run `/reload` after writing so Pi loads the new context.

## Web search

AIO provides `web_search` and `fetch_content` through
[`browser-search/`](browser-search/README.md):

- `web_search` is opt-in and uses the Exa or SearXNG provider selected under
  `aio.browserSearch` in Pi settings.
- `fetch_content` uses Camofox with an optional CloakBrowser fallback and stays
  available even when search is disabled.
- Results are returned inline; there is no curator, response-id store, or
  `get_search_content` tool.

No search provider is selected by default. See the
[browser-search setup and configuration](browser-search/README.md) for Exa API
keys, the optional self-hosted stack, and pi-web-access coexistence.

## Subagent delegation

The `subagent` tool launches focused child Pi sessions for isolated work. It
supports single-agent and bounded parallel execution, fresh or forked context,
foreground or background runs, configurable concurrency, and basic
`list`/`status`/`stop` lifecycle control.

When `model` and `thinking` are omitted, each child inherits the model and
thinking level active in the parent session at launch time. Explicit per-run,
per-task, or agent-frontmatter values override that default.

Typical single run:

```ts
{
  agent: "reviewer",
  task: "Review the current diff for correctness. Do not modify files.",
  context: "fresh"
}
```

Parallel independent review:

```ts
{
  tasks: [
    { agent: "reviewer", task: "Review correctness and regressions. Do not edit files." },
    { agent: "reviewer", task: "Review tests and edge cases. Do not edit files." },
    { agent: "reviewer", task: "Review maintainability. Do not edit files." }
  ],
  context: "fresh",
  concurrency: 3,
  async: true
}
```

Background runs return an id immediately and publish their result back into the
originating session when complete:

```ts
{ action: "status" }
{ action: "status", id: "<run-id>" }
{ action: "stop", id: "<run-id>" }
```

AIO ships neutral `scout`, `planner`, `worker`, `reviewer`, `researcher`, and
`validator` agents. Override them or add agents with Markdown files in:

- User scope: `~/.pi/agent/agents/**/*.md`
- Project scope: `.pi/agents/**/*.md`
- Legacy project scope: `.agents/agents/**/*.md`

A minimal agent definition:

```md
---
name: security-reviewer
description: Reviews changes for concrete security defects
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---
Inspect the assigned change for concrete security defects. Report evidence with
file and line references. Do not modify files.
```

Supported frontmatter fields are `name`, `description`, `tools`, `model`,
`thinking`, `timeoutMs`, `systemPromptMode`, `inheritProjectContext`, and
`inheritSkills`.

Child runs have a hard time budget: the per-run `timeoutMs` parameter wins,
then the agent's frontmatter `timeoutMs`, then a 15-minute default. The
`researcher`, `reviewer`, and `validator` agents declare 30 minutes for
evidence-gathering work that queries live sources; pass `timeoutMs` (up to 6
hours) to extend an individual run beyond its agent default.
Trusted project definitions override user definitions, which override bundled
agents. Project agent files are ignored until Pi trusts the checkout.

Subagents inherit AIO's active permission mode. In `ask` and `plan` modes,
mutations remain blocked. In `default` mode, headless children cannot answer
permission prompts, so mutation attempts are blocked. Use `auto` only when you
intend to authorize a writer child. Child sessions never receive the `subagent`
tool, so nested delegation is unavailable.

AIO launches child sessions through `pi` on `PATH`. Wrappers and custom
installations can set `AIO_SUBAGENT_PI_BINARY` to an alternate Pi executable.

This intentionally reduced runtime does not include chains, dynamic fanout,
structured-output contracts, worktrees, resume/steer, scheduling, acceptance
gates, persistent agent memory, or automatic model fallbacks. Keep parallel
children read-only in a shared checkout and use one writer for changes.

Do not load standalone `pi-subagents` alongside AIO because both packages
register a tool named `subagent`.

## `!` bash shortcuts

Pi runs shell commands when your prompt starts with `!`:

```text
!ls -la
!git status
!!npm test
```

- `!command` — runs the command, shows output in the transcript, and sends it to the model
- `!!command` — runs the command and shows output, but excludes it from model context

The `aio` extension applies the same permission-mode rules to your `!` commands as it
does to agent `bash` tool calls:

| Mode    | `!` read-only commands | `!` mutating commands |
| ------- | ---------------------- | --------------------- |
| default | allow                  | prompt                |
| ask     | allow                  | blocked               |
| plan    | allow                  | blocked               |
| auto    | allow                  | allow                 |

Read-only commands include things like `ls`, `cat`, `git status`, and `grep`. Mutating
commands include `rm`, redirects, package installs, and most `git write` operations.

While typing a `!` command, aio shows live feedback:

- Editor border switches to bash mode (green by default)
- Top border label: `! bash` or `!! hidden`
- Hint line below the editor with the parsed command preview
- Footer status: `!bash`

## Command blocklist

`aio` ships a hard blocklist: shell commands you list in it NEVER run, no
matter the permission mode (even `auto`), and for both agent `bash` tool calls
and your `!`/`!!` commands. A blocked command fails with an error explaining
which rule matched — it cannot be approved, and the model is told about the
blocklist at the start of every turn so it does not waste attempts on it.

Config is two-tier JSON with union semantics (both files apply):

- Global: `~/.pi/agent/aio-blocklist.json`
- Project: `<project>/.pi/aio-blocklist.json`

```json
{
  "enabled": true,
  "entries": [
    "rm -rf /",
    { "pattern": "kubectl delete", "reason": "no cluster deletions" },
    { "pattern": "\\bgit push --force\\b", "regex": true, "reason": "no force push" }
  ]
}
```

- Plain string entries match as case-insensitive substrings of the command.
- Object entries take a `pattern`, an optional `regex: true` flag (the pattern
  is then compiled as a case-insensitive regular expression), and an optional
  `reason` shown in the block error.
- Each file's `enabled` flag (default `true`) gates only that file's entries;
  set it to `false` to disable a tier without deleting it.
- Matching is case-insensitive: `RM -RF /` hits a `rm -rf /` rule.
- Malformed JSON, entries, or regexes are skipped rather than fatal.

The config is re-read on every check, so edits apply immediately — no reload
needed. Cursor host replay calls (`cursor-replay-*`) are exempt because they
only display work that already ran outside Pi's gate.

## Permission modes (Shift+Tab)

Cycle with **Shift+Tab**: default → ask → plan → auto → default

| Mode    | Edit/Write/Patch | Mutating bash / `!` | Reads |
| ------- | ---------------- | ------------------- | ----- |
| default | prompt           | prompt              | allow |
| ask     | disabled         | blocked             | allow |
| plan    | disabled         | blocked             | allow |
| auto    | auto-approve     | auto-approve        | allow |

Ask mode is passive Q&A and exploration: it can inspect the codebase and answer
questions, but it cannot mutate state and does not start plan extraction or
execution flows. Plan mode has the same read-only boundary but instructs the
agent to produce a numbered implementation plan.

### Commands

- `/default`, `/ask`, `/plan`, `/auto` — switch mode directly
- `/mode [name]` — selector or direct switch

Auto mode only suppresses permission prompts; it does not submit follow-up messages
or continue the agent automatically.

For `cursor/*` models, Cursor's headless host tools execute outside Pi's
`tool_call` gate. The extension therefore enables pi-cursor-sdk's overlapping
built-in bridge and directs default-mode mutations through `pi__edit`,
`pi__write`, `pi__apply_patch`, and `pi__bash`, where the normal approval prompts
apply. If Cursor
uses a host mutation anyway, Pi cannot retroactively block it; the extension
shows a warning when the completed replay reaches Pi instead of presenting a
misleading after-the-fact approval dialog.

### Todo tool

During plan execution, the `todo` tool can manage the active plan steps:

- `list` — show all steps
- `toggle` — mark a step done or undone using `step`
- `create` — add a step using `text`, optionally at a 1-based `position`
- `rename` — replace a step's text using `step` and `text`
- `reorder` — move `step` to a 1-based `position`; all steps are renumbered
- `delete` — remove `step`; remaining steps are renumbered

### Flag

```bash
pi --permission-mode ask
pi --permission-mode plan
```

## Status line

`aio` installs a quiet single-row footer that replaces noisy packages like
`pi-powerline-footer`. The default layout is:

```text
Plan · ⌂ pi-aio · ⎇ main · ◫ 42% · ⚡ effort:max · rtk✓ · ◈ cursor:local · fast:on · ◇ cursor/composer-2.5
```

Configure it in Pi settings (`~/.pi/agent/settings.json` or project
`.pi/settings.json`):

```json
{
  "aio": {
    "statusLine": {
      "enabled": true,
      "segments": ["mode", "path", "git", "context", "effort", "statuses", "cursor", "quota", "model"],
      "path": "basename",
      "workingMessage": "minimal"
    }
  }
}
```

| Field | Purpose |
| ----- | ------- |
| `enabled` | Master toggle; `false` restores Pi's default footer |
| `segments` | Ordered list: `mode`, `path`, `git`, `context`, `effort`, `statuses`, `cursor`, `quota`, `model`, `tokens`, `cost` |
| `path` | `basename`, `abbreviated`, or `full` |
| `workingMessage` | `minimal` (default), `verbose` (streaming stats), or `off` |
| `statusKeys` | Optional allowlist for extension status keys |
| `providerUsage` | Optional per-provider quota endpoint, headers, and response mappings |

Quick toggles:

- `/status-line` — enable/disable
- `/status-line minimal` or `/status-line verbose` — working message style

Extension statuses (`rtk`, `!bash`, `fff`, `codex-quota`, etc.) appear in the
`statuses` segment when active. Thinking effort (`effort`) and Cursor runtime
(`cursor:local · fast:on`) get their own segments so they do not blend with the
model name. Context percentage turns warning/error at 70%/90%.

### Custom provider quota usage

The optional `providerUsage` block fetches a quota endpoint for the active
model provider. Provider keys must match the provider id shown in the model
segment. Response mappings are dot-separated JSON paths. Requests are cached,
have a bounded timeout, fail silently, and keep the last successful value on a
transient error. Header values support `$VAR` and `${VAR}` environment
references (but never shell commands).

For example, a custom provider named `synthetic` can use Synthetic's quota API,
showing both the request quota and the weekly credit window from one response:

```json
{
  "aio": {
    "statusLine": {
      "providerUsage": {
        "refreshIntervalMs": 60000,
        "timeoutMs": 5000,
        "providers": {
          "synthetic": {
            "endpoint": "https://api.synthetic.new/v2/quotas",
            "headers": {
              "Authorization": "Bearer ${SYNTHETIC_API_KEY}"
            },
            "windows": {
              "requests": {
                "label": "synthetic",
                "mapping": {
                  "used": "subscription.requests",
                  "limit": "subscription.limit",
                  "renewsAt": "subscription.renewsAt"
                }
              },
              "weekly": {
                "label": "wk",
                "mapping": {
                  "text": "weeklyTokenLimit.remainingCredits",
                  "renewsAt": "weeklyTokenLimit.nextRegenAt"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Each mapping may provide `used`, `limit`, `remaining`, `renewsAt`, and/or
`text`. When `used` and `limit` are available, aio computes the remaining
percentage. `text` can map a provider-formatted quota string (for example
`"$23.21"`) verbatim. Windows render inside one `quota` segment, joined by
`·`, and the segment colors by the window closest to exhaustion. A provider
entry with a single top-level `mapping` instead of `windows` keeps working as
a one-window shorthand. The `quota` segment is omitted when the active
provider has no configuration or nothing has been fetched successfully.

To migrate off `pi-powerline-footer`, remove it from `packages` in Pi settings,
delete any `powerline` block, and reload extensions.

## Message queue

`aio` makes pi's message queue visible and actionable while the agent is
busy. Messages you type during a run are queued by pi as steering
(`enter` / `alt+enter`) or follow-up messages; aio mirrors that queue and
renders it as a numbered list below the input box:

```text
 queue (2) · ⏎ send next
 1. [steer]  fix the parser off-by-one
 2. [follow] then run the full test suite
```

Steering entries are delivered after the current turn; follow-ups after the
run finishes. Long messages show a first-line preview; more than five pending
messages collapse into a `+N more` row.

Pressing `enter` while the input box is **empty** interrupts the current run
and immediately pushes the next pending message at the agent (the rest stay
queued with their original steer/follow-up semantics). Pi's default behavior
— `esc` to interrupt and dump the queue back into the editor, `alt+↑` to edit
the queue — still works untouched.

Commands:

- `/queue` or `/queue status` — show the pending queue
- `/queue off` — hide the widget and disable Enter-on-empty interrupt
- `/queue on` — re-enable

The queue editor extends the `!bash` hint editor, so bash-mode hints keep
working. The mirror tracks queue additions and deliveries via pi events; in
the rare cases it cannot (messages queued during compaction, or across an
extension reload) the widget simply hides and pi's built-in dim queue lines
above the editor remain the fallback.

## Pretty built-in tools

`aio` replaces Pi's built-in `read`, `bash`, `ls`, `find`, and `grep` tool
definitions. Text reads, listings, file searches, and content searches execute
through RTK; Pi's native implementations are used only when RTK cannot execute
or when RTK cannot represent the result (for example, an inline image).

- **`read`** — RTK-backed text reads with collapsed line-count summaries and
  expanded line-numbered Shiki highlighting; image reads retain Pi's native
  inline image rendering.
- **`bash`** — colored `exit 0`/`exit 1` summaries, elapsed time, line counts,
  and expanded command output.
- **`ls`** — RTK-backed directory listings with Nerd Font icons and tree-oriented
  expanded output.
- **`find`** — RTK-backed file search with grouped results and native `fd`
  fallback only for patterns RTK cannot represent or when RTK cannot execute.
- **`grep`** — RTK-backed recursive content search with file grouping, line
  numbers, literal/extended-regex modes, highlighted matches, and context lines.
- **GNU grep guard** — bare `grep`/`egrep`/`fgrep` invocations in the `bash`
  tool are blocked with a nudge to use the `grep` tool or `rg -n`. Set
  `PRETTY_BASH_GREP_GUARD=0` to allow them.
- **`@file` completion** — FFF-ranked file suggestions while composing prompts.

Tool result bodies start collapsed. Press **Ctrl+O** (`app.tools.expand`) to toggle
full output. Pi also recognizes **Ctrl+Shift+O** for expanding all tool output in
supported builds.

FFF initializes for the current project at session start and stores its frecency
and history data under `<agent-dir>/aio/fff/`. Use these maintenance commands:

```text
/fff-health
/fff-rescan
```

All five enhanced tools are enabled by default. Configuration environment variables:

- `PRETTY_BASH_GREP_GUARD=0` — allow GNU grep in the `bash` tool (blocked by default).
- `PRETTY_DISABLE_TOOLS` — comma-separated optional renderers to leave untouched.
  RTK-covered `read`, `ls`, `find`, and `grep` cannot be disabled through this setting.
- `PRETTY_ENABLE_TOOLS` — explicitly enable optional tools if defaults change.
- `PRETTY_THEME` — Shiki theme; otherwise the active Pi theme or `github-dark`.
- `PRETTY_ICONS=none` — disable Nerd Font icons.
- `PRETTY_MAX_HL_CHARS`, `PRETTY_MAX_PREVIEW_LINES`, `PRETTY_CACHE_LIMIT` —
  highlighting and preview limits.
- `PRETTY_CONFIG_DIR` — directory containing `aio-pretty.json`.

Optional `<agent-dir>/aio-pretty.json` background configuration:

```json
{
  "background": {
    "tool": "#1e1e2e",
    "error": "#2a1e1e"
  }
}
```

Do not load standalone `@heyhuynhgiabuu/pi-pretty` alongside `aio`: both packages
own the same built-in tool names and would register duplicate FFF commands.

## rtk shell rewriting

`aio` enforces [rtk](https://github.com/rtk-ai/rtk) routing wherever RTK has a
representation. Agent `bash`, `!command`, and `!!command` inputs are offered to
`rtk rewrite`; `read`, `ls`, `find`, and `grep` invoke their RTK subcommands
directly. Commands for which RTK has no equivalent run unchanged because routing
them is impossible.

- **Agent `bash` tool** — an asynchronous `tool_call` hook rewrites the command
  after permission checks and before execution. This works independently of the
  pretty bash renderer.
- **`!command` and `!!command`** — both execute rewritten commands; Pi still keeps
  `!!` output out of model context.
- **Read-only built-ins** — text `read`, `ls`, `find`, and `grep` calls execute
  through RTK even if their names appear in `PRETTY_DISABLE_TOOLS`.
- **Impossible RTK cases** — images retain Pi's native image path, file mutation
  tools remain native, and unsupported or unavailable RTK commands fail open to
  the existing implementation.

There is no disable toggle or `RTK_DISABLED=1` bypass. Bypass assignments at
shell-command boundaries are stripped before rewriting. If RTK is missing, not
executable, times out, or has no equivalent, aio falls back to normal behavior and
warns once when the binary is unavailable. Permission modes remain responsible
for command gating.

### `/rtk` command

- `/rtk status` or `/rtk` — show enforced routing state and the detected binary.

The footer shows `rtk ✓` while the enforced integration is loaded.

### Prerequisites

[rtk](https://github.com/rtk-ai/rtk) must be installed and on your `PATH`. `rtk
init` is not required — aio calls `rtk rewrite` directly. aio degrades
gracefully without it.

Do not load standalone `@sherif-fanous/pi-rtk` alongside `aio`; both rewrite
shell commands and would double-rewrite the same command.

## Hypa context compression

`aio` also routes tool output through [Hypa](https://github.com/Hypabolic/Hypa),
a local, deterministic context runtime. It compliments rtk rather than competing
with it:

- **rtk precedence** — hypa's bash rewrite registers after rtk's and skips
  commands rtk already claimed (`rtk ...`). It engages only where rtk has no
  equivalent, GenericWrapping those commands (`hypa -c "…"`) so their output is
  compressed with deterministic reducers and recorded as recoverable evidence.
- **`hypa_*` tools** — `hypa_shell`, `hypa_read`, `hypa_grep`, `hypa_find`, and
  `hypa_ls` run shell/file tools directly through the Hypa CLI with compression,
  evidence recording, and 50KB/2000-line output caps (truncated full output is
  saved to a temp file). In the default additive mode they sit alongside aio's
  pretty built-in tools; `HYPA_PI_MODE=replace` disables each builtin only while
  its matching `hypa_*` replacement is active.
- **`hypa_read` images** — png/jpeg/gif/webp files are sniffed by magic bytes and
  attached as vision content; opaque binary gets a sized notice instead of
  mojibake.
- **Optional MCP proxy bridge** — with `HYPA_PI_ENABLE_MCP_PROXY=1`, one compact
  `hypa_mcp_proxy` tool discovers (`list`/`search`), inspects (`schema`),
  invokes, and auth-checks upstream MCP servers configured in Hypa instead of
  dumping every upstream tool into context. Servers already configured directly
  in Pi are deduplicated by default.
- **Diagnostics** — `/hypa` shows extension mode, binary resolution, MCP proxy
  settings, and the last rewrite status.
- **Fail-open** — rewrite parse, timeout, and process errors pass the original
  command through unchanged; `Deny` blocks the tool call; `Ask` confirms in UI
  mode and follows `HYPA_PI_ASK_NON_INTERACTIVE` (`deny`/`allow`) otherwise.

### Hypa configuration

Environment variables override values in the optional JSON config file
(`HYPA_PI_CONFIG`, default `~/.hypa-pi/config.json`; `none`/empty disables file
loading). JSON fields are camelCase: `mode`, `binary`, `rewriteTimeoutMs`,
`askNonInteractive`, `mcpProxyEnabled`, `mcpProxyTimeoutMs`, `piMcpConfigPath`.

| Variable | Default | Description |
| --- | --- | --- |
| `HYPA_BIN` | bundled `@hypabolic/hypa`, then `hypa` | Hypa executable or absolute path |
| `HYPA_PI_MODE` | `additive` | `replace` disables builtins while their `hypa_*` replacement is active |
| `HYPA_PI_REWRITE_TIMEOUT_MS` | `5000` | `hypa rewrite` timeout |
| `HYPA_PI_ASK_NON_INTERACTIVE` | `deny` | Ask fallback when `ctx.hasUI === false` |
| `HYPA_PI_ENABLE_MCP_PROXY` | `0` | Enable `hypa_mcp_proxy` discovery/invocation |
| `HYPA_PI_MCP_PROXY_TIMEOUT_MS` | `10000` | Per-call proxy timeout |
| `HYPA_PI_MCP_CONFIG` | `~/.pi/agent/mcp.json` | Pi MCP config used for dedup |

### Hypa prerequisites

aio bundles [`@hypabolic/hypa`](https://www.npmjs.com/package/@hypabolic/hypa) as
a dependency, so Node.js 18+ (or Bun) with Linux/macOS/Windows on x64/arm64 is
enough — the platform-native binary is selected automatically, with `bin.js` via
the host runtime as fallback. Installing aio also runs a best-effort
`hypa/scripts/postinstall.js` that creates a user-level `hypa` shim in
`~/.local/bin` when no `hypa` is already on `PATH` (set `HYPA_PI_SKIP_CLI_INSTALL=1`
to skip).

Do not load standalone `@hypabolic/pi-hypa` alongside `aio`; its tools, hooks,
and `/hypa` command are absorbed here. Upstream is FSL-1.1-ALv2 licensed — see
`hypa/LICENSE-FSL` and `hypa/UPSTREAM.md`.

## Syntax-highlighted diffs

`aio` also owns the `write`, `edit`, and `apply_patch` tools and renders mutations
as Shiki-highlighted terminal diffs:

- **`edit`** — adaptive side-by-side old/new view with unified fallback on narrow
  terminals.
- **`write`** — unified stacked diff for overwrites and highlighted previews for
  newly created files.
- **`apply_patch`** — atomic multi-file add/update/delete/move operations with
  per-file diff previews.
- **Word-level emphasis** — brighter backgrounds identify the changed characters
  within paired removed/added lines.
- **Stale-edit guard** — blocks `edit` calls when any `oldText` is no longer present,
  forcing the agent to re-read instead of retrying stale text.
- **Large-diff fallback** — preserves diff structure while skipping expensive syntax
  highlighting above the configured limit.

Diff colors derive from the active Pi theme by default. Customize presets, colors,
hunk separators, line numbers, wrapping, indicators, or disabled tools through
project/global `pi-diff.json` files and `DIFF_*`/`PI_DIFF_*` environment variables.
See [`diff-tools/CONFIG.md`](diff-tools/CONFIG.md) for the complete reference.

Do not load standalone `@heyhuynhgiabuu/pi-diff` alongside `aio`, because both
packages register `write`, `edit`, and `apply_patch`.

## YAML hooks

`aio` ships YAML-configured hooks: run bash around tool calls, block risky
commands, add same-turn prompt context, and post UI notifications,
confirmations, and status entries from one `hooks.yaml` file. The
implementation is ported from
[pi-yaml-hooks](https://github.com/KristjanPikhof/pi-yaml-hooks) (MIT — see
[`yaml-hooks/UPSTREAM.md`](yaml-hooks/UPSTREAM.md)); the YAML contract and all
`PI_YAML_HOOKS_*` environment variables are unchanged.

Config is two-tier with global-first merge and project overrides by hook `id`:

- Global: `~/.pi/agent/hook/hooks.yaml`
- Project: `<project>/.pi/hook/hooks.yaml` (loads only after `/hooks-trust`)

```yaml
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
  - id: guard-bash
    event: tool.before.bash
    conditions:
      - matchesAnyPath: "**/*.sh"
    actions:
      - bash: "./scripts/check-command.sh"   # exit 2 blocks the tool
```

- **Events** — `user.prompt.submit`, `tool.before.*`/`tool.after.*` (exact
  names or `*` wildcard), `file.changed` (synthesized from `write`, `edit`,
  `apply_patch`, and mutation-shaped bash commands), `session.created`,
  `session.idle`, and `session.deleted`.
- **Actions** — `bash` (JSON context on stdin, `PI_*` env injected, exit 2
  blocks on `tool.before.*`), `tool` (sends a follow-up prompt into the
  current session), `notify`, `confirm` (blocks a pre-tool hook when
  rejected), and `setStatus`.
- **Conditions** — `matchesCodeFiles`, `matchesAnyPath`, and `matchesAllPaths`
  over project-relative globs; `scope: all|main|child` filters session
  lineage; `async: true` moves bash-only hooks onto background queues.
- **Overrides** — a project file can replace (`override: <id>`) or disable
  (`override: <id>` + `disable: true`) a global hook by `id`.
- **Blocking** — a `tool.before.*` bash hook that exits 2, a rejected
  `confirm`, or `action: stop` blocks the tool call. `user.prompt.submit`
  hooks are synchronous, bash-only, and fail-open: successful stdout becomes
  system context for the same turn, capped at 64 KiB.
- **Async** — `async: true` (or `{ group, concurrency }`) queues bash-only
  hooks off the dispatch loop; not allowed on `tool.before.*`,
  `user.prompt.submit`, or `session.idle`.

Slash commands:

```text
/hooks-status      # active files, hook counts, trust state, log path
/hooks-validate    # validation errors grouped by global/project/imported
/hooks-trust       # add the current repo/worktree anchor to the trust store
/hooks-reload      # reload extensions; edits also refresh lazily per event
/hooks-tail-log    # log path plus a ready-to-run tail -F command
```

Config files are watched by stat fingerprint; a valid edit applies on the
next matching event without a reload, and an invalid edit keeps the last
good hook set. Startup appends a short hook-awareness note to the system
prompt (disable with `PI_YAML_HOOKS_PROMPT_AWARENESS=0`). Structured
logs are opt-in via `PI_YAML_HOOKS_DEBUG=1` or `PI_YAML_HOOKS_LOG_LEVEL`.

Important limitations (matching upstream):

- `command:` actions are unsupported and rejected at load time.
- `tool:` sends a follow-up prompt into the current session; it does not
  execute a tool or target another session.
- `action: stop` only takes effect on `tool.before.*`.
- Prompt hooks receive the expanded text prompt only; they cannot rewrite or
  block the submitted prompt.
- Human `!`/`!!` commands are intercepted only when
  `PI_YAML_HOOKS_ENABLE_USER_BASH=1` is set; every trusted-project hook can
  then read and block typed commands, so enable it only when you trust every
  loaded hook. The startup warning lists which projects will have access.

## Hunk diff review

`aio` integrates [hunk](https://hunk.dev), the review-first terminal diff
viewer, so changesets get reviewed in Hunk's multi-file review stream with
inline AI annotations beside the code. The integration wraps Hunk's public
agent surfaces (no source vendored — see
[`hunk/UPSTREAM.md`](hunk/UPSTREAM.md)); hunk is optional and everything
degrades silently when the binary is missing.

Run `/hunk` (or `/hunk diff --staged`, `/hunk show HEAD~1`,
`/hunk diff --watch`) to open an interactive review beside this session.
Launch attempts run in order and the first success wins:

1. **Otty pane split** — when Pi runs inside Otty ($OTTY_PANE_ID), the
   review opens anchored to the agent's pane (`--pane`), split right 50/50,
   so the review stream lives beside the transcript with no focus jump
2. **tmux window** — when Pi runs inside tmux
3. **Otty tab** — Otty installed with the app running (fails fast to the
   next attempt when the app is not running or the binary is absent)
4. **macOS Terminal.app** — AppleScript (darwin)
5. **Print** — always succeeds: hand the exact command to the user

Every otty/tmux launcher runs the review with an `sh -c` script that drops
into an interactive shell only when the hunk command fails, so launch errors
stay visible instead of the pane silently disappearing. The TUI belongs to
you; Pi's transcript cannot host a fullscreen review UI, which is why the
review stream lives outside the agent.

The **`hunk` tool** is the model's side of the workflow — it talks to your
live review through Hunk's session daemon:

- **`review`** — inspect the loaded file/hunk structure
  (`includePatch` opts into raw unified diff text only when needed)
- **`navigate`** — move your viewport to a file/hunk/line, the next or
  previous annotated hunk, or an exact comment id
- **`comment_add` / `comment_apply`** — leave inline AI annotations beside
  the rows they explain (one-off note or one stdin batch for several;
  anchored by old/new line or hunk, with optional `rationale` and replies
  to your notes)
- **`highlight_add` / `highlight_clear`** — paint attention marks on exact
  character ranges (`[start, end)` UTF-16 offsets; tones include `current`
  for the range under discussion)
- **`reload`** — swap the live window's contents (diff/show, refs, pathspec)
- **`comment_list` / `comment_rm` / `comment_clear`** — find note ids and
  clean up

If no review is running, the tool result tells the model to ask you to open
one. The bundled `hunk-review` skill is surfaced natively through
`resources_discover`, so the model loads Hunk's authoritative agent
workflows without you pasting anything.

### `/hunk enforce` — automatic inline annotations

By default annotations appear only when the model decides to call the
`hunk` tool. **`/hunk enforce`** turns ON automatic inline AI annotations:
after each meaningful mutation batch (`write`, `edit`, `apply_patch`, or
mutation-shaped `bash`), aio maps the change onto the live review and
leaves bounded, file-anchored comments automatically — `author: aio`,
change-map summaries (`modify ×2, create`), highlights riding along for
anchored create/modify changes, and a quiet `hunk: N note(s)` status chip
when notes land. **`/hunk enforce off`** returns to inert. State persists
in `~/.pi/agent/aio-hunk-enforce.json`.

Enforcement design:

- **Debounced** — a multi-file `apply_patch` lands as several
  `tool_result`s in quick succession; annotations aggregate over a 400 ms
  window and land as one comment batch per file set, never per call.
- **Mechanical by design** — the enforced path annotates what changed
  (paths, operations, anchors from `EditToolDetails.firstChangedLine` and
  write top-of-file); the model's own narrative (intent, risks,
  follow-ups) stays in the tool-call path, where rationale is real. The
  enforced path never invents rationale it did not derive from the tool
  result.
- **Bounded** — max 6 comments per batch and a 12-annotation bash budget
  (configurable in the state file), so a sweeping refactor cannot flood
  the review.
- **Invisible without a review** — before queueing, the driver probes the
  live review; with none open, enforcement stays silent (annotations never
  open windows on their own).
- **VCS-gated** — hunk reviews git/jujutsu/sapling changesets, so enforce
  is always OFF in a plain directory: `/hunk enforce` refuses to enable
  there, and the runtime re-checks the cwd (git via
  `git rev-parse --is-inside-work-tree`, jj/sapling via `.jj`/`.sl`
  markers, cached per cwd). A persisted ON state from another repo never
  annotates in a non-checkout.
- **Best effort** — a closed review or rejected batch degrades to a
  descriptive outcome; enforcement never breaks or blocks the mutation
  flow.

Anchors: `edit` uses the result's `firstChangedLine`, `write` anchors at
line 1, `apply_patch` stays file-anchored (aio's tool reports counts, not
lines), and bash-derived mutations are file-level only (parsed shell line
numbers would be guesses). aio's structured `apply_patch` `changes` array
is parsed directly by the annotator (yaml-hooks' extractor deliberately
reads only the unified-diff string for `file.changed` semantics).

Note the division of labor: aio's syntax-highlighted transcript diffs (above)
render individual `write`/`edit`/`apply_patch` calls inline as they happen;
Hunk is the interactive changeset review with navigation and annotations.
Hunk's own renderer is an OpenTUI component and cannot be embedded in Pi's
transcript, so the two surfaces complement rather than replace each other.

## Open in Neovim

`aio` opens files in Neovim in a new Otty pane beside this session — for
when you want an agent-touched file in your editor immediately.

```text
/nvim src/index.ts          open at the top
/nvim src/index.ts:42       open with the cursor on line 42
/nvim src/index.ts:42:7     line 42, column 7
/nvim -r src/index.ts:42    read-only view (nvim -R)
```

The launcher chain matches the hunk launcher: an Otty pane split anchored
to this session's pane (`$OTTY_PANE_ID`) → tmux window → Otty tab →
macOS Terminal.app → the printed command. Neovim owns the pane afterward
(the pane runs `exec nvim`, so it stays in the editor until `:q`), and the
pane title is `nvim <basename>[:line]` so several open files are tellable
apart in the tab bar.

The agent can open files for you too, through the **`open_nvim` tool**:
after a `write`/`edit` it can hand you the changed file at the changed
line (`firstChangedLine` for edits), and it can open anything you ask to
"see in the editor". `path:line` and `path:line:col` shorthand work; the
guidance asks the agent to offer an open rather than opening files
unprompted on every edit.

## Loop police

`aio` detects and breaks infinite reasoning/tool loops in real time, ported
from [pi-loop-police](https://github.com/sebaxzero/pi-loop-police) (MIT —
see [`loop-police/UPSTREAM.md`](loop-police/UPSTREAM.md)). Reasoning models
get stuck in characteristic ways: repeating the same phrases inside the
thinking block, re-emitting the same paragraph in the answer, re-reading
the same file over and over, or cycling through an identical sequence of
tool calls until the context runs out. Loop police watches for all of it as
it happens: it aborts looping output mid-stream, trims the repetition out
of your context, and injects a recovery message so the model continues with
a fresh perspective — you keep the tokens the loop would have burned.

Ten detectors, all enabled out of the box:

- **Streaming loops** (thinking + output, re-checked every 50 chars): a
  character-level tail detector (the text ends in two adjacent verbatim
  copies of a block between 80/100 and 4000 chars) and a semantic layer
  (the same paragraph fingerprint 3 times — ordered-list counters
  normalized, code fences skipped). The semantic layer catches loops early:
  repeats rarely stay perfectly verbatim. On detection the stream is
  aborted immediately, the contaminated reasoning is replaced by an
  ordinary marker (no provider signature, so nothing opaque is replayed),
  and a recovery message starts the model past the loop.
- **Cross-turn stagnation**: 4 turns of ≥ 85% word-similar thinking refresh
  the reasoning and scrub the stagnant window from future model requests
  (the stored transcript stays available for postmortems).
- **Re-derived reasoning**: after any detection, thinking ≥ 85% similar to
  the blocked plan is trimmed — interrupting the action is not enough for
  small models; the reasoning itself has to go. Escalates to ⚠️ STUCK when
  the same blocked plan re-derives in a row.
- **Tool-call sequence loop**: an identical sequence of calls repeating
  back-to-back is blocked in place — any cycle length, adjacency only, so
  build → edit → build never trips and legitimate re-runs after real
  changes are fine. `TOOL_LOOP_BAN=2` bans a looping call permanently;
  `TOOL_LOOP_EXEMPT` exempts polling tools.
- **File read ceiling** (20 real reads of one path), **redundant re-read
  window** (≥ 40% of the last 10 reads are re-reads of unchanged files;
  read → edit → re-read counts as fresh), and **search expansion spiral**
  (the same pattern across 3+ locations). Blocked calls never reached the
  tool, so they never spend a budget or inflate reported counts.

```text
/loop-police                # detection state + all config values
/loop-police reset          # clear state (false positive recovery)
/loop-police set KEY=VAL …  # tune live (range-checked)
/loop-police save           # persist to ~/.pi/agent/aio-loop-police.json
```

Set a detector's key to 0 to disable it (`SEMANTIC_THRESHOLD=0`,
`REREAD_WINDOW=0`, `TOOL_LOOP_BAN=0`, …). Custom `MSG_*` templates and the
`MSG_SUFFIX` rider (e.g. pointing at an advisor) are edited in the JSON
file. Every detection also emits a metadata-only payload to
`loop-police:detection` on the extension event bus, `HOOK_LOG` JSONL
statistics, and `HOOK_CMD` — all observational, never blocking.

Detection stays active in aio subagent child processes (children loop too
and burn the same tokens). Registration sits between blocklist and
permission-modes: a loop block preempts mode checks, while the hard
blocklist still wins over a loop block.

## Layout

```text
.
├── index.ts                 # wires all aio features
├── ask-user-question/       # structured question tool + TUI/RPC implementations
├── copy-widget/             # /pick parser + TUI overlay
├── diff-tools/              # write/edit/apply_patch diff rendering
├── effort/                  # /effort command + status
├── hunk/                    # live hunk diff-review control + AI annotations
├── init/                    # /init AGENTS.md bootstrap
├── nvim/                    # open files in Neovim in a new otty pane
├── loop-police/             # reasoning/tool loop detection + recovery (ported)
├── permission-modes/        # Shift+Tab modes + plan flow
├── queue/                   # message-queue widget + Enter-to-interrupt
├── status-line/             # quiet footer + working message
├── pretty-tools/            # pretty built-ins + FFF search
├── rtk/                     # rtk shell rewriting (/rtk + bash spawn hook)
├── subagents/               # child-agent discovery, execution, and lifecycle
├── user-bash/               # !/!! command permission gating
└── yaml-hooks/              # hooks.yaml automation (ported from pi-yaml-hooks)
```

## Notes

- Remove standalone `@juicesharp/rpiv-ask-user-question`,
  `@pandi-coding-agent/pandi-effort`, `@aprimediet/permission-modes`,
  `@heyhuynhgiabuu/pi-pretty`, `@heyhuynhgiabuu/pi-diff`, `pi-subagents`,
  and `@sherif-fanous/pi-rtk`
  packages from settings when installing this combined package, to avoid
  duplicate tools, commands, and shortcuts.
- Effort status (`effort:…`), rtk, and `!bash` appear in the aio status line
  when active; the footer shows mode, path, git, context, and model.
- The vendored questionnaire source remains covered by its original MIT license
  in [`ask-user-question/LICENSE`](ask-user-question/LICENSE).
- The pretty-tool implementation is based on `@heyhuynhgiabuu/pi-pretty` and
  retains its MIT license in [`pretty-tools/LICENSE`](pretty-tools/LICENSE).
- The diff implementation is based on `@heyhuynhgiabuu/pi-diff` v0.7.6 and
  retains its MIT license in [`diff-tools/LICENSE`](diff-tools/LICENSE).
