// ---------------------------------------------------------------------------
// loop-police state: per-session mutable tracking for every detector.
//
// Ported from pi-loop-police (MIT, sebaxzero) — see UPSTREAM.md. The store
// is a plain class (no SDK types) so detectors are testable in isolation.
//
// Blocked calls never enter executed histories: a call that any detector
// blocks did not reach the tool, so it never spends a budget (the file
// ceiling counts only reads that actually ran) and never inflates reported
// counts. The re-read window is cleared on a firing so blocks never chain
// back-to-back.
// ---------------------------------------------------------------------------

import { toolCallKey, isReadTool, isSearchTool, isWriteTool, pickToolPath } from "./detect.js";

/** One executed read in the re-read window. */
export interface ReadRecord {
	readonly path: string;
	/** True when a write to this path invalidated the earlier read. */
	invalidated: boolean;
}

export type DetectionEventKind =
	| "thinking_loop"
	| "semantic_loop"
	| "output_loop"
	| "output_semantic_loop"
	| "stagnation"
	| "file_scan_loop"
	| "redundant_reread"
	| "search_spiral"
	| "tool_loop"
	| "rederived_reasoning";

export interface LoopPoliceState {
	/** Per-path totals of reads that actually ran (non-blocked). */
	readonly executedReadsByPath: Map<string, number>;
	/** Sliding window of the last real reads (bounded to REREAD_WINDOW). */
	readonly readWindow: ReadRecord[];
	/** Per-pattern set of distinct paths a search pattern reached. */
	readonly searchPathsByPattern: Map<string, Set<string>>;
	/** Cycle-key history of executed tool calls. */
	readonly toolCallHistory: string[];
	/** Session-banned cycle keys (TOOL_LOOP_BAN=2). */
	readonly bannedToolCalls: Set<string>;
	/** Word-token sets of the last N turns' thinking. */
	readonly turnThinking: string[];
	/** Consecutive looped turns (escalation counter). */
	consecutiveLoops: number;
	/** Same blocked plan re-derived in a row (STUCK escalation). */
	rederiveStreak: number;
	/** True right after any detection armed the re-derivation guard. */
	rederiveGuardArmed: boolean;
}

export function createLoopPoliceState(): LoopPoliceState {
	return {
		executedReadsByPath: new Map(),
		readWindow: [],
		searchPathsByPattern: new Map(),
		toolCallHistory: [],
		bannedToolCalls: new Set(),
		turnThinking: [],
		consecutiveLoops: 0,
		rederiveStreak: 0,
		rederiveGuardArmed: false,
	};
}

/** Clear all state (/loop-police reset). */
export function resetLoopPoliceState(state: LoopPoliceState): void {
	state.executedReadsByPath.clear();
	state.readWindow.length = 0;
	state.searchPathsByPattern.clear();
	state.toolCallHistory.length = 0;
	state.bannedToolCalls.clear();
	state.turnThinking.length = 0;
	state.consecutiveLoops = 0;
	state.rederiveStreak = 0;
	state.rederiveGuardArmed = false;
}

// ---- tool-call sequence loop ----

export interface ToolLoopDecision {
	/** True when the identical call sequence repeats back-to-back. */
	readonly looped: boolean;
	/** Cycle length when looped (number of repeated calls). */
	readonly windowSize: number;
	/** True when this exact call is session-banned (TOOL_LOOP_BAN=2). */
	readonly banned: boolean;
}

/**
 * Check the pending call against the history and ban set. An interleaved
 * different action breaks adjacency: build → edit → build never trips, so
 * legitimate re-runs after real changes are fine.
 */
export function checkToolCallSequence(
	state: LoopPoliceState,
	toolName: string,
	args: Record<string, unknown> | undefined,
	ban: number,
): ToolLoopDecision {
	if (ban <= 0) return { looped: false, windowSize: 0, banned: false };
	const key = toolCallKey(toolName, args);
	const banned = ban >= 2 && state.bannedToolCalls.has(key);
	if (banned) {
		return { looped: true, windowSize: 1, banned };
	}

	// Any cycle length: the last W history entries must exactly repeat the
	// W entries before them once the pending key is appended.
	const history = state.toolCallHistory;
	for (let w = 1; w <= Math.floor(history.length / 2) + 1; w++) {
		if (history.length < w * 2 - 1) continue;
		const prior = history.slice(history.length - (w * 2 - 1), history.length - (w - 1));
		const recent = history.slice(history.length - (w - 1));
		const pending = [...recent, key];
		if (
			prior.length === w &&
			pending.length === w &&
			prior.every((entry, i) => entry === pending[i])
		) {
			return { looped: true, windowSize: w, banned: false };
		}
	}
	return { looped: false, windowSize: 0, banned: false };
}

