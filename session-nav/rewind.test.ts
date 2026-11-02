import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildCheckpoints, rewindOptions, type TreeNodeLike } from "./checkpoints.ts";
import { RewindPicker, type RewindResult } from "./rewind-view.ts";
import { cleanPromptTitle, relativeAge } from "./text.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const T0 = Date.parse("2026-11-02T10:00:00Z");

function at(minutes: number): string {
	return new Date(T0 + minutes * 60_000).toISOString();
}

function node(entry: TreeNodeLike["entry"], ...children: TreeNodeLike[]): TreeNodeLike {
	return { entry, children };
}
function user(id: string, text: string, minute: number, ...children: TreeNodeLike[]): TreeNodeLike {
	return node({ id, type: "message", timestamp: at(minute), message: { role: "user", content: text } }, ...children);
}
function assistant(id: string, text: string, tools: string[], minute: number, ...children: TreeNodeLike[]): TreeNodeLike {
	const content = [
		...tools.map((name) => ({ type: "toolCall", name, arguments: {} })),
		...(text ? [{ type: "text", text }] : []),
	];
	return node({ id, type: "message", timestamp: at(minute), message: { role: "assistant", content } }, ...children);
}
function custom(id: string, minute: number, ...children: TreeNodeLike[]): TreeNodeLike {
	return node({ id, type: "custom_message", timestamp: at(minute) }, ...children);
}

// u1 → a1(edit) → u2 → a2 ─┬→ u3 → a3   (current branch, leaf a3)
//                          └→ u3b → a3b (abandoned)
function sampleTree(): TreeNodeLike[] {
	return [
		user("u1", "first prompt", 0,
			custom("ctx", 0,
				assistant("a1", "did it", ["read", "edit"], 1,
					user("u2", "second prompt", 2,
						assistant("a2", "answer two", ["bash"], 3,
							user("u3b", "abandoned idea", 4, assistant("a3b", "nope", [], 5)),
							user("u3", "third prompt", 6, assistant("a3", "answer three", ["write", "apply_patch"], 7))))))),
	];
}

test("checkpoints list prompts only, newest first, with turn stats", () => {
	const checkpoints = buildCheckpoints(sampleTree(), "a3");
	assert.deepEqual(checkpoints.map((c) => c.id), ["u3", "u3b", "u2", "u1"]);
	const [u3, u3b, u2, u1] = checkpoints;
	assert.equal(u3!.isCurrent, true);
	assert.equal(u3!.endIsLeaf, true);
	assert.equal(u3!.edits, 2);
	assert.equal(u3b!.onPath, false);
	assert.equal(u3b!.isCurrent, false);
	assert.equal(u2!.onPath, true);
	// u2's turn follows the current branch child (a2), stopping before u3.
	assert.equal(u2!.endId, "a2");
	assert.equal(u2!.reply, "answer two");
	assert.equal(u2!.tools, 1);
	assert.equal(u2!.edits, 0);
	// Injected custom entries fold into the turn instead of being listed.
	assert.equal(u1!.endId, "a1");
	assert.equal(u1!.edits, 1);
	assert.equal(u1!.tools, 2);
});

test("deep sessions do not overflow the stack", () => {
	let chain: TreeNodeLike = assistant("a-last", "end", [], 20_000);
	for (let i = 19_999; i >= 0; i--) {
		chain = i % 2 === 0 ? user(`u${i}`, `p${i}`, i, chain) : assistant(`a${i}`, `r${i}`, [], i, chain);
	}
	const checkpoints = buildCheckpoints([chain], "a-last");
	assert.equal(checkpoints.length, 10_000);
	assert.equal(checkpoints[0]!.isCurrent, true);
});

test("rewind options hide 'after this answer' at the current leaf", () => {
	const [u3, , u2] = buildCheckpoints(sampleTree(), "a3");
	assert.ok(!rewindOptions(u3!).some((option) => option.action === "after"));
	assert.deepEqual(rewindOptions(u2!).map((option) => option.action), ["edit", "after", "summary", "fork"]);
});

test("titles strip skill markup and collapse whitespace", () => {
	assert.equal(
		cleanPromptTitle('<skill name="bmad-code-review" location="/x/SKILL.md">\nlots\nof\nbody</skill>\n\nreview story 2.2'),
		"skill: bmad-code-review — review story 2.2",
	);
	assert.equal(cleanPromptTitle("  hello\n\n  world "), "hello world");
	assert.equal(relativeAge(T0 - 30_000, T0), "now");
	assert.equal(relativeAge(T0 - 22 * 60_000, T0), "22m");
	assert.equal(relativeAge(T0 - 3 * 3600_000, T0), "3h");
});

function picker(maxRows = 30) {
	const results: (RewindResult | undefined)[] = [];
	const view = new RewindPicker({
		theme,
		checkpoints: buildCheckpoints(sampleTree(), "a3"),
		maxRows: () => maxRows,
		done: (result) => results.push(result),
		requestRender: () => {},
		now: () => T0 + 8 * 60_000,
	});
	return { view, results };
}

test("picker: enter opens actions, choosing one returns checkpoint + action", () => {
	const { view, results } = picker();
	const list = view.render(80).join("\n");
	assert.match(list, /REWIND · 4 checkpoints/);
	assert.match(list, /Files on disk are not changed/);
	assert.match(list, /you are here/);
	assert.match(list, /⑂ alternate/);
	assert.match(list, /you  third prompt/);
	view.handleInput("\x1b[B"); // down → abandoned idea
	view.handleInput("\x1b[B"); // down → second prompt
	view.handleInput("\r");
	assert.equal(view.view, "actions");
	const actions = view.render(80).join("\n");
	assert.match(actions, /Rewind to “second prompt”/);
	assert.match(actions, /Go back to right after this answer/);
	view.handleInput("2");
	assert.deepEqual(results.map((r) => r && [r.checkpoint.id, r.action]), [["u2", "after"]]);
});

test("picker: typing filters, esc clears filter then closes", () => {
	const { view, results } = picker();
	for (const char of "aband") view.handleInput(char);
	const filtered = view.render(80).join("\n");
	assert.match(filtered, /filter aband/);
	assert.doesNotMatch(filtered, /second prompt/);
	assert.equal(view.selected()?.id, "u3b");
	view.handleInput("\x1b");
	assert.equal(view.query, "");
	assert.deepEqual(results, []);
	view.handleInput("\x1b");
	assert.deepEqual(results, [undefined]);
});

test("picker: esc in actions goes back to the list", () => {
	const { view, results } = picker();
	view.handleInput("\r");
	view.handleInput("\x1b");
	assert.equal(view.view, "list");
	assert.deepEqual(results, []);
});

test("picker: every line fits narrow and wide widths, list respects maxRows", () => {
	for (const width of [8, 20, 40, 79, 140]) {
		const { view } = picker(12);
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		view.handleInput("\r");
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
	const { view } = picker(12);
	assert.ok(view.render(80).length <= 14);
});

test("picker starts on 'you are here' even when alternates are newer", () => {
	// Leaf on u2's answer: u3 and u3b are newer alternates.
	const view = new RewindPicker({
		theme,
		checkpoints: buildCheckpoints(sampleTree(), "a2"),
		maxRows: () => 30,
		done: () => {},
		requestRender: () => {},
		now: () => T0,
	});
	assert.equal(view.selected()?.id, "u2");
});
