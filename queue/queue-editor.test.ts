import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { setEditorIntercepts } from "../ui/editor-intercepts.ts";
import { QueueEditor } from "./queue-editor.ts";

afterEach(() => setEditorIntercepts(undefined));

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

/** pi-tui's registry plus the two app actions the editor consults. */
function keybindings() {
	const base = getKeybindings();
	const app: Record<string, string> = { "app.interrupt": "\x1b", "app.session.resume": "\x12" };
	return new Proxy(base, {
		get(target, key, receiver) {
			if (key === "matches") {
				return (data: string, id: string) => (id in app ? data === app[id] : target.matches(data, id as never));
			}
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as never;
}

function makeEditor() {
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { theme: { fg: (_: string, text: string) => text }, setWidget() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
	const editor = new QueueEditor(tui, editorTheme, keybindings(), ctx, { onEmptySubmit: () => false });
	editor.focused = true;
	const escapes: string[] = [];
	editor.onEscape = () => escapes.push("pi");
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	return { editor, escapes, submitted };
}

test("submitted text reaches intercepts before pi's handler", () => {
	const { editor, submitted } = makeEditor();
	const seen: string[] = [];
	setEditorIntercepts({ submit: (text) => (seen.push(text), text === "/resume") });
	for (const text of ["/resume", "hello"]) {
		editor.setText(text);
		editor.handleInput("\r");
	}
	assert.deepEqual(seen, ["/resume", "hello"]);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("pi's handler still runs when no intercept is registered", () => {
	const { editor, submitted } = makeEditor();
	editor.setText("/resume");
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["/resume"]);
});

test("Escape is offered to intercepts only on an empty editor", () => {
	const { editor, escapes } = makeEditor();
	let claim = true;
	const offered: number[] = [];
	setEditorIntercepts({ escape: () => (offered.push(1), claim) });
	editor.handleInput("\x1b");
	assert.deepEqual(escapes, []);
	claim = false;
	editor.handleInput("\x1b");
	assert.deepEqual(escapes, ["pi"]);
	editor.setText("draft");
	editor.handleInput("\x1b");
	assert.equal(offered.length, 2);
	assert.deepEqual(escapes, ["pi", "pi"]);
});

test("the resume action is offered to intercepts", () => {
	const { editor } = makeEditor();
	const actions: string[] = [];
	setEditorIntercepts({ action: (action) => (actions.push(action), true) });
	editor.handleInput("\x12");
	assert.deepEqual(actions, ["app.session.resume"]);
});
