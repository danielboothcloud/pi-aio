// Shiki stub loader hook for the pretty-tools golden generator: resolves
// @shikijs/cli to the diff-tools stub, and makes @ff-labs/fff-node fail to
// load, so the tools take the path TypeScript takes without FFF (the Go port
// has no FFF).
export async function resolve(specifier, context, next) {
	if (specifier === "@shikijs/cli") {
		return { url: new URL("../../difftools/testdata/shiki-stub.mjs", import.meta.url).href, shortCircuit: true };
	}
	if (specifier === "@ff-labs/fff-node") {
		return { url: new URL("./fff-missing.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
