import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerFrameEditor } from "./index.ts";
import { isFrameEditorFactory, probeFrameEditor } from "./protocol.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function makeHarness(options: { editorFactory?: unknown; tui?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	let installedFactory: unknown;
	const editorState = { text: "" };
	const widgets: Array<{ key: string; content: unknown }> = [];
	const existingFactory = options.editorFactory;
	const ctx = {
		mode: options.tui === false ? "rpc" : "tui",
		hasUI: true,
		cwd: process.cwd(),
		model: undefined,
		getContextUsage: () => undefined,
		getThinkingLevel: () => "high",
		sessionManager: {
			getSessionName: () => "session",
			getBranch: () => [],
		},
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			getEditorComponent: () => existingFactory,
			setEditorComponent: (factory: unknown) => {
				installedFactory = factory;
			},
			getEditorText: () => editorState.text,
			setEditorText: (text: string) => {
				editorState.text = text;
			},
			setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
		},
	} as unknown as ExtensionContext;
	const pi = {
		events: {
			on(channel: string, listener: (value: unknown) => void) {
				listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
			},
			emit(channel: string, value: unknown) {
				for (const listener of listeners.get(channel) ?? []) listener(value);
			},
		},
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { ctx, pi, fire, installed: () => installedFactory, editorState };
}

test("registerFrameEditor wraps the existing editor and answers the probe", async () => {
	// The queue (registered earlier in production) installs a base factory.
	// The queue's base editor renders multi-line output (input + rows); the
	// frame needs at least a two-line base to decorate.
	const baseFactory = () => ({
		render: () => ["base-input", "base-row"],
		getText: () => "",
		setText() {},
		handleInput() {},
	});
	const harness = makeHarness({ editorFactory: baseFactory });
	registerFrameEditor(harness.pi, { readGit: async () => ({ branch: "main", dirty: false, ahead: 0, behind: 0 }) });
	await harness.fire("session_start");

	const factory = harness.installed() as ((...args: unknown[]) => unknown) | undefined;
	assert.ok(factory, "frame factory installed");
	assert.equal(isFrameEditorFactory(factory), true);

	// The capability probe now reports supported via the shared event bus.
	const capability = probeFrameEditor(harness.pi);
	assert.deepEqual(capability, { supported: true, active: true, version: 1 });

	// Rendering the wrapped editor produces the minimalist frame.
	const editor = factory!("tui", harness.ctx.ui.theme, {}) as {
		render(width: number): string[];
	};
	const lines = editor.render(60);
	assert.match(lines[0]!, /^╭/);
	assert.match(lines.at(-1)!, /^╰/);
});

test("lifecycle repaints reach the TUI without recursion", async () => {
	// Regression: notifyChanged() -> registrar requestRender -> notifyChanged()
	// blew the stack (RangeError: Maximum call stack size exceeded) the first
	// time an agent run repainted. The editor's repaint must terminate at the
	// TUI's requestRender.
	const baseFactory = () => ({
		render: () => ["base-input", "base-row"],
		getText: () => "",
		setText() {},
		handleInput() {},
	});
	const harness = makeHarness({ editorFactory: baseFactory });
	registerFrameEditor(harness.pi, {
		readGit: async () => ({ branch: undefined, dirty: false, ahead: 0, behind: 0 }),
	});
	await harness.fire("session_start");

	const factory = harness.installed() as (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
	) => unknown;
	let repaints = 0;
	const tui = {
		requestRender() {
			repaints++;
		},
	};
	const editor = factory(tui, harness.ctx.ui.theme, {}) as { notifyChanged(): void };

	// The exact call path that crashed: every lifecycle event funnels through
	// the registrar's requestRender into editor.notifyChanged().
	for (let i = 0; i < 100; i++) editor.notifyChanged();
	assert.equal(repaints, 100, "each notifyChanged repaints exactly once via the TUI");
});

test("registerFrameEditor skips a standalone Zentui editor", async () => {
	const foreign = () => undefined;
	Object.defineProperty(foreign, Symbol.for("pi-zentui.editor-factory"), { value: true });
	const harness = makeHarness({ editorFactory: foreign });
	registerFrameEditor(harness.pi, { readGit: async () => ({ branch: undefined, dirty: false, ahead: 0, behind: 0 }) });
	await harness.fire("session_start");
	assert.equal(harness.installed(), undefined);
});

test("registerFrameEditor does nothing outside TUI mode", async () => {
	const harness = makeHarness({ tui: false });
	registerFrameEditor(harness.pi);
	await harness.fire("session_start");
	assert.equal(harness.installed(), undefined);
	// Supported means registered; active means a TUI session installed it.
	const capability = probeFrameEditor(harness.pi);
	assert.equal(capability.supported, true);
	assert.equal(capability.active, false);
});

test("session_shutdown stops refreshing without throwing", async () => {
	const harness = makeHarness();
	registerFrameEditor(harness.pi, { readGit: async () => ({ branch: undefined, dirty: false, ahead: 0, behind: 0 }) });
	await harness.fire("session_start");
	await harness.fire("session_shutdown");
	assert.ok(true, "shutdown completed without throwing");
});
