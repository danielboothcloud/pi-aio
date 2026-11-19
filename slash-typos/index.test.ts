import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editDistance, parseSlashInput, suggestCommands, typoMessage } from "./core.ts";
import { registerSlashTypos } from "./index.ts";

const KNOWN = ["handoff", "help", "recipe", "rewind", "goal", "new", "model", "skill:review", "btw"];

test("parseSlashInput accepts a command name and keeps the rest", () => {
	assert.deepEqual(parseSlashInput("/handof Cache forge repos"), { name: "handof", rest: " Cache forge repos" });
	assert.deepEqual(parseSlashInput("/handof"), { name: "handof", rest: "" });
	assert.deepEqual(parseSlashInput("/skill:reveiw x\ny"), { name: "skill:reveiw", rest: " x\ny" });
});

test("parseSlashInput ignores paths, plain text and leading spaces", () => {
	for (const text of ["/Users/daniel/file.png", "/tmp/x", "hello /handof", " /handof", "/", "//handof", "/ handof"]) {
		assert.equal(parseSlashInput(text), undefined, text);
	}
});

test("editDistance counts an adjacent swap as one edit", () => {
	assert.equal(editDistance("hnadoff", "handoff"), 1);
	assert.equal(editDistance("handof", "handoff"), 1);
	assert.equal(editDistance("", "abc"), 3);
	assert.equal(editDistance("same", "same"), 0);
});

test("suggestCommands finds near misses", () => {
	assert.deepEqual(suggestCommands("handof", KNOWN), ["handoff"]);
	assert.deepEqual(suggestCommands("hnadoff", KNOWN), ["handoff"]);
	assert.deepEqual(suggestCommands("handofff", KNOWN), ["handoff"]);
	assert.deepEqual(suggestCommands("Handoff", KNOWN), ["handoff"]);
	assert.deepEqual(suggestCommands("recpie", KNOWN), ["recipe"]);
	assert.deepEqual(suggestCommands("skill:reveiw", KNOWN), ["skill:review"]);
});

test("suggestCommands accepts a unique prefix of three or more characters", () => {
	assert.deepEqual(suggestCommands("hand", KNOWN), ["handoff"]);
	assert.deepEqual(suggestCommands("rec", KNOWN), ["recipe"]);
	// "re" is too short, and "re" alone matches recipe and rewind.
	assert.deepEqual(suggestCommands("re", KNOWN), []);
});

test("suggestCommands leaves known commands and distant words alone", () => {
	assert.deepEqual(suggestCommands("handoff", KNOWN), []);
	assert.deepEqual(suggestCommands("deploy", KNOWN), []);
	// Short names allow one edit only: "now" is close to "new", "nxx" is not.
	assert.deepEqual(suggestCommands("now", KNOWN), ["new"]);
	assert.deepEqual(suggestCommands("nxx", KNOWN), []);
});

test("suggestCommands lists several equal matches, best first", () => {
	assert.deepEqual(suggestCommands("hel", ["help", "hello", "helm"]), ["helm", "help"]);
});

test("typoMessage names the suggestion and the escape", () => {
	assert.match(typoMessage("handof", ["handoff"]), /Unknown command \/handof\. Did you mean \/handoff\?/);
	assert.match(typoMessage("x", ["a", "b"]), /one of \/a, \/b\?/);
	assert.match(typoMessage("x", ["a"]), /Start with a space/);
});

type InputHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function harness(options: { hasUI?: boolean; commands?: string[] } = {}) {
	let handler: InputHandler | undefined;
	const notes: Array<[string, string]> = [];
	const editor: string[] = [];
	const pi = {
		on: (event: string, fn: InputHandler) => {
			if (event === "input") handler = fn;
		},
		getCommands: () => (options.commands ?? ["handoff", "recipe", "review:1", "review:2"]).map((name) => ({ name })),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, type: string) => notes.push([message, type]),
			setEditorText: (text: string) => editor.push(text),
		},
	} as unknown as ExtensionContext;
	registerSlashTypos(pi);
	const send = (text: string, source = "interactive") => handler?.({ type: "input", text, source }, ctx);
	return { send, notes, editor, registered: () => handler !== undefined };
}

test("a near miss is held back and the corrected command goes to the editor", () => {
	const h = harness();
	assert.deepEqual(h.send("/handof Cache forge repos"), { action: "handled" });
	assert.equal(h.notes.length, 1);
	assert.equal(h.notes[0]?.[1], "warning");
	assert.match(h.notes[0]?.[0] ?? "", /\/handoff/);
	assert.deepEqual(h.editor, ["/handoff Cache forge repos"]);
});

test("Pi built-ins and the bare name of a suffixed command are known", () => {
	const h = harness();
	assert.deepEqual(h.send("/modle"), { action: "handled" });
	assert.deepEqual(h.editor, ["/model"]);
	assert.deepEqual(h.send("/reveiw now"), { action: "handled" });
	assert.equal(h.editor.at(-1), "/review now");
});

test("several suggestions notify without changing the editor", () => {
	const h = harness({ commands: ["help", "helm"] });
	assert.deepEqual(h.send("/hel"), { action: "handled" });
	assert.deepEqual(h.editor, []);
	assert.match(h.notes[0]?.[0] ?? "", /one of \/helm, \/help/);
});

test("other input passes through unchanged", () => {
	const h = harness();
	const passThrough = [
		"/handoff goal",
		"/deploy now",
		"/Users/x/y.png",
		"/tmp/foo is broken",
		"/tmp foo is broken",
		"/etc",
		"/a",
		"/tree",
		"/fork",
		"/model",
		"/resume",
		"/review:2 x",
		"/handoff\nsecond line of a paste",
		"hello",
		" /handof",
	];
	for (const text of passThrough) {
		assert.equal(h.send(text), undefined, text);
	}
	assert.equal(h.send("/handof x", "extension"), undefined);
	assert.deepEqual(h.notes, []);
});

test("no UI: the input passes through so print mode never hides it", () => {
	const h = harness({ hasUI: false });
	assert.equal(h.send("/handof x"), undefined);
});

test("subagent children register nothing", () => {
	const previous = process.env.AIO_SUBAGENT_CHILD;
	process.env.AIO_SUBAGENT_CHILD = "1";
	try {
		assert.equal(harness().registered(), false);
	} finally {
		if (previous === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = previous;
	}
});
