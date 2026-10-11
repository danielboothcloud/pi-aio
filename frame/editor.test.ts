import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { BashHintEditor } from "../user-bash/bash-hint-editor.ts";
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

test("the base editor's rule borders are stripped, not double-framed", () => {
	// Regression: Pi's editor renders its own `────` rule rows; passing them
	// through as content produced a border-inside-a-border. The frame must
	// consume them.
	const base = makeBase();
	base.render = function (width: number) {
		this.calls.push(`render:${width}`);
		return ["─".repeat(width), "typing text".slice(0, width), "─".repeat(width)];
	};
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	const lines = editor.render(60);

	// Exactly one frame: top border, one content row, bottom border.
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /^╭/);
	assert.match(lines[1]!, /^│ typing text\s+│$/);
	assert.match(lines.at(-1)!, /^╰/);
	assert.equal(lines.filter((line) => /^│ ─+ │$/.test(line)).length, 0);
});

test("viewport indicators from base rules surface in the frame borders", () => {
	const base = makeBase();
	base.render = function (width: number) {
		this.calls.push(`render:${width}`);
		return [
			`─── ↑ 3 more ${"─".repeat(Math.max(0, width - 11))}`,
			"typing text".slice(0, width),
			`─── ↓ 2 more ${"─".repeat(Math.max(0, width - 11))}`,
		];
	};
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	const lines = editor.render(60);
	assert.match(lines[0]!, /↑ 3 more/);
	assert.match(lines.at(-1)!, /↓ 2 more/);
	assert.doesNotMatch(lines[1]!, /─{3}/);
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

test("real padded editor keeps slash, argument, and file completions inside the frame", async () => {
	const plain = (text: string) => text;
	const editorTheme: EditorTheme = {
		borderColor: plain,
		selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
	};
	const ctx = { mode: "tui", hasUI: true, ui: { theme, setWidget() {}, setStatus() {} } } as unknown as ExtensionContext;
	for (const prefix of ["/", "/effort ", "@src/"]) {
		const base = new BashHintEditor(
			{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
			editorTheme, getKeybindings() as never, ctx,
		);
		base.setPaddingX(0); // BashHintEditor enforces Pi's real minimum padding of 1.
		base.focused = true;
		base.setAutocompleteProvider({
			getSuggestions: () => ({ prefix, items: [
				{ value: "one", label: "one", description: "first completion" },
				{ value: "two", label: "two", description: "second completion" },
			] }),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		base.setText(prefix);
		base.handleInput("\t");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(base.isShowingAutocomplete(), true, prefix);
		const editor = new MinimalistFrameEditor(base as never, editorOptions);
		for (const width of [12, 40, 80]) {
			const lines = editor.render(width);
			assert.match(lines[0]!, /^╭/);
			assert.match(lines.at(-1)!, /^╰/);
			assert.equal(lines.filter((line) => /^├─+┤$/.test(line)).length, 1);
			assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), "IME cursor preserved");
			assert.ok(lines.some((line) => line.startsWith("│ → ")), "no extra native left padding");
			if (width >= 40) assert.ok(lines.some((line) => line.startsWith("│ → one")));
			for (const line of lines) assert.ok(visibleWidth(line) <= width, line);
		}
		base.handleInput("\x1b[B");
		assert.ok(editor.render(80).some((line) => line.startsWith("│ → two")));
		base.handleInput("\x1b");
		assert.equal(base.isShowingAutocomplete(), false);
		assert.equal(editor.render(80).filter((line) => /^├─+┤$/.test(line)).length, 0);
	}
});

test("changed autocomplete content remains a native fallback", () => {
	const list = { render: () => ["one"] };
	const base = makeBase({ isShowingAutocomplete: () => true, autocompleteList: list });
	base.render = function () {
		list.render();
		return ["body", "prefix one"];
	};
	assert.deepEqual(new MinimalistFrameEditor(base as never, editorOptions).render(60), ["body", "prefix one"]);
});

test("renderWithAutocompleteCapture is a no-op without an autocomplete list", () => {
	const source = { isShowingAutocomplete: () => true };
	const { value, capture } = renderWithAutocompleteCapture(source as never, () => ["body"]);
	assert.deepEqual(value, ["body"]);
	assert.equal(capture, undefined);
});
