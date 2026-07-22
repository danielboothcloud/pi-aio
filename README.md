# aio

Combined Pi extension: structured **`ask_user_question`** dialogs, a **`/pick`**
code picker, **`/init`** AGENTS.md bootstrap, **`/effort`** thinking control, **`!` bash shortcuts**, **Shift+Tab**
permission modes, enhanced built-in output with FFF-backed search, and
syntax-highlighted write/edit/patch diffs.

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

## Pretty built-in tools

`aio` replaces Pi's built-in `read`, `bash`, `ls`, `find`, and `grep` tool
definitions while delegating their normal execution to Pi. The replacements add:

- **`read`** — collapsed line-count summaries, expanded line-numbered Shiki syntax
  highlighting, and Pi's native inline image rendering.
- **`bash`** — colored `exit 0`/`exit 1` summaries, elapsed time, line counts,
  and expanded command output.
- **`ls`** — Nerd Font icons and tree-oriented expanded listings.
- **`find`** — FFF-backed, frecency-aware file search with grouped results and
  automatic fallback to Pi's normal `fd` implementation.
- **`grep`** — FFF-backed content search with file grouping, line numbers,
  highlighted literal matches, context lines, and fallback to Pi's normal search
  whenever `path` or `glob` scopes are supplied.
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

- `PRETTY_DISABLE_TOOLS` — comma-separated tools to leave untouched.
- `PRETTY_ENABLE_TOOLS` — explicitly enable tools if defaults change.
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
├── pretty-tools/            # pretty built-ins + FFF search
└── user-bash/               # !/!! command permission gating
```

## Notes

- Remove standalone `@juicesharp/rpiv-ask-user-question`,
  `@pandi-coding-agent/pandi-effort`, `@aprimediet/permission-modes`,
  `@heyhuynhgiabuu/pi-pretty`, and `@heyhuynhgiabuu/pi-diff` packages from
  settings when installing this combined package, to avoid duplicate tools,
  commands, and shortcuts.
- Effort status (`effort:…`) and mode status (`● Default`) coexist in the status
  bar; the footer shows the active permission mode.
- The vendored questionnaire source remains covered by its original MIT license
  in [`ask-user-question/LICENSE`](ask-user-question/LICENSE).
- The pretty-tool implementation is based on `@heyhuynhgiabuu/pi-pretty` and
  retains its MIT license in [`pretty-tools/LICENSE`](pretty-tools/LICENSE).
- The diff implementation is based on `@heyhuynhgiabuu/pi-diff` v0.7.6 and
  retains its MIT license in [`diff-tools/LICENSE`](diff-tools/LICENSE).
