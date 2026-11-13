/**
 * Advisor context: the advisor system prompt, stage directives, and the
 * curated transcript sent to the advisor model. Ported from pi-advisor
 * (MIT, RimuruW — see advisor/LICENSE and advisor/UPSTREAM.md). No Pi imports.
 */

import type { AdvisorStage, ExecutorSignals } from "./signals.js";

type TextBlock = { type: "text"; text: string };
type ContentBlock = { type?: string; text?: string; [key: string]: unknown };

export interface AdvisorMessage {
	role: "user" | "assistant";
	content: string | ContentBlock[];
	timestamp: number;
	[key: string]: unknown;
}

const MAX_TEXT_LINES = 24;
const MAX_TEXT_CHARS = 1800;
const MAX_USER_LINES = 40;
const MAX_USER_CHARS = 2800;
export const MAX_SYSTEM_PROMPT_CHARS = 12_000;
export const RECENT_TOOL_SUMMARY_COUNT = 8;

export const ADVISOR_SYSTEM_PROMPT = `You are a senior engineering advisor. The executor model is doing the work; you observe the transcript and provide strategic guidance when consulted.

Your role:
- You see a curated subset of the executor's context: a truncated transcript, tool activity summaries (not full outputs), and its system prompt
- If the evidence is too thin to judge, say so — never fill gaps with guesses
- You cannot call tools or produce user-facing output
- Your advice directly shapes the executor's next actions

What you provide depends on the stage:
1. PLAN — when the executor is still exploring: shortest viable approach, main risk to avoid, first concrete steps (here the verdict judges the exploration direction so far)
2. CORRECTION — when trajectory is weak: what to stop doing, why, and the corrected path
3. VERIFICATION — when implementation appears done: missing evidence, unmet requirements, or explicit sign-off

Output format:
- Lead with a one-sentence verdict: "On track", "Course-correct", or "Not done yet"
- Follow with numbered action items (max 5) the executor should take next
- If the transcript lacks the evidence to settle a point, make your FIRST action item the exact command or file read that would settle it (e.g. "run npm test and re-consult"), instead of guessing
- Reference specific files, commands, or error signals from the transcript
- If you disagree with evidence the executor gathered, state the conflict explicitly — don't silently override

Keep it short. The executor will read your advice and immediately act on it.`;

export const STAGE_DIRECTIVES: Record<AdvisorStage, string> = {
	initial:
		"Executor is still exploring. Provide: (1) the shortest viable approach, (2) the main risk to avoid, (3) 2-3 concrete first steps.",
	recovery:
		"Executor hit friction or is off-track. Provide: (1) what went wrong, (2) what to stop doing, (3) corrected path forward.",
	"final-check":
		"Implementation appears done. Verify: (1) re-read the original user request at the top of the transcript — are all of ITS requirements met, including explicit constraints? (2) is verification evidence sufficient? (3) any missing edge cases? Give explicit sign-off or list what's missing.",
};

export const STAGE_LABELS: Record<AdvisorStage, string> = {
	initial: "initial",
	recovery: "recovery",
	"final-check": "final check",
};

export function clampText(text: string, maxLines = MAX_TEXT_LINES, maxChars = MAX_TEXT_CHARS): string {
	const normalized = text.trim();
	if (!normalized) return normalized;
	const lines = normalized.split("\n");
	let truncated = lines.length > maxLines;
	let next = lines.slice(0, maxLines).join("\n");
	if (next.length > maxChars) {
		next = `${next.slice(0, maxChars).trimEnd()}…`;
		truncated = true;
	}
	return truncated ? `${next}\n[truncated for advisor context]` : next;
}

function userContent(content: unknown): string | ContentBlock[] | undefined {
	if (typeof content === "string") return clampText(content, MAX_USER_LINES, MAX_USER_CHARS);
	if (!Array.isArray(content)) return undefined;
	// Text only: images and other blocks would bloat or break the side call.
	const blocks = content
		.filter((block): block is TextBlock => block?.type === "text" && typeof block.text === "string")
		.map((block) => ({ type: "text" as const, text: clampText(block.text, MAX_USER_LINES, MAX_USER_CHARS) }))
		.filter((block) => block.text.length > 0);
	return blocks.length > 0 ? blocks : undefined;
}

