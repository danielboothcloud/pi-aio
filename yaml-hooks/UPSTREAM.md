# Upstream

`yaml-hooks/` is a port of
[pi-yaml-hooks](https://github.com/KristjanPikhof/pi-yaml-hooks)
(KristjanPikhof, MIT — see `yaml-hooks/LICENSE`), fetched from the upstream
repository at the time of the port.

## What was kept

- The complete YAML hook contract: events (`user.prompt.submit`,
  `tool.before.*`/`tool.after.*`, `file.changed`, `session.created/idle/deleted`),
  actions (`bash`, `tool`, `notify`, `confirm`, `setStatus`), conditions
  (`matchesCodeFiles`, `matchesAnyPath`, `matchesAllPaths`), scopes, async
  queues, and project-override resolution by hook `id`.
- The load-time validation surface and error codes, including the
  unsupported-`command:` policy (Pi rejects `command:` actions; upstream's
  OMP host kept them).
- The config discovery + trust model for Pi only:
  `<agentDir>/hook/hooks.yaml` (global) and `<project>/.pi/hook/hooks.yaml`
  (project, trust-gated through Pi's `trusted-projects.json`).
- The runtime internals: capped bash execution with JSON stdin, capped output
  capture, UTF-8-boundary truncation, session-state file-change collection,
  mutation-tool path extraction (including bash mutation commands and patch
  payloads), path-condition evaluation, async hook queues with pending caps,
  and the action recursion guard.
- Environment-variable names (all `PI_YAML_HOOKS_*`, plus the documented
  `OPENCODE_*` aliases) so existing hooks.yaml docs, examples, and shell
  profiles keep working unchanged.
- The `/hooks-status`, `/hooks-validate`, `/hooks-trust`, `/hooks-reload`,
  and `/hooks-tail-log` commands, and the context-free diagnostics message
  surface.

## What was dropped or restructured

- All OMP host support (`src/omp/*`, OMP discovery paths, OMP profiles, OMP
  trust stores, OMP confirmation deadlines) — aio ships Pi-only. The host
  profile abstraction collapsed into direct Pi paths (`getAgentDir()`).
- Upstream's process-wide singleton logger and host-profile singletons were
  replaced with an env-gated structured emitter in `actions.ts` and direct
  imports (aio loads as one extension; no separate host profiles exist).
- The autocomplete overlay and persistent custom-entry diagnostics fallback
  were simplified to Pi's `registerMessageRenderer` + `sendMessage` surface.
- The runtime registry keeps one runtime per cwd (upstream kept one per
  profile+cwd); OMP-only scope/lineage bookkeeping was removed.
- Upstream's `src/core/hooks/snapshot-cache.ts` cache bookkeeping was
  collapsed into `discovery.ts` with a single stat-fingerprint cache.
- `OPENCODE_*` env aliases remain injected for hooks that migrated, matching
  upstream; the OpenCode host itself is not supported (same as upstream).

## Syncing

Upstream is actively developed. When porting upstream changes, keep:

- the MIT license and this attribution file,
- the `PI_YAML_HOOKS_*` env names (append-only contract),
- the YAML validation error codes (append-only contract),
- the failure semantics: prompt hooks fail-open, user-bash interception fails
  closed, post-tool hooks fail-open, cleanup hooks are best-effort.
