# handoff — upstream

Based on [pi-handoff](https://github.com/jalbarrang/pi-handoff) v0.3.1
(npm `@dreki-gg/pi-handoff`, commit `ce72722`, MIT, Copyright (c) 2026 Juan
Albarran — see `LICENSE`).

## Ported

- `core.ts` ← `extensions/handoff/index.ts`: the system prompt, the
  compaction-aware branch selection (`getHandoffMessages`), and the
  previous-conversation link (`appendPreviousConversationLink`).
- `index.ts` ← the `/handoff` command: one isolated `modelRegistry.complete`
  call (`cacheRetention: "none"`), an editable draft, and
  `ctx.newSession({ parentSession, withSession })` with the draft in the
  editor.

## Changed for AIO

- Branch summaries are included in the history. The system prompt also tells
  the model not to continue the conversation.
- The serialized history has a size limit (60% of the model context window).
  A longer history keeps its start and its newest part.
- `/handoff` without a goal asks for one. It refuses while the agent is busy,
  because the new session aborts the running turn.
- The loader is TUI-only. RPC hosts generate without a loader.
- Failures and empty replies show a warning instead of an empty draft.
- `setup` copies the newest `recipe-state`, `advisor-state`, and `styles`
  entries and writes an `aio-handoff` entry before the new session starts.
  The new session restores the recipe, advisor override, style, model, and
  thinking level. A width-safe `HANDOFF` note renders at its top.
- Subagent children register only the entry renderer.
