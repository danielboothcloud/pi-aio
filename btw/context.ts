/**
 * btw — side-question context assembly.
 *
 * Context builders for the /btw ("by the way") side channel: a bounded digest
 * of the recent session flow, a bounded workspace snapshot, and the prompt
 * that packages them with the user's question. Every budget lives here so
 * the isolated one-shot side call stays bounded no matter how long the
 * session or how large the workspace.
 *
 * The module has no Pi host imports: the session branch enters as a loose
 * `readonly unknown[]` (the SDK's heterogeneous SessionEntry union, viewed
 * through a record lens — the YSK task-digest pattern), so tests exercise
 * everything with plain fixtures.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================
// Budgets (all enforced here, not at call sites)
// ============================================================

/** Hard cap on the question text that reaches the prompt. */
export const MAX_QUESTION_CHARS = 800;

/** Character budget for the recent-flow digest. */
export const MAX_FLOW_DIGEST_CHARS = 12_000;

/** Newest messages kept in the digest before older ones trim away. */
export const MAX_MESSAGES_IN_DIGEST = 40;

/** Hard cap for the assembled side-question prompt (UTF-8 bytes). */
export const MAX_PROMPT_BYTES = 28_000;

/** Directories the snapshot walk never descends into. */
export const SNAPSHOT_EXCLUDE_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"vendor",
	"coverage",
	".next",
	".turbo",
	".cache",
	"__pycache__",
	".venv",
]);

export const SNAPSHOT_MAX_FILES = 2500;
export const SNAPSHOT_MAX_DIRS = 200;
export const SNAPSHOT_MAX_DEPTH = 8;
export const SNAPSHOT_ROOT_ENTRIES = 40;
export const SNAPSHOT_TOP_FILES = 30;

export const SNAPSHOT_UNAVAILABLE = "(workspace snapshot unavailable)";
export const FLOW_EMPTY = "(fresh session — no earlier messages yet)";

/**
 * The side-channel persona: concise, grounded, never invents context.
 * The answer renders for a human on a live terminal — never fed back to the
 * main agent — so it must be direct and standalone-safe.
 */
export const BTW_SYSTEM_PROMPT = [
	'You are "By The Way", a side channel of the pi coding agent. The user taps you with quick aside questions while the main agent keeps working. You have no tools and exactly one shot to answer.',
	"",
	"You receive: a bounded workspace snapshot, a digest of the recent session flow, and the user's question. Answer directly and concisely:",
	"",
	"- Get to the point: no preamble, no restating the question, no offers of further help.",
	"- At most ~150 words, plain text; include short code, paths, or values only when they are the answer.",
	"- Ground the answer in the provided context; quote paths, sizes, names, and outputs from it when useful.",
	"- If the context does not answer it, say in one short line what is missing. Never invent paths, APIs, or results.",
	"- Never suggest running commands; the user is watching a live session and you cannot run anything.",
].join("\n");

// ============================================================
// Recent-flow digest
// ============================================================

export interface FlowDigestOptions {
	/** Overall character budget for the digest. */
	maxChars?: number;
	/** Newest messages kept before older messages trim away. */
	maxMessages?: number;
	/** Per-kind caps for rendered message text. */
	perMessageChars?: Partial<Record<"user" | "assistant" | "toolResult" | "toolCall", number>>;
}

const DEFAULT_PER_MESSAGE_CHARS: Record<"user" | "assistant" | "toolResult" | "toolCall", number> = {
	user: 800,
	assistant: 900,
	toolResult: 400,
	toolCall: 160,
};

type PerMessageChars = Record<"user" | "assistant" | "toolResult" | "toolCall", number>;

/** Loose message view of one session entry; unknown shapes yield undefined. */
interface MessageView {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}

function entryMessage(entry: unknown): MessageView | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	return message as MessageView;
}

/** Text blocks of a content array (or the raw string), ANSI-bearing. */
function blockTexts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			texts.push(record.text);
		}
	}
	return texts;
}

