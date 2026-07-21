# Upstream provenance

The implementation in this directory is vendored from
[`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
under the MIT license in [`LICENSE`](LICENSE).

- Upstream package version: `2.0.0`
- Upstream commit inspected: `f9a31bb2671efc6e07db0c83cca87527b4bd32d0`
- Vendored into `aio`: 2026-07-21
- Original event namespace: `rpiv:ask-user:prompt` (preserved)
- Original config namespace: `rpiv-ask-user-question` (preserved)

## Local integration changes

- The upstream extension registrar is called from `aio`'s root `index.ts`.
- Public event types are re-exported from the `aio` entry point.
- `ask_user_question` uses `executionMode: "sequential"` so clarification
  completes before sibling tool calls and multiple questionnaire overlays cannot
  race.
- The upstream test suite is retained as `*.upstream.test.ts`, with a small local
  compatibility shim and focused Node regression tests. All test-only files are
  excluded from the published package.
- `aio` owns the dependency and package-file declarations that were previously
  in the standalone package manifest.

When updating this directory, compare against the recorded upstream version,
preserve `LICENSE`, reapply the integration changes above, and run `npm test`
plus `npm pack --dry-run --json` from the repository root.
