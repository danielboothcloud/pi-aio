# tuiwidth upstream

This package is a copy of the PiG Go SDK package
`github.com/MichaelKinsy/PiG/extensions/sdk/tui/internal/widthx` (MIT, see
`LICENSE`), with its `jsstring` and `lazyregexp` dependencies under
`internal/`. The SDK package is internal, so go/internal packages cannot
import it, and go/internal packages must not import the SDK.

It is pi-tui's `visibleWidth`, `truncateToWidth`, and `wrapTextWithAnsi`
with JavaScript UTF-16 semantics. The Go port uses it so that rendered rows
match the TypeScript golden data and the host's own measurement.

Source: PiG 0.7.0 staged SDK `sdk-51955af53b263ab7`. Only the package name
and the import paths changed. To update, copy the files again from the SDK
that matches the `pig` binary.
