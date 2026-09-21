// ---------------------------------------------------------------------------
// Hunk annotator: mutation batches → inline comment batches + highlights.
//
// The enforcement engine behind /hunk enforce. After each meaningful
// mutation batch (write / edit / apply_patch / mutation-shaped bash), the
// annotator maps the change onto the live Hunk review and leaves bounded,
// file-anchored inline AI annotations automatically.
//
// Annotation content stays mechanical and factual by design (what changed,
// where, operation counts) — the enforced path never invents rationale it
// did not derive from the tool result. The model's own narrative lives in
// the transcript; the review shows the change map.
// ---------------------------------------------------------------------------

import { execHunkSession, hunkCliError, type HunkExec, type HunkSessionPayload } from "./cli.js";
import { applyCommentBatch } from "./tool.js";
import type { CommentBatchItem } from "./cli.js";
import { throwIfAborted } from "./abort.js";

/** One annotated change: the diff file path plus per-file change summary. */
export interface MutationRecord {
	readonly path: string;
	readonly operation: "create" | "modify" | "delete" | "rename";
	/** 1-based new-side line to anchor the comment (best effort). */
	readonly anchorLine?: number;
	/** True when the change came from a bash mutation command (unanchored). */
	readonly fromBash?: boolean;
}

/** Result of one annotate call. */
export interface AnnotateOutcome {
	/** Human summary for the tool_result details / notify. */
	readonly text: string;
	/** Comments actually left. */
	readonly left: number;
	readonly payload?: HunkSessionPayload;
}

export interface AnnotatorOptions {
	readonly maxCommentsPerBatch: number;
}

/** True when any live session matches this repo (cheap probe). */
export async function hasLiveSession(
	ex: HunkExec,
	repo: string,
): Promise<boolean> {
	try {
		const result = await execHunkSession(ex, ["session", "list"], { cwd: repo });
		const payload = result.parsed as { sessions?: Array<{ repoRoot?: string; cwd?: string }> } | undefined;
		const sessions = payload?.sessions;
		if (!Array.isArray(sessions) || sessions.length === 0) return false;
		if (!repo || repo === ".") return true;
		return sessions.some(
			(session) =>
				(session.repoRoot === repo ||
					session.cwd === repo ||
					(typeof session.repoRoot === "string" && repo.startsWith(session.repoRoot)) ||
					(typeof session.cwd === "string" && repo.startsWith(session.cwd))),
		);
	} catch {
		return false;
	}
}

/**
 * Map mutation records to one bounded comment batch, grouped per file with
 * per-operation counts and a best-effort line anchor. Bash-derived changes
 * are left unanchored (file-level comment) because line numbers from a
 * parsed shell command would be guesses.
 */
export function buildMutationComments(
	mutations: readonly MutationRecord[],
	options: AnnotatorOptions,
): CommentBatchItem[] {
	const byPath = new Map<string, MutationRecord[]>();
	for (const mutation of mutations) {
		const list = byPath.get(mutation.path) ?? [];
		list.push(mutation);
		byPath.set(mutation.path, list);
	}

	const comments: CommentBatchItem[] = [];
	for (const [path, records] of byPath) {
		const operations = new Map<string, number>();
		for (const record of records) {
			operations.set(record.operation, (operations.get(record.operation) ?? 0) + 1);
		}
		const summaryParts = [...operations.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([operation, count]) => (count === 1 ? operation : `${operation} ×${count}`));
		const fromBash = records.every((record) => record.fromBash);
		const anchor = fromBash ? undefined : records.find((record) => record.anchorLine !== undefined)?.anchorLine;
		comments.push({
			filePath: path,
			summary: `Agent change: ${summaryParts.join(", ")}`,
			author: "aio",
			...(anchor !== undefined ? { newLine: anchor } : {}),
		});
	}

	// Bounded: newest mutations first win the budget.
	if (comments.length > options.maxCommentsPerBatch) {
		comments.length = options.maxCommentsPerBatch;
	}
	return comments;
}

/** Highlight span for one mutation: the anchor line, word 0..N bounded. */
export interface MutationHighlight {
	readonly filePath: string;
	readonly newLine: number;
	readonly start: number;
	readonly end: number;
}

/** Build highlights for anchored, create/modify mutations (bounded by the same budget). */
export function buildMutationHighlights(
	mutations: readonly MutationRecord[],
	options: AnnotatorOptions,
): MutationHighlight[] {
	const highlights: MutationHighlight[] = [];
	for (const mutation of mutations) {
		if (mutation.fromBash) continue;
		if (mutation.operation !== "create" && mutation.operation !== "modify") continue;
		if (mutation.anchorLine === undefined) continue;
		highlights.push({
			filePath: mutation.path,
			newLine: mutation.anchorLine,
			start: 0,
			end: 1,
		});
		if (highlights.length >= options.maxCommentsPerBatch) break;
	}
	return highlights;
}

/**
 * Annotate one mutation batch on the live review. Best effort: a missing
 * session, a closed review, or a rejected batch degrades to a descriptive
 * outcome — enforcement must never break the mutation flow.
 */
export async function annotateMutations(
	ex: HunkExec,
	mutations: readonly MutationRecord[],
	target: { sessionId?: string; repo?: string },
	options: AnnotatorOptions,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AnnotateOutcome> {
	throwIfAborted(signal);
	if (mutations.length === 0) {
		return { text: "no mutations to annotate", left: 0 };
	}

	const comments = buildMutationComments(mutations, options);
	if (comments.length === 0) {
		return { text: "no comments derived from mutations", left: 0 };
	}

	try {
		const payload = await applyCommentBatch(ex, target, comments, cwd, signal);
		return {
			text: `left ${comments.length} inline annotation(s) on the live review`,
			left: comments.length,
			payload,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if ((error as { kind?: string }).kind === "no_sessions") {
			return { text: "no live Hunk review to annotate (open one with /hunk)", left: 0 };
		}
		return { text: `annotation failed: ${message}`, left: 0 };
	}
}

/** Highlight one mutation on the live review (best effort, never throws). */
export async function highlightMutation(
	ex: HunkExec,
	highlight: MutationHighlight,
	target: { sessionId?: string; repo?: string },
	cwd: string,
): Promise<boolean> {
	const args = [...(target.sessionId ? [target.sessionId] : ["--repo", target.repo ?? "."]), "--file", highlight.filePath, "--new-line", String(highlight.newLine), "--start", String(highlight.start), "--end", String(highlight.end), "--tone", "info", "--quiet"];
	const fullArgs = ["session", "highlight", "add", ...args];
	try {
		const result = await ex("hunk", fullArgs, { cwd, timeout: 10_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

/** True when the annotations reached a live review (session targeting helper). */
export function sessionTargetFor(repo: string): { repo: string } {
	return { repo };
}

// Failure-shaping helper reused by the wiring (no_sessions already shaped in cli).
export { hunkCliError };
