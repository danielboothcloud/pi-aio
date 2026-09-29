import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerUserBash } from "../user-bash/index.ts";
import { registerQueue, restoreTextsToEditor } from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function makeHarness(editorFactory?: (...args: never[]) => unknown) {
	const handlers = new Map<string, Handler[]>();
	let installedEditors = 0;
	const widgetFactories: unknown[] = [];
	const editorState = { text: "" };
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {},
		ui: {
			getEditorComponent: () => editorFactory,
			getEditorText: () => editorState.text,
			notify() {},
			setEditorComponent() {
				installedEditors++;
			},
			setEditorText(text: string) {
				editorState.text = text;
			},
			setWidget(_key: string, factory: unknown) {
				if (factory !== undefined) widgetFactories.push(factory);
			},
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		editorState,
		get installedEditors() {
			return installedEditors;
		},
		pi,
		widgetFactories,
		start: async () => {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({}, ctx);
			}
		},
		fire: async (name: string, event: unknown) => {
			for (const handler of handlers.get(name) ?? []) {
				await handler(event, ctx);
			}
		},
	};
}

test("queue installs its editor when Zentui will wrap it later", async () => {
	const harness = makeHarness();
	registerQueue(harness.pi);
	await harness.start();
	assert.equal(harness.installedEditors, 1);
});

test("AIO editor layers preserve an editor already owned by standalone Zentui", async () => {
	const factory = () => undefined;
	Object.defineProperty(factory, Symbol.for("pi-zentui.editor-factory"), {
		value: true,
	});
	const harness = makeHarness(factory);
	registerUserBash(harness.pi);
	registerQueue(harness.pi);
	await harness.start();
	assert.equal(harness.installedEditors, 0);
});

const plainTheme = {
	fg: (_name: string, text: string) => text,
};

async function renderQueuedWidget(harness: ReturnType<typeof makeHarness>) {
	await harness.fire("input", {
		text: "queued message",
		source: "interactive",
		streamingBehavior: "steer",
	});
	const factory = harness.widgetFactories.at(-1);
	assert.equal(typeof factory, "function");
	const component = (factory as (
		tui: never,
		theme: unknown,
	) => { render(width: number): string[] })(undefined as never, plainTheme);
	return component.render(80);
}

test("the widget renders in Zentui's frame style when Zentui owns the editor", async () => {
	const factory = () => undefined;
	Object.defineProperty(factory, Symbol.for("pi-zentui.editor-factory"), {
		value: true,
	});
	const harness = makeHarness(factory);
	registerQueue(harness.pi);
	await harness.start();

	const lines = await renderQueuedWidget(harness);
	assert.match(lines[0] ?? "", /^├─ queue · 1 pending message · Enter sends next ─+┤$/);
	assert.match(lines[1] ?? "", /^│ 1 queued message\s+steer │$/);
});

test("the widget renders in the chrome style when Zentui does not own the editor", async () => {
	const harness = makeHarness();
	registerQueue(harness.pi);
	await harness.start();

	const lines = await renderQueuedWidget(harness);
	assert.match(lines[0] ?? "", /QUEUE/);
	assert.match(lines[1] ?? "", /1 queued message · steer/);
});

test("restoring to the editor never duplicates texts it already holds", () => {
	const harness = makeHarness();
	harness.editorState.text = "already queued";

	restoreTextsToEditor(harness.ctx, ["already queued", "new one"]);

	// The orphaned queue text leads; the pre-existing editor text follows.
	assert.equal(harness.editorState.text, "new one\n\nalready queued");
});

test("restoring to an empty editor combines the texts", () => {
	const harness = makeHarness();

	restoreTextsToEditor(harness.ctx, ["one", "two"]);

	assert.equal(harness.editorState.text, "one\n\ntwo");
});

test("restoring nothing is a no-op", () => {
	const harness = makeHarness();
	harness.editorState.text = "untouched";

	restoreTextsToEditor(harness.ctx, []);

	assert.equal(harness.editorState.text, "untouched");
});
