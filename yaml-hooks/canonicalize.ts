// Path canonicalization with bounded symlink fallback. Extracted so both
// paths.ts (trust anchors) and imports.ts (cycle detection) share one
// implementation without circular imports. Ported from pi-yaml-hooks (MIT).

import { realpathSync } from "node:fs";
import path from "node:path";

const MAX_CANONICALIZE_DEPTH = 32;

/**
 * Canonical form of a file path: the realpath when it resolves, otherwise a
 * best-effort walk up to the nearest existing ancestor (so symlink chains
 * above a missing leaf are still collapsed). Used as the stable key for
 * import cycle detection and trust-anchor comparison.
 */
export function canonicalizePath(filePath: string, realpath: (filePath: string) => string = realpathSync): string {
	try {
		return realpath(filePath);
	} catch {
		return canonicalizePathFallback(path.resolve(filePath), realpath);
	}
}

function canonicalizePathFallback(startPath: string, realpath: (filePath: string) => string): string {
	let current = startPath;
	for (let depth = 0; depth < MAX_CANONICALIZE_DEPTH; depth += 1) {
		try {
			const resolved = realpath(current);
			return resolved;
		} catch {
			// Walk up one component and retry so the parent symlink chain
			// collapses even when the leaf is missing.
			const parent = path.dirname(current);
			if (parent === current) {
				return startPath;
			}
			try {
				const parentReal = realpath(parent);
				return path.join(parentReal, path.basename(current));
			} catch {
				current = parent;
			}
		}
	}
	// Reached the depth cap without resolving — return the original input so
	// the caller still has a stable key.
	return startPath;
}
