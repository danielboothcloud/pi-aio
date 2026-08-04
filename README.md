# aio

Combined Pi extension: structured **`ask_user_question`** dialogs, a **`/pick`**
code picker, **`/init`** AGENTS.md bootstrap, **`/effort`** thinking control,
generic **subagent delegation**, self-hosted **`web_search`** and
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

## Self-hosted web search

AIO provides `web_search` and `fetch_content` using the native TypeScript port
in [`browser-search/`](browser-search/README.md):

- SearXNG supplies raw multi-engine search hits.
- Camofox extracts readable page content through headless Firefox.
- CloakBrowser is an optional stealth fallback for blocked or empty pages.
- Results are returned inline; there is no curator, response-id store, or
  `get_search_content` tool.

SearXNG and Camofox must be running separately. See the
[browser-search setup and configuration](browser-search/README.md), including
how to disable pi-web-access's overlapping extension while retaining its skills.

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
`thinking`, `systemPromptMode`, `inheritProjectContext`, and `inheritSkills`.
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
      "segments": ["mode", "path", "git", "context", "effort", "statuses", "cursor", "model"],
      "path": "basename",
      "workingMessage": "minimal"
    }
  }
}
```

| Field | Purpose |
| ----- | ------- |
| `enabled` | Master toggle; `false` restores Pi's default footer |
| `segments` | Ordered list: `mode`, `path`, `git`, `context`, `effort`, `statuses`, `cursor`, `model`, `tokens`, `cost` |
| `path` | `basename`, `abbreviated`, or `full` |
| `workingMessage` | `minimal` (default), `verbose` (streaming stats), or `off` |
| `statusKeys` | Optional allowlist for extension status keys |

Quick toggles:

- `/status-line` — enable/disable
- `/status-line minimal` or `/status-line verbose` — working message style

Extension statuses (`rtk`, `!bash`, `fff`, `codex-quota`, etc.) appear in the
`statuses` segment when active. Thinking effort (`effort`) and Cursor runtime
(`cursor:local · fast:on`) get their own segments so they do not blend with the
model name. Context percentage turns warning/error at 70%/90%.

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

## Layout

```text
.
├── index.ts                 # wires all aio features
├── ask-user-question/       # structured question tool + TUI/RPC implementations
├── copy-widget/             # /pick parser + TUI overlay
├── diff-tools/              # write/edit/apply_patch diff rendering
├── effort/                  # /effort command + status
├── init/                    # /init AGENTS.md bootstrap
├── permission-modes/        # Shift+Tab modes + plan flow
├── queue/                   # message-queue widget + Enter-to-interrupt
├── status-line/             # quiet footer + working message
├── pretty-tools/            # pretty built-ins + FFF search
├── rtk/                     # rtk shell rewriting (/rtk + bash spawn hook)
├── subagents/               # child-agent discovery, execution, and lifecycle
└── user-bash/               # !/!! command permission gating
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
