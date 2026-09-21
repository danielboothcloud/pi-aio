// ---------------------------------------------------------------------------
// hunk session CLI helpers.
//
// Wraps Hunk's non-interactive `hunk session *` surface (through the local
// loopback daemon) so the model can inspect a live review, navigate it, and
// leave inline AI annotations. Hunk's TUI commands are interactive and are
// NEVER run here — they belong to the user's terminal (see the bundled
// hunk-review skill).
// ---------------------------------------------------------------------------

export const HUNK_BINARY = "hunk";
export const HUNK_SESSION_TIMEOUT_MS = 10_000;

export interface HunkExec {
	(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
}

export interface HunkCliError extends Error {
	readonly kind: "not_found" | "no_sessions" | "multiple_sessions" | "failed";
	readonly stderrText?: string;
}

export function hunkCliError(kind: HunkCliError["kind"], message: string, stderrText?: string): HunkCliError {
	return Object.assign(new Error(message), {
		kind,
		...(stderrText !== undefined ? { stderrText } : {}),
	}) as HunkCliError;
}

/**
 * Run a `hunk session *` command and parse its JSON output.
 * `--json` is appended when absent; commands that do not take `--json`
 * (comment rm/clear, highlight clear) are detected by the caller passing
 * `json: false`.
 */
export async function execHunkSession(
	ex: HunkExec,
	args: string[],
	options: { cwd?: string; timeout?: number; json?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string; parsed?: HunkSessionPayload }> {
	const json = options.json ?? true;
	const finalArgs = json && !args.includes("--json") ? [...args, "--json"] : args;
	const result = await ex(HUNK_BINARY, finalArgs, {
		timeout: options.timeout ?? HUNK_SESSION_TIMEOUT_MS,
		cwd: options.cwd,
	});

	if (result.code !== 0) {
		throw classifyHunkSessionFailure(finalArgs, result.stderr, result.code);
	}

	if (!json) {
		return { code: result.code, stdout: result.stdout, stderr: result.stderr };
	}
	return {
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
		parsed: parseHunkJson(result.stdout),
	};
}

/** Named domain type for parsed session CLI output. */
export type HunkSessionPayload = HunkPayloadValue;
/**
 * Runtime parse of session CLI stdout into the payload domain. Some session
 * subcommands print human text even with --json; those degrade to a raw-text
 * payload so the tool result still shows something useful.
 */
export type HunkPayloadValue =
	| string
	| number
	| boolean
	| null
	| HunkPayloadValue[]
	| { readonly [key: string]: HunkPayloadValue };

export function parseHunkJson(stdout: string): HunkSessionPayload {
	const text = stdout.trim();
	if (!text) {
		return { raw: "" };
	}
	try {
		return JSON.parse(text) as HunkSessionPayload;
	} catch {
		return { raw: text };
	}
}

function classifyHunkSessionFailure(args: string[], stderr: string, code: number): HunkCliError {
	const stderrText = stderr.trim();
	const combined = `${args.join(" ")} ${stderrText}`;
	if (/command not found|No such file/i.test(combined) || code === 127) {
		return hunkCliError("not_found", "The hunk binary is not installed or not on $PATH.");
	}
	if (/no active hunk sessions/i.test(stderrText)) {
		return hunkCliError(
			"no_sessions",
			"No active Hunk sessions. Ask the user to open a review first (for example `hunk diff` in another terminal).",
		);
	}
	if (/multiple active sessions match/i.test(stderrText)) {
		return hunkCliError(
			"multiple_sessions",
			"Multiple active sessions match; pass an explicit sessionId to select one.",
		);
	}
	return hunkCliError("failed", stderrText || `hunk session command failed (exit ${code}).`, stderrText || undefined);
}

// ---- arg builders (pure; unit-tested) ----

/** Resolve session targeting: explicit id wins, then --repo, else repo ".". */
export function sessionTargetArgs(
	args: string[],
	target: { sessionId?: string; repo?: string },
): string[] {
	if (target.sessionId) {
		return [...args, target.sessionId];
	}
	return [...args, "--repo", target.repo ?? "."];
}

export interface CommentBatchItem {
	readonly filePath?: string;
	readonly summary: string;
	readonly rationale?: string;
	readonly author?: string;
	readonly markup?: string;
	readonly replyTo?: string;
	readonly hunk?: string;
	readonly hunkNumber?: number;
	readonly oldLine?: number;
	readonly newLine?: number;
}

/**
 * Build the `comment apply` batch payload. Every item needs `summary` plus
 * either `replyTo` by itself, or `filePath` with exactly one of
 * hunk / hunkNumber / oldLine / newLine. Hunk validates the whole batch
 * before mutating the session.
 */
export function buildCommentBatch(comments: readonly CommentBatchItem[]): string {
	const items = comments.map((comment) => {
		const out: Record<string, unknown> = { summary: comment.summary };
		if (comment.filePath !== undefined) out.filePath = comment.filePath;
		if (comment.rationale !== undefined) out.rationale = comment.rationale;
		if (comment.author !== undefined) out.author = comment.author;
		if (comment.markup !== undefined) out.markup = comment.markup;
		if (comment.replyTo !== undefined) out.replyTo = comment.replyTo;
		if (comment.hunk !== undefined) out.hunk = comment.hunk;
		if (comment.hunkNumber !== undefined) out.hunkNumber = comment.hunkNumber;
		if (comment.oldLine !== undefined) out.oldLine = comment.oldLine;
		if (comment.newLine !== undefined) out.newLine = comment.newLine;
		return out;
	});
	return JSON.stringify({ comments: items });
}

/** Build `session comment add` args from a structured note. */
export function buildCommentAddArgs(
	target: { sessionId?: string; repo?: string },
	note: {
		filePath?: string;
		oldLine?: number;
		newLine?: number;
		replyTo?: string;
		summary: string;
		rationale?: string;
		author?: string;
		focus?: boolean;
	},
): string[] {
	const args = sessionTargetArgs(["session", "comment", "add"], target);
	if (note.replyTo !== undefined) {
		args.push("--reply-to", note.replyTo);
	} else {
		if (note.filePath === undefined) {
			throw hunkCliError("failed", "comment add requires filePath (or replyTo for replies).");
		}
		args.push("--file", note.filePath);
		const targetCount = [note.oldLine, note.newLine].filter((value) => value !== undefined).length;
		if (targetCount !== 1) {
			throw hunkCliError("failed", "comment add requires exactly one of oldLine or newLine.");
		}
		if (note.oldLine !== undefined) {
			args.push("--old-line", String(note.oldLine));
		} else {
			args.push("--new-line", String(note.newLine));
		}
	}
	args.push("--summary", note.summary);
	if (note.rationale !== undefined) args.push("--rationale", note.rationale);
	if (note.author !== undefined) args.push("--author", note.author);
	if (note.focus) args.push("--focus");
	return args;
}

/** Build `session highlight add` args; offsets are [start, end) UTF-16 units. */
export function buildHighlightAddArgs(
	target: { sessionId?: string; repo?: string },
	mark: {
		filePath: string;
		oldLine?: number;
		newLine?: number;
		start: number;
		end: number;
		tone?: "match" | "info" | "warning" | "error" | "dim" | "current";
		focus?: boolean;
	},
): string[] {
	if (mark.end <= mark.start) {
		throw hunkCliError("failed", "Highlight end must be greater than start.");
	}
	if (mark.oldLine === undefined && mark.newLine === undefined) {
		throw hunkCliError("failed", "highlight add requires exactly one of oldLine or newLine.");
	}
	const args = sessionTargetArgs(["session", "highlight", "add"], target);
	args.push("--file", mark.filePath);
	if (mark.oldLine !== undefined) {
		args.push("--old-line", String(mark.oldLine));
	} else if (mark.newLine !== undefined) {
		args.push("--new-line", String(mark.newLine));
	} else {
		throw hunkCliError("failed", "highlight add requires exactly one of oldLine or newLine.");
	}
	args.push("--start", String(mark.start), "--end", String(mark.end));
	if (mark.tone !== undefined) args.push("--tone", mark.tone);
	if (mark.focus) args.push("--focus");
	return args;
}

/** Build `session navigate` args; requires --file plus exactly one target. */
export function buildNavigateArgs(
	target: { sessionId?: string; repo?: string },
	nav: {
		filePath?: string;
		hunk?: number;
		oldLine?: number;
		newLine?: number;
		commentId?: string;
		nextComment?: boolean;
		prevComment?: boolean;
	},
): string[] {
	if (nav.commentId !== undefined) {
		return [...sessionTargetArgs(["session", "navigate"], target), "--comment", nav.commentId];
	}
	if (nav.nextComment && nav.prevComment) {
		throw hunkCliError("failed", "Specify either nextComment or prevComment, not both.");
	}
	if (nav.nextComment) {
		return [...sessionTargetArgs(["session", "navigate"], target), "--next-comment"];
	}
	if (nav.prevComment) {
		return [...sessionTargetArgs(["session", "navigate"], target), "--prev-comment"];
	}
	if (nav.filePath === undefined) {
		throw hunkCliError("failed", "navigate requires filePath plus exactly one of hunk, oldLine, or newLine.");
	}
	const targets = [nav.hunk, nav.oldLine, nav.newLine].filter((value) => value !== undefined);
	if (targets.length !== 1) {
		throw hunkCliError("failed", "navigate requires exactly one of hunk, oldLine, or newLine.");
	}
	const args = sessionTargetArgs(["session", "navigate"], target);
	args.push("--file", nav.filePath);
	if (nav.hunk !== undefined) args.push("--hunk", String(nav.hunk));
	if (nav.oldLine !== undefined) args.push("--old-line", String(nav.oldLine));
	if (nav.newLine !== undefined) args.push("--new-line", String(nav.newLine));
	return args;
}

/**
 * Build `session reload` args. The replacement review command always comes
 * after `--` and must be one of Hunk's non-interactive review commands.
 */
export function buildReloadArgs(
	target: { sessionId?: string; repo?: string; sessionPath?: string },
	reload: {
		command: "diff" | "show";
		target?: string;
		staged?: boolean;
		excludeUntracked?: boolean;
		pathspec?: readonly string[];
	},
): string[] {
	let selector: string[];
	if (target.sessionPath) {
		selector = ["--session-path", target.sessionPath];
	} else if (target.sessionId) {
		selector = [target.sessionId];
	} else {
		selector = ["--repo", target.repo ?? "."];
	}
	const args = ["session", "reload", ...selector, "--"];
	args.push(reload.command);
	if (reload.target !== undefined) args.push(reload.target);
	if (reload.staged) args.push("--staged");
	if (reload.excludeUntracked) args.push("--exclude-untracked");
	if (reload.pathspec?.length) {
		args.push("--", ...reload.pathspec);
	}
	return args;
}

/** True when a parsed `session review` descriptor has no files loaded. */
export function isReviewEmpty(review: unknown): boolean {
	if (typeof review !== "object" || review === null) return true;
	const record = review as Record<string, unknown>;
	const files = record.files;
	if (!Array.isArray(files)) return true;
	return files.length === 0;
}
