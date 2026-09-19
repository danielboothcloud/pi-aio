# Upstream provenance

The implementation in this directory is vendored from
[`@hypabolic/pi-hypa`](https://github.com/Hypabolic/Hypa/tree/main/packages/pi-hypa)
under the Functional Source License 1.1 with an Apache License 2.0 future
license (FSL-1.1-ALv2) in [`LICENSE-FSL`](LICENSE-FSL).

- Upstream package version: `0.1.15`
- Upstream commit inspected: `169b45e35fc77da4dda69f14d65a726c76e8f4ef`
  ("Fix rewritten bash commands failing on Windows Git Bash (#101)")
- Vendored into `aio`: 2026-09-18
- Original env/config namespaces preserved: `HYPA_BIN`, `HYPA_PI_*`,
  `~/.hypa-pi/config.json`, the `/hypa` command, and the `hypa_*` tool
  names.

## Composition with rtk (aio-specific)

aio registers `registerHypa` after `registerRtk`. rtk rewrites most shell
commands to `rtk ...` equivalents and owns their output compression. Hypa's
bash rewrite therefore skips commands already claimed by rtk
(`isRtkClaimedCommand`) and compliments rtk only where rtk declined to
rewrite (arbitrary pipes, `curl`, unknown utilities) through its
GenericWrapper path plus evidence recording. The `hypa_*` file/shell tools
are independent of rtk's bash path and never compete with it.

## Local integration changes

- The upstream extension default export is the named registrar
  `registerHypa` called from `aio`'s root `index.ts`; `export default` is
  retained for upstream test compatibility.
- Upstream formatting is re-indented to the repository style (tabs); import
  paths are flattened (`../extensions/x.js` → `./x.js`).
- The upstream `HypaExtensionAPI` cast is retained: the vendored duck-typed
  modules (`tools.ts`, `mcp-proxy-bridge.ts`) need the loose
  `registerTool`/`exec` signatures, which the SDK's generic
  `ToolDefinition<TParams extends TSchema, ...>` cannot express.
- Upstream's `PiToolParams = Record<string, any>` duck types are structural
  optional-field types (aio anti-slop convention). Absent required params
  default to `""`; schema-valid calls behave identically.
- `parseRewriteJson` and the MCP bridge `parseJson` wrap `JSON.parse` and
  rethrow descriptive typed errors; the throwing contracts are preserved
  (callers still fail open).
- Upstream TUI/duck-typing idioms are retained: `any`-typed renderer params,
  exhaustive switches without a `default` clause, and `filter().map()`
  chains are upstream style and accepted for sync fidelity.
- `scripts/postinstall.js` resolves the development-install check against
  the aio package root (the script lives one level deeper than upstream).
- `aio` owns the `@hypabolic/hypa` dependency declaration that was
  previously in the standalone package manifest.

## Tests

The upstream test suite is ported beside the feature (`*.test.ts`,
`node:test` through `tsx --test`) with import paths flattened.
`rtk-precedence.test.ts` covers the aio composition rule. Upstream's
`test/types.d.ts` ambient SDK shim is not ported (`tsx` does not typecheck;
the ported tests use structural fakes).

When updating this directory, compare against the recorded upstream
version, preserve `LICENSE-FSL`, reapply the integration changes above, and
run `npm test` plus `npm pack --dry-run --json` from the repository root.
