# advisor — upstream

Based on [pi-advisor](https://github.com/RimuruW/pi-advisor) v0.3.0
(npm `pi-advisor`, MIT, Copyright (c) 2026 RimuruW — see `LICENSE`).

## Ported

- `signals.ts` ← `src/advisor-signals.ts`: tool-result summaries, stage
  detection, executor signals. Adapted to AIO tool names (`apply_patch` is a
  mutation; `hypa_shell` is a shell; `hypa_read` is a read) and `npm run
  test:*` / `tsx --test` count as verification.
- `messages.ts` ← `src/advisor-messages.ts` plus the system prompt and stage
  directives from `index.ts`. User content is reduced to text blocks.
- `index.ts` ← the `advisor` tool from `index.ts`.

## Changed for AIO

- No `~/.pi/agent/advisor.json`. The switch is the active recipe's `advisor`
  key (absent = off). `/advisor on [model] | off | reset` overrides it for the
  session (an `advisor-state` branch entry); a live `/recipe` switch drops the
  override.
- No `/advisor ask` and no `/advisor config`: `/btw` covers manual side
  questions, and limits live in the recipe object form.
- The side call goes through `ctx.modelRegistry.streamSimple` (request-time
  auth) instead of `completeSimple` with a resolved API key.
- Model lookup reuses the recipe resolver (`findRecipeModel`), so bare ids and
  scoped models resolve like the recipe `model` key.
- Errors throw (error tool results) instead of error-shaped successes.
- No footer nudge status.
- Rendering uses `ui/chrome.ts`.
- Subagent children inherit the parent's effective advisor via `AIO_ADVISOR`;
  the subagent runner admits `advisor` into agent tool allowlists.
