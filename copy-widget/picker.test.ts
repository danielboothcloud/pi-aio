import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CopyableBlock } from "./parse.ts";
import { blockLabel, CopyBlockPicker } from "./picker.ts";

initTheme("dark", false);

const theme = {
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

function blocks(count: number): CopyableBlock[] {
	return Array.from({ length: count }, (_, index) => ({
		kind: "code" as const,
		text: `const value${index + 1} = ${index + 1};\n`.repeat(12).trimEnd(),
		info: "typescript",
		language: "typescript",
		lineCount: 12,
		ordinal: index + 1,
	}));
}

test("navigation clamps and Enter returns the selected block", () => {
	const items = blocks(8);
	let selected: CopyableBlock | undefined;
	let renders = 0;
	const picker = new CopyBlockPicker({
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
	let selected: CopyableBlock | undefined;
	const picker = new CopyBlockPicker({
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
	let selected: CopyableBlock | undefined = blocks(1)[0];
	const picker = new CopyBlockPicker({
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

test("compact rendering preserves controls within tiny row budgets", () => {
	for (const maxRows of [1, 2, 3, 4, 8]) {
		const picker = new CopyBlockPicker({
			blocks: blocks(10),
			theme,
			requestRender: () => {},
			getMaxRows: () => maxRows,
			done: () => {},
		});
		const lines = picker.render(36);
		assert.ok(lines.length <= maxRows);
		assert.ok(lines.some((line) => line.includes("#1")));
		if (maxRows >= 2) assert.ok(lines.some((line) => line.includes("Enter copy")));
		if (maxRows >= 3) assert.match(lines.at(-1) ?? "", /╰/);
		for (const line of lines) assert.ok(visibleWidth(line) <= 36);
	}
});

test("copy picker uses the editor's muted frame and fits ANSI/wide content", () => {
	const roles: string[] = [];
	const themed = {
		...theme,
		fg: (role: string, text: string) => { roles.push(role); return `\x1b[32m${text}\x1b[0m`; },
	} as unknown as Theme;
	const items = blocks(2);
	items[0]!.text = "界".repeat(80);
	const picker = new CopyBlockPicker({ blocks: items, theme: themed, requestRender() {}, getMaxRows: () => 18, done() {} });
	for (const width of [0, 1, 4, 5, 12, 64]) {
		for (const line of picker.render(width)) assert.ok(visibleWidth(line) <= width);
	}
	assert.ok(roles.includes("borderMuted"));
	assert.ok(!roles.includes("border"));
});

test("quotes get a word-count label with a snippet and a quoted preview", () => {
	const quote: CopyableBlock = {
		kind: "quote",
		text: "Hi Jack, I checked the switch for Equativ. The only roles on that account are Admin and Trafficker.\n\nLet me know.",
		lineCount: 3,
		ordinal: 2,
	};
	assert.equal(blockLabel(quote), "#2 · quote · 21 words · Hi Jack, I checked the switch for Equat…");

	let selected: CopyableBlock | undefined;
	const picker = new CopyBlockPicker({
		blocks: [blocks(1)[0]!, quote],
		theme,
		requestRender() {},
		getMaxRows: () => 24,
		done: (result) => {
			selected = result;
		},
	});
	picker.handleInput("j");
	const lines = picker.render(60);
	assert.match(lines[1] ?? "", /COPY · 2 blocks in last response/);
	assert.ok(lines.some((line) => line.includes("Hi Jack, I checked")), "preview shows the quote");
	for (const line of lines) assert.ok(visibleWidth(line) <= 60);
	picker.handleInput("\r");
	assert.equal(selected, quote);
});

test("render stays within the overlay row and column budgets", () => {
	const maxRows = 18;
	const width = 64;
	const picker = new CopyBlockPicker({
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
