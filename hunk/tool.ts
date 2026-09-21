// ---------------------------------------------------------------------------
// The `hunk` model tool: inline AI annotations and live-review control.
//
// Wraps Hunk's non-interactive `hunk session *` CLI. The TUI is for the
// user; the model inspects the live review, navigates it, adds inline
// comments beside the code, and paints attention marks on exact character
// ranges. This is the upstream recommended agent workflow, made native.
//
// House conventions: StringEnum for enums, throw from execute for error
// results, details on the success result for machine-readable output.
// ---------------------------------------------------------------------------

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	buildCommentAddArgs,
	buildCommentBatch,
	buildHighlightAddArgs,
	buildNavigateArgs,
	buildReloadArgs,
	execHunkSession,
	hunkCliError,
	parseHunkJson,
	type CommentBatchItem,
	type HunkExec,
	type HunkSessionPayload,
} from "./cli.js";
import { throwIfAborted } from "./abort.js";

export const HUNK_ACTIONS = [
	"list",
	"get",
	"context",
	"review",
	"navigate",
	"reload",
	"comment_add",
	"comment_apply",
	"comment_list",
	"comment_rm",
	"comment_clear",
	"highlight_add",
	"highlight_clear",
] as const;

export type HunkAction = (typeof HUNK_ACTIONS)[number];

const COMMENT_TYPES = ["live", "all", "ai", "agent", "user"] as const;
const HIGHLIGHT_TONES = ["match", "info", "warning", "error", "dim", "current"] as const;

const TOOL_DESCRIPTION = `Control a live Hunk terminal diff review: inspect the loaded changeset, navigate the user's viewport, add inline AI annotations beside the code, and paint attention marks on exact ranges.

Hunk is an interactive terminal diff viewer the user opens themselves (with /hunk or \`hunk diff\` in another terminal). The TUI is for the user — never run \`hunk diff\`, \`hunk show\`, or other interactive Hunk commands yourself; use this tool, which talks to the live session through Hunk's local session daemon.

Workflow: start with action "review" to see the file/hunk structure (includePatch only when you truly need raw unified diff text), then "navigate" to line up the user's view, then "comment_add" (or one "comment_apply" batch for several notes) explaining what matters, and "highlight_add" to light up the exact expression while explaining it. Use "comment_list" to find note ids, "comment_rm" for cleanup, and "highlight_clear" when moving to the next topic.

Notes render beside the rows they explain: comments need filePath plus exactly one anchor (oldLine, newLine — 1-based; hunkNumber works too) or replyTo to inherit an existing note's anchor. Highlight offsets are [start, end) in UTF-16 code units into the line text, end exclusive. Use focus sparingly — it actively moves the user's viewport. If no session is running, ask the user to open Hunk first (for example /hunk, which can also /hunk enforce automatic annotations).`;

export const HunkCommentBatchItem = Type.Object({
	filePath: Type.Optional(Type.String({ description: "Diff file path (required unless replyTo is set)." })),
	summary: Type.String({ description: "Plain-text note body (required; the fallback)." }),
	rationale: Type.Optional(Type.String({ description: "Why this matters (shown with the note)." })),
	author: Type.Optional(Type.String({ description: "Author label shown on the note." })),
	markup: Type.Optional(
		Type.String({
			description:
				"Experimental STML note body; only when the session context lists stml in experimentalFeatures.",
		}),
	),
	replyTo: Type.Optional(Type.String({ description: "Note id to reply to (inherits its anchor)." })),
	hunk: Type.Optional(
		Type.String({ description: "Hunk id anchor (alternative to hunkNumber/oldLine/newLine)." }),
	),
	hunkNumber: Type.Optional(Type.Integer({ minimum: 1, description: "1-based hunk anchor." })),
	oldLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line on the old (removed) side." })),
	newLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line on the new (added) side." })),
});

