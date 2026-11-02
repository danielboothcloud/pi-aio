// Pure model for the resume picker: readable titles, day groups, search, and
// a bounded tail read for the "last message" preview.
import { open } from "node:fs/promises";
import { contentText } from "./checkpoints.js";
import { cleanPromptTitle, matchesQuery, toMillis } from "./text.js";

/** Structural subset of pi's SessionInfo. */
export interface SessionLike {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date | string | number;
	modified: Date | string | number;
	messageCount: number;
	firstMessage: string;
	allMessagesText?: string;
}

export type SessionGroup = "today" | "yesterday" | "this week" | "earlier";

const GROUP_ORDER: SessionGroup[] = ["today", "yesterday", "this week", "earlier"];

function startOfDay(ms: number): number {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function groupFor(modified: number, now: number): SessionGroup {
	const today = startOfDay(now);
	if (modified >= today) return "today";
	const day = 24 * 3600_000;
	// Calendar-day arithmetic in local time; DST shifts stay within the hour.
	if (modified >= startOfDay(today - day / 2)) return "yesterday";
	if (modified >= today - 6 * day) return "this week";
	return "earlier";
}

export function sessionTitle(session: SessionLike): string {
	const name = session.name?.replace(/\s+/g, " ").trim();
	if (name) return name;
	return cleanPromptTitle(session.firstMessage ?? "") || "(empty session)";
}

export function filterSessions(sessions: SessionLike[], query: string): SessionLike[] {
	if (!query.trim()) return sessions;
	return sessions.filter((session) =>
		matchesQuery(query, sessionTitle(session), session.name, session.firstMessage, session.allMessagesText, session.cwd));
}

export interface SessionGroupRows {
	group: SessionGroup;
	sessions: SessionLike[];
}

/** Newest first, bucketed by day. Empty groups are omitted. */
export function groupSessions(sessions: SessionLike[], now: number): SessionGroupRows[] {
	const sorted = [...sessions].sort((a, b) => (toMillis(b.modified) || 0) - (toMillis(a.modified) || 0));
	const buckets = new Map<SessionGroup, SessionLike[]>();
	for (const session of sorted) {
		const group = groupFor(toMillis(session.modified), now);
		const list = buckets.get(group) ?? [];
		list.push(session);
		buckets.set(group, list);
	}
	return GROUP_ORDER.filter((group) => buckets.has(group)).map((group) => ({ group, sessions: buckets.get(group)! }));
}

export interface LastExchange {
	lastPrompt?: string;
	lastReply?: string;
}

/**
 * Read only the tail of a session file and find its latest prompt and reply.
 * Session files can be tens of megabytes; never load them whole for a preview.
 */
export async function readLastExchange(path: string, maxBytes = 256 * 1024): Promise<LastExchange> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n");
		if (length < size) lines.shift(); // partial first line
		const result: LastExchange = {};
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index]!.trim();
			if (!line) continue;
			let entry: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message") continue;
			const text = contentText(entry.message?.content).trim();
			if (!text) continue;
			if (entry.message?.role === "assistant" && result.lastReply === undefined) result.lastReply = text;
			if (entry.message?.role === "user" && result.lastPrompt === undefined) result.lastPrompt = cleanPromptTitle(text);
			if (result.lastReply !== undefined && result.lastPrompt !== undefined) break;
		}
		return result;
	} finally {
		await handle.close();
	}
}
