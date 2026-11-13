import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ChangedFile } from "./git.js";
import type { CommitGroup } from "./plan.js";
import { CommitPlanView, type PlanAction } from "./view.js";

const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const FILES: ChangedFile[] = [
	{ path: "a.ts", status: "M", added: 1, deleted: 0 },
	{ path: "b.ts", status: "A", added: 3, deleted: 0 },
	{ path: "c.ts", status: "D", added: 0, deleted: 4 },
];

function view(groups: CommitGroup[], rows = 40) {
	const actions: PlanAction[] = [];
	const component = new CommitPlanView({
		theme,
		branch: "main",
		groups,
		files: FILES,
		unstagedCount: 2,
		notice: "Suggestion failed: boom",
		requestRender: () => {},
		getMaxRows: () => rows,
		done: (action) => actions.push(action),
	});
	return { component, actions };
}

const GROUPS: CommitGroup[] = [
	{ message: "feat(a): add a", files: ["a.ts", "b.ts"], include: true },
	{ message: "bad message", files: ["c.ts"], include: true },
];

describe("CommitPlanView", () => {
	it("renders groups, files, warnings, and keeps lines within width", () => {
		for (const width of [30, 60, 120]) {
			const lines = view(GROUPS).component.render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide at ${width}: ${line}`);
		}
		const text = view(GROUPS).component.render(120).join("\n");
		assert.match(text, /GIT COMMIT · main · 2 commits · 3 files/);
		assert.match(text, /feat\(a\): add a/);
		assert.match(text, /A b\.ts {2}\+3 -0/);
		assert.match(text, /not type\(scope\): description/);
		assert.match(text, /2 unstaged files not included/);
		assert.match(text, /Suggestion failed: boom/);
	});

	it("respects the row budget", () => {
		const lines = view(GROUPS, 10).component.render(80);
		assert.ok(lines.length <= 10);
	});

	it("moves a file to the next group and merges groups", () => {
		const { component, actions } = view(GROUPS);
		component.handleInput("j"); // a.ts
		component.handleInput("\u001b[C"); // right: move a.ts to group 2
		component.handleInput("c");
		const commit = actions.at(-1);
		assert.equal(commit?.type, "commit");
		assert.deepEqual(commit?.type === "commit" && commit.groups.map((g) => g.files), [["b.ts"], ["c.ts", "a.ts"]]);

		component.handleInput("k");
		component.handleInput("k");
		component.handleInput("k"); // group 1 header
		component.handleInput("m");
		component.handleInput("c");
		const merged = actions.at(-1);
		assert.deepEqual(merged?.type === "commit" && merged.groups.map((g) => g.files), [["b.ts", "c.ts", "a.ts"]]);
	});

	it("skips groups with space and reports edit, regenerate, cancel", () => {
		const { component, actions } = view(GROUPS);
		component.handleInput(" ");
		component.handleInput("c");
		const skipped = actions.at(-1);
		assert.deepEqual(skipped?.type === "commit" && skipped.groups.map((g) => g.include), [false, true]);
		component.handleInput("\r");
		assert.deepEqual(actions.at(-1), { type: "edit", groups: (skipped as { groups: CommitGroup[] }).groups, cursor: { group: 0, file: -1 } });
		component.handleInput("r");
		assert.equal(actions.at(-1)?.type, "regenerate");
		component.handleInput("\u001b");
		assert.deepEqual(actions.at(-1), { type: "cancel" });
	});
});
