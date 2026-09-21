// ---------------------------------------------------------------------------
// Detection core: pure text/stream detectors.
//
// Ported from pi-loop-police (MIT, sebaxzero) — see UPSTREAM.md. Every
// detector here is pure: no Pi SDK types, no state, no I/O. The runtime
// (index.ts) owns state and the event plumbing, so these are trivially
// testable with plain strings.
//
// Two layers catch reasoning loops early:
//   character-level — the text ends in two adjacent verbatim copies of a
//   block between WINDOW and MAX_WINDOW chars (the model re-emits content
//   word for word).
//   semantic — every paragraph is fingerprinted by its first
//   FINGERPRINT_LEN chars (leading ordered-list counters normalized, so
//   renumbering "23. 24. 25." cannot disguise a repeat); a fingerprint
//   appearing N times means the model cycles through the same reasoning
//   even when wording drifts or other text sits in between.
// ---------------------------------------------------------------------------

/** A loop detected by one of the stream detectors. */
export interface StreamLoop {
	/** Which detector fired. */
	readonly kind: "char_loop" | "semantic_loop";
	/** Where the repeating tail boundary sits (char offset) for output truncation. */
	readonly boundary: number;
	/** The detected repeating unit (char-level only). */
	readonly unit?: string;
	/** The fingerprint repeated too many times (semantic only). */
	readonly fingerprint?: string;
	/** How many times the repeating unit was observed. */
	readonly count: number;
}

export interface CharLoopOptions {
	/** Shortest repeating block flagged (chars). */
	readonly window: number;
	/** Longest repeating block checked (chars). */
	readonly maxWindow: number;
}

/**
 * Character-level tail detector: does the text end in two adjacent verbatim
 * copies of a block between `window` and `maxWindow` chars? Single O(length)
 * pass over the tail window, cheap even on very long streams.
 */
export function detectCharTailLoop(text: string, options: CharLoopOptions): StreamLoop | undefined {
	const { window, maxWindow } = options;
	if (window <= 0 || maxWindow <= 0) return undefined;

	// Longest checkable unit: bounded by half the text length (two copies
	// must fit) and the maxWindow cap.
	const limit = Math.min(maxWindow, Math.floor(text.length / 2));
	if (limit < window) return undefined;

	for (let size = limit; size >= window; size--) {
		const tail = text.slice(text.length - size);
		const before = text.slice(text.length - size * 2, text.length - size);
		if (before === tail) {
			return {
				kind: "char_loop",
				boundary: text.length - size,
				unit: tail,
				count: 2,
			};
		}
	}
	return undefined;
}

export interface SemanticLoopOptions {
	/** Paragraphs shorter than this are ignored. */
	readonly paraMinLen: number;
	/** Chars used as the paragraph identity key. */
	readonly fingerprintLen: number;
	/** Same fingerprint N times → loop. */
	readonly threshold: number;
}

const ORDERED_LIST_PREFIX = /^\s*\d+\.\s*/;

/**
 * Fingerprint one paragraph: first `fingerprintLen` chars, with a leading
 * ordered-list counter stripped so renumbering cannot disguise a repeat.
 */
export function paragraphFingerprint(paragraph: string, options: Pick<SemanticLoopOptions, "fingerprintLen">): string {
	const normalized = paragraph.replace(ORDERED_LIST_PREFIX, "");
	return normalized.slice(0, Math.max(1, options.fingerprintLen));
}

/**
 * Split text into paragraphs outside ``` code fences. Repeated code
 * structure is legitimate (checklists, per-file reports), so fenced content
 * is skipped entirely rather than fingerprinted.
 */
