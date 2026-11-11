// Loader hook for the diff-tools golden generator: resolves @shikijs/cli to
// the deterministic stub in this directory.
export async function resolve(specifier, context, next) {
	if (specifier === "@shikijs/cli") {
		return { url: new URL("./shiki-stub.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
