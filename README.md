# aio

Combined Pi extension: a **`/pick`** code picker, **`/effort`**
thinking control, and **Shift+Tab** permission modes.

Based on
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

## Permission modes (Shift+Tab)

Cycle with **Shift+Tab**: default → plan → auto → default

| Mode    | Edit/Write   | Mutating bash | Reads |
| ------- | ------------ | ------------- | ----- |
| default | prompt       | prompt        | allow |
| plan    | disabled     | blocked       | allow |
| auto    | auto-approve | auto-approve  | allow |

### Commands

- `/default`, `/plan`, `/auto` — switch mode directly
- `/mode [name]` — selector or direct switch
- `/auto-depth <n>` — auto-follow-up cap (default 20, 0 = unlimited)
- `/done` — stop auto-follow-up in auto mode

### Flag

```bash
pi --permission-mode plan
```

## Layout

```text
.
├── index.ts                 # wires all aio features
├── copy-widget/             # /pick parser + TUI overlay
├── effort/                  # /effort command + status
└── permission-modes/        # Shift+Tab modes + plan flow
```

## Notes

- Remove the standalone `@pandi-coding-agent/pandi-effort` and
  `@aprimediet/permission-modes` packages from settings when installing this
  combined package, to avoid duplicate commands and shortcuts.
- Effort status (`effort:…`) and mode status (`● Default`) coexist in the status
  bar; the footer shows the active permission mode.
