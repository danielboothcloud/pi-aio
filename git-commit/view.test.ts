import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ChangedFile } from "./git.js";
import { CommitView, type CommitAction } from "./view.js";

const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const FILES: ChangedFile[] = Array.from({ length: 12 }, (_value, index) => ({
	path: `src/file-${index}.ts`,
	status: index === 0 ? "A" : "M",
	added: index,
	deleted: 1,
}));

function view(message: string, rows = 40, files = FILES) {
	const actions: CommitAction[] = [];
	const component = new CommitView({
		theme,
		branch: "main",
		message,
		files,
		unstagedCount: 2,
		notice: "Suggestion failed: boom",
		getMaxRows: () => rows,
		done: (action) => actions.push(action),
	});
	return { component, actions };
}

describe("CommitView", () => {
	it("renders the message, files, warnings, and hints within the width", () => {
		const message = "feat(commit): add the commit overlay\n\nA long body line that explains why the change is needed and wraps.";
		for (const width of [20, 60, 120]) {
			for (const line of view(message).component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `line too wide at ${width}: ${line}`);
			}
		}
		const text = view(message).component.render(120).join("\n");
		assert.match(text, /COMMIT · main · 12 files/);
		assert.match(text, /feat\(commit\): add the commit overlay/);
		assert.match(text, /A long body line/);
		assert.match(text, /A src\/file-0\.ts {2}\+0 -1/);
		assert.match(text, /2 unstaged files not included/);
		assert.match(text, /Suggestion failed: boom/);
		assert.match(text, /c commit · e edit · p commit and push/);
		assert.doesNotMatch(text, /not type\(scope\)/);
		assert.match(view("bad message").component.render(120).join("\n"), /not type\(scope\): description/);
	});

	it("respects the row budget and summarizes hidden files and lines", () => {
		const long = `feat(a): b\n\n${Array.from({ length: 30 }, (_v, i) => `line ${i}`).join("\n")}`;
		for (const rows of [8, 14, 20]) {
			const lines = view(long, rows).component.render(80);
			assert.ok(lines.length <= rows, `${lines.length} > ${rows}`);
		}
		const text = view(long, 20).component.render(80).join("\n");
		assert.match(text, /more line/);
		assert.match(text, /and \d+ more files/);
	});

	it("maps keys to actions", () => {
		const { component, actions } = view("feat(a): b");
		for (const key of ["c", "p", "e", "\r", "r", "x", "\u001b", "q"]) component.handleInput(key);
		assert.deepEqual(actions.map((action) => action.type), ["commit", "push", "edit", "edit", "regenerate", "cancel", "cancel"]);
	});
});
