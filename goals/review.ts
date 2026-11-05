/**
 * goals — one isolated review call that checks a goal_done claim.
 *
 * Never throws: infrastructure failures come back as `error`, never as a
 * verdict. Tests inject the complete and exec seams directly.
 */

import { buildFlowDigest } from "../btw/context.js";
import { textFromContent } from "../btw/engine.js";
import { type Goal, parseReview, REVIEW_SYSTEM_PROMPT, reviewPrompt, type ReviewVerdict } from "./core.js";

export const REVIEW_TRANSCRIPT_CHARS = 16_000;
export const REVIEW_TRANSCRIPT_MESSAGES = 60;
const WORKSPACE_LINES = 60;
const GIT_TIMEOUT_MS = 5_000;

export type ReviewCompleteFn = (
	model: unknown,
	context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options?: { signal?: AbortSignal },
) => Promise<{ content: Array<Record<string, unknown>>; stopReason: string; errorMessage?: string }>;

export type ReviewExecFn = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; code: number }>;

export type ReviewOutcome = ReviewVerdict | { error: string };

function capLines(text: string, max: number): string {
	const lines = text.trimEnd().split("\n");
	if (lines.length <= max) return lines.join("\n");
	return [...lines.slice(0, max), `…[${lines.length - max} more lines]`].join("\n");
}

/** `git status --short` plus `git diff --stat`, bounded; never throws. */
export async function workspaceSummary(exec: ReviewExecFn, cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		const status = await exec("git", ["status", "--short"], { cwd, timeout: GIT_TIMEOUT_MS, signal });
		if (status.code !== 0) return "(not a git repository)";
		const diff = await exec("git", ["diff", "--stat", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS, signal });
		const parts = [`git status --short:\n${capLines(status.stdout, WORKSPACE_LINES) || "(clean)"}`];
		if (diff.code === 0 && diff.stdout.trim()) parts.push(`git diff --stat HEAD:\n${capLines(diff.stdout, WORKSPACE_LINES)}`);
		return parts.join("\n\n");
	} catch {
		return "(git unavailable)";
	}
}

export async function reviewGoal(options: {
	goal: Goal;
	summary: string;
	branch: readonly unknown[];
	cwd: string;
	model: unknown;
	complete: ReviewCompleteFn;
	exec: ReviewExecFn;
	signal?: AbortSignal;
}): Promise<ReviewOutcome> {
	if (!options.model) return { error: "no session model is selected" };
	try {
		const transcript = buildFlowDigest(options.branch, {
			maxChars: REVIEW_TRANSCRIPT_CHARS,
			maxMessages: REVIEW_TRANSCRIPT_MESSAGES,
		});
		const workspace = await workspaceSummary(options.exec, options.cwd, options.signal);
		const response = await options.complete(
			options.model,
			{
				systemPrompt: REVIEW_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: reviewPrompt({ goal: options.goal, summary: options.summary, transcript, workspace }),
						timestamp: Date.now(),
					},
				],
			},
			{ signal: options.signal },
		);
		if (options.signal?.aborted || response.stopReason === "aborted") return { error: "the review was aborted" };
		if (response.stopReason === "error") return { error: response.errorMessage || "the review call failed" };
		const verdict = parseReview(textFromContent(response.content));
		return verdict ?? { error: "the review reply had no APPROVED or REJECTED verdict" };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
