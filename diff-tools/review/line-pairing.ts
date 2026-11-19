import * as Diff from "diff";

/** One aligned row of a change block. `similar` rows get word-level emphasis. */
export interface PairedRow {
	del: number | null;
	add: number | null;
	similar: boolean;
}

export type CharRange = [number, number];

export interface WordHighlights {
	oldRanges: CharRange[];
	newRanges: CharRange[];
}

/** Minimum token similarity for two lines to count as an edit of each other. */
export const PAIR_MIN_SIMILARITY = 0.4;
/** Above this changed share of a line, emphasis is noise: the whole line changed. */
const MAX_HIGHLIGHT_SHARE = 0.75;
// NOTE: bounds the O(n·m) alignment; larger blocks fall back to index pairing.
const MAX_ALIGN_CELLS = 4_000;
const BLANK_PAIR_SCORE = PAIR_MIN_SIMILARITY + 0.01;
const TOKEN_RE = /[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu;

function tokens(line: string): string[] {
	return line.match(TOKEN_RE) ?? [];
}

/** Dice coefficient over token multisets; blank lines only weakly match each other. */
export function lineSimilarity(a: string, b: string): number {
	const left = tokens(a);
	const right = tokens(b);
	if (left.length === 0 && right.length === 0) return BLANK_PAIR_SCORE;
	if (left.length === 0 || right.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
	let common = 0;
	for (const token of right) {
		const count = counts.get(token) ?? 0;
		if (count > 0) {
			common += 1;
			counts.set(token, count - 1);
		}
	}
	return (2 * common) / (left.length + right.length);
}

function zipRows(
	dels: number[],
	adds: number[],
	rows: PairedRow[],
	similarity?: (del: number, add: number) => number,
): void {
	const count = Math.max(dels.length, adds.length);
	for (let index = 0; index < count; index++) {
		const del = dels[index] ?? null;
		const add = adds[index] ?? null;
		const similar =
			!!similarity &&
			del !== null &&
			add !== null &&
			similarity(del, add) >= PAIR_MIN_SIMILARITY;
		rows.push({ del, add, similar });
	}
}

/**
 * Align deleted and added lines so that edits of the same line share a row.
 * Unmatched lines between two matches are zipped side by side without emphasis.
 */
export function pairChangedLines(dels: string[], adds: string[]): PairedRow[] {
	const rows: PairedRow[] = [];
	const n = dels.length;
	const m = adds.length;
	if (n === 0 || m === 0 || n * m > MAX_ALIGN_CELLS) {
		const range = (length: number) => Array.from({ length }, (_, i) => i);
		zipRows(range(n), range(m), rows, (d, a) =>
			lineSimilarity(dels[d], adds[a]),
		);
		return rows;
	}

	const sim: number[][] = dels.map((del) =>
		adds.map((add) => lineSimilarity(del, add)),
	);
	// Monotonic alignment maximizing total similarity of matched pairs.
	const score: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const s = sim[i - 1][j - 1];
			const match =
				s >= PAIR_MIN_SIMILARITY ? score[i - 1][j - 1] + s : -Infinity;
			score[i][j] = Math.max(match, score[i - 1][j], score[i][j - 1]);
		}
	}
	const matches: Array<[number, number]> = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		const s = sim[i - 1][j - 1];
		if (
			s >= PAIR_MIN_SIMILARITY &&
			score[i][j] === score[i - 1][j - 1] + s
		) {
			matches.push([i - 1, j - 1]);
			i -= 1;
			j -= 1;
		} else if (score[i][j] === score[i - 1][j]) i -= 1;
		else j -= 1;
	}
	matches.reverse();

	let nextDel = 0;
	let nextAdd = 0;
	for (const [del, add] of [...matches, [n, m] as [number, number]]) {
		const gapDels: number[] = [];
		const gapAdds: number[] = [];
		for (; nextDel < del; nextDel++) gapDels.push(nextDel);
		for (; nextAdd < add; nextAdd++) gapAdds.push(nextAdd);
		zipRows(gapDels, gapAdds, rows);
		if (del < n && add < m) rows.push({ del, add, similar: true });
		nextDel = del + 1;
		nextAdd = add + 1;
	}
	return rows;
}

function trimRange(text: string, [start, end]: CharRange): CharRange | null {
	while (start < end && /\s/.test(text[start])) start += 1;
	while (end > start && /\s/.test(text[end - 1])) end -= 1;
	return start < end ? [start, end] : null;
}

/** Join ranges split only by whitespace or one punctuation character. */
function mergeRanges(text: string, ranges: CharRange[]): CharRange[] {
	const merged: CharRange[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && text.slice(last[1], range[0]).trim().length <= 1) {
			last[1] = range[1];
		} else merged.push([range[0], range[1]]);
	}
	return merged;
}

function changedShare(text: string, ranges: CharRange[]): number {
	const total = text.replace(/\s/g, "").length;
	if (total === 0) return 0;
	let changed = 0;
	for (const [start, end] of ranges)
		changed += text.slice(start, end).replace(/\s/g, "").length;
	return changed / total;
}

/**
 * Character ranges to emphasize inside a paired line. Whitespace-only edits are
 * ignored; returns null when nothing (or nearly everything) changed.
 */
export function wordHighlights(
	oldText: string,
	newText: string,
): WordHighlights | null {
	const oldRaw: CharRange[] = [];
	const newRaw: CharRange[] = [];
	let oldPos = 0;
	let newPos = 0;
	for (const part of Diff.diffWordsWithSpace(oldText, newText)) {
		const length = part.value.length;
		if (part.removed) {
			oldRaw.push([oldPos, oldPos + length]);
			oldPos += length;
		} else if (part.added) {
			newRaw.push([newPos, newPos + length]);
			newPos += length;
		} else {
			oldPos += length;
			newPos += length;
		}
	}
	const clean = (text: string, ranges: CharRange[]) =>
		mergeRanges(
			text,
			ranges
				.map((range) => trimRange(text, range))
				.filter((range): range is CharRange => range !== null),
		);
	const oldRanges = clean(oldText, oldRaw);
	const newRanges = clean(newText, newRaw);
	if (oldRanges.length === 0 && newRanges.length === 0) return null;
	if (
		changedShare(oldText, oldRanges) > MAX_HIGHLIGHT_SHARE ||
		changedShare(newText, newRanges) > MAX_HIGHLIGHT_SHARE
	)
		return null;
	return { oldRanges, newRanges };
}

/** Emphasis ranges per deleted/added line index for one change block. */
export function blockHighlights(
	dels: string[],
	adds: string[],
): {
	rows: PairedRow[];
	delRanges: Map<number, CharRange[]>;
	addRanges: Map<number, CharRange[]>;
} {
	const rows = pairChangedLines(dels, adds);
	const delRanges = new Map<number, CharRange[]>();
	const addRanges = new Map<number, CharRange[]>();
	for (const row of rows) {
		if (!row.similar || row.del === null || row.add === null) continue;
		const highlights = wordHighlights(dels[row.del], adds[row.add]);
		if (!highlights) continue;
		delRanges.set(row.del, highlights.oldRanges);
		addRanges.set(row.add, highlights.newRanges);
	}
	return { rows, delRanges, addRanges };
}
