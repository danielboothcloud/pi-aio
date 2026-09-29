import assert from "node:assert/strict";
import test from "node:test";
import { MinimalistFrameEditor, renderWithAutocompleteCapture } from "./editor.ts";
import { DEFAULT_FRAME_STYLE } from "./render.ts";

const theme = { fg: (_name: string, text: string) => text };

function makeBase(overrides: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const base = {
		calls,
		text: "",
		focused: false,
		render(width: number): string[] {
			calls.push(`render:${width}`);
			return [`input:${this.text}`, `cursor`].map((line) => line.slice(0, width));
		},
		getText() {
			return this.text;
		},
		setText(text: string) {
			this.text = text;
		},
		handleInput(data: string) {
			calls.push(`input:${data}`);
		},
		invalidate() {
			calls.push("invalidate");
		},
		...overrides,
	};
	return base;
}

const editorOptions = {
	uiTheme: theme,
	style: DEFAULT_FRAME_STYLE,
	getMetadata: () => ({ cwd: "/repo", modelLabel: "m" }),
};

test("the wrapper frames the base render and preserves text handling", () => {
	const base = makeBase();
	base.setText("hello");
	const editor = new MinimalistFrameEditor(base as never, editorOptions);

	const lines = editor.render(60);
	assert.match(lines[0]!, /^╭/);
	assert.match(lines[1]!, /^│ input:hello\s+│$/);
	assert.match(lines.at(-1)!, /^╰/);
	// The base rendered at frame content width (width - 4).
	assert.deepEqual(base.calls, ["render:56"]);
	assert.equal(editor.getText(), "hello");
	editor.setText("changed");
	assert.equal(base.text, "changed");
	editor.handleInput("x");
	assert.deepEqual(base.calls.filter((c) => c.startsWith("input:")), ["input:x"]);
	editor.invalidate();
	assert.ok(base.calls.includes("invalidate"));
});

test("narrow widths fall through to the unframed base render", () => {
	const base = makeBase();
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	const lines = editor.render(4);
	assert.deepEqual(lines, base.render(4));
});

test("autocomplete rows are captured, re-framed, and stripped from the body", () => {
	const rows = ["completion one", "completion two"];
	const list = {
		render(width: number) {
			return rows.map((row) => row.slice(0, width));
		},
	};
	const base = makeBase({
		isShowingAutocomplete: () => true,
		autocompleteList: list,
	});
	// A real editor delegates its trailing autocomplete rows to the list's own
	// render — the capture hook observes exactly that delegation.
	base.render = function (width: number) {
		this.calls.push(`render:${width}`);
		return [
			`input:${this.text}`.slice(0, width),
			...(this.autocompleteList as { render(w: number): string[] }).render(width),
		];
	};
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	const lines = editor.render(60);

	// Top + content + divider + one row per completion + bottom.
	assert.equal(lines.length, 6);
	assert.match(lines[2]!, /^├─+┤$/);
	assert.match(lines[3]!, /^│ completion one\s+│$/);
	assert.match(lines[4]!, /^│ completion two\s+│$/);
	assert.doesNotMatch(lines[1]!, /completion/);
});

test("renderWithAutocompleteCapture restores the predecessor render", () => {
	const list = {
		render(width: number) {
			return [`${width}`];
		},
	};
	const source = { isShowingAutocomplete: () => true, autocompleteList: list };
	// The probe render must delegate to the list, like a real editor does.
	const { value, capture } = renderWithAutocompleteCapture(
		source as never,
		() => ["body", ...(source.autocompleteList as typeof list).render(7)],
	);
	assert.deepEqual(value, ["body", "7"]);
	assert.deepEqual(capture?.rows, ["7"]);
	// Predecessor restored afterwards: direct calls hit the original.
	assert.deepEqual(list.render(5), ["5"]);
	// Predecessor restored: calling render directly hits the original.
	assert.deepEqual(list.render(5), ["5"]);
});

test("renderWithAutocompleteCapture is a no-op without an autocomplete list", () => {
	const source = { isShowingAutocomplete: () => true };
	const { value, capture } = renderWithAutocompleteCapture(source as never, () => ["body"]);
	assert.deepEqual(value, ["body"]);
	assert.equal(capture, undefined);
});
