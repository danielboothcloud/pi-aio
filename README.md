# aio

Combined Pi extension: structured **`ask_user_question`** dialogs, a **`/pick`**
code picker, **`/effort`** thinking control, **`!` bash shortcuts**, and **Shift+Tab** permission modes.

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

Cycle with **Shift+Tab**: default → plan → auto → default

| Mode    | Edit/Write/Patch | Mutating bash / `!` | Reads |
| ------- | ---------------- | ------------------- | ----- |
| default | prompt           | prompt        | allow |
| plan    | disabled         | blocked       | allow |
| auto    | auto-approve     | auto-approve  | allow |

### Commands

- `/default`, `/plan`, `/auto` — switch mode directly
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
pi --permission-mode plan
```

## Layout

```text
.
├── index.ts                 # wires all aio features
├── ask-user-question/       # structured question tool + TUI/RPC implementations
├── copy-widget/             # /pick parser + TUI overlay
├── effort/                  # /effort command + status
├── permission-modes/        # Shift+Tab modes + plan flow
└── user-bash/               # !/!! command permission gating
```

## Notes

- Remove standalone `@juicesharp/rpiv-ask-user-question`,
  `@pandi-coding-agent/pandi-effort`, and `@aprimediet/permission-modes`
  packages from settings when installing this combined package, to avoid
  duplicate tools, commands, and shortcuts.
- Effort status (`effort:…`) and mode status (`● Default`) coexist in the status
  bar; the footer shows the active permission mode.
- The vendored questionnaire source remains covered by its original MIT license
  in [`ask-user-question/LICENSE`](ask-user-question/LICENSE).
