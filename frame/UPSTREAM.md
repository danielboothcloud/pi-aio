# frame — AIO proprietary minimalist editor frame

Adapted from [pi-zentui](https://github.com/lmilojevicc/pi-zentui)
(MIT License — see `LICENSE`). AIO vendors only the Minimalist editor
treatment and its direct helpers; everything else (presets, Starship
footer, user-message styles, working line, and settings UI) remains upstream
and is not used by AIO. Selector framing is an AIO-owned adapter, not a
vendored upstream integration.

## Deviations from upstream

- Configuration is code-owned (`FrameStyle` defaults); there is no
  zentui.json and no color-source/terminal-palette machinery — Pi theme
  tokens only.
- Editor mouse hit-testing is forwarded unadjusted (upstream offsets by the
  frame chrome); the editor chain AIO wraps does not rely on it.
- Public host selectors receive the same muted, rounded frame via
  `menus.ts`, installed only while AIO owns a TUI editor. It narrowly wraps
  selector render/mouse methods (not Container or SelectList), replaces
  native rule/spacer rows without adding rows (including /resume, /tree,
  and /fork's leading headers), translates horizontal mouse
  coordinates, and restores predecessor descriptors on shutdown. Unknown
  or already-framed host layouts remain native. RPC/non-TUI is untouched.
- Live streaming context override is dropped; context percent resolves
  through `ctx.getContextUsage()` per render.
- Git probe is trimmed to branch/dirty/ahead/behind (porcelain v2).
- Queue panel rows render inside the frame (as framed rows above the
  bottom border) — an AIO-specific integration.
- Codex quota is retained (`codex-quota.ts`) and always on: upstream gates it
  behind a `codexQuota` setting, AIO renders the 5h/weekly windows whenever
  the native `openai-codex` route is active. Upstream's `getProviderAuth`
  does not exist on the host surface, so the token resolves through the
  registry's own auth accessors (`getApiKeyAndHeaders`, falling back to
  `getApiKeyForProvider`) — the same bearer Pi uses for the codex route.
