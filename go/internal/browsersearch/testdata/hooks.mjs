// Loader hook for the browser-search golden generator: node:dns resolves to
// dns-stub.mjs for url-validation.ts, so validateUrlWithDns never reaches a
// real resolver (no live network in golden generation).
export async function resolve(specifier, context, next) {
	if ((specifier === "node:dns" || specifier === "dns") && context.parentURL?.includes("/browser-search/url-validation.ts")) {
		return { url: new URL("./dns-stub.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
