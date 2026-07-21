import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CopyableCodeBlock } from "./parse.ts";
import { CodeBlockPicker } from "./picker.ts";

initTheme("dark", false);

const theme = {
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

function blocks(count: number): CopyableCodeBlock[] {
	return Array.from({ length: count }, (_, index) => ({
		code: `const value${index + 1} = ${index + 1};\n`.repeat(12).trimEnd(),
		info: "typescript",
		language: "typescript",
		lineCount: 12,
		ordinal: index + 1,
	}));
}

test("navigation clamps and Enter returns the selected block", () => {
	const items = blocks(8);
	let selected: CopyableCodeBlock | undefined;
	let renders = 0;
	const picker = new CodeBlockPicker({
		blocks: items,
		theme,
		requestRender: () => renders++,
		getMaxRows: () => 30,
		done: (result) => {
			selected = result;
		},
	});

	picker.handleInput("\x04"); // Ctrl+D.
	picker.handleInput("j");
	picker.handleInput("\r");

	assert.equal(selected?.ordinal, 8);
	assert.equal(renders, 2);
});

test("vim start/end keys jump to the first and last blocks", () => {
	const items = blocks(8);
	let selected: CopyableCodeBlock | undefined;
	const picker = new CodeBlockPicker({
		blocks: items,
		theme,
		requestRender: () => {},
		getMaxRows: () => 30,
		done: (result) => {
			selected = result;
		},
	});

	picker.handleInput("G");
	picker.handleInput("g");
	picker.handleInput("j");
	picker.handleInput("\r");

	assert.equal(selected?.ordinal, 2);
});

test("Escape cancels without returning a block", () => {
	let completed = false;
	let selected: CopyableCodeBlock | undefined = blocks(1)[0];
	const picker = new CodeBlockPicker({
		blocks: blocks(1),
		theme,
		requestRender: () => {},
		getMaxRows: () => 30,
		done: (result) => {
			completed = true;
			selected = result;
		},
	});

	picker.handleInput("\x1b");

	assert.equal(completed, true);
	assert.equal(selected, undefined);
});

test("render stays within the overlay row and column budgets", () => {
	const maxRows = 18;
	const width = 64;
	const picker = new CodeBlockPicker({
		blocks: blocks(10),
		theme,
		requestRender: () => {},
		getMaxRows: () => maxRows,
		done: () => {},
	});

	const lines = picker.render(width);

	assert.ok(lines.length <= maxRows, `rendered ${lines.length} rows, expected at most ${maxRows}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `rendered ${visibleWidth(line)} columns, expected at most ${width}`);
	}
	assert.match(lines.at(-2) ?? "", /Enter copy/);
	assert.match(lines.at(-1) ?? "", /╰/);
});
