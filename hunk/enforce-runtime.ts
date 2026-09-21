// ---------------------------------------------------------------------------
// Hunk enforce runtime: tool_result watcher → annotator driver.
//
// Watches mutation tool results (write / edit / apply_patch / mutation-shaped
// bash), maps them onto MutationRecords (reusing yaml-hooks' mutation-path
// extraction — aio already parses these shapes for file.changed), and drives
// the annotator against the live review when enforce is on.
//
// Debounce: annotations for one mutation batch are aggregated over a short
// window (a multi-file apply_patch lands as several tool_results in quick
// succession) and left as one comment batch — one batch per file set, never
// per call. Best effort: enforcement never breaks or delays the mutation
// flow, and never blocks a tool.
// ---------------------------------------------------------------------------

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { HunkExec } from "./cli.js";
import type { MutationRecord, AnnotateOutcome } from "./annotator.js";
import { annotateMutations, buildMutationComments, buildMutationHighlights, hasLiveSession, highlightMutation } from "./annotator.js";
import { detectVcs, type VcsKind } from "./enforce.js";
import { throwIfAborted } from "./abort.js";
import { getToolFileChanges, getChangedPaths, type FileChange } from "../yaml-hooks/tool-paths.js";

const AGGREGATION_WINDOW_MS = 400;

/** Live review state: whether enforce probes found a review to annotate. */
export type LiveReviewState = "unknown" | "available" | "unavailable";

/** Pick a string field (mirrors yaml-hooks' pickString). */
function pickString(...values: unknown[]): string | undefined {
	const value = values.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
	return typeof value === "string" ? value : undefined;
}

/**
 * Parse aio apply_patch's structured `changes` array (which yaml-hooks'
 * extractor deliberately ignores — it reads the unified-diff string). The
 * hunk annotator owns aio's own tool schema, so it parses the structured
 * shape directly: add/update/delete/move with per-file paths.
 */

/**
 * Apply_patch's structured `changes` array maps operation names onto the
 * FileChange union: aio uses add/update/delete/move (Cursor-style).
 */
export function applyPatchStructuredChanges(args: Record<string, unknown>): FileChange[] {
	const raw = args.changes;
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const changes: FileChange[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const path = pickString(record.path, record.movePath);
		if (path === undefined) continue;
		const action = pickString(record.action) ?? "update";
		const fromPath = pickString(record.fromPath);
		if (action === "move" && fromPath !== undefined && fromPath !== path) {
			changes.push({ operation: "rename", fromPath, toPath: path });
		} else if (action === "add") {
			changes.push({ operation: "create", path });
		} else if (action === "delete") {
			changes.push({ operation: "delete", path });
		} else {
			changes.push({ operation: "modify", path });
		}
	}
	return changes;
}

/** Extract anchors from an edit result: EditToolDetails.firstChangedLine. */
function editAnchorFromDetails(details: unknown): number | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const firstChangedLine = (details as { firstChangedLine?: unknown }).firstChangedLine;
	if (typeof firstChangedLine === "number" && Number.isInteger(firstChangedLine) && firstChangedLine >= 1) {
		return firstChangedLine;
	}
	return undefined;
}

/** Extract an anchor for apply_patch from per-file change metadata (best effort). */
function patchAnchorFromContent(content: ReadonlyArray<{ type: string; text?: string }>): number | undefined {
	const text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
	// aio's apply_patch reports change counts, not line numbers; keep the
	// comment file-anchored (no line guess).
	void text;
	return undefined;
}

/**
 * Map one tool_result onto MutationRecords. Anchor precision:
 *   edit — EditToolDetails.firstChangedLine (authoritative)
 *   write — line 1 (new file or overwrite starts at the top)
 *   apply_patch — file-anchored (aio reports counts, not lines)
 *   bash — unanchored (parsed shell command lines would be guesses)
 */
export function mutationsFromToolResult(event: ToolResultEvent): MutationRecord[] {
	if (event.isError) return [];

	const args = (event.input ?? {}) as Record<string, unknown>;
	const structured = applyPatchStructuredChanges(args);
	const isPatch = event.toolName === "apply_patch" || event.toolName === "patch";
	const changes = isPatch && structured.length > 0 ? structured : getToolFileChanges(event.toolName, args);
	if (changes.length === 0) return [];

	const paths = getChangedPaths(changes);
	const anchor = (() => {
		if (event.toolName === "edit") return editAnchorFromDetails(event.details);
		if (event.toolName === "write") return 1;
		if (event.toolName === "apply_patch" || event.toolName === "patch") return patchAnchorFromContent(event.content);
		return undefined;
	})();

	return paths.map((path) => {
		const operation = changes.find((change) =>
			change.operation === "rename"
				? change.fromPath === path || change.toPath === path
				: change.path === path,
		)?.operation ?? "modify";
		const record: MutationRecord = { path, operation };
		if (anchor !== undefined) {
			return { ...record, anchorLine: anchor };
		}
		return record;
	});
}

/** True when the tool is a mutation-shaped bash call aio's extractor parsed. */
export function isBashMutation(event: ToolResultEvent): boolean {
	if (event.isError || event.toolName !== "bash") return false;
	return getToolFileChanges("bash", (event.input ?? {}) as Record<string, unknown>).length > 0;
}

