# Anthropic auth Go port reference

## Status: implemented, needs a pig built from the PiG fork

`extension.go` is the separate `anthropic-auth` factory. It unregisters only `anthropic`, then registers `{api: "anthropic-messages", streamSimple: wrapper}` without OAuth or model overrides, so the host keeps login, refresh and the model catalog. Named providers from the global config register at load time and trusted project providers at `session_start`. `/anthropic-auth:status` (with `--account`) and its completions are registered. AIO does not import it, and loading `go/aio` does not activate it.

The wrapper delegates to `sdk.AnthropicMessagesAPI(ctx).StreamSimple`, the raw built-in transport the PiG fork adds. It does not resolve its own registered provider, so it cannot recurse. It needs two fork changes that are not in PiG 0.7.0:

- `sdk.AnthropicMessagesAPI`: the raw built-in Anthropic stream (the existing `modelStream` call with `apiRequest: true`).
- The legacy provider callback bridge: a `registerProvider({streamSimple})` wrapper receives the caller's `onPayload`, `onResponse`, `fetch` and `onProviderStreamEvent`, so other extensions' request hooks keep working through it.

At the time of writing both are uncommitted in the fork worktree. Build pig from a fork tree that has them.

## Exact reference and license

- Package: [`@gotgenes/pi-anthropic-auth` 3.4.4](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth/v/3.4.4).
- Repository: <https://github.com/gotgenes/pi-anthropic-auth>.
- Tag: [`v3.4.4`](https://github.com/gotgenes/pi-anthropic-auth/tree/v3.4.4).
- Annotated tag object: `37b1ff56a5d9370908a9c7b50eac65b5c42debb1`.
- Commit: `fcc2003ca57df5b841edcdd27da58e428cded743`.
- Author: Christopher D. Lasher (Chris Lasher, `gotgenes`).
- License: MIT; the original notice is retained in `LICENSE`, the core's `LICENSE`, and the vendored oracle snapshot.

The installed npm package's complete `src/` directory was compared with this tag and matched byte-for-byte. `../internal/anthropicauth/testdata/upstream/` retains every source file and every upstream test file, plus the original package metadata and license. `upstream-manifest.json` records their SHA-256 digests. The golden generator verifies those digests before importing the unmodified sources. The snapshot is test-only; Go runtime code neither imports nor executes TypeScript, Node, or JavaScript.

## History: the original SDK blocker (resolved by the fork)

Upstream delegates directly to `anthropicMessagesApi().streamSimple` from Pi's `@earendil-works/pi-ai/compat`. It never resolves its own registered provider through `ModelRegistry`.

The Go SDK inspected was `/Users/danielbooth/projects/work/danielboothcloud/PiG/extensions/sdk`, at PiG commit `0ac0afaaf95fc917fcab6ee32b412a82f12f59b5`. It provides `ProviderStreamSimpleFunc`, `OnPayloadFunc`, and `ModelFetchFunc`, but no exported raw `AnthropicMessagesApi` equivalent. In `provider_proxy.go`, `ModelRegistry.GetProvider` explicitly rejects built-in/composed provider objects with D78. `GetRegisteredNativeProvider` only returns extension-owned providers. `ModelRegistry.StreamSimple` dispatches through the registered provider and cannot serve as the delegate for its own override.

A real, isolated subprocess probe using installed `pig` version `0.7.0+1.5.0` returned:

```text
provider_nil=true error=builtin/composed Provider object carrier is unavailable (D78)
```

The staged SDK was `state/pigsdk/sdk-252945fe20348bcb`. Its `provider_proxy.go` and the local SDK file had the same SHA-256: `66953fb98c9e6f80c2c126c5ed7165de5597334d2b52a1187bd36f931b752a4a`.

Reproduce without reading or changing real credentials:

```sh
python3 go/internal/anthropicauth/testdata/probe-host.py
```

The probe creates temporary agent, home, and build directories under this repository's `test/`, clears inherited `PIG_EXT_*`, `PIG_HARNESS_*`, and `PIG_PRODUCT_*`, makes no model request, and removes its own scratch directory. It proves the missing capability, not successful HTTP transport integration.

The required bridge is a raw built-in Anthropic `streamSimple` delegate independent of provider registration. It must forward cancellation, caller `onPayload`, caller `onResponse`, and a custom `fetch` whose response body can be inspected, replaced, closed, and retried once. Merely enabling composed `GetProvider` is not sufficient if it resolves back to the override. No PiG host or SDK files were changed for this port.

## Implemented SDK-independent behavior

| Reference sources | Go core | Evidence |
|---|---|---|
| `billing-header.ts`, `claude-code-version.ts` | `billing.go`, `version.go` | Exact source-generated hashes, UTF-16 sampling (including sampled surrogate halves), version parsing, override errors, numeric comparisons |
| `system-prompt-sections.ts`, `system-prompt-shaping.ts`, `constants.ts` | `sections.go`, `shaping.go` | Exact chunks and prompt text, malformed framing, nested sections, project context preservation, replacement scoping, docs/filler removal, mid-conversation updates |
| `request-shaping.ts`, `anthropic-message.ts` | `shaping.go` | Full payload fixtures, cache-control preservation, no duplicate billing block, first-user-text rules, effort-bearing empty system messages, unchanged signed assistant ordering |
| `oauth-transport.ts` | `transport.go` | Token `includes("sk-ant-oat")` gating, API-key passthrough, caller mutation/replacement/nil/error composition, caller fetch preservation, shared learned floor |
| `billing-version-sync.ts`, `version-rejection.ts` | `sync.go`, `rejection.go` | Exact outgoing request body strings, host version reconciliation, override priority, one retry, learned floor, all recovery hints, response field/header preservation |
| `extension-config.ts`, `extra-provider-shaping.ts` | `config.go` | Config fixtures and warnings, JavaScript object-key order in invalid-entry warnings, additive layer tracking, first-layer ownership, no untrusted-project reads, surfaced registration errors |
| `account-profile.ts`, `diagnostics.ts` | `diagnostics.go` | Token-gated mocked profile fetch, endpoint/headers/deadline, malformed responses, profile type checks, identity opt-in, ordered parallel lookups, exact reports/completions |
| `debug.ts` | `shaping.go` | Debug modes and concurrent once-only unstructured-prompt warnings; logs do not include user text or credentials |

The transport core accepts an injected delegate through a generic Go function. It is deliberately SDK-free. This is not a second Anthropic implementation and does not build native Anthropic requests itself.

## Validation and limits

From the repository root, use repo-local scratch storage:

```sh
mkdir -p test/.anthropic-auth-work/tmp
export TMPDIR="$PWD/test/.anthropic-auth-work/tmp"
node --import tsx go/internal/anthropicauth/testdata/gen-golden.ts --check
(cd go && go vet ./internal/anthropicauth && go test -trimpath -race ./internal/anthropicauth -timeout 60s)
python3 go/internal/anthropicauth/testdata/mutation-check.py
```

Node is a test oracle only. `node --import tsx` avoids tsx CLI's Unix-socket path limit with long repo-local `TMPDIR` paths. The golden checker is also discovered by the existing `npm run test:go` glob.

`TestWrapperHTTPRetryAndConcurrentLearnedFloor` drives the pure wrapper through a hermetic HTTP server, verifies caller callback composition, forces a rejection and retry, then joins 32 concurrent named-provider requests at the learned floor. `TestWrapperCancellationClosesHTTPExchange` proves cancellation reaches the server and ends the request. Success bodies stay unread, rejected response bodies are closed, opaque request bodies are not rebuilt, and replaced request bodies are closed.

Mutation checks compile before running the regression. Removing shaping, removing OAuth gating, removing retry, and replacing UTF-16 sampling with rune sampling each fail an upstream-derived regression. Direct red/green tests also caught and fixed trailing-JSON profile acceptance, invalid-entry warning key-order drift, rejection-body key-order drift, and a replaced request-body cleanup leak.

The full existing `go/internal/...` test tier was attempted with a repo-local `HOME`. All packages except `permissionmodes` passed. Its pre-existing `TestPureFunctionsMatchTypeScript` compares the parent of `~` with a literal `/Users` in its golden file; an isolated home inside this checkout produces a different parent. That fixture was not changed. `go vet ./internal/...` passed. The new package passed `-race`.

A representative 110,780-byte structured prompt benchmark on Apple M3 / Go 1.27.3 measured about 187 µs/op, 121 KB/op, and 66 allocations/op. CPU and allocation profiles were captured in repo-local scratch. This measures only the pure shaper, not subprocess IPC or model streaming.

### Host integration evidence

`integration_test.go` runs a real pig built from the fork against an `httptest` server, with fake credentials in a repo-local agent directory. Set `AIO_ANTHROPIC_AUTH_PIG` to that binary; without it both tests skip.

- `TestPiGMainAuxiliaryRetryAndCatalog`: the main turn and three auxiliary `ModelRegistry.CompleteContext` calls (OAuth `anthropic`, named OAuth `anthropic-2`, API-key `anthropic-key`). OAuth requests carry the billing header and the shaped prompt; the API-key request passes through untouched. A `claude_code_version_too_old` rejection is retried once, and later requests keep the learned `9.9.9` floor. The built-in catalog and auth status are the same with and without the extension. Red when shaping is removed (`transport.go` returns the unshaped payload).
- `TestPiGCallerCallbacks`: a caller's `onPayload`, `fetch` and `onResponse` run in that order through the wrapper, the caller's replacement payload is shaped afterwards, and its fetch header reaches the server. Red when the wrapper drops the caller's `onPayload`.

```sh
# In the PiG fork checkout:
CGO_ENABLED=0 go build -buildvcs=false -trimpath -o <pi-aio>/test/.anthropic-auth-work/pig ./cmd/pig
# In pi-aio/go, with a go.work that uses this module and the fork's extensions/sdk:
AIO_ANTHROPIC_AUTH_PIG=$PWD/../test/.anthropic-auth-work/pig go test ./anthropic-auth -count=1
```

### Remaining gaps

- Compaction through the wrapper is not exercised by a host test. It uses the same registered `streamSimple` as the main turn.
- `/anthropic-auth:status` is unit-tested in the core but not run through a host test.
- Lone UTF-16 surrogates in prompt text are not proven across the SDK JSON boundary. Valid Unicode, including sampled surrogate halves, is proven.
- The fork's raw factory is Go only. Rust, Python and Lisp list it as an SDK export gap.

Install and a one-off load:

```sh
pig install ./go/anthropic-auth
pig -ne -e ./go/aio -e ./go/anthropic-auth
```

Do not load a TypeScript copy and a future Go copy of Anthropic auth together. `-ne` prevents configured TypeScript extensions from loading during an explicit one-off check. Keep login, refresh, the model catalog, and settings under the host's existing ownership.
