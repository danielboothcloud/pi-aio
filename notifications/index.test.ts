import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createExtensionRuntime, ExtensionRunner, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerNotifications } from "./index.ts";
import { defaultSettings, type NotificationSettings } from "./settings.ts";
import { AGENT_PROMPT_EVENT, emitGoalActivity, emitNotification, GOAL_ACTIVITY_EVENT, NOTIFICATION_EVENT, withAgentPrompt } from "./protocol.ts";
import type { DesktopNotification } from "./backend.ts";

const flush = () => new Promise((done) => setImmediate(done));
type Handler = (event: any, ctx: ExtensionContext) => unknown;
function harness(options: { mode?: string; settings?: NotificationSettings } = {}) {
	const handlers = new Map<string, Handler>();
	const events = new EventEmitter();
	const sent: DesktopNotification[] = [];
	const notices: string[] = [];
	const saved: NotificationSettings[] = [];
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	let settings = options.settings ?? defaultSettings();
	let time = 0;
	let id = "session-a";
	let focus: (signal: AbortSignal) => Promise<boolean> = async () => false;
	let failSave = false;
	let failSend = false;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: {
			on: (name: string, listener: (data: unknown) => void) => { events.on(name, listener); return () => events.off(name, listener); },
			emit: (name: string, data: unknown) => events.emit(name, data),
		},
		getSessionName: () => "Work session",
		registerCommand: (_name: string, config: any) => { command = config.handler; },
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: options.mode ?? "tui", hasUI: options.mode !== "print" && options.mode !== "json", cwd: "/project",
		sessionManager: { getSessionId: () => id },
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionContext;
	registerNotifications(pi, {
		load: () => structuredClone(settings),
		save: (next) => { if (failSave) throw new Error("disk full"); settings = structuredClone(next); saved.push(next); },
		now: () => time,
		backend: {
			name: () => "mock",
			focused: (signal) => focus(signal),
			send: async (notification, _signal, valid) => { if (failSend) throw new Error("unavailable"); if (valid()) sent.push(notification); },
		},
	});
	const fire = (name: string, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
	const start = () => fire("agent_start");
	const end = () => fire("agent_settled", { aborted: false });
	const message = (stopReason = "stop", text = "Private model output") => fire("message_end", { message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
	const tool = (name: string, _args: unknown = {}) => {
		if (!["ask_user_question", "write", "edit", "apply_patch", "bash", "hypa_shell", "propose_goal_draft"].includes(name)) return;
		events.emit(AGENT_PROMPT_EVENT, {
			id: 1, sessionId: id, active: true,
			kind: ["bash", "hypa_shell", "propose_goal_draft"].includes(name) ? "confirm" : "custom",
			title: name === "ask_user_question" ? "Question waiting" : name === "propose_goal_draft" ? "Input needed" : "Approval needed",
			body: "The agent needs your attention.", preview: "Secret details",
		});
	};
	const signal = (category = "background", overrides = {}) => events.emit(NOTIFICATION_EVENT, { sessionId: id, category, id: "result", title: "Background ready", body: "Generic body", preview: "Secret details", ...overrides });
	fire("session_start");
	return { handlers, pi, ctx, events, sent, notices, saved, fire, start, end, message, tool, signal,
		command: (args: string) => command(args, ctx),
		setTime: (next: number) => { time = next; }, setId: (next: string) => { id = next; },
		setFocus: (next: typeof focus) => { focus = next; },
		failSave: () => { failSave = true; }, failSend: () => { failSend = true; },
	};
}

test("only settled runs notify, not intermediate ends, turns, or recovered tool errors", async () => {
	const h = harness();
	h.start(); h.message(); h.fire("agent_end"); h.fire("turn_end");
	h.fire("tool_execution_end", { toolCallId: "call", isError: true });
	await flush(); assert.equal(h.sent.length, 0);
	h.start(); h.message(); h.end(); await flush();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].title, "Pi · Finished");
	assert.doesNotMatch(h.sent[0].body, /Private/);
	h.end(); await flush(); assert.equal(h.sent.length, 1);
});

test("unrecovered errors notify even below completion duration threshold; recovered errors do not", async () => {
	const settings = defaultSettings(); settings.minSeconds = 10;
	const h = harness({ settings });
	h.start(); h.message("error"); h.end(); await flush();
	assert.match(h.sent[0].title, /failed/);
	h.start(); h.message("error"); h.fire("agent_end"); h.start(); h.message(); h.end();
	await flush(); assert.equal(h.sent.length, 1);
	h.start(); h.message(); h.setTime(11000); h.end(); await flush();
	assert.equal(h.sent.length, 2);
});

for (const mode of ["rpc", "print", "json"]) {
	test(`no desktop effects in ${mode}`, async () => {
		const h = harness({ mode }); h.start(); h.message(); h.end(); h.signal();
		await h.command("test"); await flush(); assert.equal(h.sent.length, 0);
	});
}

test("children register nothing", () => {
	const before = process.env.AIO_SUBAGENT_CHILD;
	try {
		process.env.AIO_SUBAGENT_CHILD = "1";
		assert.equal(harness().handlers.size, 0);
	} finally {
		if (before === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = before;
	}
});

for (const abort of [{ aborted: true }, { aborted: false, stopReason: "aborted" }]) {
	test("intentional abort is silent", async () => {
		const h = harness(); h.start(); h.message(abort.stopReason); h.fire("agent_settled", abort);
		await flush(); assert.equal(h.sent.length, 0);
	});
}

for (const name of ["ask_user_question", "write", "edit", "apply_patch", "bash", "hypa_shell", "propose_goal_draft"]) {
	test(`actual blocking ${name} prompts notify without duration gating`, async () => {
		const settings = defaultSettings(); settings.minSeconds = 100;
		const h = harness({ settings }); h.start();
		h.tool(name, { questions: [{ question: "Secret question?" }] });
		h.fire("ui_prompt_start", { kind: ["bash", "hypa_shell", "propose_goal_draft"].includes(name) ? "confirm" : "custom", title: "Secret command" });
		await flush(); assert.equal(h.sent.length, 1);
		assert.match(h.sent[0].title, name === "ask_user_question" ? /Question/ : name === "propose_goal_draft" ? /Input/ : /Approval/);
		assert.doesNotMatch(h.sent[0].body, /Secret/);
	});
}

test("idle menus, tools that do not prompt, and unrelated custom overlays are silent", async () => {
	const h = harness(); h.fire("ui_prompt_start", { kind: "select" });
	h.start(); h.tool("read"); h.fire("ui_prompt_start", { kind: "custom" });
	await flush(); assert.equal(h.sent.length, 0);
});

for (const action of ["answer", "shutdown", "replace", "identity", "off"]) {
	test(`a slow focus probe cannot deliver a stale prompt after ${action}`, async () => {
		const h = harness(); let resolve!: (value: boolean) => void;
		h.setFocus(() => new Promise((done) => { resolve = done; }));
		h.start(); h.tool("write"); h.fire("ui_prompt_start", { kind: "custom" });
		await Promise.resolve();
		if (action === "answer") h.events.emit(AGENT_PROMPT_EVENT, { id: 1, sessionId: "session-a", active: false });
		if (action === "shutdown") h.fire("session_shutdown");
		if (action === "replace") h.fire("session_start");
		if (action === "identity") h.setId("session-b");
		if (action === "off") await h.command("off");
		resolve(false); await flush(); assert.equal(h.sent.length, 0);
	});
}

test("focus suppression, persistent toggles, previews and test bypass", async () => {
	const h = harness(); h.setFocus(async () => true);
	h.start(); h.end(); await flush(); assert.equal(h.sent.length, 0);
	await h.command("focus off"); await h.command("preview on");
	h.start(); h.message(); h.end(); await flush();
	assert.match(h.sent[0].body, /Private/);
	await h.command("off"); h.start(); h.end(); h.signal(); await flush();
	assert.equal(h.sent.length, 1);
	await h.command("test"); await flush(); assert.equal(h.sent.length, 2);
	assert.equal(h.saved.length, 3);
	h.fire("session_start"); h.start(); h.end(); await flush(); assert.equal(h.sent.length, 2);
});

test("goal activity suppresses false idle alerts, outcomes replace generic completion, signals dedupe", async () => {
	const h = harness();
	h.events.emit(GOAL_ACTIVITY_EVENT, { sessionId: "session-a", active: true });
	h.start(); h.end(); await flush(); assert.equal(h.sent.length, 0);
	h.events.emit(GOAL_ACTIVITY_EVENT, { sessionId: "session-a", active: false });
	h.start(); h.signal("goal", { replacesCompletion: true }); h.signal("goal"); h.end();
	await flush(); assert.equal(h.sent.length, 1);
	h.start(); h.end(); await flush(); assert.equal(h.sent.length, 2);
	h.signal("critical", { id: "finding" }); h.signal("background", { sessionId: "other" });
	await flush(); assert.equal(h.sent.length, 3);
});

test("background completion before a follow-up suppresses just its next idle alert", async () => {
	const h = harness(); h.signal("background", { replacesCompletion: true });
	h.start(); h.end(); await flush(); assert.equal(h.sent.length, 1);
	h.start(); h.end(); await flush(); assert.equal(h.sent.length, 2);
});

test("disabled categories do not suppress core completion", async () => {
	const h = harness(); await h.command("events goal off");
	h.start(); h.signal("goal", { replacesCompletion: true }); h.end();
	await flush(); assert.equal(h.sent.length, 1); assert.match(h.sent[0].title, /Finished/);
});

test("bad commands never persist; failed saves retain old settings; backend failures are silent", async () => {
	const h = harness();
	for (const command of ["min nope", "min -1", "min Infinity", "focus wat", "events unknown on", "on extra", "preview on extra", "sound Bad;Script", "events core on extra"]) await h.command(command);
	assert.equal(h.saved.length, 0);
	h.failSave(); await h.command("off"); h.start(); h.end(); await flush(); assert.equal(h.sent.length, 1);
	h.failSend(); h.start(); h.end(); await flush(); assert.equal(h.sent.length, 1);
	assert.ok(h.notices.some((notice) => notice.includes("previous settings retained")));
});

test("producer helpers are session-bound, TUI-only, and fail open", () => {
	const h = harness(); const signals: any[] = [];
	h.events.on(NOTIFICATION_EVENT, (data) => signals.push(data));
	const event = { category: "critical" as const, id: "a", title: "Alert", body: "Body" };
	emitNotification(h.pi, h.ctx, event);
	assert.equal(signals[0].sessionId, "session-a");
	emitNotification(h.pi, { ...h.ctx, mode: "rpc" } as ExtensionContext, event);
	assert.equal(signals.length, 1);
	assert.doesNotThrow(() => emitNotification({} as ExtensionAPI, h.ctx, event));
	assert.doesNotThrow(() => emitGoalActivity(null, h.ctx, "active"));
});

test("owned prompt markers cover actual UI waits and clear on rejection", async () => {
	const h = harness();
	await withAgentPrompt(h.pi, h.ctx, { kind: "select", title: "Plan ready", body: "Review the plan." }, async () => {
		h.fire("ui_prompt_start", { kind: "select" });
		await flush();
		assert.equal(h.sent.length, 1);
	});
	h.fire("ui_prompt_start", { kind: "select" });
	await flush(); assert.equal(h.sent.length, 1);
	await assert.rejects(withAgentPrompt(h.pi, h.ctx, { kind: "confirm", title: "Confirm", body: "Review" }, async () => { throw new Error("closed"); }));
	h.fire("ui_prompt_start", { kind: "confirm" });
	await flush(); assert.equal(h.sent.length, 1);
});

test("user menus during streaming never inherit ownership from unrelated running tools", async () => {
	const h = harness(); h.start();
	for (const toolName of ["read", "bash", "hypa_shell", "write", "ask_user_question"]) {
		h.fire("tool_execution_start", { toolCallId: toolName, toolName, args: {} });
		h.fire("ui_prompt_start", { kind: "select", title: "Interaction style" });
		h.fire("ui_prompt_start", { kind: "custom" });
	}
	await flush(); assert.equal(h.sent.length, 0);
});

test("a new run invalidates pending completion without discarding independent background alerts", async () => {
	const h = harness(); const gates: ((value: boolean) => void)[] = [];
	h.setFocus(() => new Promise((done) => gates.push(done)));
	h.start(); h.end(); h.signal(); h.start();
	for (const done of gates) done(false);
	await flush(); assert.deepEqual(h.sent.map((notification) => notification.title), ["Pi · Background ready"]);
});

test("quiet goal stops silence only their own settlement, not later unrelated turns", async () => {
	for (const stop of ["quota auto-retry", "manual pause", "cancel"]) {
		const h = harness(); h.start();
		h.events.emit(GOAL_ACTIVITY_EVENT, { sessionId: "session-a", active: false, quietSettle: true, reason: stop });
		h.end(); await flush(); assert.equal(h.sent.length, 0);
		h.start(); h.end(); await flush(); assert.equal(h.sent.length, 1);
	}
});

test("shutdown releases shared event-bus listeners", () => {
	const h = harness();
	assert.equal(h.events.listenerCount(NOTIFICATION_EVENT), 1);
	h.fire("session_shutdown");
	for (const event of [NOTIFICATION_EVENT, AGENT_PROMPT_EVENT, GOAL_ACTIVITY_EVENT]) assert.equal(h.events.listenerCount(event), 0);
});

test("turning previews off cancels pending private snapshots", async () => {
	const settings = defaultSettings(); settings.preview = true;
	const h = harness({ settings }); let resolve!: (value: boolean) => void;
	h.setFocus(() => new Promise((done) => { resolve = done; }));
	h.start(); h.message(); h.end();
	await h.command("preview off"); resolve(false);
	await flush(); assert.equal(h.sent.length, 0);
});

test("agent prompts notify over an already-open user menu without another host prompt-start event", async () => {
	const h = harness();
	const hostStarts: string[] = [];
	// SAFETY: the runner's emit path consumes only path + handlers here;
	// no tools, commands, providers, or model calls are exercised.
	const extension = { path: "notification-overlap-test", handlers: new Map([
		["ui_prompt_start", [(event: { kind: string }) => hostStarts.push(event.kind)]],
	]) } as unknown as ConstructorParameters<typeof ExtensionRunner>[0][number];
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), "/project",
		h.ctx.sessionManager as ConstructorParameters<typeof ExtensionRunner>[3],
		h.ctx.modelRegistry);
	let closeMenu!: (value: string | undefined) => void;
	let closeQuestion!: (value: boolean) => void;
	// SAFETY: only select/confirm are invoked on this injected host UI.
	runner.setUIContext({
		select: () => new Promise<string | undefined>((done) => { closeMenu = done; }),
		confirm: () => new Promise<boolean>((done) => { closeQuestion = done; }),
	} as unknown as Parameters<typeof runner.setUIContext>[0], "tui");
	const menu = runner.getUIContext().select("Interaction style", ["Tutor", "Concise"]);
	await flush();
	assert.deepEqual(hostStarts, ["select"]);
	const question = withAgentPrompt(h.pi, h.ctx, { kind: "confirm", title: "Approval needed", body: "The agent needs permission." },
		() => runner.getUIContext().confirm("Allow command?", "Permission required"));
	try {
		await flush();
		assert.deepEqual(hostStarts, ["select"], "nested dialogs do not emit another host start event");
		assert.deepEqual(h.sent.map((notification) => notification.title), ["Pi · Approval needed"]);
	} finally {
		closeQuestion(true); closeMenu(undefined);
		await Promise.all([question, menu]);
		h.fire("session_shutdown");
	}
});

test("a specific goal failure replaces generic error as well as success alerts", async () => {
	const h = harness(); h.start(); h.message("error");
	h.signal("goal", { title: "Goal needs attention", replacesCompletion: true }); h.end();
	await flush(); assert.deepEqual(h.sent.map((notification) => notification.title), ["Pi · Goal needs attention"]);
});