/** Record an executed (non-blocked) call; exempt calls also break adjacency. */
export function recordToolCall(state: LoopPoliceState, toolName: string, args: Record<string, unknown> | undefined): void {
	state.toolCallHistory.push(toolCallKey(toolName, args));
	if (state.toolCallHistory.length > 64) {
		state.toolCallHistory.splice(0, state.toolCallHistory.length - 64);
	}
}

// ---- file read ceiling + redundant re-read window ----

export interface ReadCheckDecision {
	/** Ceiling block: this path has been read FILE_SCAN_LIMIT times. */
	readonly ceilingBlocked: boolean;
	readonly executedCount: number;
	/** Re-read window block: ≥ REREAD_RATIO of the window is redundant. */
	readonly reReadBlocked: boolean;
	readonly redundantCount: number;
}

/**
 * Classify a pending read. Per-path ceiling counts only reads that actually
 * ran; the re-read window marks a read redundant when its path was already
 * read and has not been written since (read → edit → re-read counts as
 * fresh, because the edit invalidated what was in context).
 */
export function checkRead(
	state: LoopPoliceState,
	toolName: string,
	args: Record<string, unknown> | undefined,
	options: { fileScanLimit: number; reReadWindow: number; reReadRatio: number },
): ReadCheckDecision & { path?: string } {
	const path = pickToolPath(args ?? {}) ?? "";
	const executedCount = state.executedReadsByPath.get(path) ?? 0;

	let ceilingBlocked = false;
	if (options.fileScanLimit > 0 && executedCount >= options.fileScanLimit) {
		ceilingBlocked = true;
	}

	let reReadBlocked = false;
	let redundantCount = 0;
	if (options.reReadWindow > 0 && path.length > 0) {
		const window = state.readWindow.slice(-options.reReadWindow);
		// Redundancy is a property of each window entry: a record is redundant
		// when its path was already read earlier in the window and has not
		// been written since (read → edit → re-read counts as fresh because
		// the edit invalidated what was in context).
		const seen = new Set<string>();
		let redundantInWindow = 0;
		for (const record of window) {
			if (seen.has(record.path) && !record.invalidated) {
				redundantInWindow += 1;
			}
			seen.add(record.path);
		}
		redundantCount = redundantInWindow;
		if (window.length >= options.reReadWindow) {
			reReadBlocked = redundantInWindow / window.length >= options.reReadRatio;
		}
	}

	return { ceilingBlocked, executedCount, reReadBlocked, redundantCount, path };
}

/** Record an executed read in the ceiling totals and the re-read window. */
export function recordRead(
	state: LoopPoliceState,
	path: string,
	options: { reReadWindow: number },
): void {
	if (path.length === 0) return;
	state.executedReadsByPath.set(path, (state.executedReadsByPath.get(path) ?? 0) + 1);

	// Reads never invalidate each other: only a WRITE to a previously-read
	// path invalidates the earlier read (handled by recordWrite).
	state.readWindow.push({ path, invalidated: false });
	if (state.readWindow.length > options.reReadWindow) {
		state.readWindow.splice(0, state.readWindow.length - options.reReadWindow);
	}
}

/** A write to a previously-read path invalidates the earlier read. */
export function recordWrite(state: LoopPoliceState, path: string): void {
	if (path.length === 0) return;
	for (const record of state.readWindow) {
		if (record.path === path) record.invalidated = true;
	}
}

/** Clear the re-read window on a firing so blocks never chain back-to-back. */
export function clearReadWindow(state: LoopPoliceState): void {
	state.readWindow.length = 0;
}

// ---- search expansion spiral ----

export interface SearchCheckDecision {
	readonly blocked: boolean;
	readonly pathCount: number;
}

/**
 * Track distinct locations per search pattern. A call that would reach
 * SEARCH_EXPAND_LIMIT locations is blocked and not recorded as executed.
 */
export function checkSearch(
	state: LoopPoliceState,
	toolName: string,
	args: Record<string, unknown> | undefined,
	limit: number,
): SearchCheckDecision & { pattern?: string; path?: string } {
	if (!isSearchTool(toolName) || limit <= 0) {
		return { blocked: false, pathCount: 0 };
	}
	const pattern = pickToolPath(args ?? {});
	if (pattern === undefined) {
		return { blocked: false, pathCount: 0 };
	}
	const paths = state.searchPathsByPattern.get(pattern) ?? new Set<string>();
	const pathCount = paths.size;
	// The pending call would reach the next distinct location: block when it
	// would be the limit-th (recorded + 1 ≥ limit).
	return { blocked: pathCount + 1 >= limit, pathCount, pattern, path: pattern };
}

/** Record an executed search in the per-pattern location set. */
export function recordSearch(state: LoopPoliceState, pattern: string, location: string): void {
	if (pattern.length === 0) return;
	const paths = state.searchPathsByPattern.get(pattern) ?? new Set<string>();
	paths.add(location);
	state.searchPathsByPattern.set(pattern, paths);
}

// ---- tool classification helpers (re-exported for the runtime) ----

export { isReadTool, isWriteTool, isSearchTool, pickToolPath };
