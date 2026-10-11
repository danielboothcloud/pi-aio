// Per-session state: scope evaluation, pending tool-call tracking (TTL +
// caps), file-change collection for session.idle, and tool_args redaction
// before serialization. Ported from pi-yaml-hooks (MIT).

import type { FileChange } from "./types.js";

export type SessionScope = "all" | "main" | "child";

interface PendingToolCallEntry {
	readonly sessionID: string;
	readonly toolArgs: Record<string, unknown>;
	readonly insertedAt: number;
}

interface SessionRecord {
	parentID?: string | null;
	rootSessionID?: string;
	changes: Map<string, FileChange>;
	activeIdleDispatchKeys?: Set<string>;
	replayedDuringIdleKeys: Set<string>;
}

const MAX_DELETED_TOMBSTONES = 256;
const MAX_PENDING_TOOL_CALLS = 1000;
const PENDING_TOOL_CALL_TTL_MS = 5 * 60_000;

export class SessionStateStore {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly pendingToolCalls = new Map<string, PendingToolCallEntry>();
	private readonly deletedTombstones = new Set<string>();
	private readonly nowFn: () => number;

	constructor(options: { nowFn?: () => number } = {}) {
		this.nowFn = options.nowFn ?? (() => Date.now());
	}

	rememberSession(sessionID: string, parentID?: string | null): void {
		const record = this.getOrCreateSession(sessionID);
		if (parentID !== undefined) {
			record.parentID = parentID;
		}
	}

	/**
	 * Evaluate a hook scope against the session lineage. `main` matches the
	 * root session; `child` matches everything else.
	 */
	async evaluateScope(
		sessionID: string,
		scope: SessionScope,
		resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
	): Promise<boolean> {
		if (scope === "all") {
			return true;
		}
		const rootSessionID = await this.getRootSessionID(sessionID, resolveParentID);
		const isMainSession = rootSessionID === sessionID;
		return scope === "main" ? isMainSession : !isMainSession;
	}

	async getRootSessionID(
		sessionID: string,
		resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
	): Promise<string> {
		return this.resolveRootSessionID(sessionID, resolveParentID, new Set(), true);
	}

	isDeleted(sessionID: string): boolean {
		if (this.sessions.has(sessionID)) {
			return false;
		}
		return this.deletedTombstones.has(sessionID);
	}

	deleteSession(sessionID: string): void {
		for (const [callID, pending] of this.pendingToolCalls) {
			if (pending.sessionID === sessionID) {
				this.pendingToolCalls.delete(callID);
			}
		}
		this.sessions.delete(sessionID);
		this.recordTombstone(sessionID);
	}

	private recordTombstone(sessionID: string): void {
		this.deletedTombstones.add(sessionID);
		if (this.deletedTombstones.size > MAX_DELETED_TOMBSTONES) {
			const oldest = this.deletedTombstones.values().next().value;
			if (oldest !== undefined) this.deletedTombstones.delete(oldest);
		}
	}

	setPendingToolCall(callID: string, sessionID: string, toolArgs: Record<string, unknown>): void {
		this.sweepExpiredPendingToolCalls();

		if (this.pendingToolCalls.size >= MAX_PENDING_TOOL_CALLS) {
			// Evict the oldest entry; an unbounded backlog means the host is
			// wedged and dropping the oldest is preferable to leaking.
			const oldest = this.pendingToolCalls.keys().next().value;
			if (oldest !== undefined) {
				this.pendingToolCalls.delete(oldest);
			}
		}

		this.pendingToolCalls.set(callID, { sessionID, toolArgs, insertedAt: this.nowFn() });
	}

	consumePendingToolCall(callID: string): { sessionID: string; toolArgs: Record<string, unknown> } | undefined {
		const pending = this.pendingToolCalls.get(callID);
		if (!pending) {
			return undefined;
		}
		this.pendingToolCalls.delete(callID);
		return { sessionID: pending.sessionID, toolArgs: pending.toolArgs };
	}

	pendingToolCallCount(): number {
		return this.pendingToolCalls.size;
	}

