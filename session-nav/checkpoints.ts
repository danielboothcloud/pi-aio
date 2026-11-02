// Pure model for the rewind picker: every user prompt in the session tree is
// a checkpoint. Tool calls, injected context and other entries are folded
// into the prompt's turn instead of being listed on their own.
import { cleanPromptTitle, toMillis } from "./text.js";

/** Structural subset of pi's SessionTreeNode / SessionEntry used here. */
export interface TreeNodeLike {
	entry: EntryLike;
	children: TreeNodeLike[];
	label?: string;
}

export interface EntryLike {
	id: string;
	parentId?: string | null;
	type: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: unknown;
	};
}

export interface Checkpoint {
	/** The user-message entry id (rewinding "before" this prompt targets it). */
	id: string;
	/** Full prompt text as sent. */
	text: string;
	/** One readable line for the list. */
	title: string;
	timestamp: number;
	/** On the branch the session is currently following. */
	onPath: boolean;
	/** The latest prompt on the current branch ("you are here"). */
	isCurrent: boolean;
	/** Last entry of this prompt's turn: rewinding "after the answer" targets it. */
	endId: string;
	/** True when endId is the current leaf, so "after the answer" is a no-op. */
	endIsLeaf: boolean;
	/** Count of file-changing tool calls (edit/write/apply_patch) in the turn. */
	edits: number;
	/** Count of all tool calls in the turn. */
	tools: number;
	/** Final assistant text of the turn, for the preview. */
	reply: string;
	/** User label set on the prompt entry, if any. */
	label?: string;
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multi_edit", "multiedit"]);

function isUserMessage(entry: EntryLike): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } =>
			!!block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("");
}

function toolCalls(entry: EntryLike): string[] {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return [];
	const content = entry.message.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall")
		.map((block) => String((block as { name?: unknown }).name ?? ""));
}

function assistantText(entry: EntryLike): string {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return "";
	return contentText(entry.message.content).trim();
}

/**
 * Build checkpoints newest-first. Iterative walks only: long sessions are
 * thousands of entries deep and must not overflow the stack.
 */
export function buildCheckpoints(roots: TreeNodeLike[], leafId: string | null | undefined): Checkpoint[] {
	const parent = new Map<string, string | null>();
	const nodes: TreeNodeLike[] = [];
	const stack = [...roots];
	while (stack.length) {
		const node = stack.pop()!;
		nodes.push(node);
		for (const child of node.children) {
			parent.set(child.entry.id, node.entry.id);
			stack.push(child);
		}
	}

	const onPath = new Set<string>();
	for (let id = leafId ?? null; id; id = parent.get(id) ?? null) {
		if (onPath.has(id)) break;
		onPath.add(id);
	}

	const checkpoints: Checkpoint[] = [];
	for (const node of nodes) {
		if (!isUserMessage(node.entry)) continue;
		let edits = 0;
		let tools = 0;
		let reply = "";
		let end = node;
		// Follow the turn: the child on the current branch when there is one,
		// otherwise the newest child, stopping before the next prompt.
		for (;;) {
			const children = end.children;
			if (children.length === 0) break;
			const next = children.find((child) => onPath.has(child.entry.id)) ?? children[children.length - 1]!;
			if (isUserMessage(next.entry)) break;
			end = next;
			for (const name of toolCalls(end.entry)) {
				tools++;
				if (EDIT_TOOLS.has(name)) edits++;
			}
			reply = assistantText(end.entry) || reply;
		}
		const text = contentText(node.entry.message?.content);
		checkpoints.push({
			id: node.entry.id,
			text,
			title: cleanPromptTitle(text) || "(empty prompt)",
			timestamp: toMillis(node.entry.timestamp),
			onPath: onPath.has(node.entry.id),
			isCurrent: false,
			endId: end.entry.id,
			endIsLeaf: end.entry.id === leafId,
			edits,
			tools,
			reply,
			label: node.label,
		});
	}

	checkpoints.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
	const current = checkpoints.find((checkpoint) => checkpoint.onPath);
	if (current) current.isCurrent = true;
	return checkpoints;
}

export type RewindAction = "edit" | "after" | "summary" | "fork";

export interface RewindOption {
	action: RewindAction;
	label: string;
	description: string;
}

/** The plain-English choices offered for one checkpoint. */
export function rewindOptions(checkpoint: Checkpoint): RewindOption[] {
	const options: RewindOption[] = [
		{
			action: "edit",
			label: "Edit and resend this prompt",
			description: "Go back to just before this prompt and put it in the editor, so you can change it and send it again. Later messages are kept as an alternate branch.",
		},
	];
	if (!checkpoint.endIsLeaf) {
		options.push({
			action: "after",
			label: "Go back to right after this answer",
			description: "Continue the conversation from the point where pi finished answering this prompt. Later messages are kept as an alternate branch.",
		});
	}
	options.push(
		{
			action: "summary",
			label: "Rewind, keeping a summary of what came after",
			description: "Same as edit and resend, but pi first writes a short summary of the later conversation, so the model keeps what was learned. This uses the model and takes a moment.",
		},
		{
			action: "fork",
			label: "Start a new session from here",
			description: "Open a new session with the conversation before this prompt, and put the prompt in the editor. This session is not changed.",
		},
	);
	return options;
}
