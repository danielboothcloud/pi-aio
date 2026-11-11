// Loader hook for the ask-user-question golden generator:
// @earendil-works/pi-coding-agent resolves to pi-shim.mjs (a deterministic
// getMarkdownTheme) for every importer except the shim itself.
export async function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-coding-agent" && !context.parentURL?.endsWith("/pi-shim.mjs")) {
		return { url: new URL("./pi-shim.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