	private sweepExpiredPendingToolCalls(): void {
		if (this.pendingToolCalls.size === 0) {
			return;
		}
		const cutoff = this.nowFn() - PENDING_TOOL_CALL_TTL_MS;
		for (const [callID, entry] of this.pendingToolCalls) {
			if (entry.insertedAt >= cutoff) {
				return;
			}
			this.pendingToolCalls.delete(callID);
		}
	}

	addFileChanges(sessionID: string, changes: Iterable<FileChange>): void {
		const record = this.getOrCreateSession(sessionID);
		for (const change of changes) {
			const key = serializeFileChange(change);
			if (record.activeIdleDispatchKeys?.has(key)) {
				record.replayedDuringIdleKeys.add(key);
			}
			if (!record.changes.has(key)) {
				record.changes.set(key, change);
			}
		}
	}

	getFileChanges(sessionID: string): FileChange[] {
		const record = this.sessions.get(sessionID);
		if (!record || record.changes.size === 0) {
			return [];
		}
		return Array.from(record.changes.values());
	}

	getModifiedPaths(sessionID: string): string[] {
		return getChangedPaths(this.getFileChanges(sessionID));
	}

	beginIdleDispatch(sessionID: string, changes: readonly FileChange[]): void {
		const record = this.getOrCreateSession(sessionID);
		record.activeIdleDispatchKeys = new Set(changes.map((change) => serializeFileChange(change)));
		record.replayedDuringIdleKeys.clear();
	}

	consumeFileChanges(sessionID: string, changes: readonly FileChange[]): void {
		const record = this.sessions.get(sessionID);
		if (!record) {
			return;
		}
		for (const change of changes) {
			const key = serializeFileChange(change);
			const wasReplayed = record.replayedDuringIdleKeys.has(key);
			record.changes.delete(key);
			if (wasReplayed) {
				// Re-insert so the change survives consumption and is replayed
				// on the next idle dispatch.
				record.changes.set(key, change);
			}
		}
		record.activeIdleDispatchKeys = undefined;
		record.replayedDuringIdleKeys.clear();
	}

	cancelIdleDispatch(sessionID: string): void {
		const record = this.sessions.get(sessionID);
		if (!record) {
			return;
		}
		record.activeIdleDispatchKeys = undefined;
		record.replayedDuringIdleKeys.clear();
	}

	private getOrCreateSession(sessionID: string): SessionRecord {
		let record = this.sessions.get(sessionID);
		if (!record) {
			record = { changes: new Map(), replayedDuringIdleKeys: new Set() };
			this.sessions.set(sessionID, record);
		}
		return record;
	}

	/**
	 * Walk the parentID chain to the root session id. The result is cached on
	 * the caller's session record only; intermediate parents are read-only so
	 * a transitive walk never resurrects a deleted session.
	 */
	private async resolveRootSessionID(
		sessionID: string,
		resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
		visited: Set<string>,
		isOriginalCaller: boolean,
	): Promise<string> {
		if (visited.has(sessionID)) {
			// Cycle: treat the cycle entry point as its own root.
			if (isOriginalCaller) {
				const record = this.getOrCreateSession(sessionID);
				record.rootSessionID = sessionID;
			}
			return sessionID;
		}
		visited.add(sessionID);

		const existing = this.sessions.get(sessionID);
		const record = isOriginalCaller ? this.getOrCreateSession(sessionID) : existing;

		let parentID = record?.parentID;
		if (parentID === undefined) {
			parentID = (await resolveParentID(sessionID)) ?? null;
			if (record) {
				record.parentID = parentID;
			}
		}

		if (!parentID) {
			if (record) {
				record.rootSessionID = sessionID;
			}
			return sessionID;
		}

		if (record?.rootSessionID) {
			const parentRootSessionID = this.sessions.get(parentID)?.rootSessionID;
			if (parentRootSessionID && parentRootSessionID === record.rootSessionID) {
				return record.rootSessionID;
			}
		}

		const rootSessionID = await this.resolveRootSessionID(parentID, resolveParentID, visited, false);
		if (record) {
			record.rootSessionID = rootSessionID;
		}
		return rootSessionID;
	}
}

