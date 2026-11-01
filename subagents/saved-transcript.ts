import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { applyTranscriptEvent, createTranscript, pushTranscriptNotice, type ChildTranscript } from "./transcript.js";

/** Bound file I/O as well as rendered memory, even for very long child runs. */
export const MAX_SAVED_TRANSCRIPT_BYTES = 1_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

/** Read a bounded tail of the saved child's selected branch, lazily on inspect. */
export function loadSavedTranscript(sessionFile: string): ChildTranscript | undefined {
	let fd: number | undefined;
	try {
		if (!statSync(sessionFile).isFile()) return undefined;
		fd = openSync(sessionFile, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - MAX_SAVED_TRANSCRIPT_BYTES);
		const buffer = Buffer.alloc(Math.min(size, MAX_SAVED_TRANSCRIPT_BYTES));
		const read = readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.subarray(0, read).toString("utf8");
		const lines = text.split("\n");
		if (start > 0) lines.shift(); // First line may start inside UTF-8/JSON.
		const entries: Array<Record<string, unknown>> = [];
		for (const line of lines) {
			try {
				const entry = record(JSON.parse(line));
				if (entry) entries.push(entry);
			} catch {
				// A crash can leave a partial final line; keep the valid history.
			}
		}
		// IDs/parentIds keep abandoned branches out; legacy stubs without IDs
		// are linear. We never read preceding bytes just to fill missing parents.
		const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
		let branch = entries;
		const leaf = entries.at(-1);
		if (leaf && typeof leaf.id === "string") {
			branch = [];
			const visited = new Set<string>();
			let current: Record<string, unknown> | undefined = leaf;
			while (current && typeof current.id === "string" && !visited.has(current.id)) {
				visited.add(current.id);
				branch.push(current);
				current = byId.get(current.parentId);
			}
			branch.reverse();
		}
		const transcript = createTranscript();
		for (const entry of branch) {
			const message = record(entry.message);
			if (!message) continue;
			const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) || 0 : 0;
			if (message.role === "toolResult") {
				if (!transcript.tools.has(String(message.toolCallId ?? "")))
					applyTranscriptEvent(transcript, { type: "tool_execution_start", toolCallId: message.toolCallId, toolName: message.toolName }, at);
				applyTranscriptEvent(transcript, { type: "tool_execution_end", toolCallId: message.toolCallId, result: message, isError: message.isError }, at);
				continue;
			}
			if (message.role === "assistant") applyTranscriptEvent(transcript, { type: "turn_start" }, at);
			applyTranscriptEvent(transcript, { type: "message_end", message }, at);
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const raw of message.content) {
				const block = record(raw);
				if (block?.type !== "toolCall") continue;
				applyTranscriptEvent(transcript, { type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments }, at);
			}
		}
		if (!transcript.entries.length) return undefined;
		pushTranscriptNotice(transcript, `Restored from saved child session${start > 0 ? " · bounded tail" : ""}`, "muted");
		return transcript;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
