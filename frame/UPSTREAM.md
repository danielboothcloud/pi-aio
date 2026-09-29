# frame — AIO proprietary minimalist editor frame

Adapted from [pi-zentui](https://github.com/lmilojevicc/pi-zentui)
(MIT License — see `LICENSE`). AIO vendors only the Minimalist editor
treatment and its direct helpers; everything else (presets, Starship
footer, user-message styles, working line, selector borders, settings
UI) remains upstream and is not used by AIO.

## Deviations from upstream

- Configuration is code-owned (`FrameStyle` defaults); there is no
  zentui.json and no color-source/terminal-palette machinery — Pi theme
  tokens only.
- Mouse hit-testing is forwarded unadjusted (upstream offsets by the
  frame chrome); the editor chain AIO wraps does not rely on it.
- Live streaming context override is dropped; context percent resolves
  through `ctx.getContextUsage()` per render.
- Git probe is trimmed to branch/dirty/ahead/behind (porcelain v2).
- Queue panel rows render inside the frame (as framed rows above the
  bottom border) — an AIO-specific integration.