export function assistantText(content: unknown): TextBlock[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((block): block is TextBlock => block?.type === "text" && typeof block.text === "string")
		.map((block) => ({ type: "text" as const, text: clampText(block.text) }))
		.filter((block) => block.text.length > 0);
}

function contextPolicy(): string {
	return `Context policy:
- Assistant tool calls are stripped from the transcript above.
- Tool results are summarized under "Recent tool activity", not replayed in full.
- User task framing is retained where possible.
- If truncated: middle messages omitted, focus on the task framing and recent evidence.`;
}

function signalsBlock(signals: ExecutorSignals): string {
	const verification = signals.verificationCommands.length > 0 ? signals.verificationCommands.join(", ") : "none";
	const failures = signals.recentFailures.length > 0 ? signals.recentFailures.join("; ") : "none";
	return `Executor signals:
- Phase: ${signals.phase}
- Mutations: ${signals.mutationsCount}
- Verification commands run: ${verification}
- Recent failures: ${failures}`;
}

/** Bounded executor system prompt + active tool list. */
export function buildAdvisorSystemPrompt(executorSystemPrompt: string, activeToolsSummary: string): string {
	const trimmed = executorSystemPrompt.trim();
	const bounded =
		trimmed.length > MAX_SYSTEM_PROMPT_CHARS
			? `${trimmed.slice(0, MAX_SYSTEM_PROMPT_CHARS).trimEnd()}\n[executor system prompt truncated for advisor context]`
			: trimmed;
	return `${ADVISOR_SYSTEM_PROMPT}

Executor system prompt:
<<<SYSTEM_PROMPT
${bounded}
SYSTEM_PROMPT>>>

Active tools available to the executor:
${activeToolsSummary}`;
}

export interface AdvisorStageContext {
	stage: AdvisorStage;
	reason: string;
	directive: string;
}

/**
 * The advisor transcript: user and assistant text only (tool calls stripped,
 * tool results summarized separately), first two + latest messages when
 * long, then a closing message with stage, signals, and recent activity —
 * the freshest evidence goes last, where the advisor's attention is strongest.
 */
export function buildAdvisorMessages(
	branch: ReadonlyArray<unknown>,
	stage: AdvisorStageContext,
	recentToolActivity: string,
	maxMessages: number,
	signals?: ExecutorSignals,
	now: number = Date.now(),
): AdvisorMessage[] {
	const transcript: AdvisorMessage[] = [];
	for (const raw of branch) {
		const entry = raw as { type?: string; message?: { role?: string; content?: unknown; timestamp?: number } };
		if (entry?.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : now;
		if (msg.role === "user") {
			const content = userContent(msg.content);
			if (content) transcript.push({ role: "user", content, timestamp });
		} else if (msg.role === "assistant") {
			const content = assistantText(msg.content);
			// Spread the real assistant message so provider metadata survives.
			if (content.length > 0) transcript.push({ ...msg, role: "assistant", content, timestamp });
		}
	}
	if (transcript.length === 0) return [];

	const blocks = [
		contextPolicy(),
		`Current advisory stage: ${stage.stage}`,
		`Stage objective: ${stage.directive}`,
		`Why this stage: ${stage.reason}`,
	];
	if (signals) blocks.push(signalsBlock(signals));
	blocks.push(recentToolActivity ? `Recent tool activity:\n${recentToolActivity}` : "Recent tool activity: none yet");
	blocks.push("Provide your advisory assessment now based on the transcript and the context above.");
	const closing: AdvisorMessage = { role: "user", content: blocks.join("\n\n"), timestamp: now };

	const limit = Math.max(4, maxMessages);
	if (transcript.length + 1 <= limit) return [...transcript, closing];

	const keepFirst = 2;
	const keepLast = Math.max(1, limit - keepFirst - 2);
	const omitted = transcript.length - keepFirst - keepLast;
	const omittedNote: AdvisorMessage = {
		role: "user",
		content: `[${omitted} earlier transcript messages omitted. Focus on the retained task framing and the most recent evidence.]`,
		timestamp: now,
	};
	return [...transcript.slice(0, keepFirst), omittedNote, ...transcript.slice(-keepLast), closing];
}