const HunkToolParameters = Type.Object({
	action: StringEnum(HUNK_ACTIONS, {
		description:
			"Session surface to use: inspect (list/get/context/review), navigate, reload, annotate (comment_add/comment_apply/comment_list/comment_rm/comment_clear), or highlight (highlight_add/highlight_clear).",
	}),
	sessionId: Type.Optional(
		Type.String({ description: "Exact live session id; use when multiple sessions share a repo." }),
	),
	repo: Type.Optional(
		Type.String({ description: "Match the live session by loaded repo root (default: current directory)." }),
	),
	includePatch: Type.Optional(
		Type.Boolean({ description: "review only: include raw unified diff text (bounds agent context)." }),
	),
	filePath: Type.Optional(
		Type.String({ description: "Diff file path for navigate/comment/highlight/clear targeting." }),
	),
	hunk: Type.Optional(
		Type.Integer({ minimum: 1, description: "navigate only: 1-based hunk number within filePath." }),
	),
	oldLine: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based line on the old (removed) side of the diff." }),
	),
	newLine: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based line on the new (added) side of the diff." }),
	),
	commentId: Type.Optional(
		Type.String({ description: "navigate/comment_rm only: comment id from comment_list." }),
	),
	nextComment: Type.Optional(
		Type.Boolean({ description: "navigate only: jump to the next annotated hunk." }),
	),
	prevComment: Type.Optional(
		Type.Boolean({ description: "navigate only: jump to the previous annotated hunk." }),
	),
	reloadCommand: Type.Optional(
		StringEnum(["diff", "show"] as const, {
			description: "reload only: replacement review command loaded into the live window.",
		}),
	),
	reloadTarget: Type.Optional(
		Type.String({ description: "reload only: optional ref/revset (e.g. HEAD~1)." }),
	),
	staged: Type.Optional(
		Type.Boolean({ description: "reload only: review staged changes." }),
	),
	excludeUntracked: Type.Optional(
		Type.Boolean({ description: "reload only: hide untracked files in the working-tree review." }),
	),
	pathspec: Type.Optional(
		Type.Array(Type.String(), { description: "reload only: optional pathspec after --." }),
	),
	summary: Type.Optional(
		Type.String({ description: "comment_add only: plain-text note body (required; the fallback)." }),
	),
	rationale: Type.Optional(
		Type.String({ description: "comment_add only: why this matters (shown with the note)." }),
	),
	author: Type.Optional(
		Type.String({ description: "comment_add only: author label shown on the note." }),
	),
	markup: Type.Optional(
		Type.String({
			description:
				"comment_add only: experimental STML note body; only when the session context lists stml in experimentalFeatures.",
		}),
	),
	focus: Type.Optional(
		Type.Boolean({
			description: "comment/highlight only: also move the user's viewport to the note (use sparingly).",
		}),
	),
	replyTo: Type.Optional(
		Type.String({ description: "comment_add/apply only: note id to reply to (inherits its anchor)." }),
	),
	comments: Type.Optional(
		Type.Array(HunkCommentBatchItem, {
			description: "comment_apply only: batch notes applied in one stdin payload.",
		}),
	),
	type: Type.Optional(
		StringEnum(COMMENT_TYPES, {
			description: "comment_list only: filter live/all/ai/agent/user notes.",
		}),
	),
	clearFile: Type.Optional(
		Type.String({ description: "comment_clear only: clear notes for one file." }),
	),
	clearAll: Type.Optional(
		Type.Boolean({ description: "comment_clear only: clear every note including human notes." }),
	),
	includeUser: Type.Optional(
		Type.Boolean({ description: "comment_clear only: also clear human notes on clearFile." }),
	),
	start: Type.Optional(
		Type.Integer({ minimum: 0, description: "highlight_add only: 0-based inclusive offset into the line text." }),
	),
	end: Type.Optional(
		Type.Integer({ minimum: 1, description: "highlight_add only: exclusive end offset (UTF-16 code units)." }),
	),
	tone: Type.Optional(
		StringEnum(HIGHLIGHT_TONES, {
			description: "highlight_add only: mark tone; current renders reverse video for the range under discussion.",
		}),
	),
});

export type HunkToolParams = Static<typeof HunkToolParameters>;

export type HunkToolDetails = {
	readonly action: HunkAction;
	readonly payload: HunkSessionPayload | null;
};

