// Session lineage: resolve the root session id reachable from a starting id
// by walking parentSession file paths from the session header. Intentionally
// conservative: only the session manager's current session can be resolved;
// anything else returns the input id. Ported from pi-yaml-hooks (MIT).

import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from "node:fs";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./host-adapter.js";

// Bound the lineage walk + per-file read so a pathological session chain or
// oversized header line cannot block the event loop.
const MAX_LINEAGE_DEPTH = 64;
const MAX_HEADER_BYTES = 64 * 1024;

// Bounded LRU cache of previously resolved (sessionId → rootId) pairs.
const SESSION_ROOT_CACHE_MAX = 64;
const sessionRootCache = new Map<string, string>();

function rememberSessionRoot(sessionId: string, rootId: string): void {
	if (sessionRootCache.has(sessionId)) {
		sessionRootCache.delete(sessionId);
	}
	sessionRootCache.set(sessionId, rootId);
	while (sessionRootCache.size > SESSION_ROOT_CACHE_MAX) {
		const oldest = sessionRootCache.keys().next().value;
		if (oldest === undefined) break;
		sessionRootCache.delete(oldest);
	}
}

/** Test-only: clear the resolution cache so each case starts fresh. */
export function resetSessionLineageCacheForTests(): void {
	sessionRootCache.clear();
}

/**
 * Return the root session id reachable from `currentSessionId`.
 *
 * Walks `sessionManager.getHeader().parentSession` when it points to a file
 * we can read; otherwise returns the starting id. Best-effort by design.
 */
export function getRootSessionId(
	currentSessionId: string,
	sessionManager: ReadonlySessionManager | undefined,
): string {
	if (!currentSessionId) return currentSessionId;
	if (!sessionManager) return currentSessionId;

	let header: SessionHeader | null = null;
	try {
		header = sessionManager.getHeader();
	} catch {
		return currentSessionId;
	}
	if (!header) return currentSessionId;

	// A session that isn't the manager's current one cannot be resolved
	// without loading arbitrary session files; try the in-memory cache first.
	if (header.id !== currentSessionId) {
		const cached = sessionRootCache.get(currentSessionId);
		if (cached) return cached;
		return currentSessionId;
	}

	// Cache hit on the active session id (repeated lookups per event).
	const cachedRoot = sessionRootCache.get(currentSessionId);
	if (cachedRoot) return cachedRoot;

	const visited = new Set<string>([header.id]);
	let cursor: SessionHeader | null = header;
	let depth = 0;
	while (cursor?.parentSession) {
		if (++depth > MAX_LINEAGE_DEPTH) break;
		const parent = readSessionHeaderFromFile(cursor.parentSession);
		if (!parent) break;
		if (visited.has(parent.id)) break;
		visited.add(parent.id);
		cursor = parent;
	}

	const rootId = cursor?.id ?? currentSessionId;
	rememberSessionRoot(currentSessionId, rootId);
	return rootId;
}

function readSessionHeaderFromFile(filePath: string): SessionHeader | null {
	// Read at most MAX_HEADER_BYTES from the start of the file — enough for
	// the JSON header line, bounded if a file is unexpectedly huge.
	let fd: number | undefined;
	try {
		// O_NONBLOCK so a FIFO with no writer cannot block openSync; it is a
		// no-op for regular files. The fstat check rejects anything unusual.
		fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			return null;
		}
		const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
		const read = readSync(fd, buffer, 0, MAX_HEADER_BYTES, 0);
		const text = buffer.toString("utf8", 0, read);
		const newlineIndex = text.indexOf("\n");
		const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
		if (!firstLine.trim()) return null;
		const parsed = JSON.parse(firstLine) as {
			type?: string;
			id?: string;
			parentSession?: string;
			timestamp?: string;
			cwd?: string;
		};
		if (parsed?.type !== "session" || typeof parsed.id !== "string") return null;
		return {
			type: "session",
			id: parsed.id,
			timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			...(typeof parsed.parentSession === "string" ? { parentSession: parsed.parentSession } : {}),
		};
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore — best-effort close
			}
		}
	}
}
