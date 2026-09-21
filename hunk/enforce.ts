// ---------------------------------------------------------------------------
// Hunk enforce: automatic inline AI annotations after mutations.
//
// `/hunk enforce` turns ON proactive annotation: after each meaningful
// mutation batch (write / edit / apply_patch / mutation-shaped bash), the
// extension leaves inline comments and highlights on the live Hunk review
// automatically — instead of annotations appearing only when the model
// decides to call the hunk tool. `/hunk enforce off` returns to inert.
//
// The toggle persists per agent dir (aio agent-file pattern, same as
// aio-blocklist.json) and loads tolerant-and-fail-open.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HunkExec } from "./cli.js";

export const HUNK_ENFORCE_FILE_NAME = "aio-hunk-enforce.json";

export interface HunkEnforceState {
	/** Automatic annotation after mutation batches. */
	readonly enforce: boolean;
	/** Max inline comments left per batch (bounded; highlights ride along). */
	readonly maxCommentsPerBatch: number;
	/** Max mutation-shaped bash commands annotated per session. */
	readonly maxBashAnnotations: number;
}

export const DEFAULT_ENFORCE_STATE: HunkEnforceState = {
	enforce: false,
	maxCommentsPerBatch: 6,
	maxBashAnnotations: 12,
};

export function hunkEnforceFilePath(): string {
	return join(getAgentDir(), HUNK_ENFORCE_FILE_NAME);
}

/**
 * Read the persisted enforce state. Tolerant: a missing file or broken JSON
 * yields defaults — the enforce toggle must never break the extension.
 */
export function readHunkEnforceState(file: string = hunkEnforceFilePath()): HunkEnforceState {
	try {
		if (!existsSync(file)) return DEFAULT_ENFORCE_STATE;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return DEFAULT_ENFORCE_STATE;
		}
		const record = parsed as Record<string, unknown>;
		const bool = (value: unknown, fallback: boolean): boolean =>
			typeof value === "boolean" ? value : fallback;
		const boundedInt = (value: unknown, fallback: number): number =>
			typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
				? Math.floor(value)
				: fallback;
		return {
			enforce: bool(record.enforce, DEFAULT_ENFORCE_STATE.enforce),
			maxCommentsPerBatch: boundedInt(record.maxCommentsPerBatch, DEFAULT_ENFORCE_STATE.maxCommentsPerBatch),
			maxBashAnnotations: boundedInt(record.maxBashAnnotations, DEFAULT_ENFORCE_STATE.maxBashAnnotations),
		};
	} catch {
		return DEFAULT_ENFORCE_STATE;
	}
}

/** Persist the enforce state (mode 0600, aio agent-file pattern). */
export function writeHunkEnforceState(state: HunkEnforceState, file: string = hunkEnforceFilePath()): void {
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

// ---- VCS checkout detection ----

/**
 * Hunk reviews VCS changesets (git, jujutsu, sapling — hunk auto-detects
 * all three), so enforce is meaningless outside a checkout: there is no
 * diff to annotate. Enforce stays OFF in a plain directory.
 */
export type VcsKind = "git" | "jj" | "sl" | "none";

const VCS_MARKERS: ReadonlyArray<readonly [marker: string, kind: VcsKind]> = [
	[".jj", "jj"],
	[".sl", "sl"],
	[".git", "git"],
];

/**
 * Marker walk from cwd up to the filesystem root: the primary check for
 * jj/sapling (whose CLIs aio does not assume) and the fallback when the
 * git binary is unavailable. Injected `exists` keeps this pure for tests.
 */
export function detectVcsByMarkers(startDir: string, exists: (filePath: string) => boolean = existsSync): VcsKind {
	let current = resolve(startDir);
	while (true) {
		for (const [marker, kind] of VCS_MARKERS) {
			if (exists(join(current, marker))) return kind;
		}
		const parent = resolve(current, "..");
		if (parent === current) return "none";
		current = parent;
	}
}

/**
 * Detect the VCS kind for a cwd. `git rev-parse --is-inside-work-tree` is
 * authoritative for git (worktrees, subdirectories); markers cover
 * jj/sapling and the git-binary-missing case. A bare repo ("false") and a
 * plain directory both degrade to the marker walk (no .git marker in a
 * bare repo's top level → "none").
 */
export async function detectVcs(ex: HunkExec, cwd: string): Promise<VcsKind> {
	try {
		const result = await ex("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			timeout: 3_000,
		});
		if (result.code === 0 && result.stdout.trim() === "true") {
			return "git";
		}
	} catch {
		// git missing or spawn failure — fall through to markers.
	}
	return detectVcsByMarkers(cwd);
}