export function splitParagraphsSkippingCodeFences(text: string): string[] {
	const paragraphs: string[] = [];
	let inFence = false;
	let current: string[] = [];

	for (const line of text.split("\n")) {
		const isFenceLine = /^\s*```/.test(line);
		if (isFenceLine) {
			// Fence boundaries end the paragraph that was accumulating.
			if (current.length > 0) {
				paragraphs.push(current.join("\n"));
				current = [];
			}
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (line.trim().length === 0) {
			if (current.length > 0) {
				paragraphs.push(current.join("\n"));
				current = [];
			}
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) {
		paragraphs.push(current.join("\n"));
	}
	return paragraphs;
}

/**
 * Semantic detector: when the same paragraph fingerprint appears `threshold`
 * times in the text, the model is cycling through the same reasoning.
 */
export function detectSemanticLoop(text: string, options: SemanticLoopOptions): StreamLoop | undefined {
	const { threshold, paraMinLen } = options;
	if (threshold < 2) return undefined;

	const counts = new Map<string, number>();
	const firstBoundary = new Map<string, number>();
	for (const paragraph of splitParagraphsSkippingCodeFences(text)) {
		if (paragraph.length < paraMinLen) continue;
		const fingerprint = paragraphFingerprint(paragraph, options);
		const count = (counts.get(fingerprint) ?? 0) + 1;
		if (!firstBoundary.has(fingerprint)) {
			firstBoundary.set(fingerprint, text.indexOf(paragraph));
		}
		counts.set(fingerprint, count);
		if (count >= threshold) {
			return {
				kind: "semantic_loop",
				boundary: firstBoundary.get(fingerprint) ?? 0,
				fingerprint,
				count,
			};
		}
	}
	return undefined;
}

/**
 * Both stream detectors in priority order: the semantic layer fires first
 * because repeats rarely stay perfectly verbatim — with both layers a loop
 * is typically caught on its third repetition regardless of wording drift.
 */
export function detectStreamLoop(
	text: string,
	charOptions: CharLoopOptions,
	semanticOptions: SemanticLoopOptions,
): StreamLoop | undefined {
	if (text.length === 0) return undefined;
	return (
		detectSemanticLoop(text, semanticOptions) ??
		detectCharTailLoop(text, charOptions)
	);
}

// ---- cross-turn similarity (stagnation + re-derived reasoning) ----

/** Word tokens for Jaccard comparison (lowercase, length ≥ 3). */
export function wordTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length >= 3) tokens.add(raw);
	}
	return tokens;
}

/** Jaccard similarity between two word-token sets. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) {
		if (b.has(token)) shared++;
	}
	return shared / (a.size + b.size - shared);
}

/** Jaccard similarity between two texts via their word tokens. */
export function textSimilarity(a: string, b: string): number {
	return jaccardSimilarity(wordTokens(a), wordTokens(b));
}

/**
 * Cross-turn stagnation: when the last `window` turns of thinking are all
 * ≥ `threshold` word-similar, the model is rephrasing the same plan.
 */
export function isStagnantWindow(
	recentThinking: readonly string[],
	options: { window: number; threshold: number },
): boolean {
	const { window, threshold } = options;
	if (window < 2 || threshold <= 0) return false;
	if (recentThinking.length < window) return false;
	const relevant = recentThinking.slice(-window);
	const current = wordTokens(relevant[relevant.length - 1] ?? "");
	if (current.size === 0) return false;
	for (let i = 0; i < relevant.length - 1; i++) {
		const prior = wordTokens(relevant[i] ?? "");
		if (jaccardSimilarity(prior, current) < threshold) return false;
	}
	return true;
}

// ---- search / read tool classification ----

const SEARCH_TOOLS = new Set(["grep", "find", "glob", "rg", "search", "search_files", "hypa_grep", "hypa_find"]);
const READ_TOOLS = new Set(["read", "view", "cat", "hypa_read", "open"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit"]);

export function isSearchTool(toolName: string): boolean {
	return SEARCH_TOOLS.has(toolName.toLowerCase());
}

export function isReadTool(toolName: string): boolean {
	return READ_TOOLS.has(toolName.toLowerCase());
}

export function isWriteTool(toolName: string): boolean {
	return WRITE_TOOLS.has(toolName.toLowerCase());
}

/** First string argument that looks like a path/pattern for the tool shape. */
export function pickToolPath(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "filePath", "pattern", "query", "glob", "url"]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** Hash a tool call into a cycle key (name + JSON args) for the loop history. */
export function toolCallKey(toolName: string, args: Record<string, unknown> | undefined): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(args ?? {}, Object.keys(args ?? {}).sort());
	} catch {
		serialized = String(args);
	}
	return `${toolName}:${serialized}`;
}
