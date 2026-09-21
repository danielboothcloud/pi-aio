# Upstream

`loop-police/` is a port of
[pi-loop-police](https://github.com/sebaxzero/pi-loop-police)
(sebaxzero, MIT — see `loop-police/LICENSE`). It detects and breaks infinite
reasoning/tool loops in real time, before they waste the context window.

## What was kept

- The complete detector set (all enabled out of the box):
  - **Streaming** (thinking + output, re-checked every STRIDE chars):
    character-level tail repetition and semantic paragraph fingerprinting
    (ordered-list counters normalized, code fences skipped). The semantic
    layer catches loops early — repeats rarely stay perfectly verbatim.
  - **Cross-turn**: stagnation (STAGNATION_WINDOW turns of ≥
    STAGNATION_THRESHOLD word-similar thinking) and the re-derived reasoning
    guard (post-detection thinking ≥ REDERIVE_THRESHOLD similar to the
    blocked plan is trimmed — interrupting the action is not enough for
    small models; the reasoning itself has to go).
  - **Tool traffic**: identical tool-call sequence repeating back-to-back
    (any cycle length; adjacency only, so build → edit → build never trips);
    file read ceiling (real, non-blocked reads of the same path); redundant
    re-read window (≥ REREAD_RATIO of the window re-reads of unchanged
    files; read → edit → re-read counts as fresh); search expansion spiral
    (same pattern across SEARCH_EXPAND_LIMIT locations).
- The blocked-in-place tool semantics: a blocked call never reached the
  tool, so it never spends a budget, never enters an executed history, and
  the recovery message is handed back as the tool's result in the same turn
  (no duplicate recovery message in context). The re-read window clears on
  a firing so blocks never chain back-to-back.
- The sanitized-reasoning contract: contaminated thinking is replaced by an
  ordinary marker with no thinkingSignature and no redacted payload,
  preventing providers from replaying opaque reasoning that was supposedly
  removed.
- The `/loop-police` command surface (status / reset / set / save) with
  range-checked live tuning, MSG_* templates edited in the JSON file only,
  {token} substitution where unknown tokens stay visible so typos show.
- All config key names, defaults, ranges, and the 0-disables-a-detector
  convention (append-only contract for existing loop-police.json files).
- The structured detection payload (metadata only — never thinking text or
  tool arguments) and the observer channels: `loop-police:detection` on the
  shared extension event bus, HOOK_LOG JSONL statistics, HOOK_CMD external
  command — all purely observational, never blocking detection or recovery.
- Escalation: CONSECUTIVE_LOOP_LIMIT looped turns in a row escalate the
  recovery message; re-derived reasoning in a row escalates to STUCK.

## What was adapted to aio

- **Persistent config location**: `getAgentDir()/aio-loop-police.json`
  (aio's agent-file pattern, same as aio-blocklist.json) instead of a file
  next to the installed extension. Loads tolerant-and-fail-open; values are
  range-checked on load with invalid values falling back to defaults.
- **Stream abort mechanics**: upstream was written against a host whose
  `message_update` handlers could abort the stream from the handler result.
  In the Pi SDK, `message_update` is notify-only (the runner ignores return
  values — verified in `extensions/runner.js emit()`), so the port aborts
  through `ctx.abort()` from the watcher, sanitizes the just-aborted
  message through `message_end`'s same-role replacement, and starts
  recovery through the before_agent_start message injection.
- **Recovery delivery**: the upstream `sendMessage` recovery path is the
  Pi `before_agent_start` result (system context for the same turn) — the
  fail-open delivery matches upstream's prompt-hook contract.
- **No npm packaging/skills**: aio ships as one package; upstream's two
  bundled skills (help card, postmortem) were dropped — `/loop-police`
  documents the surface, and the status output covers the help card.
- **Subagent children**: detectors stay ACTIVE in `AIO_SUBAGENT_CHILD=1`
  processes (children loop too and burn the same tokens); UI surfaces stay
  parent-only (children run JSON mode without dialogs).

## Syncing

When porting upstream changes, keep:

- the MIT license and this attribution file,
- the config key names and defaults (append-only contract),
- the `loop-police:detection` event name and payload shape,
- the blocked-in-place semantics (blocked calls never enter histories),
- the sanitized-reasoning contract (no signature, no redacted payload).
