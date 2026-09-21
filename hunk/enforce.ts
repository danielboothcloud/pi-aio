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
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
