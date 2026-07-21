# aio

Combined pi extension: **`/effort`** thinking control and **Shift+Tab**
permission modes.

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
├── index.ts                 # wires effort + permission-modes
├── effort/                  # /effort command + status
└── permission-modes/        # Shift+Tab modes + plan flow
```

## Notes

- Remove the standalone `@pandi-coding-agent/pandi-effort` and `@aprimediet/permission-modes` packages from settings if you install this combined package, to avoid duplicate commands/shortcuts.
- Effort status (`effort:…`) and mode status (`● Default`) coexist in the status bar; the footer shows the active permission mode.
