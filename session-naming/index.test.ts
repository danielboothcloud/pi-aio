import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { cleanSessionTitle, registerSessionNaming } from "./index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
const user = { type: "message", message: { role: "user", content: "Fix login session expiry" } };
const assistant = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Updated token refresh." }] } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: { old?: boolean; name?: string; parent?: boolean; timeoutMs?: number; mode?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	let name = options.name;
	let id = "session-a";
	let entries: any[] = options.old ? [user, assistant] : [];
	const names: string[] = [];
	const calls: any[] = [];
	let reply: () => Promise<any> = async () => ({ role: "assistant", content: [{ type: "text", text: '"Fix login session expiry"' }], stopReason: "stop" });
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getSessionName: () => name,
		setSessionName: (value: string) => { names.push(value); name = value; },
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: options.mode ?? "tui",
		model: { provider: "test", id: "session-model" },
		sessionManager: {
			getSessionId: () => id,
			getHeader: () => ({ parentSession: options.parent ? "parent.jsonl" : undefined }),
			getEntries: () => entries,
			getBranch: () => entries,
		},
		modelRegistry: { streamSimple: (...args: any[]) => { calls.push(args); return { result: () => reply() }; } },
	} as unknown as ExtensionContext;
	registerSessionNaming(pi, { timeoutMs: options.timeoutMs });
	const fire = (event: string, data: any = {}) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event, ...data }, ctx);
	};
	return {
		pi, ctx, handlers, calls, names, fire,
		start: (reason = "startup") => fire("session_start", { reason }),
		end: () => { entries = [user, assistant]; return fire("agent_end"); },
		setEntries: (value: any[]) => { entries = value; },
		setName: (value: string) => { name = value; },
		setId: (value: string) => { id = value; },
		setReply: (value: typeof reply) => { reply = value; },
	};
}

test("new session gets a native title once, without awaiting the side request", async () => {
	const h = harness();
	h.start();
	let resolve!: (value: any) => void;
	h.setReply(() => new Promise((done) => { resolve = done; }));
	assert.equal(h.end(), undefined);
	assert.equal(h.calls.length, 1);
	h.end();
	assert.equal(h.calls.length, 1);
	resolve({ role: "assistant", content: [{ type: "text", text: "Fix login session expiry" }], stopReason: "stop" });
	await flush();
	assert.deepEqual(h.names, ["Fix login session expiry"]);
	assert.equal(h.calls[0][0], h.ctx.model);
	assert.match(h.calls[0][1].messages[0].content, /Fix login session expiry/);
	h.end();
	assert.equal(h.calls.length, 1);
});

for (const mode of ["tui", "rpc", "print"]) {
	test(`naming is independent of UI availability (${mode})`, async () => {
		const h = harness({ mode });
		h.start("new");
		h.end();
		await flush();
		assert.deepEqual(h.names, ["Fix login session expiry"]);
	});
}

for (const options of [{ old: true }, { name: "My title" }, { parent: true }]) {
	test(`preserves existing or inherited sessions: ${JSON.stringify(options)}`, async () => {
		const h = harness(options);
		h.start();
		h.end();
		await flush();
		assert.equal(h.calls.length, 0);
	});
}

for (const reason of ["resume", "reload", "fork"]) {
	test(`does not backfill on ${reason}`, () => {
		const h = harness();
		h.start(reason);
		h.end();
		assert.equal(h.calls.length, 0);
	});
}

