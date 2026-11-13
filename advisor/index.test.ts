/**
 * advisor/index.ts — registrar wiring through a mocked Pi/ctx harness:
 * recipe-driven activation, the side call seam, per-run limits, the
 * /advisor session override, live recipe switches, subagent inheritance,
 * and width-safe rendering. No network: `complete` is injected.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	ADVISOR_ENV,
	ADVISOR_STATE_ENTRY,
	getAdvisorAccess,
	parseAdvisorSetting,
	setRecipeAdvisor,
} from "./config.ts";
import { registerAdvisor, type AdvisorCompleteFn, type AdvisorResponse } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolDef {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		usage?: unknown;
	}>;
	renderCall: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
}

const savedEnv = { child: process.env.AIO_SUBAGENT_CHILD, advisor: process.env[ADVISOR_ENV] };

afterEach(() => {
	setRecipeAdvisor(undefined);
	if (savedEnv.child === undefined) delete process.env.AIO_SUBAGENT_CHILD;
	else process.env.AIO_SUBAGENT_CHILD = savedEnv.child;
	if (savedEnv.advisor === undefined) delete process.env[ADVISOR_ENV];
	else process.env[ADVISOR_ENV] = savedEnv.advisor;
});

const MODELS = [
	{ provider: "anthropic", id: "claude-opus", api: "anthropic-messages" },
	{ provider: "openai", id: "gpt-x", api: "openai-responses" },
];

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

function reply(text: string, extra: Partial<AdvisorResponse> = {}): AdvisorResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 1200,
			output: 300,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		...extra,
	};
}

function harness(options: { child?: boolean; responses?: AdvisorResponse[]; branch?: unknown[] } = {}) {
	if (options.child) process.env.AIO_SUBAGENT_CHILD = "1";
	else delete process.env.AIO_SUBAGENT_CHILD;

	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDef>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const branch: unknown[] = options.branch ?? [
		{ type: "message", message: { role: "user", content: "refactor the router" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reading files first." }] } },
	];
	let active = ["read", "bash", "edit"];
	const calls: Array<Parameters<AdvisorCompleteFn>> = [];
	const responses = [...(options.responses ?? [])];

	const complete: AdvisorCompleteFn = async (...args) => {
		calls.push(args);
		return responses.shift() ?? reply("On track.\n1. Run the tests.");
	};

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (def: ToolDef) => tools.set(def.name, def),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => [
			{ name: "read", description: "Read a file" },
			{ name: "bash", description: "Run a shell command" },
			{ name: "advisor", description: "Consult" },
		],
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
	};

	const ctx = {
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		scopedModels: [],
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
		getSystemPrompt: () => "EXECUTOR PROMPT",
		modelRegistry: {
			find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id),
			getModelsOfType: () => MODELS,
			getAvailable: () => MODELS,
		},
	};

	// SAFETY: the harness implements the Pi surface the registrar touches.
	registerAdvisor(pi as never, { complete });

	const emit = async (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const tool = () => {
		const def = tools.get("advisor");
		assert.ok(def, "advisor tool registered");
		return def;
	};
	const run = (params: Record<string, unknown> = {}) => tool().execute("call-1", params, undefined, undefined, ctx);
	const command = async (args: string) => {
		const def = commands.get("advisor");
		assert.ok(def, "advisor command registered");
		await def.handler(args, ctx);
	};
	return { ctx, branch, calls, notifications, commands, emit, run, tool, command, active: () => active };
}

test("off by default: no recipe advisor → tool inactive, no env mirror", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.active().includes("advisor"), false);
	assert.equal(process.env[ADVISOR_ENV], undefined);
	await assert.rejects(h.run(), /advisor is off/);
});

test("a recipe advisor turns the tool on and mirrors it for subagents", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting("anthropic/claude-opus:xhigh")! });
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.active().includes("advisor"), true);
	assert.equal(JSON.parse(process.env[ADVISOR_ENV]!).model, "anthropic/claude-opus");

	// Another feature's snapshot restore drops it; the next run re-adds it.
	await h.emit("before_agent_start");
	assert.equal(h.active().filter((n) => n === "advisor").length, 1);

	setRecipeAdvisor(undefined);
	await h.emit("before_agent_start");
	assert.equal(h.active().includes("advisor"), false);
	assert.equal(process.env[ADVISOR_ENV], undefined);
});

test("execute: one side call with the advisor model, reasoning, curated context", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting({ model: "anthropic/claude-opus:xhigh", maxTokens: 4096 })! });
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.emit("agent_start");
	await h.emit("tool_result", { toolName: "read", input: { path: "router.ts" }, isError: false });
	await h.emit("tool_result", { toolName: "bash", input: { command: "rg route" }, isError: false });

	const result = await h.run();
	assert.equal(result.content[0]?.text, "On track.\n1. Run the tests.");
	assert.deepEqual(
		{ stage: result.details.stage, callNumber: result.details.callNumber, model: result.details.model },
		{ stage: "initial", callNumber: 1, model: "anthropic/claude-opus" },
	);
	assert.ok(result.usage, "usage is reported for accounting");

	const [, model, context, callOptions] = h.calls[0]!;
	assert.equal((model as { id: string }).id, "claude-opus");
	assert.equal(callOptions.reasoning, "xhigh");
	assert.equal(callOptions.maxTokens, 4096);
	assert.equal(callOptions.sessionId, "session-1");
	assert.match(context.systemPrompt, /EXECUTOR PROMPT/);
	assert.match(context.systemPrompt, /- bash: Run a shell command/);
	assert.doesNotMatch(context.systemPrompt, /- advisor:/);
	assert.match(String(context.messages.at(-1)?.content), /- read router\.ts\n- \$ rg route/);
});

test("per-run limit, run reset, and failures surface as errors", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting({ model: "anthropic/claude-opus", maxUsesPerRun: 1 })! });
	const h = harness({
		responses: [reply("ok"), reply("", { stopReason: "error", errorMessage: "overloaded" }), reply("")],
	});
	await h.emit("session_start", { reason: "startup" });
	await h.emit("agent_start");
	await h.run({ stage: "recovery" });
	await assert.rejects(h.run(), /usage limit reached \(1 per run\)/);
	await h.emit("agent_start");
	await assert.rejects(h.run(), /Advisor call failed: overloaded/);
	await h.emit("agent_start");
	await assert.rejects(h.run(), /empty response/);
});

test("unknown model and empty transcript throw before any call", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting("nope/missing")! });
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await assert.rejects(h.run(), /"nope\/missing" was not found/);

	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting("openai/gpt-x")! });
	const empty = harness({ branch: [] });
	await empty.emit("session_start", { reason: "startup" });
	await assert.rejects(empty.run(), /No conversation context/);
	assert.equal(empty.calls.length, 0);
});

test("/advisor off|on|reset override the recipe for the session and persist", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting({ model: "anthropic/claude-opus", maxUsesPerRun: 5 })! });
	const h = harness();
	await h.emit("session_start", { reason: "startup" });

	await h.command("off");
	assert.equal(h.active().includes("advisor"), false);
	assert.deepEqual((h.branch.at(-1) as { data: unknown }).data, { override: { mode: "off" } });

	await h.command("on openai/gpt-x:low");
	assert.equal(h.active().includes("advisor"), true);
	const on = (h.branch.at(-1) as { data: { override: { settings: Record<string, unknown> } } }).data.override;
	// Model + reasoning from the command, limits kept from the recipe.
	assert.deepEqual(
		{ model: on.settings.model, reasoning: on.settings.reasoning, maxUsesPerRun: on.settings.maxUsesPerRun },
		{ model: "openai/gpt-x", reasoning: "low", maxUsesPerRun: 5 },
	);

	await h.command("");
	assert.match(h.notifications.at(-1)!.message, /Advisor: on — openai\/gpt-x:low\nSource: session override/);
	assert.match(h.notifications.at(-1)!.message, /Recipe "work" sets: anthropic\/claude-opus:high/);

	await h.command("on missing/model");
	assert.match(h.notifications.at(-1)!.message, /was not found/);

	await h.command("reset");
	assert.deepEqual((h.branch.at(-1) as { data: unknown }).data, { override: null });
	assert.match(h.notifications.at(-1)!.message, /following the recipe — anthropic\/claude-opus:high/);

	// A new session on the same branch restores the newest override.
	await h.command("off");
	await h.emit("session_start", { reason: "resume" });
	assert.equal(h.active().includes("advisor"), false);
});

test("/advisor on without a model needs a recipe advisor", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.command("on");
	assert.match(h.notifications.at(-1)!.message, /Name a model/);
	assert.equal(h.active().includes("advisor"), false);
});

test("a live recipe switch drops the session override", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting("anthropic/claude-opus")! });
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.command("off");
	getAdvisorAccess()?.followRecipe(h.ctx as never);
	assert.equal(h.active().includes("advisor"), true);
	assert.deepEqual((h.branch.at(-1) as { customType: string; data: unknown }), {
		type: "custom",
		customType: ADVISOR_STATE_ENTRY,
		data: { override: null },
	});
});

test("subagent child: no command, inherits the parent's advisor from the env", async () => {
	process.env[ADVISOR_ENV] = JSON.stringify(parseAdvisorSetting("openai/gpt-x:medium"));
	const h = harness({ child: true });
	assert.equal(h.commands.has("advisor"), false);
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.active().includes("advisor"), true);
	// Children never rewrite or clear the inherited mirror.
	assert.equal(JSON.parse(process.env[ADVISOR_ENV]!).model, "openai/gpt-x");
	await h.run();
	assert.equal(h.calls[0]![3].reasoning, "medium");
});

test("renderers keep every line within the width", async () => {
	setRecipeAdvisor({ recipe: "work", settings: parseAdvisorSetting("anthropic/claude-opus")! });
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const long = `Course-correct ${"x".repeat(200)}\n${Array.from({ length: 10 }, (_, i) => `${i + 1}. step`).join("\n")}`;
	const result = { content: [{ type: "text", text: long }], details: { stage: "recovery", callNumber: 1, maxUses: 3, model: "anthropic/claude-opus", inputTokens: 12_345, outputTokens: 678 } };
	for (const width of [1, 8, 30, 80]) {
		const rows = [
			...h.tool().renderCall({ stage: "final-check" }, theme, {}).render(width),
			...h.tool().renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }).render(width),
			...h.tool().renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false }).render(width),
			...h.tool().renderResult(result, { expanded: false, isPartial: true }, theme, { isError: false }).render(width),
			...h.tool().renderResult({ content: [{ type: "text", text: "boom ".repeat(30) }] }, { expanded: false, isPartial: false }, theme, { isError: true }).render(width),
		];
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
	}
	const collapsed = h.tool().renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }).render(80);
	assert.ok(collapsed.some((row) => row.includes("more lines")));
	assert.ok(collapsed.some((row) => row.includes("↑12k · ↓678")));
	assert.match(h.tool().renderCall({}, theme, {}).render(80)[0]!, /ADVISOR · anthropic\/claude-opus · auto stage/);
});
