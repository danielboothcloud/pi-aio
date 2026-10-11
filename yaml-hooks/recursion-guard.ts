// Action recursion guard. Wraps an execute() body in an AsyncLocalStorage
// frame keyed by an action key: per-key dedup plus a nesting-depth cap so a
// misconfigured hook chain cannot run unbounded. Ported from pi-yaml-hooks (MIT).

import type { AsyncLocalStorage } from "node:async_hooks";

export const RECURSION_DEPTH_CAP = 32;
export const recursionDepthByStore = new WeakMap<
	Set<string>,
	{ depth: number; loggedExceedance: boolean }
>();

export async function withActionRecursionGuard<T>(
	actionRecursionGuards: AsyncLocalStorage<Set<string>>,
	actionKey: string,
	execute: () => Promise<T>,
): Promise<T | undefined> {
	const activeKeys = actionRecursionGuards.getStore();
	if (activeKeys?.has(actionKey)) {
		return undefined;
	}

	if (activeKeys) {
		const meta = recursionDepthByStore.get(activeKeys) ?? { depth: 0, loggedExceedance: false };
		if (meta.depth >= RECURSION_DEPTH_CAP) {
			if (!meta.loggedExceedance) {
				meta.loggedExceedance = true;
				recursionDepthByStore.set(activeKeys, meta);
				// eslint-disable-next-line no-console
				console.warn(
					`[aio yaml hooks] Hook action recursion depth exceeded ${RECURSION_DEPTH_CAP}; skipping further nested actions.`,
				);
			}
			return undefined;
		}
		activeKeys.add(actionKey);
		meta.depth += 1;
		recursionDepthByStore.set(activeKeys, meta);
		try {
			return await execute();
		} finally {
			activeKeys.delete(actionKey);
			meta.depth -= 1;
			if (meta.depth === 0) {
				recursionDepthByStore.delete(activeKeys);
			}
		}
	}

	const rootKeys = new Set<string>([actionKey]);
	recursionDepthByStore.set(rootKeys, { depth: 1, loggedExceedance: false });
	return await actionRecursionGuards.run(rootKeys, async () => {
		try {
			return await execute();
		} finally {
			rootKeys.delete(actionKey);
			recursionDepthByStore.delete(rootKeys);
		}
	});
}
