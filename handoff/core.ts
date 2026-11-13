/**
 * handoff/core — pure helpers for `/handoff`. Based on pi-handoff (MIT,
 * jalbarrang — see handoff/LICENSE and handoff/UPSTREAM.md). No Pi runtime
 * imports, so tests drive it without a session.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Custom entry written into the new session (never in model context). */
export const HANDOFF_ENTRY_TYPE = "aio-handoff";

export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Do NOT continue the conversation and do NOT answer questions in it. Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/** Structural subset of Pi's SessionEntry that the helpers read. */
export interface BranchEntryLike {
	type: string;
	id?: string;
	timestamp?: string;
	message?: unknown;
	summary?: string;
	tokensBefore?: number;
	firstKeptEntryId?: string;
	fromId?: string;
	customType?: string;
	data?: unknown;
}

/** An AgentMessage-shaped value (message, compaction or branch summary). */
export type HandoffMessage =
	| { role: string; [key: string]: unknown }
	| { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number }
	| { role: "branchSummary"; summary: string; fromId: string | null; timestamp: number };

function timeOf(entry: BranchEntryLike): number {
	const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

function entryToMessage(entry: BranchEntryLike): HandoffMessage | undefined {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		return entry.message as HandoffMessage;
	}
	if (entry.type === "compaction" && typeof entry.summary === "string") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore ?? 0,
			timestamp: timeOf(entry),
		};
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId ?? null, timestamp: timeOf(entry) };
	}
	// Custom messages (hidden AIO instructions, goal continuations) stay out.
	return undefined;
}

/**
 * The branch as the model last saw it: after a compaction, the latest
 * summary plus the entries from its firstKeptEntryId onward.
 */
export function getHandoffMessages(branch: ReadonlyArray<BranchEntryLike>): HandoffMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	const toMessages = (entries: ReadonlyArray<BranchEntryLike>) =>
		entries.map(entryToMessage).filter((message): message is HandoffMessage => message !== undefined);
	if (compactionIndex < 0) return toMessages(branch);

	const compaction = branch[compactionIndex] as BranchEntryLike;
	const firstKept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	return toMessages([
		compaction,
		...(firstKept >= 0 && firstKept < compactionIndex ? branch.slice(firstKept, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	]);
}

/** Characters of serialized conversation the generation call may use. */
export function conversationBudget(contextWindow: number | undefined): number {
	const window = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
	// About 3.5 characters per token, 60% of the window for the history.
	return Math.min(1_500_000, Math.max(40_000, Math.floor(window * 0.6 * 3.5)));
}

/** Keep the opening task framing and the most recent work when too long. */
export function boundConversation(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.2);
	const tail = maxChars - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n\n[… ${omitted} characters of the middle of the conversation omitted; the previous transcript has them …]\n\n${text.slice(-tail)}`;
}

export function buildHandoffRequest(conversationText: string, goal: string): string {
	return `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`;
}

/** Plain path for read/rg plus a file:// target for terminals with links. */
export function appendPreviousConversationLink(prompt: string, sessionFile: string | undefined): string {
	if (!sessionFile) return prompt;
	const transcriptPath = resolve(sessionFile);
	const transcriptUrl = pathToFileURL(transcriptPath).href;
	return `${prompt.trimEnd()}\n\n## Previous conversation\nFull pi transcript (JSONL): [\`${transcriptPath}\`](${transcriptUrl})\n\nUse \`read\` or \`rg\` on this file if the summary omits a detail.`;
}

/** Text blocks of an assistant reply. */
export function responseText(content: ReadonlyArray<Record<string, unknown>> | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.trim();
}

/**
 * The newest entry of each carried custom type on the branch, oldest first.
 * The new session gets copies, so each feature restores its own state there
 * (an `off` pin included) exactly as it would on a resumed branch.
 */
export function carriedEntries(
	branch: ReadonlyArray<BranchEntryLike>,
	types: ReadonlyArray<string>,
): Array<{ customType: string; data: unknown }> {
	const latest = new Map<string, { index: number; data: unknown }>();
	branch.forEach((entry, index) => {
		if (entry.type === "custom" && entry.customType && types.includes(entry.customType)) {
			latest.set(entry.customType, { index, data: entry.data });
		}
	});
	return [...latest.entries()]
		.sort((a, b) => a[1].index - b[1].index)
		.map(([customType, value]) => ({ customType, data: value.data }));
}

export interface HandoffEntryData {
	version: 1;
	goal: string;
	/** Previous session transcript, when it was persisted. */
	parentSession?: string;
	/** "provider/id" of the model the previous session used. */
	model?: string;
	thinkingLevel?: string;
	/** Carried custom entry types (for the transcript note). */
	carried: string[];
	createdAt: string;
}

/** The handoff entry of a new session, if it is the newest one on the branch. */
export function latestHandoffEntry(branch: ReadonlyArray<BranchEntryLike>): HandoffEntryData | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom" || entry.customType !== HANDOFF_ENTRY_TYPE) continue;
		const data = entry.data as HandoffEntryData | undefined;
		return data?.version === 1 ? data : undefined;
	}
	return undefined;
}

/** True while the branch holds no conversation yet (a just-created handoff). */
export function hasNoMessages(branch: ReadonlyArray<BranchEntryLike>): boolean {
	return !branch.some((entry) => entry.type === "message");
}
