import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerStatusLine } from "./index.ts";
import { registerFrameEditor } from "../frame/index.ts";
import { probeFrameEditor, setFrameMetadataContributor } from "../frame/protocol.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

/**
 * Regression harness for the double-quota display: status-line registers
 * BEFORE the frame (index.ts order) and its session_start fires first. The
 * frame must report `supported` at registration — not first install — or the
 * legacy footer installs alongside the frame and the quota renders twice
 * (widget/footer) with mode/effort duplicated for good measure.
 */
function makeHarness() {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const footers: unknown[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let installedFactory: unknown;
	const editorState = { text: "" };
	const baseEditor = {
		render: () => ["base-input", "base-row"],
		getText: () => editorState.text,
		setText() {},
		handleInput() {},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => false,
		cwd: process.cwd(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {},
		model: undefined,
		getContextUsage: () => undefined,
		sessionManager: { getSessionName: () => "session", getBranch: () => [] },
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			// Production: the queue installs a QueueEditor factory before the
			// frame's session_start. Simulate it until the frame overwrites it.
			getEditorComponent: () => installedFactory ?? (() => baseEditor),
			setEditorComponent: (factory: unknown) => {
				installedFactory = factory;
			},
			getEditorText: () => editorState.text,
			setEditorText: (text: string) => {
				editorState.text = text;
			},
			setFooter: (footer: unknown) => {
				footers.push(footer);
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses.set(key, value);
			},
			setWidget: (key: string, content: unknown) => {
				widgets.set(key, content);
			},
			notify() {},
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
		registerCommand() {},
		sendUserMessage() {},
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const fireAll = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { ctx, pi, fireAll, footers, statuses, widgets, installed: () => installedFactory };
}

test("status-line before frame: legacy footer never installs, quota embeds once", async () => {
	const harness = makeHarness();

	// index.ts order: status-line first, frame last.
	registerStatusLine(harness.pi);
	registerFrameEditor(harness.pi, {
		readGit: async () => ({ branch: undefined, dirty: false, ahead: 0, behind: 0 }),
	});

	// The frame answers supported at REGISTRATION, before any session_start.
	assert.equal(probeFrameEditor(harness.pi).supported, true);

	// Both lifecycle handlers fire in registration order (status-line first).
	await harness.fireAll("session_start");

	// The legacy footer must not install alongside the frame.
	assert.equal(harness.footers.length, 0, "legacy footer must stay uninstalled");
	assert.ok(harness.installed(), "frame editor installed");

	// Quota surface: no widget, no footer status (data arrives via the
	// frame's metadata contributor once a fetch populates it).
	assert.equal(harness.widgets.get("aio-provider-usage"), undefined);
	assert.equal(harness.statuses.get("aio-provider-usage"), undefined);

	// The contributor path renders quota into the frame's top border.
	setFrameMetadataContributor("quota", () => ({
		quota: { text: "synthetic 100% →5h", role: "muted" },
	}));
	const factory = harness.installed() as (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
	) => { render(width: number): string[] };
	const editor = factory({ requestRender() {} }, harness.ctx.ui.theme, {});
	const lines = editor.render(80);
	assert.match(lines[0]!, /synthetic 100% →5h/, "quota embedded in frame border");
});
