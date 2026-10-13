import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { BashHintEditor } from "../user-bash/bash-hint-editor.ts";
import { QueueEditor } from "../queue/queue-editor.ts";
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

function makeShellBase(queued = false, rows = 24) {
	const statuses: Array<string | undefined> = [];
	const editorTheme: EditorTheme = {
		borderColor: (text) => `\x1b[32m${text}\x1b[39m`,
		selectList: {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		},
	};
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { theme, setWidget() {}, setStatus(_key: string, text: string | undefined) { statuses.push(text); } },
	} as unknown as ExtensionContext;
	const tui = { terminal: { rows }, requestRender() {} } as unknown as TUI;
	const keybindings = getKeybindings() as never;
	const base = queued
		? new QueueEditor(tui, editorTheme, keybindings, ctx, { onEmptySubmit: () => false })
		: new BashHintEditor(tui, editorTheme, keybindings, ctx);
	base.setPaddingX(0);
	base.focused = true;
	return { base, statuses };
}

test("! and !! use one frame with an integrated mode badge and run hint", () => {
	for (const queued of [false, true]) {
		const { base, statuses } = makeShellBase(queued);
		const editor = new MinimalistFrameEditor(base as never, editorOptions);
		for (const [input, label] of [
			["!", "! bash"], ["!!", "!! hidden"],
			["! pwd", "! bash"], ["!! pwd", "!! hidden"],
			["! echo 日本語", "! bash"], ["!! echo 日本語", "!! hidden"],
		] as const) {
			editor.setText(input);
			assert.equal(statuses.at(-1), undefined, "the frame owns the mode, not a duplicate footer");
			const lines = editor.render(80);
			assert.equal(lines.length, 3, `${input}: top, input, bottom only`);
			assert.ok(lines[0]!.includes(label));
			assert.match(lines[0]!, /Enter to run/);
			assert.match(lines[0]!, /^╭/);
			assert.match(lines.at(-1)!, /^╰/);
			assert.doesNotMatch(lines[1]!, /─{3}|Enter to run|hidden|bash/);
			assert.ok(lines[1]!.includes(CURSOR_MARKER), "IME cursor preserved");
			// Native Pi wrapping needs room for a two-cell CJK glyph plus padding.
			const widths = input.includes("日本語") ? [8, 12, 24, 40, 80, 160] : [1, 4, 5, 8, 12, 24, 40, 80, 160];
			for (const width of widths) {
				for (const line of editor.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			}
		}
		editor.setText("normal input");
		assert.doesNotMatch(editor.render(80)[0]!, /bash|hidden|Enter to run/);
	}
});

test("shell chrome ownership clears existing status and can be restored", () => {
	const { base, statuses } = makeShellBase();
	base.setText("!! pwd");
	assert.equal(statuses.at(-1), "!!bash");
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	assert.equal(statuses.at(-1), undefined, "construction clears a preexisting shell status");
	assert.match(editor.render(80)[0]!, /!! hidden/);
	base.setFrameChrome(false);
	assert.equal(statuses.at(-1), "!!bash");
	assert.match(base.render(80)[0]!, /!! hidden/);
});

test("typing !, !!, and a command keeps framed shell status suppressed", () => {
	const { base, statuses } = makeShellBase(true);
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	for (const [key, text, label] of [["!", "!", "! bash"], ["!", "!!", "!! hidden"], ["p", "!! p", "!! hidden"]] as const) {
		editor.handleInput(key);
		assert.equal(editor.getText(), text);
		assert.match(editor.render(80)[0]!, new RegExp(label));
		assert.equal(statuses.at(-1), undefined);
	}
});

test("native shell fallback restores hints without changing status during render", () => {
	const { base, statuses } = makeShellBase();
	const editor = new MinimalistFrameEditor(base as never, editorOptions);
	editor.setText("!! pwd");
	// Force the frame's compatibility fallback without mutating native autocomplete state.
	base.isShowingAutocomplete = () => true;
	const before = statuses.length;
	const lines = editor.render(80);
	assert.match(lines[0]!, /!! hidden/);
	assert.match(lines[0]!, /Enter to run/);
	assert.doesNotMatch(lines[0]!, /╭/);
	assert.equal(statuses.length, before, "render has no status side effects");
	assert.equal(statuses.at(-1), undefined);
	for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});

test("framed shell input retains native viewport indicators", () => {
	for (const prefix of ["!", "!!"]) {
		const { base } = makeShellBase(false, 12);
		const editor = new MinimalistFrameEditor(base as never, editorOptions);
		editor.setText(`${prefix} first\n${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}`);
		const lines = editor.render(120);
		assert.match(lines[0]!, /↑ [1-9]\d* more/);
		assert.ok(lines.slice(1, -1).every((line) => !/─{3}/.test(line)), "no nested native borders");
	}
});

test("unframed shell editors retain their own mode badge and status", () => {
	const { base, statuses } = makeShellBase();
	for (const [input, label, status] of [["! pwd", "! bash", "!bash"], ["!! pwd", "!! hidden", "!!bash"]]) {
		base.setText(input!);
		const lines = base.render(80);
		assert.ok(lines[0]!.includes(label!));
		assert.match(lines[0]!, /Enter to run/);
		assert.equal(statuses.at(-1), status);
	}
});

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