/** Map a bash mutation onto unanchored records (file-level comments). */
export function bashMutationsFromToolResult(event: ToolResultEvent): MutationRecord[] {
	if (!isBashMutation(event)) return [];
	const changes = getToolFileChanges("bash", (event.input ?? {}) as Record<string, unknown>);
	return getChangedPaths(changes).map((path) => {
		const operation = changes.find((change) =>
			change.operation === "rename"
				? change.fromPath === path || change.toPath === path
				: change.path === path,
		)?.operation ?? "modify";
		return { path, operation, fromBash: true };
	});
}

export interface EnforceRuntimeOptions {
	readonly maxCommentsPerBatch: number;
	readonly maxBashAnnotations: number;
	readonly windowMs?: number;
}

/** Debounced enforce driver. One instance per extension load. */
export class EnforceRuntime {
	private readonly pending: MutationRecord[] = [];
	private timer: NodeJS.Timeout | undefined;
	private bashAnnotationCount = 0;
	private inFlight = false;

	constructor(
		private readonly ex: HunkExec,
		private readonly options: EnforceRuntimeOptions,
	) {}

	/** Live review probe cache (refreshed before each queue). */
	private liveReviewState: LiveReviewState = "unknown";

	/** VCS checkout cache: enforce only runs inside a hunk-supported checkout. */
	private vcsState: "unknown" | "available" | "unavailable" = "unknown";
	private vcsKind: VcsKind | undefined;

	/** Detected VCS kind for the last-probed cwd (status output). */
	get currentVcsKind(): VcsKind | undefined {
		return this.vcsKind;
	}

	/** True when the cwd probe found a hunk-supported VCS checkout. */
	get vcsReady(): boolean {
		return this.vcsState === "available";
	}

	/** True when the enforce budget for bash annotations is spent. */
	get bashBudgetSpent(): boolean {
		return this.bashAnnotationCount >= this.options.maxBashAnnotations;
	}

	/** Pending (unflushed) mutation count — for tests and diagnostics. */
	get pendingCount(): number {
		return this.pending.length;
	}

	/**
	 * Queue a mutation batch and schedule the debounced flush. Two gates run
	 * before queueing (both cached per cwd until clear()):
	 *
	 *   1. VCS checkout — hunk reviews VCS changesets, so enforce is always
			 OFF in a plain directory (no diff exists to annotate).
	 *   2. live review — annotation must stay invisible when no review is
			 open; enforcement never opens windows on its own.
	 */
	async queue(mutations: readonly MutationRecord[], target: { sessionId?: string; repo?: string }, cwd: string, signal: AbortSignal | undefined, onOutcome?: (outcome: AnnotateOutcome) => void): Promise<void> {
		if (mutations.length === 0) return;
		if (this.vcsState === "unknown") {
			this.vcsKind = await detectVcs(this.ex, cwd);
			this.vcsState = this.vcsKind === "none" ? "unavailable" : "available";
		}
		if (this.vcsState !== "available") return;
		if (this.liveReviewState !== "available") {
			this.liveReviewState = (await liveReviewAvailable(this.ex, cwd)) ? "available" : "unavailable";
		}
		if (this.liveReviewState !== "available") return;

		for (const mutation of mutations) {
			if (mutation.fromBash && this.bashBudgetSpent) continue;
			if (mutation.fromBash) this.bashAnnotationCount += 1;
			this.pending.push(mutation);
		}
		if (this.pending.length === 0) return;

		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		const windowMs = this.options.windowMs ?? AGGREGATION_WINDOW_MS;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush(target, cwd, signal, onOutcome);
		}, windowMs);
		this.timer.unref?.();
	}

	/** Flush pending mutations as one annotation batch (best effort). */
	async flush(target: { sessionId?: string; repo?: string }, cwd: string, signal: AbortSignal | undefined, onOutcome?: (outcome: AnnotateOutcome) => void): Promise<AnnotateOutcome> {
		if (this.inFlight) {
			// A flush is already running; the next queued batch will flush.
			return { text: "annotation batch already in flight", left: 0 };
		}
		const batch = this.pending.splice(0, this.pending.length);
		if (batch.length === 0) {
			return { text: "no pending mutations", left: 0 };
		}

		this.inFlight = true;
		try {
			const options = { maxCommentsPerBatch: this.options.maxCommentsPerBatch };
			const outcome = await annotateMutations(this.ex, batch, target, options, cwd, signal);
			// Highlights ride along for anchored create/modify changes (best
			// effort, never blocking the comment batch).
			if (outcome.left > 0) {
				const highlights = buildMutationHighlights(batch, options);
				for (const highlight of highlights) {
					void highlightMutation(this.ex, highlight, target, cwd);
				}
			}
			onOutcome?.(outcome);
			return outcome;
		} finally {
			this.inFlight = false;
		}
	}

	/** Drop pending mutations (session switch / shutdown). */
	clear(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending.length = 0;
		// Reset both probe caches: a review may have opened or closed, and the
		// cwd may have moved in or out of a VCS checkout since.
		this.liveReviewState = "unknown";
		this.vcsState = "unknown";
		this.vcsKind = undefined;
	}
}

/** Cheap live-session probe the wiring uses before queueing (best effort). */
export async function liveReviewAvailable(ex: HunkExec, repo: string): Promise<boolean> {
	throwIfAborted(undefined);
	return hasLiveSession(ex, repo);
}

// Re-exports for tests (single import surface).
export { buildMutationComments };
