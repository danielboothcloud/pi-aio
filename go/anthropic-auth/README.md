# Anthropic auth for PiG

Separate Go port of `@gotgenes/pi-anthropic-auth` 3.4.4 (MIT, Christopher D. Lasher / gotgenes).

It needs a `pig` built from the PiG fork with `sdk.AnthropicMessagesAPI` and the legacy provider callback bridge. PiG 0.7.0 cannot load it. Loading AIO does not enable it.

```sh
pig install ./go/anthropic-auth
```

Remove the TypeScript `npm:@gotgenes/pi-anthropic-auth` first, so the `anthropic` provider is not wrapped twice.

The tested, SDK-free core is in `../internal/anthropicauth`. See [UPSTREAM.md](UPSTREAM.md) for the source commit, license, tests, host evidence and remaining gaps.