export function getChangedPaths(changes: readonly FileChange[]): string[] {
	const paths = new Set<string>();
	for (const change of changes) {
		if (change.operation === "rename") {
			if (change.fromPath) {
				paths.add(change.fromPath);
			}
			if (change.toPath) {
				paths.add(change.toPath);
			}
			continue;
		}
		if (change.path) {
			paths.add(change.path);
		}
	}
	return Array.from(paths);
}

function serializeFileChange(change: FileChange): string {
	if (change.operation === "rename") {
		return `${change.operation}:${change.fromPath}->${change.toPath}`;
	}
	return `${change.operation}:${change.path}`;
}

/**
 * Redact known-sensitive keys from a tool_args object before serialization.
 * Shallow-clone; recursive over nested objects/arrays.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
	/^password$/i,
	/^token$/i,
	/^api[_-]?key$/i,
	/^secret$/i,
	/^authorization$/i,
	/^auth$/i,
	/^private[_-]?key$/i,
	/^bearer$/i,
];

const REDACTED = "[REDACTED]";
const TOOL_ARGS_MAX_BYTES = 64 * 1024;
const TOOL_ARGS_TRUNCATED_PLACEHOLDER = "[aio yaml hooks: tool_args truncated]";

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Domain type for hook-context values: the JSON-ish shapes a tool_args or
 * hook payload can carry. Redaction operates on this type, never `unknown`.
 */
export type HookContextValue =
	| string
	| number
	| boolean
	| null
	| HookContextValue[]
	| { readonly [key: string]: HookContextValue };

/** Runtime parse of an arbitrary JSON-ish value into the context domain. */
export function toHookContextValue(value: unknown, depth = 0): HookContextValue {
	if (depth > 16) {
		return "[aio yaml hooks: value depth exceeded]";
	}
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => toHookContextValue(entry, depth + 1));
	}
	if (typeof value === "object") {
		const out: Record<string, HookContextValue> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = toHookContextValue(entry, depth + 1);
		}
		return out;
	}
	return String(value);
}

/**
 * Redact known-sensitive keys from a hook-context value before serialization.
 * Shallow-clone per object level; recursive over nested values.
 */
const REDACTION_DEPTH_LIMIT = 8;

export function redactSensitiveKeys(value: HookContextValue, depth = 0): HookContextValue {
	if (depth > REDACTION_DEPTH_LIMIT) {
		return "[aio yaml hooks: redaction depth exceeded]";
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactSensitiveKeys(entry, depth + 1));
	}
	if (typeof value === "object" && value !== null) {
		const redacted: Record<string, HookContextValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			redacted[key] = isSensitiveKey(key) ? REDACTED : redactSensitiveKeys(entry, depth + 1);
		}
		return redacted;
	}
	return value;
}

/**
 * Redact and byte-cap a tool_args object before it reaches the serialized
 * hook context. The 64 KiB cap matches the upstream serialized-args limit.
 */
export function sanitizeToolArgsForSerialization(
	toolArgs: Record<string, unknown> | undefined,
): Record<string, HookContextValue> | undefined {
	if (!toolArgs) {
		return undefined;
	}
	// Parse at the boundary into the context domain, then redact.
	const parsedValue = toHookContextValue(toolArgs);
	if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
		return { _aio_hooks_tool_args_unserializable: true };
	}
	const redactedValue = redactSensitiveKeys(parsedValue);
	if (typeof redactedValue !== "object" || redactedValue === null || Array.isArray(redactedValue)) {
		return { _aio_hooks_tool_args_unserializable: true };
	}
	const redacted = redactedValue;
	let serialized: string;
	try {
		serialized = JSON.stringify(redacted);
	} catch {
		return { _aio_hooks_tool_args_unserializable: true };
	}
	if (Buffer.byteLength(serialized, "utf8") <= TOOL_ARGS_MAX_BYTES) {
		return redacted;
	}
	return {
		_aio_hooks_tool_args_truncated: true,
		_aio_hooks_tool_args_original_bytes: Buffer.byteLength(serialized, "utf8"),
		_aio_hooks_tool_args_placeholder: TOOL_ARGS_TRUNCATED_PLACEHOLDER,
	};
}
