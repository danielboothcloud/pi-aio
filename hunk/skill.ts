// ---------------------------------------------------------------------------
// Bundled Hunk skill discovery.
//
// `hunk skill path` prints the installed hunk-review skill (the upstream
// agent-workflow document: inspect / navigate / reload / comment / highlight
// against live sessions). aio feeds that path into Pi's resources_discover
// so the model loads the authoritative hunk-review guidance natively.
// A missing or broken hunk install degrades silently — hunk is optional.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import type { HunkExec } from "./cli.js";
import { HUNK_BINARY, HUNK_SESSION_TIMEOUT_MS } from "./cli.js";

let cachedSkillPath: string | undefined;
let resolvedSkillPath = false;

/** Resolve (and cache) the installed hunk-review skill path; undefined when hunk is absent. */
export async function resolveHunkSkillPath(ex: HunkExec): Promise<string | undefined> {
	if (resolvedSkillPath) {
		return cachedSkillPath;
	}
	resolvedSkillPath = true;
	try {
		const result = await ex(HUNK_BINARY, ["skill", "path"], { timeout: HUNK_SESSION_TIMEOUT_MS });
		if (result.code !== 0) {
			return undefined;
		}
		const path = result.stdout.trim().split("\n").pop()?.trim();
		if (!path || !existsSync(path)) {
			return undefined;
		}
		cachedSkillPath = path;
		return path;
	} catch {
		return undefined;
	}
}

/** Test-only reset so each case resolves fresh. */
export function resetHunkSkillPathForTests(): void {
	cachedSkillPath = undefined;
	resolvedSkillPath = false;
}