test("skips subagent children", () => {
	const previous = process.env.AIO_SUBAGENT_CHILD;
	try {
		process.env.AIO_SUBAGENT_CHILD = "1";
		assert.equal(harness().handlers.size, 0);
	} finally {
		if (previous === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = previous;
	}
});

test("does not replace a manual name assigned during the request", async () => {
	const h = harness();
	h.start();
	h.end();
	h.setName("Manual name");
	await flush();
	assert.deepEqual(h.names, []);
});

for (const change of ["shutdown", "id", "replacement"]) {
	test(`stale completion cannot rename a session after ${change}`, async () => {
		const h = harness();
		h.start();
		h.end();
		if (change === "shutdown") h.fire("session_shutdown");
		if (change === "id") h.setId("session-b");
		if (change === "replacement") h.start("new");
		await flush();
		assert.deepEqual(h.names, []);
		if (change !== "id") assert.equal(h.calls[0][2].signal.aborted, true);
	});
}

for (const reply of [
	async () => { throw new Error("offline"); },
	async () => ({ stopReason: "error", content: [{ type: "text", text: "not a title" }] }),
	async () => ({ stopReason: "length", content: [{ type: "text", text: "truncated title" }] }),
	async () => ({ stopReason: "stop", content: [] }),
]) {
	test("failed or empty title calls are silent and never retried", async () => {
		const h = harness();
		h.setReply(reply);
		h.start();
		h.end();
		await flush();
		h.end();
		assert.deepEqual(h.names, []);
		assert.equal(h.calls.length, 1);
	});
}

test("timeout aborts even if the provider never resolves", async () => {
	const h = harness({ timeoutMs: 5 });
	h.setReply(() => new Promise(() => {}));
	h.start();
	h.end();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(h.calls[0][2].signal.aborted, true);
	assert.deepEqual(h.names, []);
});

test("waits for a successful response and a selected model", async () => {
	const h = harness();
	h.start();
	h.setEntries([user, { ...assistant, message: { ...assistant.message, stopReason: "aborted" } }]);
	h.fire("agent_end");
	assert.equal(h.calls.length, 0);
	const model = h.ctx.model;
	h.ctx.model = undefined;
	h.end();
	assert.equal(h.calls.length, 0);
	h.ctx.model = model;
	h.end();
	await flush();
	assert.equal(h.names.length, 1);
});

test("prompt is bounded and excludes tools, hidden context, images and thinking", async () => {
	const h = harness();
	h.start();
	h.setEntries([
		{ type: "custom_message", content: "PRIVATE SYSTEM" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(8000) }, { type: "image", data: "PRIVATE IMAGE" }] } },
		{ type: "message", message: { role: "toolResult", content: "PRIVATE TOOL" } },
		{ type: "message", message: { ...assistant.message, content: [{ type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: "y".repeat(4000) }] } },
	]);
	h.fire("agent_end");
	await flush();
	const prompt = h.calls[0][1].messages[0].content;
	assert.ok(prompt.length < 6100);
	assert.doesNotMatch(prompt, /PRIVATE/);
});

test("virtual session models route title calls through the real SDK without network", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "session-naming-fixture", tokensPerSecond: 1_000_000 });
	faux.setResponses([fauxAssistantMessage("Fix login session expiry")]);
	runtime.registerNativeProvider({
		...faux.provider,
		auth: { apiKey: { name: "Offline fixture", resolve: async () => ({ auth: { apiKey: "offline-fixture" } }) } },
	});
	const routes: string[] = [];
	runtime.registerVirtualModel({
		provider: "session-naming-router", id: "auto", name: "Offline title router",
		route: (request) => { routes.push(request.reason); return { model: faux.getModel(), thinkingLevel: "off" }; },
	});
	await runtime.setRuntimeApiKey(faux.provider.id, "offline-fixture");
	await runtime.refresh({ allowNetwork: false, providers: [faux.provider.id] });
	assert.equal(runtime.hasConfiguredAuth(faux.provider.id), true);
	const registry = new ModelRegistry(runtime);
	const selected = registry.find("session-naming-router", "auto");
	assert.ok(selected);
	const h = harness();
	h.ctx.model = selected;
	h.ctx.modelRegistry = registry;
	h.start();
	h.end();
	for (let i = 0; i < 100 && h.names.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(routes, ["direct"]);
	assert.deepEqual(h.names, ["Fix login session expiry"]);
	assert.equal(faux.state.callCount, 1);
});

test("generated names persist in Pi's native resume listing", async () => {
	// Explicit repository-local fixture, never the user's real session store.
	const dir = mkdtempSync(join(process.cwd(), "node_modules", ".session-naming-"));
	try {
		const manager = SessionManager.create(process.cwd(), dir);
		const h = harness();
		h.ctx.sessionManager = manager;
		h.pi.getSessionName = () => manager.getSessionName();
		h.pi.setSessionName = (name) => { manager.appendSessionInfo(name); };
		h.start();
		manager.appendMessage({ ...user.message, role: "user", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant", content: [{ type: "text", text: "Updated token refresh." }],
			stopReason: "stop", api: "openai-responses", provider: "test", model: "session-model", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		h.fire("agent_end");
		await flush();
		const sessions = await SessionManager.list(process.cwd(), dir);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].name, "Fix login session expiry");
		assert.equal(SessionManager.open(sessions[0].path).getSessionName(), "Fix login session expiry");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("titles are single-line, terminal-safe and length bounded", () => {
	assert.equal(cleanSessionTitle('\u001b[31m"Fix login expiry"\u001b[0m\nExplanation'), "Fix login expiry");
	assert.equal(cleanSessionTitle("\nTitle: Fix\u0007 login\u202e"), "Fix login");
	assert.equal(Array.from(cleanSessionTitle("😀".repeat(100))).length, 80);
});
