// ---------------------------------------------------------------------------
// aio tuicr integration, core: tuicr CLI capture, comment collection, and
// the editor-prefill formatting.
//
// Ported from @joelazar/pi-tuicr 1.1.0 (MIT, joelazar — see UPSTREAM.md and
// LICENSE). `/tuicr` (or ctrl+shift+r) asks what to review, suspends pi's
// TUI, and opens tuicr on that diff in the foreground. When tuicr exits,
// comments created during that session are collected, numbered, and
// prefilled into the editor so they can be sent back to the agent.
//
// Every exec goes through the `Capture` seam so tests inject fakes and
// never shell out to a live tuicr or git binary.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

export const TUICR_COMMAND = "tuicr";

/** A tuicr review session as reported by `tuicr review list --all`. */
export interface TuicrSession {
	path: string;
	comment_count: number;
}

/** A review comment as reported by `tuicr review comments --session <path>`. */
export interface TuicrComment {
	id: string;
	location?: string;
	path?: string;
	comment_type?: string;
	content: string;
}

/**
 * The exec seam: run a command and return trimmed stdout, or null when the
 * command cannot run or exits non-zero (missing tuicr, unknown ref). The
 * probe semantics both callers want; output that does run is trusted.
 */
export type Capture = (command: string, args: string[], cwd: string) => string | null;

/** Production seam: execFileSync with stderr discarded. */
export function captureSync(command: string, args: string[], cwd: string): string | null {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/** Run a git command through the capture seam. */
export function git(cwd: string, args: string[], capture: Capture): string | null {
	return capture("git", args, cwd);
}

/** Run a tuicr subcommand that prints a JSON array. */
export function tuicrJson<T>(cwd: string, args: string[], capture: Capture): T[] {
	const out = capture(TUICR_COMMAND, args, cwd);
	if (out === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${TUICR_COMMAND} ${args.join(" ")} printed malformed JSON: ${message}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`${TUICR_COMMAND} ${args.join(" ")} did not print a JSON array`);
	}
	return parsed as T[];
}

/** Every comment currently stored in tuicr for this checkout. */
export function allComments(cwd: string, capture: Capture): TuicrComment[] {
	return tuicrJson<TuicrSession>(cwd, ["review", "list", "--all"], capture)
		.filter((session) => session.comment_count > 0)
		.flatMap((session) =>
			tuicrJson<TuicrComment>(cwd, ["review", "comments", "--session", session.path], capture),
		);
}

/**
 * Best guess at the branch this work forked from: origin/HEAD's target,
 * then the usual main/master suspects. Skips the current branch itself and
 * returns null when nothing verifies (those picker entries stay hidden).
 */
export function baseBranch(cwd: string, capture: Capture): string | null {
	const head = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], capture);
	const candidates = [
		...(head ? [head] : []),
		"origin/main",
		"origin/master",
		"main",
		"master",
	];
	const current = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], capture);
	for (const ref of candidates) {
		if (ref === current) continue;
		if (git(cwd, ["rev-parse", "--verify", "--quiet", ref], capture)) return ref;
	}
	return null;
}

/** Format fresh comments as the numbered editor prefill. */
export function format(comments: TuicrComment[]): string {
	const lines = comments.map((comment, index) => {
		const anchor = comment.location ?? comment.path;
		const type =
			comment.comment_type && comment.comment_type !== "none"
				? ` [${comment.comment_type.toUpperCase()}]`
				: "";
		const body = comment.content.trim().replace(/\n+/g, " ");
		return anchor
			? `${index + 1}. \`${anchor}\`${type} - ${body}`
			: `${index + 1}.${type} - ${body}`;
	});

	return [
		"I reviewed your changes. Please address these comments:",
		"",
		...lines,
	].join("\n");
}
