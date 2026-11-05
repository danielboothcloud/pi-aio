/**
 * goals — pure state, prompts, and parsing for the /goal loop.
 *
 * A goal is bound to the session: its state is a custom session entry
 * (`aio-goal`), the newest one in the session file wins, and nothing is
 * read from or written to the project directory.
 */

export const GOAL_STATE_ENTRY = "aio-goal";
export const GOAL_MESSAGE_TYPE = "aio-goal-message";
export const GOAL_STATUS_KEY = "aio-goal";

/** Automatic continuations before the loop pauses (reset by /goal resume). */
export const MAX_CONTINUATIONS = 50;
/** Consecutive review rejections before the loop pauses. */
export const MAX_REJECTIONS = 3;

export type GoalStatus = "active" | "paused" | "done";

export interface Goal {
	id: string;
	objective: string;
	doneWhen: string;
	status: GoalStatus;
	/** Automatic continuations since the goal started or last resumed. */
	continuations: number;
	/** Consecutive review rejections. */
	rejections: number;
	pauseReason?: string;
	/** The agent's completion summary once the review approved it. */
	summary?: string;
	/** The latest review reason (approved or rejected). */
	lastReview?: string;
	createdAt: string;
	updatedAt: string;
}

export interface GoalStateData {
	goal: Goal | null;
}

export type GoalMessageKind = "draft" | "continue";

export interface GoalMessageDetails {
	kind: GoalMessageKind;
	text: string;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function newGoal(objective: string, doneWhen: string): Goal {
	const at = nowIso();
	return {
		id: `g-${Date.now().toString(36)}`,
		objective,
		doneWhen,
		status: "active",
		continuations: 0,
		rejections: 0,
		createdAt: at,
		updatedAt: at,
	};
}

function isGoal(value: unknown): value is Goal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Record<string, unknown>;
	return (
		typeof goal.id === "string" &&
		typeof goal.objective === "string" &&
		typeof goal.doneWhen === "string" &&
		(goal.status === "active" || goal.status === "paused" || goal.status === "done") &&
		typeof goal.continuations === "number" &&
		typeof goal.rejections === "number"
	);
}

/** The newest goal state in the session file; `null` when none or cleared. */
export function latestGoal(entries: ReadonlyArray<unknown>): Goal | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { goal?: unknown } };
		if (entry?.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
		const goal = entry.data?.goal;
		return isGoal(goal) ? { ...goal } : null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export type GoalCommand =
	| { kind: "status" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "cancel" }
	| { kind: "start"; text: string };

export const GOAL_SUBCOMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "status", description: "show the current goal" },
	{ name: "pause", description: "stop the loop" },
	{ name: "resume", description: "start the loop again" },
	{ name: "cancel", description: "drop the current goal" },
	{ name: "clear", description: "drop the current goal" },
];

/** A single exact subcommand word routes; any other text is a new goal. */
export function parseGoalArgs(args: string): GoalCommand {
	const text = args.trim();
	if (!text) return { kind: "status" };
	const word = text.toLowerCase();
	if (word === "status" || word === "pause" || word === "resume" || word === "cancel") {
		return { kind: word };
	}
	if (word === "clear") return { kind: "cancel" };
	return { kind: "start", text };
}

// ---------------------------------------------------------------------------
// Agent prompts
// ---------------------------------------------------------------------------

function goalBlock(goal: Pick<Goal, "objective" | "doneWhen">): string {
	return `Objective: ${goal.objective}\nDone when: ${goal.doneWhen || "(not specified)"}`;
}

export function draftPrompt(text: string): string {
	return [
		"The user started a goal with /goal:",
		"",
		"<goal>",
		text,
		"</goal>",
		"",
		"Before you start the work, turn this into a confirmed goal:",
		"1. Read enough of the code to understand the request.",
		"2. If an important detail is unclear and the answer changes what you build, ask the user with ask_user_question. Ask only what you cannot find out yourself, in one round.",
		"3. Call goal_propose with a precise objective and concrete done criteria (behavior, tests, or checks that prove the work is complete).",
		"If the request is already clear, call goal_propose immediately. Do not edit files before goal_propose confirms the goal.",
	].join("\n");
}

