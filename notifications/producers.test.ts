import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBtw } from "../btw/index.ts";
import { registerPermissionModes } from "../permission-modes/index.ts";
import { registerGoals } from "../goals/index.ts";
import { AGENT_PROMPT_EVENT, GOAL_ACTIVITY_EVENT, NOTIFICATION_EVENT, type NotificationSignal } from "./protocol.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
function harness() {
	const directory = mkdtempSync(join(process.cwd(), ".notify-producer-test-"));
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const events = new EventEmitter();
	const signals: NotificationSignal[] = [];
	const prompts: any[] = [];
	const activities: any[] = [];
	events.on(NOTIFICATION_EVENT, (data) => signals.push(data));
	events.on(AGENT_PROMPT_EVENT, (data) => prompts.push(data));
	events.on(GOAL_ACTIVITY_EVENT, (data) => activities.push(data));
	const pi = {
		events,
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerEntryRenderer() {}, registerMessageRenderer() {}, registerShortcut() {}, registerFlag() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {},
		getActiveTools: () => [...tools.keys()], setActiveTools() {}, getAllTools: () => [{ name: "write" }], getCommands: () => [], getFlag: () => undefined,
		getThinkingLevel: () => "high", exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: directory, mode: "tui", hasUI: true, scopedModels: [], model: { provider: "openai", id: "test" },
		sessionManager: { getSessionId: () => "producer-session", getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined },
		isIdle: () => true, hasPendingMessages: () => false, abort() {},
		ui: { theme: { fg: (_role: string, text: string) => text }, notify() {}, setStatus() {}, setWidget() {}, setWorkingIndicator() {}, select: async () => "Allow", custom: async () => "allow", confirm: async () => true },
		modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Answer" }] }) },
	} as unknown as ExtensionContext;
	const fire = async (name: string, event = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	};
	return { directory, pi, ctx, events, signals, prompts, activities, tools, commands, fire,
		cleanup: async () => { await fire("session_shutdown", { reason: "quit" }); rmSync(directory, { recursive: true, force: true }); },
	};
}
async function until(predicate: () => boolean) {
	for (let index = 0; index < 200; index++) {
		if (predicate()) return;
		await new Promise((done) => setTimeout(done, 5));
	}
	assert.fail("producer did not emit its notification");
}

test("both shell approval surfaces and file approvals publish ownership only when approval is needed", async () => {
	const h = harness();
	try {
		registerPermissionModes(h.pi); await h.fire("session_start");
		for (const toolName of ["bash", "hypa_shell", "write"]) {
			await h.fire("tool_call", { toolCallId: toolName, toolName, input: toolName === "write" ? { path: "new.txt", content: "hi" } : { command: "python3 script.py" } });
			const [start, end] = h.prompts.splice(0);
			assert.equal(start.title, "Approval needed"); assert.equal(start.active, true);
			assert.equal(end.active, false); assert.equal(start.id, end.id);
		}
		await h.fire("tool_call", { toolCallId: "read", toolName: "bash", input: { command: "pwd" } });
		assert.equal(h.prompts.length, 0);
	} finally { await h.cleanup(); }
});

test("real /btw completion publishes a session-bound background signal", async () => {
	const h = harness();
	try {
		registerBtw(h.pi, { answerCardMs: 0 });
		await h.commands.get("btw").handler("What changed?", h.ctx);
		await until(() => h.signals.length > 0);
		assert.equal(h.signals[0].category, "background");
		assert.equal(h.signals[0].sessionId, "producer-session");
		assert.equal(h.signals[0].title, "Side answer ready");
	} finally { await h.cleanup(); }
});

test("actual goal pause transitions notify once, while manual pause/cancel are quiet stops", async () => {
	const h = harness();
	try {
		registerGoals(h.pi); await h.fire("session_start");
		await h.commands.get("goal").handler("Test notification transitions", h.ctx);
		await h.tools.get("goal_propose").execute("propose", { objective: "Test notification transitions", doneWhen: "signals fire" }, undefined, undefined, h.ctx);
		const blocked = h.tools.get("goal_blocked");
		assert.ok(blocked);
		await blocked.execute("pause", { reason: "Need credentials" }, undefined, undefined, h.ctx);
		assert.equal(h.signals.length, 1); assert.equal(h.signals[0].title, "Goal needs attention");
		await assert.rejects(blocked.execute("pause-again", { reason: "Need credentials" }, undefined, undefined, h.ctx));
		assert.equal(h.signals.length, 1);
		await h.commands.get("goal").handler("resume", h.ctx);
		await h.commands.get("goal").handler("pause", h.ctx);
		await h.commands.get("goal").handler("cancel", h.ctx);
		assert.equal(h.signals.length, 1);
		assert.ok(h.activities.some((activity) => activity.quietSettle));
	} finally { await h.cleanup(); }
});
