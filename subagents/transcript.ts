/**
 * Bounded, live per-child transcript for the subagent inspector overlay.
 *
 * The runner folds every child JSON event through `applyTranscriptEvent`
 * (and stderr chunks through `appendTranscriptLog`), so the inspector can
 * show thinking, assistant text, tool calls with their arguments and
 * results, retries, compaction, and child logs while the child runs.
 *
 * Memory is bounded per child (entry count and total characters, oldest
 * entries dropped first; each block clipped head+tail) and across runs by
 * the registry, which discards transcripts of older finished runs. The
 * transcript never enters tool details or model context.
 */
import { summarizeToolArgs } from "./activity.js";

export const MAX_TRANSCRIPT_ENTRIES = 500;
export const MAX_TRANSCRIPT_CHARS = 250_000;
const MAX_BLOCK_CHARS = 8_000;
const MAX_TOOL_OUTPUT_CHARS = 6_000;
const MAX_TOOL_ARGS_CHARS = 2_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_LOG_CHARS = 4_000;

const ANSI_PATTERN =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// Control characters other than newline would corrupt the overlay layout.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional strip
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export type NoticeTone = "muted" | "success" | "warning" | "error";

interface EntryBase {
	at: number;
	/** Bumped on every mutation so renderers can cache wrapped lines. */
	rev: number;
}

export interface NoticeEntry extends EntryBase {
	kind: "notice";
	text: string;
	tone: NoticeTone;
}

export interface PromptEntry extends EntryBase {
	kind: "prompt";
	text: string;
}

export interface BlockEntry extends EntryBase {
	kind: "thinking" | "text";
	text: string;
	streaming: boolean;
	/** Characters dropped while streaming past the per-block cap. */
	clipped: number;
}

export interface ToolEntry extends EntryBase {
	kind: "tool";
	id: string;
	name: string;
	summary: string;
	args: string;
	output: string;
	status: "running" | "done" | "error";
	durationMs?: number;
}

export interface LogEntry extends EntryBase {
	kind: "log";
	text: string;
}

export type TranscriptEntry =
	| NoticeEntry
	| PromptEntry
	| BlockEntry
	| ToolEntry
	| LogEntry;

export interface ChildTranscript {
	entries: TranscriptEntry[];
	/** Entries evicted to respect the entry/character budget. */
	dropped: number;
	chars: number;
	turns: number;
	/** Streaming blocks of the current assistant message by contentIndex. */
	openBlocks: Map<number, BlockEntry>;
	/** Whether the current assistant message streamed any content block. */
	streamedMessage: boolean;
	tools: Map<string, ToolEntry>;
	/** Bumped on every change (any entry or the list itself). */
	revision: number;
}

export function createTranscript(): ChildTranscript {
	return {
		entries: [],
		dropped: 0,
		chars: 0,
		turns: 0,
		openBlocks: new Map(),
		streamedMessage: false,
		tools: new Map(),
		revision: 0,
	};
}

export function sanitizeText(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(CONTROL_PATTERN, "");
}