export function startedText(goal: Goal): string {
	return [
		"Goal confirmed and active. Start the work now.",
		goalBlock(goal),
		"",
		"Work through the goal end to end without stopping to ask for permission. When every done criterion is met and verified, call goal_done with a summary and the evidence (tests, commands, changed files). If you cannot continue without the user, call goal_blocked with the reason.",
	].join("\n");
}

export function continuationPrompt(goal: Goal): string {
	const lines = [
		`Continue working on the active goal (automatic continuation ${goal.continuations}/${MAX_CONTINUATIONS}).`,
		goalBlock(goal),
	];
	if (goal.rejections > 0 && goal.lastReview) {
		lines.push("", `The last review rejected the completion: ${goal.lastReview}`);
	}
	lines.push(
		"",
		"Take the next concrete step. When every done criterion is met and verified, call goal_done. If you need the user, call goal_blocked. Do not stop with only a status update.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM_PROMPT = [
	"You review whether a coding agent finished a goal.",
	"You get the goal, the agent's completion summary, the recent conversation with tool calls and results, and the git working tree state.",
	"Approve when the evidence shows that every done criterion is met.",
	"Reject when required work is missing, a required check was not run, or a check failed.",
	"Do not reject for style preferences or optional extras.",
	"Reply with APPROVED or REJECTED on the first line, then one short paragraph with the reason. When you reject, name the specific open points.",
].join("\n");

export function reviewPrompt(input: {
	goal: Goal;
	summary: string;
	transcript: string;
	workspace: string;
}): string {
	return [
		"<goal>",
		goalBlock(input.goal),
		"</goal>",
		"",
		"<completion_summary>",
		input.summary || "(no summary)",
		"</completion_summary>",
		"",
		"<recent_conversation>",
		input.transcript || "(no conversation)",
		"</recent_conversation>",
		"",
		"<workspace>",
		input.workspace || "(unavailable)",
		"</workspace>",
		"",
		"Is the goal complete? Answer APPROVED or REJECTED on the first line.",
	].join("\n");
}

export interface ReviewVerdict {
	approved: boolean;
	reason: string;
}

/** First non-empty line decides; `null` when the reply has no verdict. */
export function parseReview(text: string): ReviewVerdict | null {
	const lines = text.split("\n").map((line) => line.trim());
	const first = lines.findIndex((line) => line.length > 0);
	if (first < 0) return null;
	const head = lines[first].replace(/[*_#`>:.\s]+/g, " ").trim().toUpperCase();
	let approved: boolean;
	if (head.startsWith("APPROVED")) approved = true;
	else if (head.startsWith("REJECTED")) approved = false;
	else return null;
	const sameLine = lines[first].replace(/^[*_#`> ]*(?:APPROVED|REJECTED)[*_` ]*[:.\-—]?/i, "").trim();
	const reason = [sameLine, ...lines.slice(first + 1)].join("\n").trim();
	return { approved, reason: reason || (approved ? "Approved." : "Rejected without a reason.") };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function oneLine(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Footer status text without styling; `undefined` clears the status. */
export function statusText(
	goal: Goal | null,
	options: { drafting: boolean; reviewing: boolean },
): string | undefined {
	if (options.reviewing) return "◎ goal · reviewing";
	if (goal?.status === "active") return `◎ goal · ${goal.continuations}/${MAX_CONTINUATIONS}`;
	if (goal?.status === "paused") return "◎ goal · paused";
	if (options.drafting) return "◎ goal · draft";
	return undefined;
}

export function describeGoal(goal: Goal): string {
	let state = "done";
	if (goal.status === "active") state = `active (${goal.continuations}/${MAX_CONTINUATIONS} continuations)`;
	else if (goal.status === "paused") state = `paused${goal.pauseReason ? `: ${goal.pauseReason}` : ""}`;
	const lines = [`Goal: ${goal.objective}`, `Status: ${state}`, `Done when: ${goal.doneWhen || "(not specified)"}`];
	if (goal.lastReview) lines.push(`Last review: ${oneLine(goal.lastReview, 200)}`);
	if (goal.summary) lines.push(`Summary: ${oneLine(goal.summary, 300)}`);
	if (goal.status === "paused") lines.push("Run /goal resume to continue or /goal cancel to drop it.");
	return lines.join("\n");
}
