import { describe, expect, it } from "vitest";

import {
	blockHighlights,
	lineSimilarity,
	pairChangedLines,
	wordHighlights,
} from "./line-pairing.js";

describe("pairChangedLines", () => {
	it("puts an edited line on the same row as its original", () => {
		const rows = pairChangedLines(
			["function unused() {", "\treturn 1;", "}", "export const VALUE = 42;"],
			["export const VALUE = 43;"],
		);
		expect(rows).toEqual([
			{ del: 0, add: null, similar: false },
			{ del: 1, add: null, similar: false },
			{ del: 2, add: null, similar: false },
			{ del: 3, add: 0, similar: true },
		]);
	});

	it("zips unrelated lines between matches without emphasis", () => {
		const rows = pairChangedLines(
			["alpha beta", "const x = 1;"],
			["gamma delta", "const x = 2;"],
		);
		expect(rows).toEqual([
			{ del: 0, add: 0, similar: false },
			{ del: 1, add: 1, similar: true },
		]);
	});

	it("keeps pure additions and deletions one-sided", () => {
		expect(pairChangedLines([], ["a", "b"])).toEqual([
			{ del: null, add: 0, similar: false },
			{ del: null, add: 1, similar: false },
		]);
	});

	it("falls back to index pairing for very large blocks", () => {
		const dels = Array.from({ length: 100 }, (_, i) => `old ${i}`);
		const adds = Array.from({ length: 100 }, (_, i) => `old ${i}`);
		const rows = pairChangedLines(dels, adds);
		expect(rows).toHaveLength(100);
		expect(rows[5]).toEqual({ del: 5, add: 5, similar: true });
	});
});

describe("lineSimilarity", () => {
	it("scores token overlap", () => {
		expect(lineSimilarity("a b", "a b")).toBe(1);
		expect(lineSimilarity("a b", "c d")).toBe(0);
		expect(lineSimilarity("", "x")).toBe(0);
	});
});

describe("wordHighlights", () => {
	it("ignores whitespace-only edits", () => {
		expect(wordHighlights("  return x;", "    return x;")).toBeNull();
	});

	it("trims whitespace and merges fragments split by one character", () => {
		const oldText = "items.filter(Boolean);";
		const newText = "items.filter((item) => item.length > 0);";
		const result = wordHighlights(oldText, newText);
		expect(result?.oldRanges.map(([s, e]) => oldText.slice(s, e))).toEqual([
			"Boolean",
		]);
		expect(result?.newRanges.map(([s, e]) => newText.slice(s, e))).toEqual([
			"(item) => item.length > 0)",
		]);
	});

	it("highlights a pure insertion on one side only", () => {
		const result = wordHighlights("foo(a);", "foo(a, b);");
		expect(result?.oldRanges).toEqual([]);
		expect(result?.newRanges.length).toBe(1);
	});

	it("skips emphasis when nearly the whole line changed", () => {
		expect(wordHighlights("const a = 1;", "let total = compute();")).toBeNull();
	});
});

describe("blockHighlights", () => {
	it("maps emphasis ranges to block line indexes", () => {
		const { delRanges, addRanges } = blockHighlights(
			["drop me entirely", "export const VALUE = 42;"],
			["export const VALUE = 43;"],
		);
		expect([...delRanges.keys()]).toEqual([1]);
		expect([...addRanges.keys()]).toEqual([0]);
	});
});
