import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerUserBash } from "../user-bash/index.ts";
import { registerQueue } from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function makeHarness(editorFactory?: (...args: never[]) => unknown) {
	const handlers = new Map<string, Handler[]>();
	let installedEditors = 0;
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
			notify() {},
			setEditorComponent() {
				installedEditors++;
			},
			setEditorText() {},
			setWidget() {},
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		get installedEditors() {
			return installedEditors;
		},
		pi,
		start: async () => {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({}, ctx);
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
