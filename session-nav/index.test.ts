import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEditorIntercepts, setEditorIntercepts } from "../ui/editor-intercepts.ts";
import { DOUBLE_ESCAPE_MS, launchSelectsSession, readDoubleEscapeAction, registerSessionNav } from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "aio-session-nav-agent-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	setEditorIntercepts(undefined);
});

function harness(options: { flag?: boolean; idle?: boolean; mode?: string; argv?: string[] } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, unknown>();
	const sent: string[] = [];
	let idle = options.idle ?? true;
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		registerFlag() {},
		getFlag: () => options.flag ?? false,
		sendUserMessage(text: string, opts?: { expandPromptTemplates?: boolean }) {
			assert.equal(opts?.expandPromptTemplates, true, "commands must be dispatched");
			sent.push(text);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: agentDir,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	registerSessionNav(pi, options.argv ?? ["pi", "pi", "--sessions"]);
	return {
		commands,
		sent,
		setIdle(value: boolean) {
			idle = value;
		},
		fire: async (name: string, event: unknown = {}) => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

test("registers /rewind and /sessions", () => {
	const h = harness();
	assert.ok(h.commands.has("rewind"));
	assert.ok(h.commands.has("sessions"));
});

test("double Esc on an idle session opens /rewind; a single Esc passes through", async () => {
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	const escape = getEditorIntercepts().escape!;
	assert.equal(escape(), false);
	assert.deepEqual(h.sent, []);
	assert.equal(escape(), true);
	assert.deepEqual(h.sent, ["/rewind"]);
	// The pair resets: the next press starts a new double.
	assert.equal(escape(), false);
});

test("Esc while pi is working is never claimed", async () => {
	const h = harness({ idle: false });
	await h.fire("session_start", { reason: "startup" });
	const escape = getEditorIntercepts().escape!;
	assert.equal(escape(), false);
	assert.equal(escape(), false);
	assert.deepEqual(h.sent, []);
});

test("presses further apart than the double window do not open rewind", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	const escape = getEditorIntercepts().escape!;
	escape();
	t.mock.timers.tick(DOUBLE_ESCAPE_MS + 1);
	assert.equal(escape(), false);
	assert.deepEqual(h.sent, []);
});

test("doubleEscapeAction none keeps double Esc inert", async () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ doubleEscapeAction: "none" }));
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	const escape = getEditorIntercepts().escape!;
	escape();
	assert.equal(escape(), false);
	assert.deepEqual(h.sent, []);
});

test("project settings only apply when the project is trusted", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ doubleEscapeAction: "fork" }));
	const project = join(agentDir, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ doubleEscapeAction: "none" }));
	assert.equal(readDoubleEscapeAction(project, false), "fork");
	assert.equal(readDoubleEscapeAction(project, true), "none");
});

test("/resume and the resume keybinding open the AIO session picker", async () => {
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	const intercepts = getEditorIntercepts();
	assert.equal(intercepts.submit!("hello"), false);
	assert.equal(intercepts.submit!("/resume extra"), false);
	assert.equal(intercepts.submit!("/resume"), true);
	assert.equal(intercepts.action!("app.session.resume"), true);
	assert.deepEqual(h.sent, ["/sessions", "/sessions"]);
});

test("--sessions opens the picker once at startup", async () => {
	const h = harness({ flag: true });
	await h.fire("session_start", { reason: "startup" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await h.fire("session_start", { reason: "new" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(h.sent, ["/sessions"]);
});

test("non-TUI sessions install no intercepts; shutdown clears them", async () => {
	const rpc = harness({ mode: "rpc" });
	await rpc.fire("session_start", { reason: "startup" });
	assert.equal(getEditorIntercepts().escape, undefined);
	const tui = harness();
	await tui.fire("session_start", { reason: "startup" });
	assert.ok(getEditorIntercepts().escape);
	await tui.fire("session_shutdown");
	assert.equal(getEditorIntercepts().escape, undefined);
});

test("--sessions stays closed when the launch already selects a session (recipe relaunch)", async () => {
	const h = harness({ flag: true, argv: ["pi", "pi", "--sessions", "--session", "/s/a.jsonl"] });
	await h.fire("session_start", { reason: "startup" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(h.sent, []);
	assert.equal(launchSelectsSession(["pi", "pi", "-c"]), true);
	assert.equal(launchSelectsSession(["pi", "pi", "--sessions"]), false);
});