/** Keep the head and tail of oversized text; the middle is elided. */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.max(0, max - 40);
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n… ${omitted} chars omitted …\n${tail ? text.slice(-tail) : ""}`;
}

function entrySize(entry: TranscriptEntry): number {
	switch (entry.kind) {
		case "tool":
			return entry.args.length + entry.output.length + entry.summary.length;
		default:
			return entry.text.length;
	}
}

function forgetEntry(transcript: ChildTranscript, entry: TranscriptEntry): void {
	if (entry.kind === "tool" && transcript.tools.get(entry.id) === entry)
		transcript.tools.delete(entry.id);
	if (entry.kind === "thinking" || entry.kind === "text") {
		for (const [index, open] of transcript.openBlocks) {
			if (open === entry) transcript.openBlocks.delete(index);
		}
	}
}

function enforceBudget(transcript: ChildTranscript): void {
	while (
		transcript.entries.length > 1 &&
		(transcript.entries.length > MAX_TRANSCRIPT_ENTRIES ||
			transcript.chars > MAX_TRANSCRIPT_CHARS)
	) {
		const oldest = transcript.entries.shift();
		if (!oldest) break;
		transcript.chars -= entrySize(oldest);
		transcript.dropped++;
		forgetEntry(transcript, oldest);
	}
}

/** Apply a size-changing mutation to an entry and keep the budget honest. */
function mutate<T extends TranscriptEntry>(
	transcript: ChildTranscript,
	entry: T,
	change: (entry: T) => void,
): void {
	const before = entrySize(entry);
	change(entry);
	entry.rev++;
	transcript.revision++;
	if (transcript.entries.includes(entry)) {
		transcript.chars += entrySize(entry) - before;
		enforceBudget(transcript);
	}
}

function push<T extends TranscriptEntry>(
	transcript: ChildTranscript,
	entry: T,
): T {
	transcript.entries.push(entry);
	transcript.chars += entrySize(entry);
	transcript.revision++;
	enforceBudget(transcript);
	return entry;
}

function removeEntry(transcript: ChildTranscript, entry: TranscriptEntry): void {
	const index = transcript.entries.indexOf(entry);
	if (index === -1) return;
	transcript.entries.splice(index, 1);
	transcript.chars -= entrySize(entry);
	transcript.revision++;
	forgetEntry(transcript, entry);
}

export function pushTranscriptNotice(
	transcript: ChildTranscript,
	text: string,
	tone: NoticeTone = "muted",
	now = Date.now(),
): void {
	push(transcript, {
		kind: "notice",
		text: clipMiddle(sanitizeText(text), MAX_PROMPT_CHARS),
		tone,
		at: now,
		rev: 0,
	});
}

/** Child stderr; consecutive chunks coalesce into one log entry. */
export function appendTranscriptLog(
	transcript: ChildTranscript,
	chunk: string,
	now = Date.now(),
): void {
	const text = sanitizeText(chunk);
	if (!text.trim()) return;
	const last = transcript.entries.at(-1);
	if (last?.kind === "log") {
		mutate(transcript, last, (entry) => {
			entry.text = clipMiddle(`${entry.text}${text}`, MAX_LOG_CHARS);
		});
		return;
	}
	push(transcript, {
		kind: "log",
		text: clipMiddle(text, MAX_LOG_CHARS),
		at: now,
		rev: 0,
	});
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const block = part as { type?: unknown; text?: unknown };
			if (block.type === "text" && typeof block.text === "string")
				return [block.text];
			if (block.type === "image") return ["[image]"];
			return [];
		})
		.join("\n");
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (typeof result !== "object" || result === null) return "";
	return contentText((result as { content?: unknown }).content);
}

function formatArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return clipMiddle(
			sanitizeText(JSON.stringify(args, null, 2) ?? ""),
			MAX_TOOL_ARGS_CHARS,
		);
	} catch {
		return "";
	}
}

function openBlock(
	transcript: ChildTranscript,
	kind: BlockEntry["kind"],
	index: number,
	now: number,
): BlockEntry {
	const existing = transcript.openBlocks.get(index);
	if (existing?.kind === kind) return existing;
	const entry = push(transcript, {
		kind,
		text: "",
		streaming: true,
		clipped: 0,
		at: now,
		rev: 0,
	});
	transcript.openBlocks.set(index, entry);
	transcript.streamedMessage = true;
	return entry;
}

function closeBlock(
	transcript: ChildTranscript,
	entry: BlockEntry,
	content: unknown,
): void {
	const authoritative =
		typeof content === "string" ? sanitizeText(content) : undefined;
	mutate(transcript, entry, (block) => {
		if (authoritative !== undefined) {
			block.text = clipMiddle(authoritative, MAX_BLOCK_CHARS);
			block.clipped = 0;
		}
		block.streaming = false;
	});
	if (!entry.text.trim()) removeEntry(transcript, entry);
}

function applyMessageUpdate(
	transcript: ChildTranscript,
	inner: Record<string, unknown>,
	now: number,
): void {
	const type = String(inner.type ?? "");
	const index = Number(inner.contentIndex) || 0;
	const kind: BlockEntry["kind"] | undefined = type.startsWith("thinking_")
		? "thinking"
		: type.startsWith("text_")
			? "text"
			: undefined;
	if (!kind) return;
	if (type.endsWith("_start")) {
		openBlock(transcript, kind, index, now);
		return;
	}
	const entry = openBlock(transcript, kind, index, now);
	if (type.endsWith("_delta")) {
		const delta = typeof inner.delta === "string" ? sanitizeText(inner.delta) : "";
		if (!delta) return;
		mutate(transcript, entry, (block) => {
			const room = Math.max(0, MAX_BLOCK_CHARS - block.text.length);
			block.text += delta.slice(0, room);
			block.clipped += Math.max(0, delta.length - room);
		});
		return;
	}
	if (type.endsWith("_end")) {
		closeBlock(transcript, entry, inner.content);
		transcript.openBlocks.delete(index);
	}
}

/** Fold an assistant message that arrived without streaming deltas. */
function reconcileUnstreamed(
	transcript: ChildTranscript,
	message: Record<string, unknown>,
	now: number,
): void {
	if (!Array.isArray(message.content)) return;
	for (const part of message.content) {
		if (typeof part !== "object" || part === null) continue;
		const block = part as Record<string, unknown>;
		const kind =
			block.type === "thinking" ? "thinking" : block.type === "text" ? "text" : undefined;
		const raw = kind === "thinking" ? block.thinking : block.text;
		if (!kind || typeof raw !== "string" || !raw.trim()) continue;
		push(transcript, {
			kind,
			text: clipMiddle(sanitizeText(raw), MAX_BLOCK_CHARS),
			streaming: false,
			clipped: 0,
			at: now,
			rev: 0,
		});
	}
}

/** Fold one child JSON event into the transcript. */
export function applyTranscriptEvent(
	transcript: ChildTranscript,
	event: Record<string, unknown>,
	now = Date.now(),
): void {
	switch (event.type) {
		case "turn_start":
			transcript.turns++;
			pushTranscriptNotice(transcript, `turn ${transcript.turns}`, "muted", now);
			return;
		case "message_start": {
			const message = event.message as Record<string, unknown> | undefined;
			if (message?.role === "assistant") {
				transcript.openBlocks.clear();
				transcript.streamedMessage = false;
			}
			return;
		}
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (typeof inner === "object" && inner !== null)
				applyMessageUpdate(transcript, inner as Record<string, unknown>, now);
			return;
		}
		case "message_end": {
			const message = event.message as Record<string, unknown> | undefined;
			if (!message) return;
			if (message.role === "user") {
				const text = sanitizeText(contentText(message.content)).trim();
				if (text)
					push(transcript, {
						kind: "prompt",
						text: clipMiddle(text, MAX_PROMPT_CHARS),
						at: now,
						rev: 0,
					});
				return;
			}
			if (message.role !== "assistant") return;
			for (const entry of transcript.openBlocks.values())
				closeBlock(transcript, entry, undefined);
			transcript.openBlocks.clear();
			if (!transcript.streamedMessage) reconcileUnstreamed(transcript, message, now);
			transcript.streamedMessage = false;
			if (typeof message.errorMessage === "string" && message.errorMessage)
				pushTranscriptNotice(transcript, message.errorMessage, "error", now);
			return;
		}
		case "tool_execution_start": {
			const id = String(event.toolCallId ?? `tool-${transcript.tools.size}`);
			const name = String(event.toolName ?? "tool");
			const entry = push(transcript, {
				kind: "tool",
				id,
				name,
				summary: summarizeToolArgs(name, event.args),
				args: formatArgs(event.args),
				output: "",
				status: "running",
				at: now,
				rev: 0,
			});
			transcript.tools.set(id, entry);
			return;
		}
		case "tool_execution_update": {
			const entry = transcript.tools.get(String(event.toolCallId ?? ""));
			if (!entry) return;
			const text = sanitizeText(resultText(event.partialResult));
			mutate(transcript, entry, (tool) => {
				tool.output = clipMiddle(text, MAX_TOOL_OUTPUT_CHARS);
			});
			return;
		}
		case "tool_execution_end": {
			const id = String(event.toolCallId ?? "");
			const entry = transcript.tools.get(id);
			if (!entry) return;
			const text = sanitizeText(resultText(event.result));
			mutate(transcript, entry, (tool) => {
				if (text || !tool.output)
					tool.output = clipMiddle(text, MAX_TOOL_OUTPUT_CHARS);
				tool.status = event.isError === true ? "error" : "done";
				tool.durationMs =
					typeof event.durationMs === "number"
						? event.durationMs
						: Math.max(0, now - tool.at);
			});
			transcript.tools.delete(id);
			return;
		}
		case "auto_retry_start": {
			const attempt = Number(event.attempt) || 1;
			const max = Number(event.maxAttempts) || 1;
			const error =
				typeof event.errorMessage === "string" ? `: ${event.errorMessage}` : "";
			pushTranscriptNotice(
				transcript,
				`provider retry ${attempt}/${max}${error}`,
				"warning",
				now,
			);
			return;
		}
		case "auto_retry_end":
			if (event.success === false)
				pushTranscriptNotice(
					transcript,
					`provider retries exhausted${typeof event.finalError === "string" ? `: ${event.finalError}` : ""}`,
					"error",
					now,
				);
			return;
		case "compaction_start":
			pushTranscriptNotice(
				transcript,
				`compacting context${typeof event.reason === "string" ? ` (${event.reason})` : ""}`,
				"muted",
				now,
			);
			return;
		case "compaction_end":
			if (typeof event.errorMessage === "string")
				pushTranscriptNotice(transcript, `compaction failed: ${event.errorMessage}`, "error", now);
			else pushTranscriptNotice(transcript, "compaction finished", "muted", now);
			return;
		case "agent_settled":
			pushTranscriptNotice(
				transcript,
				event.aborted === true ? "aborted" : "settled",
				event.aborted === true ? "warning" : "success",
				now,
			);
			return;
		default:
			return;
	}
}