function toolResult(text: string, details: HunkToolDetails): AgentToolResult<HunkToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Exec surface for `sh -c` payloads (comment_apply stdin redirection). */
export type ShExec = (
	command: string,
	args: string[],
	options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export function createHunkTool(pi: ExtensionAPI): ToolDefinition<typeof HunkToolParameters> {
	return {
		name: "hunk",
		label: "Hunk Review",
		description: TOOL_DESCRIPTION,
		promptSnippet:
			"Use to inspect and steer a live Hunk diff review: navigate, add inline AI annotations, and highlight exact code ranges.",
		promptGuidelines: [
			"Start with the review action to see the loaded changeset structure before navigating or annotating.",
			"Leave inline annotations proactively after your mutations: one comment_apply batch per changeset explains what you changed and why (set author to your agent name so notes are attributable in parallel reviews).",
			"When /hunk enforce is ON, aio auto-annotates mutations mechanically (change maps); use the hunk tool for the narrative — intent, risks, and follow-ups.",
			"Use comment_apply with a comments array for several notes at once; comment_add for one-off notes. Use highlight_add --focus to steer the user's eyes while explaining.",
			"The Hunk TUI belongs to the user — never run interactive hunk diff/show commands yourself.",
		],
		parameters: HunkToolParameters,

		async execute(
			_callId: string,
			params: HunkToolParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<HunkToolDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<HunkToolDetails>> {
			throwIfAborted(signal);
			const target = { sessionId: params.sessionId, repo: params.repo };
			const outcome = await runHunkAction((command, args, options) => pi.exec(command, args, options), params, target, ctx.cwd, signal);
			return toolResult(outcome.text, { action: params.action, payload: outcome.payload ?? null });
		},
	};
}

export interface HunkActionOutcome {
	readonly text: string;
	readonly payload?: HunkSessionPayload;
}

export async function runHunkAction(
	ex: HunkExec,
	params: HunkToolParams,
	target: { sessionId?: string; repo?: string },
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<HunkActionOutcome> {
	throwIfAborted(signal);
	switch (params.action) {
		case "list": {
			const result = await execHunkSession(ex, ["session", "list"], { cwd });
			return { text: formatOutcome("Active Hunk sessions", result.parsed), payload: result.parsed };
		}
		case "get": {
			const result = await execHunkSession(ex, sessionTargeted(["session", "get"], target), { cwd });
			return { text: formatOutcome("Session details", result.parsed), payload: result.parsed };
		}
		case "context": {
			const result = await execHunkSession(ex, sessionTargeted(["session", "context"], target), { cwd });
			return { text: formatOutcome("Session context", result.parsed), payload: result.parsed };
		}
		case "review": {
			const args = sessionTargeted(["session", "review"], target);
			if (params.includePatch) args.push("--include-patch");
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Loaded review structure", result.parsed), payload: result.parsed };
		}
		case "navigate": {
			const args = buildNavigateArgs(target, {
				filePath: params.filePath,
				hunk: params.hunk,
				oldLine: params.oldLine,
				newLine: params.newLine,
				commentId: params.commentId,
				nextComment: params.nextComment,
				prevComment: params.prevComment,
			});
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Viewport moved", result.parsed), payload: result.parsed };
		}
		case "reload": {
			if (params.reloadCommand === undefined) {
				throw hunkCliError("failed", "reload requires reloadCommand (diff or show).");
			}
			const args = buildReloadArgs(target, {
				command: params.reloadCommand,
				target: params.reloadTarget,
				staged: params.staged,
				excludeUntracked: params.excludeUntracked,
				pathspec: params.pathspec,
			});
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Session reloaded", result.parsed), payload: result.parsed };
		}
		case "comment_add": {
			if (params.summary === undefined) {
				throw hunkCliError("failed", "comment_add requires summary.");
			}
			const args = buildCommentAddArgs(target, {
				filePath: params.filePath,
				oldLine: params.oldLine,
				newLine: params.newLine,
				replyTo: params.replyTo,
				summary: params.summary,
				rationale: params.rationale,
				author: params.author,
				focus: params.focus,
			});
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Inline annotation added", result.parsed), payload: result.parsed };
		}
		case "comment_apply": {
			if (!params.comments?.length) {
				throw hunkCliError("failed", "comment_apply requires a non-empty comments array.");
			}
			const result = await applyCommentBatch(ex, target, params.comments, cwd, signal);
			return { text: formatOutcome("Inline annotations applied", result), payload: result };
		}
		case "comment_list": {
			const args = sessionTargeted(["session", "comment", "list"], target);
			if (params.filePath !== undefined) args.push("--file", params.filePath);
			if (params.type !== undefined) args.push("--type", params.type);
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Review notes", result.parsed), payload: result.parsed };
		}
		case "comment_rm": {
			if (params.commentId === undefined) {
				throw hunkCliError("failed", "comment_rm requires commentId.");
			}
			const args = [...sessionTargeted(["session", "comment", "rm"], target), params.commentId];
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Review note removed", result.parsed), payload: result.parsed };
		}
		case "comment_clear": {
			const args = sessionTargeted(["session", "comment", "clear"], target);
			if (params.clearAll) {
				args.push("--all");
			} else if (params.clearFile !== undefined) {
				args.push("--file", params.clearFile);
				if (params.includeUser) args.push("--include-user");
			} else {
				throw hunkCliError("failed", "comment_clear requires clearFile or clearAll.");
			}
			args.push("--yes");
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Review notes cleared", result.parsed), payload: result.parsed };
		}
		case "highlight_add": {
			if (params.filePath === undefined || params.start === undefined || params.end === undefined) {
				throw hunkCliError("failed", "highlight_add requires filePath, start, and end.");
			}
			const args = buildHighlightAddArgs(target, {
				filePath: params.filePath,
				oldLine: params.oldLine,
				newLine: params.newLine,
				start: params.start,
				end: params.end,
				tone: params.tone,
				focus: params.focus,
			});
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Attention mark painted", result.parsed), payload: result.parsed };
		}
		case "highlight_clear": {
			const args = sessionTargeted(["session", "highlight", "clear"], target);
			if (params.filePath !== undefined) args.push("--file", params.filePath);
			const result = await execHunkSession(ex, args, { cwd });
			return { text: formatOutcome("Attention marks cleared", result.parsed), payload: result.parsed };
		}
		default:
			throw hunkCliError("failed", `Unsupported hunk action: ${String((params as { action?: unknown }).action)}`);
	}
}

function sessionTargeted(base: string[], target: { sessionId?: string; repo?: string }): string[] {
	if (target.sessionId) {
		return [...base, target.sessionId];
	}
	return [...base, "--repo", target.repo ?? "."];
}

function formatOutcome(title: string, payload: HunkSessionPayload | undefined): string {
	if (payload === undefined) {
		return `${title} (no output).`;
	}
	const inline = JSON.stringify(payload);
	const bounded = inline.length <= 8_000 ? inline : `${inline.slice(0, 8_000)}… [truncated]`;
	return `${title}:\n${bounded}`;
}

/**
 * `comment apply --stdin` reads its batch payload from stdin; the shared
 * exec surface has no stdin, so the batch JSON is written to a mode-0600
 * temp file and redirected through `sh -c` (quoting the hunk args, never
 * the payload).
 */
export async function applyCommentBatch(
	ex: HunkExec,
	target: { sessionId?: string; repo?: string },
	comments: readonly CommentBatchItem[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<HunkSessionPayload> {
	throwIfAborted(signal);
	const payload = buildCommentBatch(comments);
	const { writeFileSync, unlinkSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const file = join(tmpdir(), `aio-hunk-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		const args = sessionTargeted(["session", "comment", "apply"], target);
		const quoted = ["hunk", ...args]
			.map((arg) => (/^[A-Za-z0-9@._/-]+$/.test(arg) ? arg : JSON.stringify(arg)))
			.join(" ");
		const result = await ex("sh", ["-c", `${quoted} < ${JSON.stringify(file)}`], {
			cwd,
			timeout: 15_000,
			...(signal ? { signal } : {}),
		});
		if (result.code !== 0) {
			throw classifyBatchFailure(result.stderr, result.code);
		}
		return parseHunkJson(result.stdout);
	} finally {
		try {
			unlinkSync(file);
		} catch {
			// ignore — best-effort temp cleanup
		}
	}
}

function classifyBatchFailure(stderr: string, code: number): Error {
	const stderrText = stderr.trim();
	if (/no active hunk sessions/i.test(stderrText)) {
		return hunkCliError(
			"no_sessions",
			"No active Hunk sessions. Ask the user to open a review first (for example `hunk diff` in another terminal).",
		);
	}
	return hunkCliError("failed", stderrText || `hunk session comment apply failed (exit ${code}).`);
}
