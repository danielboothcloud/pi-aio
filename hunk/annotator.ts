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
import { relative, isAbsolute } from "node:path";

/** One annotated change: the diff file path plus per-file change summary. */
export interface MutationRecord {
	readonly path: string;
	readonly operation: "create" | "modify" | "delete" | "rename";
	/** 1-based line to anchor the comment (best effort). */
	readonly anchorLine?: number;
	/** Which diff side the anchor sits on (new-side by default). */
	readonly anchorSide?: "old" | "new";
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

// ---- anchor resolution ----

/** First anchorable line per diff file: newSide for edits/creates, oldSide for pure deletions. */
export interface DiffAnchor {
	readonly newLine?: number;
	readonly oldLine?: number;
}

/**
 * Parse `git diff --unified=0` output into per-file anchors: the first
 * hunk with new-side content gives newLine; a file whose hunks are all
 * pure deletions anchors on the old side instead. Hunk comments require
 * exactly one of oldLine/newLine, so bash-derived and patch-derived
 * mutations must resolve to a line before they can be annotated.
 */
export function parseGitDiffAnchors(diffText: string): Map<string, DiffAnchor> {
	const anchors = new Map<string, DiffAnchor>();
	let currentFile: string | undefined;
	let anchor: { newLine?: number; oldLine?: number } | undefined;

	const flush = (): void => {
		if (currentFile !== undefined && anchor !== undefined) {
			anchors.set(currentFile, anchor);
		}
	};

	for (const line of diffText.split("\n")) {
		const gitLine = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
		if (gitLine) {
			flush();
			currentFile = gitLine[2];
			anchor = undefined;
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && currentFile !== undefined) {
			const newStart = Number.parseInt(hunk[1] ?? "0", 10);
			const newCount = hunk[2] !== undefined ? Number.parseInt(hunk[2], 10) : 1;
			anchor ??= {};
			if (newCount > 0 && anchor.newLine === undefined) {
				anchor.newLine = newStart;
			} else if (newCount === 0 && anchor.newLine === undefined && anchor.oldLine === undefined) {
				// Pure-deletion hunk: the new-side start is the line AFTER the
				// deletion; hunk anchors comments on the old side there.
				const oldMatch = /^@@ -(\d+)/.exec(line);
				anchor.oldLine = Math.max(1, Number.parseInt(oldMatch?.[1] ?? "1", 10));
			}
		}
	}
	flush();
	return anchors;
}

/** Normalize a mutation path against the cwd git runs in (absolute → relative). */
function mutationPathRelativeTo(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	return rel.startsWith("..") ? path : rel;
}

/** Match a diff-header path (repo-root relative) onto a normalized mutation path. */
function headerMatchesPath(headerPath: string, normalizedPath: string): boolean {
	return normalizedPath === headerPath || normalizedPath.endsWith(`/${headerPath}`);
}

/**
 * Resolve anchors for unanchored mutations with one `git diff HEAD -U0`
 * call over the whole batch (working tree + index vs HEAD). Records that
 * stay unanchored are dropped: Hunk validates that every comment item
 * carries exactly one of hunk/hunkNumber/oldLine/newLine, and one invalid
 * item fails the entire batch. Anchored records pass through untouched.
 */
export async function resolveMutationAnchors(
	ex: HunkExec,
	mutations: readonly MutationRecord[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<MutationRecord[]> {
	const unanchored = mutations.filter((mutation) => mutation.anchorLine === undefined);
	if (unanchored.length === 0) return [...mutations];
	throwIfAborted(signal);

	const pathspecs = [...new Set(unanchored.map((mutation) => mutationPathRelativeTo(mutation.path, cwd)))];
	let diffText: string;
	try {
		const result = await ex("git", ["diff", "HEAD", "--unified=0", "--", ...pathspecs], {
			cwd,
			timeout: 5_000,
			...(signal ? { signal } : {}),
		});
		if (result.code !== 0) return mutations.filter((mutation) => mutation.anchorLine !== undefined);
		diffText = result.stdout;
	} catch {
		return mutations.filter((mutation) => mutation.anchorLine !== undefined);
	}

	const anchors = parseGitDiffAnchors(diffText);
	return mutations.flatMap((mutation): MutationRecord[] => {
		if (mutation.anchorLine !== undefined) return [mutation];
		const normalized = mutationPathRelativeTo(mutation.path, cwd);
		const hit = [...anchors.entries()].find(([headerPath]) => headerMatchesPath(headerPath, normalized));
		if (!hit) return [];
		const anchor = hit[1];
		if (mutation.operation === "delete") {
			if (anchor.oldLine === undefined) return [];
			return [{ ...mutation, anchorLine: anchor.oldLine, anchorSide: "old" }];
		}
		if (anchor.newLine !== undefined) {
			return [{ ...mutation, anchorLine: anchor.newLine, anchorSide: "new" }];
		}
		if (anchor.oldLine !== undefined) {
			return [{ ...mutation, anchorLine: anchor.oldLine, anchorSide: "old" }];
		}
		return [];
	});
}

/**
 * Map resolved mutation records to one bounded comment batch, grouped per
 * file with per-operation counts. Every item carries exactly one anchor
 * (oldLine or newLine) — Hunk rejects any batch containing a target-less
 * item. Callers must run resolveMutationAnchors first; unanchored records
 * are dropped here as a final guard.
 */
export function buildMutationComments(
	mutations: readonly MutationRecord[],
	options: AnnotatorOptions,
): CommentBatchItem[] {
	const byPath = new Map<string, MutationRecord[]>();
	for (const mutation of mutations) {
		if (mutation.anchorLine === undefined) continue;
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
		// One comment per file; anchor from the first record that has one.
		// byPath only stores anchored records, but narrow explicitly so the
		// compiler sees the line number too.
		const anchored = records.find((record) => record.anchorLine !== undefined);
		if (anchored === undefined || anchored.anchorLine === undefined) continue;
		const anchorLine = anchored.anchorLine;
		comments.push({
			filePath: path,
			summary: `Agent change: ${summaryParts.join(", ")}`,
			author: "aio",
			...(anchored.anchorSide === "old" ? { oldLine: anchorLine } : { newLine: anchorLine }),
		});
	}

	// Bounded: newest mutations first win the budget.
	if (comments.length > options.maxCommentsPerBatch) {
		comments.length = options.maxCommentsPerBatch;
	}
	return comments;
}
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
		if (mutation.operation !== "create" && mutation.operation !== "modify") continue;
		if (mutation.anchorLine === undefined || mutation.anchorSide === "old") continue;
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

	// Hunk requires every comment to sit on a line: resolve anchors from
	// the working-tree diff first, dropping mutations that stay unanchored.
	const resolved = await resolveMutationAnchors(ex, mutations, cwd, signal);
	const comments = buildMutationComments(resolved, options);
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