/** Tool calls of an assistant content array, with a compact args preview. */
function blockToolCalls(content: unknown): Array<{ name: string; args: string }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ name: string; args: string }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type !== "toolCall") continue;
		let args: string;
		try {
			args = JSON.stringify(record.arguments ?? {}) ?? "{}";
		} catch {
			args = "(unserializable args)";
		}
		calls.push({ name: String(record.name ?? "tool"), args });
	}
	return calls;
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…[cut]`;
}

/** Renders one message entry to digest lines, or undefined when skippable. */
function renderMessage(entry: unknown, caps: PerMessageChars): string[] | undefined {
	const message = entryMessage(entry);
	if (!message) return undefined;

	if (message.role === "user") {
		const text = blockTexts(message.content).join("\n").trim();
		if (!text) return undefined;
		return [`USER: ${clip(text, caps.user)}`];
	}

	if (message.role === "assistant") {
		const text = blockTexts(message.content).join("\n").trim();
		const lines: string[] = [];
		if (text) lines.push(`ASSISTANT: ${clip(text, caps.assistant)}`);
		for (const call of blockToolCalls(message.content)) {
			lines.push(`  → ${call.name}(${clip(call.args, caps.toolCall)})`);
		}
		return lines.length > 0 ? lines : undefined;
	}

	if (message.role === "toolResult") {
		const text = blockTexts(message.content).join("\n").trim();
		if (!text) return undefined;
		const name = message.toolName ?? "tool";
		const prefix = message.isError ? `TOOL ${name} (failed): ` : `TOOL ${name}: `;
		return [`${prefix}${clip(text, caps.toolResult)}`];
	}

	return undefined;
}

function countMessages(branch: readonly unknown[], uptoIndex: number): number {
	let count = 0;
	for (let i = 0; i <= uptoIndex; i++) {
		if (entryMessage(branch[i])) count++;
	}
	return count;
}

/**
 * Newest window of the session flow: user/assistant text, tool-call
 * one-liners, and tool-result tails, chronological, within a character
 * budget. Newest messages are kept whole; once one overflows it and every
 * older message trim away behind a single `…[N messages trimmed]` marker.
 */
export function buildFlowDigest(branch: readonly unknown[], options?: FlowDigestOptions): string {
	const maxChars = options?.maxChars ?? MAX_FLOW_DIGEST_CHARS;
	const maxMessages = options?.maxMessages ?? MAX_MESSAGES_IN_DIGEST;
	const caps: PerMessageChars = { ...DEFAULT_PER_MESSAGE_CHARS, ...options?.perMessageChars };

	const parts: string[] = []; // newest first
	let used = 0;
	let kept = 0;
	let trimmed = 0;

	for (let i = branch.length - 1; i >= 0; i--) {
		const lines = renderMessage(branch[i], caps);
		if (!lines) continue; // non-message entries pass uncounted
		const rendered = lines.join("\n");
		if (kept >= maxMessages || rendered.length > maxChars - used) {
			trimmed += countMessages(branch, i);
			break;
		}
		parts.push(rendered);
		used += rendered.length;
		kept++;
	}

	if (parts.length === 0) return "";
	const ordered = parts.toReversed();

	const rows: string[] = [];
	if (trimmed > 0) {
		rows.push(`…[${trimmed} ${trimmed === 1 ? "message" : "messages"} trimmed]`);
	}
	rows.push(...ordered);
	return rows.join("\n");
}

// ============================================================
// Workspace snapshot
// ============================================================

export interface ProjectSnapshotOptions {
	maxFiles?: number;
	maxDirs?: number;
	maxDepth?: number;
	rootEntries?: number;
	topFiles?: number;
}

interface SnapshotFile {
	rel: string;
	size: number;
}

function describeRoot(entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>, maxEntries: number): string {
	const names = entries
		.slice(0, maxEntries)
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
	const extras = entries.length - names.length;
	const joined = names.length > 0 ? names.join(", ") : "(empty)";
	return extras > 0 ? `${joined}, …(+${extras} more)` : joined;
}

/**
 * Bounded workspace view for repo-level questions ("what is chunkiest in
 * this repo"): root listing plus the largest files by bytes. Never throws —
 * unreadable trees degrade to a partial marker or the unavailable note.
 */
export async function buildProjectSnapshot(cwd: string, options?: ProjectSnapshotOptions): Promise<string> {
	const maxFiles = options?.maxFiles ?? SNAPSHOT_MAX_FILES;
	const maxDirs = options?.maxDirs ?? SNAPSHOT_MAX_DIRS;
	const maxDepth = options?.maxDepth ?? SNAPSHOT_MAX_DEPTH;
	const maxRootEntries = options?.rootEntries ?? SNAPSHOT_ROOT_ENTRIES;
	const topFiles = options?.topFiles ?? SNAPSHOT_TOP_FILES;

	let rootEntries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
	try {
		rootEntries = await fs.readdir(cwd, { withFileTypes: true });
	} catch {
		return SNAPSHOT_UNAVAILABLE;
	}

	const lines: string[] = [`WORKSPACE: ${cwd}`, "ROOT:"];
	// Excluded trees never claim root-listing slots either.
	lines.push(
		`  ${describeRoot(
			rootEntries.filter(
				(entry) => (entry.isDirectory() && !SNAPSHOT_EXCLUDE_DIRS.has(entry.name)) || entry.isFile(),
			),
			maxRootEntries,
		)}`,
	);

	const files: SnapshotFile[] = [];
	let partial = false;
	let dirsWalked = 0;
	const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];

	while (queue.length > 0) {
		const current = queue.shift() as { dir: string; depth: number };
		dirsWalked++;
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = await fs.readdir(current.dir, { withFileTypes: true });
		} catch {
			partial = true;
			continue;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) break;
			if (entry.isDirectory()) {
				if (SNAPSHOT_EXCLUDE_DIRS.has(entry.name)) continue;
				if (current.depth + 1 > maxDepth || dirsWalked + queue.length > maxDirs) {
					partial = true;
					continue;
				}
				queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue; // symlinks etc. stay out
			try {
				const stat = await fs.stat(path.join(current.dir, entry.name));
				files.push({
					rel: path.relative(cwd, path.join(current.dir, entry.name)) || entry.name,
					size: stat.size,
				});
			} catch {
				partial = true;
			}
		}
		if (files.length >= maxFiles) {
			partial = true;
			break;
		}
	}

	files.sort((a, b) => b.size - a.size);
	if (files.length > 0) {
		const total = files.length;
		lines.push("LARGEST FILES (bytes):");
		for (const file of files.slice(0, topFiles)) {
			lines.push(`  ${file.rel} — ${file.size}`);
		}
		if (total > topFiles) {
			lines.push(`  …+${total - topFiles} more files (${total} walked)`);
		}
	}
	lines.push(
		`FILES WALKED: ${files.length}${partial ? " (partial — walk cap or read error hit)" : ""}`,
	);
	return lines.join("\n");
}

// ============================================================
// Prompt assembly
// ============================================================

export interface BtwPromptInput {
	question: string;
	/** From buildFlowDigest; "" falls back to the fresh-session note. */
	flowDigest?: string;
	/** From buildProjectSnapshot; "" falls back to the unavailable note. */
	projectSnapshot?: string;
	maxPromptBytes?: number;
}

/**
 * Packages the side question with its context sections. Empty/missing
 * sections fall back to explicit notes so the model knows what it lacks.
 */
export function buildBtwPrompt(input: BtwPromptInput): string {
	const cap = input.maxPromptBytes ?? MAX_PROMPT_BYTES;
	const question = clip((input.question ?? "").trim(), MAX_QUESTION_CHARS);
	const digest = input.flowDigest?.trim() ?? "";
	const snapshot = input.projectSnapshot?.trim() ?? "";

	const prompt = [
		"CONTEXT — WORKSPACE SNAPSHOT",
		snapshot || SNAPSHOT_UNAVAILABLE,
		"",
		"CONTEXT — RECENT SESSION FLOW (oldest first)",
		digest || FLOW_EMPTY,
		"",
		"QUESTION",
		question,
	].join("\n");

	// A belt over the section budgets; keeps the hard byte cap honest.
	if (Buffer.byteLength(prompt, "utf8") <= cap) return prompt;
	let cut = prompt.length;
	while (cut > 0 && Buffer.byteLength(prompt.slice(0, cut), "utf8") > cap - 64) {
		cut = Math.max(0, cut - 1024);
	}
	return `${prompt.slice(0, cut)}\n…[truncated to fit the budget]`;
}
