import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { recipeScaffold, registerRecipes } from "./index.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
	ACTIVE_RECIPE_ENV,
	RECIPE_CONTEXT_TYPE,
	RECIPE_FLAG,
	RECIPE_ORIGIN_ENV,
	RECIPE_STAGE_ENV,
	RECIPE_STATE_ENTRY,
	RECIPES_FILE_ENV,
} from "./config.ts";
import { recipeRuntime, resetRecipeRuntimeForTests } from "./apply.ts";
import { TRUST_CHOICE_LABELS, recipeFileTrust, recordRecipeFileTrust } from "./trust.ts";
import { RECIPE_STATUS_ENTRY, type RecipeStatusReport } from "./status.ts";

// Isolated agent dir for loadRecipes (PI_CODING_AGENT_DIR + the
// AIO_RECIPES_FILE scratch contract the same way the blocklist suite does).
const tmp = mkdtempSync(join(tmpdir(), "aio-recipes-registration-"));
const agentDir = join(tmp, "agent");
mkdirSync(agentDir, { recursive: true });
function writeRecipesFile(config: unknown): void {
	writeFileSync(join(agentDir, "aio-recipes.json"), JSON.stringify(config));
}
function restoreRecipesFile(): void {
	writeRecipesFile({
		defaultRecipe: "home",
		recipes: {
			home: {
				description: "Personal stack",
				model: "anthropic/claude-5:high",
			},
			work: {
				description: "Work subscriptions",
				mcpServers: { linear: { url: "https://mcp.example.com/linear" } },
			},
		},
	});
}
restoreRecipesFile();

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env[RECIPES_FILE_ENV] = join(agentDir, "aio-recipes.json");

const SAVED_ACTIVE_RECIPE = process.env[ACTIVE_RECIPE_ENV];
const SAVED_SUBAGENT_CHILD = process.env.AIO_SUBAGENT_CHILD;

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env[RECIPES_FILE_ENV];
	if (SAVED_ACTIVE_RECIPE === undefined) delete process.env[ACTIVE_RECIPE_ENV];
	else process.env[ACTIVE_RECIPE_ENV] = SAVED_ACTIVE_RECIPE;
	if (SAVED_SUBAGENT_CHILD === undefined) delete process.env.AIO_SUBAGENT_CHILD;
	else process.env.AIO_SUBAGENT_CHILD = SAVED_SUBAGENT_CHILD;
	rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockState {
	events: Map<string, Handler[]>;
	commands: Map<string, { description?: string; getArgumentCompletions?: (p: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }>;
	flagOptions: Map<string, Record<string, unknown>>;
	entryRenderers: Map<string, unknown>;
	flagValues: Map<string, boolean | string | undefined>;
	entries: Array<{ customType: string; data: unknown }>;
	notifications: Array<{ message: string; type: string }>;
	statuses: Map<string, string | undefined>;
	activeTools: string[];
	setActiveCalls: string[][];
	setModelCalls: Array<{ provider: string; id: string }>;
	thinkingCalls: string[];
	registeredMcp: Map<string, unknown>;
	branchEntries: unknown[];
	selectReturns: Array<string | undefined>;
	uiHasUI: boolean;
	startupExitCode: number | undefined;
}

function makeMocks(): { pi: Record<string, unknown>; state: MockState } {
	const state: MockState = {
		events: new Map(),
		commands: new Map(),
		flagOptions: new Map(),
		entryRenderers: new Map(),
		flagValues: new Map(),
		entries: [],
		notifications: [],
		statuses: new Map(),
		activeTools: ["read", "bash", "edit", "write"],
		setActiveCalls: [],
		setModelCalls: [],
		thinkingCalls: [],
		registeredMcp: new Map(),
		branchEntries: [],
		selectReturns: [],
		uiHasUI: true,
		startupExitCode: undefined,
	};

	const pi = {
		registerFlag: (name: string, options: Record<string, unknown>) => {
			state.flagOptions.set(name, options);
		},
		registerEntryRenderer: (name: string, renderer: unknown) => { state.entryRenderers.set(name, renderer); },
		getCommands: () => [...state.commands.keys()].map(name => ({
			name, source: "extension", sourceInfo: { path: "/fixture/aio/index.ts", source: "cli", scope: "temporary", origin: "top-level" },
		})),
		getThinkingLevel: () => state.thinkingCalls.at(-1) ?? "xhigh",
		registerCommand: (name: string, command: unknown) => {
			state.commands.set(name, command as MockState["commands"] extends Map<string, infer V> ? V : never);
		},
		getFlag: (name: string) => state.flagValues.get(name),
		on: (event: string, handler: Handler) => {
			state.events.set(event, [...(state.events.get(event) ?? []), handler]);
		},
		appendEntry: (customType: string, data: unknown) => {
			state.entries.push({ customType, data });
		},
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (names: string[]) => {
			state.activeTools = [...names];
			state.setActiveCalls.push([...names]);
		},
		getAllTools: () =>
			["read", "bash", "edit", "write", "codemode", "grep", "find", "ls"].map((name) => ({ name })),
		setModel: async (model: { provider: string; id: string }) => {
			state.setModelCalls.push({ ...model });
			return true;
		},
		setThinkingLevel: (level: string) => {
			state.thinkingCalls.push(level);
		},
		registerMcpServer: (name: string, config: unknown) => {
			state.registeredMcp.set(name, config);
		},
		unregisterMcpServer: (name: string) => {
			state.registeredMcp.delete(name);
		},
		events: { emit: () => {} },
	};

	return { pi, state };
}

function makeCtx(state: MockState) {
	return {
		ui: {
			notify: (message: string, type?: string) =>
				state.notifications.push({ message, type: type ?? "info" }),
			setStatus: (key: string, text: string | undefined) => state.statuses.set(key, text),
			select: async (_title: string, _options: string[]) => state.selectReturns.shift(),
			theme: { fg: (_role: string, text: string) => text },
		},
		mode: "tui",
		hasUI: state.uiHasUI,
		cwd: "/tmp/project",
		sessionManager: { getBranch: () => state.branchEntries },
		isProjectTrusted: () => true,
		modelRegistry: {
			find: (provider: string, id: string) =>
				modelsHelper.find((m) => m.provider === provider && m.id === id),
			getModelsOfType: (type: string) => (type === "chat" ? modelsHelper : []),
		},
		scopedModels: [],
		model: modelsHelper[0],
	};
}

const modelsHelper = [{ provider: "anthropic", id: "claude-5" }];

async function fire(
	state: MockState,
	event: string,
	argument: unknown,
	ctx: unknown,
): Promise<unknown> {
	const handlers = state.events.get(event) ?? [];
	let result: unknown;
	for (const handler of handlers) {
		result = await handler(argument, ctx);
	}
	return result;
}

test.beforeEach(() => {
	resetRecipeRuntimeForTests();
	restoreRecipesFile();
	delete process.env[ACTIVE_RECIPE_ENV];
	delete process.env.AIO_SUBAGENT_CHILD;
});

test("registration wires the flag, command, and lifecycle events", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);

	assert.equal((state.flagOptions.get(RECIPE_FLAG) as { type: string }).type, "string");
	assert.match(
		(state.flagOptions.get(RECIPE_FLAG) as { description: string }).description,
		/named recipe/,
	);
	const command = state.commands.get("recipe");
	assert.ok(command, "/recipe command registered");
	assert.match(command.description!, /aio-recipes\.json/);
	for (const event of [
		"context",
		"session_start",
		"session_tree",
		"session_shutdown",
	]) {
		assert.ok(state.events.has(event), `${event} handler registered`);
	}
});

test("the relaunch bridge stays down when no --recipe flag is on the test argv", async () => {
	const { pi } = makeMocks();
	// The test runner's own argv has no --recipe: registration must complete
	// without relaunching (this exercises the factory-time decision path).
	await registerRecipes(pi as never);
	assert.equal(recipeRuntime().launchNotice, undefined);
});

test("subagent children register the context filter but no command surface", async () => {
	process.env.AIO_SUBAGENT_CHILD = "1";
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);

	assert.ok(state.events.has("context"));
	assert.equal(state.commands.size, 0);
	assert.equal(state.events.has("session_start"), false);
	assert.equal(state.events.has("before_agent_start"), false);
	// The inherited-instruction contract: a forked child strips its parent's
	// recipe instructions from context while no recipe is active.
	const messages = [
		{ role: "user", content: [], customType: RECIPE_CONTEXT_TYPE },
		{ role: "user", content: [], customType: "plain" },
	] as unknown as AgentMessage[];
	const result = (await fire(state, "context", { messages }, makeCtx(state))) as {
		messages: AgentMessage[];
	};
	assert.deepEqual(
		result.messages.map((m) => (m as { customType?: string }).customType),
		["plain"],
	);
	assert.equal(
		(await fire(state, "context", { messages: [] }, makeCtx(state))) as never,
		undefined,
		"evidence-incredible filter normal path",
	);
});

test("session_start applies a --recipe flag selection end to end", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	state.flagValues.set(RECIPE_FLAG, "home");

	const ctx = makeCtx(state);
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const runtime = recipeRuntime();
	assert.equal(runtime.activeName, "home");
	assert.equal(runtime.source, "flag");
	assert.match(state.statuses.get("recipe")!, /recipe:home/);
	// Model + `:high` suffix thinking applied, and the state
	// entry pins the selection on the branch.
	assert.deepEqual(state.setModelCalls, [{ provider: "anthropic", id: "claude-5" }]);
	assert.deepEqual(state.thinkingCalls, ["high"]);
	assert.deepEqual(state.setActiveCalls, []);
	assert.deepEqual(state.entries, [{ customType: RECIPE_STATE_ENTRY, data: { name: "home" } }]);
	assert.match(
		state.notifications.find((n) =>
			n.message.includes('Recipe "home" active'))!.message,
		/applied: model, thinking/,
	);
});

test("session_start precedence: env (relaunched child) beats a session entry; flag beats both", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	state.branchEntries = [
		{ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name: "home" } },
	];

	// No flag, no env: the session's own entry wins on resume.
	await fire(state, "session_start", { type: "session_start", reason: "resume" }, makeCtx(state));
	assert.equal(recipeRuntime().source, "session");
	assert.equal(recipeRuntime().activeName, "home");
	assert.equal(state.entries.length, 0, "session restores do not re-pin entries");

	// A bridged relaunch (env) outranks the session entry.
	state.flagValues.clear();
	process.env[ACTIVE_RECIPE_ENV] = "work";
	await fire(state, "session_start", { type: "session_start", reason: "resume" }, makeCtx(state));
	assert.equal(recipeRuntime().source, "env");
	assert.equal(recipeRuntime().activeName, "work");
	assert.equal(state.entries.length, 1, "env selection pins its own entry");

	// The --recipe flag beats everything.
	state.flagValues.set(RECIPE_FLAG, "home");
	await fire(state, "session_start", { type: "session_start", reason: "resume" }, makeCtx(state));
	assert.equal(recipeRuntime().source, "flag");
	assert.equal(recipeRuntime().activeName, "home");
});

test("a relaunched recipe stops when its requested scope resolves to zero models", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never, {
		exitOnInvalidScope: (code) => { state.startupExitCode = code; throw new Error("test startup exit"); },
	});
	const originalArgv = process.argv;
	try {
		process.env[ACTIVE_RECIPE_ENV] = "work";
		process.argv = [...originalArgv.slice(0, 2), "--models", "cursor/grok-4.7"];
		await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
		assert.equal(state.startupExitCode, 1, "never start with Pi's implicit all-model scope");
		assert.equal(recipeRuntime().activeName, undefined);
		assert.equal(state.setModelCalls.length, 0);
		assert.equal(state.entries.length, 0, "do not pin a recipe that did not activate");
		assert.ok(state.notifications.some((notice) =>
			notice.type === "error" && /cursor\/grok-4\.7/.test(notice.message) && /Stopping/.test(notice.message),
		));
	} finally {
		process.argv = originalArgv;
	}
});

test("an explicit --models override also stops an unbridged recipe if unresolved", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never, {
		exitOnInvalidScope: (code) => { state.startupExitCode = code; throw new Error("test startup exit"); },
	});
	const originalArgv = process.argv;
	try {
		state.flagValues.set(RECIPE_FLAG, "work");
		process.argv = [...originalArgv.slice(0, 2), "--models", "cursor/missing"];
		await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
		assert.equal(state.startupExitCode, 1);
		assert.equal(recipeRuntime().activeName, undefined);
	} finally {
		process.argv = originalArgv;
	}
});

test("a relaunched recipe with a resolved scope activates normally", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const originalArgv = process.argv;
	try {
		process.env[ACTIVE_RECIPE_ENV] = "home";
		process.argv = [...originalArgv.slice(0, 2), "--models", "anthropic/claude-5"];
		const ctx = { ...makeCtx(state), scopedModels: [{ model: modelsHelper[0] }] };
		await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
		assert.equal(state.startupExitCode, undefined);
		assert.equal(recipeRuntime().activeName, "home");
		assert.equal(state.setModelCalls.length, 1);
	} finally {
		process.argv = originalArgv;
	}
});

test("reload preserves a scope the user intentionally changed to all models", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never, {
		exitOnInvalidScope: (code) => { state.startupExitCode = code; throw new Error("test startup exit"); },
	});
	const originalArgv = process.argv;
	try {
		process.env[ACTIVE_RECIPE_ENV] = "home";
		process.argv = [...originalArgv.slice(0, 2), "--models", "anthropic/claude-5"];
		const scopedCtx = { ...makeCtx(state), scopedModels: [{ model: modelsHelper[0] }] };
		await fire(state, "session_start", { type: "session_start", reason: "startup" }, scopedCtx);
		await fire(state, "session_start", { type: "session_start", reason: "reload" }, makeCtx(state));
		assert.equal(state.startupExitCode, undefined);
		assert.equal(recipeRuntime().activeName, "home");
	} finally {
		process.argv = originalArgv;
	}
});

test("session_start auto-activates defaultRecipe on a fresh startup only", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);

	await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
	assert.equal(recipeRuntime().activeName, "home");
	assert.equal(recipeRuntime().source, "default");

	// A brand-new in-process session (/model new) never re-defaults.
	state.branchEntries = [];
	await fire(state, "session_start", { type: "session_start", reason: "new" }, makeCtx(state));
	assert.equal(recipeRuntime().activeName, undefined);
});

test("session_start without any selection clears leftover state", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	writeRecipesFile({ recipes: {} }); // no default, no recipes

	const ctx = makeCtx(state);
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(recipeRuntime().activeName, undefined);
	assert.equal(state.statuses.get("recipe"), undefined);

	// Unknown selected names notify and stay inert.
	state.flagValues.set(RECIPE_FLAG, "ghost");
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const ghostNotice = state.notifications.find((n) =>
		/Unknown recipe "ghost"/.test(n.message),
	);
	assert.ok(ghostNotice, "unknown recipes notify");
	assert.match(ghostNotice.message, /none configured/);
	assert.equal(recipeRuntime().activeName, undefined);

	// And a bare --recipe flag (parsed as boolean true) warns.
	state.flagValues.set(RECIPE_FLAG, true);
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const bareNotice = state.notifications.find((n) =>
		/--recipe needs a recipe name/.test(n.message),
	);
	assert.ok(bareNotice, "bare --recipe warns");
	assert.match(bareNotice.message, /--recipe needs a recipe name/);
});

test("the bridge's opening notice is stored and fired once", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const runtime = recipeRuntime();
	runtime.launchNotice = 'recipe "work": model scope left unchanged (overridden by explicit CLI flags)';

	await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
	assert.equal(
		state.notifications.filter((n) => n.message.includes("model scope left unchanged")).length,
		1,
	);
	// Second session_start does not repeat the warning.
	await fire(state, "session_start", { type: "session_start", reason: "resume" }, makeCtx(state));
	assert.equal(
		state.notifications.filter((n) => n.message.includes("model scope left unchanged")).length,
		1,
	);
});

test("legacy recipe options neither inject context nor discover resources nor change tools", async () => {
	writeRecipesFile({ recipes: { work: {
		tools: ["read"], instructions: "Old rules", skills: ["skills/work.md"],
		prompts: ["prompts/work.md"], themes: ["theme.json"],
	} } });
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	state.flagValues.set(RECIPE_FLAG, "work");
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
	assert.equal(recipeRuntime().activeName, "work");
	assert.equal(state.events.has("before_agent_start"), false);
	assert.equal(state.events.has("resources_discover"), false);
	assert.deepEqual(state.activeTools, ["read", "bash", "edit", "write"]);
	assert.deepEqual(state.setActiveCalls, []);
	const plain = { role: "user", content: "Hello" };
	const result = await fire(state, "context", { messages: [
		{ role: "custom", customType: RECIPE_CONTEXT_TYPE, content: "Old rules" }, plain,
	] }, makeCtx(state)) as { messages: unknown[] };
	assert.deepEqual(result.messages, [plain], "active recipes also strip legacy instructions");
	await state.commands.get("recipe")!.handler("off", makeCtx(state));
	await state.commands.get("recipe")!.handler("work", makeCtx(state));
	assert.deepEqual(state.setActiveCalls, [], "switching never changes tools");
});

test("/recipe switches mid-session and /recipe off clears", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const command = state.commands.get("recipe")!;
	const ctx = makeCtx(state);

	// No session_start has fired yet: the command still refreshes the config
	// itself, so the switch works even before the cache is warm.
	await command.handler("work", ctx);
	assert.equal(recipeRuntime().activeName, "work");
	assert.equal(recipeRuntime().source, "command");
	assert.match(
		state.notifications.find((n) => n.message.includes('Recipe "work" active'))!
			.message,
		/applied: mcp/,
	);
	// Switching persists the new selection for the branch.
	assert.deepEqual(state.entries.at(-1), {
		customType: RECIPE_STATE_ENTRY,
		data: { name: "work" },
	});

	await command.handler("off", ctx);
	assert.equal(recipeRuntime().activeName, undefined);
	assert.deepEqual(state.entries.at(-1), {
		customType: RECIPE_STATE_ENTRY,
		data: { name: null },
	});
	assert.equal(state.registeredMcp.size, 0, "off unregisters this feature's MCP servers");
});

test("/recipe with no args shows the picker (or names the recipes without UI)", async () => {
const { pi, state } = makeMocks();
await registerRecipes(pi as never);
const command = state.commands.get("recipe")!;

// Non-UI: the command refreshes its own config view and lists recipes.
state.uiHasUI = false;
await command.handler("", makeCtx(state));
assert.match(
state.notifications.at(-1)!.message,
/Recipe: none — available: home, work/,
);

// UI: picker with description labels; "off" clears.
state.uiHasUI = true;
state.selectReturns.push("off — clear the active recipe");
await command.handler("", makeCtx(state));
assert.equal(recipeRuntime().activeName, undefined);
assert.match(state.notifications.at(-1)!.message, /Recipe: off/);

// Unknown names list what exists.
await command.handler("ghost", makeCtx(state));
assert.match(state.notifications.at(-1)!.message, /Unknown recipe "ghost". Available: home, work/);
});

test("/recipe status inspects runtime without changing recipe/model/tools or starting a turn", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const ctx = makeCtx(state);
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const modelCalls = state.setModelCalls.length;
	const toolCalls = state.setActiveCalls.length;
	const recipeEntries = state.entries.filter(entry => entry.customType === RECIPE_STATE_ENTRY).length;
	await state.commands.get("recipe")!.handler("status", ctx);
	assert.equal(recipeRuntime().activeName, "home");
	assert.equal(state.setModelCalls.length, modelCalls);
	assert.equal(state.setActiveCalls.length, toolCalls);
	assert.equal(state.entries.filter(entry => entry.customType === RECIPE_STATE_ENTRY).length, recipeEntries);
	assert.ok(state.entryRenderers.has(RECIPE_STATUS_ENTRY));
	const entry = state.entries.at(-1);
	assert.equal(entry?.customType, RECIPE_STATUS_ENTRY);
	// SAFETY: the status command stores this report type in its own entry.
	const report = entry?.data as RecipeStatusReport;
	assert.equal(report.runtime.model, "anthropic/claude-5");
	assert.equal(report.runtime.scopeMode, "all");
	assert.ok(report.observedExtensionSources.some(source => source.path === "/fixture/aio/index.ts"));
});

test("status JSON and the dedicated /recipe-status spelling are available", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const ctx = makeCtx(state);
	await state.commands.get("recipe")!.handler("status --json", ctx);
	const notice = state.notifications.at(-1);
	assert.ok(notice);
	assert.equal(JSON.parse(notice.message).recipe, null);
	await state.commands.get("recipe-status")!.handler("--json", ctx);
	assert.equal(state.entries.at(-1)?.customType, RECIPE_STATUS_ENTRY);
	const count = state.entries.length;
	await state.commands.get("recipe-status")!.handler("unknown-option", ctx);
	assert.equal(state.entries.length, count);
	assert.match(state.notifications.at(-1)!.message, /Use \/recipe-status/);
});

test("an existing recipe named status keeps its switching semantics", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	writeRecipesFile({ recipes: { status: { model: "anthropic/claude-5" } } });
	const ctx = makeCtx(state);
	await state.commands.get("recipe")!.handler("status", ctx);
	assert.equal(recipeRuntime().activeName, "status");
	assert.equal(state.entries.at(-1)?.customType, RECIPE_STATE_ENTRY);
	await state.commands.get("recipe-status")!.handler("", ctx);
	assert.equal(recipeRuntime().activeName, "status");
	assert.equal(state.entries.at(-1)?.customType, RECIPE_STATUS_ENTRY);
});

test("/recipe completions cover names, descriptions, and off", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	// Completions read the recipe cache the session populated.
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
	const command = state.commands.get("recipe")!;
	const completions = (await command.getArgumentCompletions?.("")) as Array<{
		value: string;
		description: string;
	}>;
	assert.deepEqual(
		completions.map((c) => c.value),
		["home", "work", "off", "init", "status"],
	);
	// Each named recipe carries its configured description.
	assert.equal(
		completions.find((c) => c.value === "work")!.description,
		"Work subscriptions",
	);
	const none = await command.getArgumentCompletions?.("zzz");
	assert.equal(none, null, "empty completions yield null");
});

// ---------------------------------------------------------------------------
// .pi-recipe directory defaults
// ---------------------------------------------------------------------------

function makeRepo(name: string, config: unknown): string {
	const dir = join(tmp, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".pi-recipe"), JSON.stringify(config));
	return dir;
}

async function withEnv(values: Record<string, string>, body: () => Promise<void>): Promise<void> {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try {
		await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("a trusted .pi-recipe default activates on a fresh startup with its own marker", async () => {
	const cwd = makeRepo("repo-trusted", {
		defaultRecipe: "repo",
		recipes: { repo: { description: "Repo stack" } },
	});
	recordRecipeFileTrust(join(cwd, ".pi-recipe"), true);
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);

	await fire(state, "session_start", { type: "session_start", reason: "startup" }, { ...makeCtx(state), cwd });
	assert.equal(state.selectReturns.length, 0);
	assert.equal(recipeRuntime().activeName, "repo");
	assert.equal(recipeRuntime().source, "directory");
	assert.equal(recipeRuntime().active?.source, "directory");
	assert.deepEqual(state.entries.at(-1), { customType: RECIPE_STATE_ENTRY, data: { name: "repo" } });

	// A recipe picked mid-session is pinned and restored on resume.
	await state.commands.get("recipe")!.handler("work", { ...makeCtx(state), cwd });
	state.branchEntries = [{ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name: "work" } }];
	await fire(state, "session_start", { type: "session_start", reason: "resume" }, { ...makeCtx(state), cwd });
	assert.equal(recipeRuntime().activeName, "work");
});

test("a directory relaunch is a default: a restored session recipe outranks it", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	await withEnv(
		{ [ACTIVE_RECIPE_ENV]: "work", [RECIPE_ORIGIN_ENV]: "directory", [RECIPE_STAGE_ENV]: "1" },
		async () => {
			// Fresh relaunched child: the bridged default applies.
			await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
			assert.equal(recipeRuntime().activeName, "work");
			assert.equal(recipeRuntime().source, "directory");

			// /resume inside that child: the resumed session's recipe wins.
			state.branchEntries = [{ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name: "home" } }];
			await fire(state, "session_start", { type: "session_start", reason: "resume" }, makeCtx(state));
			assert.equal(recipeRuntime().activeName, "home");
			assert.equal(recipeRuntime().source, "session");

			// /new never re-applies a default.
			state.branchEntries = [];
			await fire(state, "session_start", { type: "session_start", reason: "new" }, makeCtx(state));
			assert.equal(recipeRuntime().activeName, undefined);
		},
	);
});

test("a continue bridge keeps branch selection authoritative and does not re-pin it", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	await withEnv(
		{ [ACTIVE_RECIPE_ENV]: "work", [RECIPE_ORIGIN_ENV]: "session", [RECIPE_STAGE_ENV]: "1" },
		async () => {
			for (const [reason, name] of [["startup", "work"], ["resume", "home"], ["resume", null], ["startup", null]] as const) {
				state.branchEntries = [{ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name } }];
				await fire(state, "session_start", { type: "session_start", reason }, makeCtx(state));
				assert.equal(recipeRuntime().activeName, name ?? undefined);
				assert.equal(state.entries.length, 0, "restores do not append another recipe-state entry");
			}
			state.branchEntries = [];
			await fire(state, "session_start", { type: "session_start", reason: "new" }, makeCtx(state));
			assert.equal(recipeRuntime().activeName, undefined);
		},
	);
});

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("a new .pi-recipe is asked about before launch, even when pi trusts the folder", async () => {
	const cwd = makeRepo("repo-launch", {
		defaultRecipe: "repo",
		recipes: { repo: { description: "Repo stack" } },
	});
	const file = join(cwd, ".pi-recipe");
	new ProjectTrustStore(agentDir).set(cwd, true);
	const asked: string[] = [];
	const original = process.cwd();
	process.chdir(cwd);
	try {
		const { pi, state } = makeMocks();
		await registerRecipes(pi as never, {
			interactiveLaunch: true,
			promptTrust: async (path) => {
				asked.push(path);
				return "trust";
			},
		});
		assert.equal(asked.length, 1);
		assert.equal(recipeFileTrust(file), "trusted", "the answer is remembered");

		await fire(state, "session_start", { type: "session_start", reason: "startup" }, { ...makeCtx(state), cwd });
		assert.equal(recipeRuntime().activeName, "repo");
		assert.equal(state.selectReturns.length, 0);

		// Remembered: the next launch does not ask.
		resetRecipeRuntimeForTests();
		await registerRecipes(makeMocks().pi as never, {
			interactiveLaunch: true,
			promptTrust: async () => assert.fail("must not ask again"),
		});
	} finally {
		process.chdir(original);
	}
});

test("\"not now\" at launch skips the file without a second question in the session", async () => {
	const cwd = makeRepo("repo-skip", { defaultRecipe: "repo", recipes: { repo: {} } });
	writeRecipesFile({ recipes: { home: {} } });
	const original = process.cwd();
	process.chdir(cwd);
	try {
		const { pi, state } = makeMocks();
		await registerRecipes(pi as never, { interactiveLaunch: true, promptTrust: async () => "skip" });
		state.selectReturns = ["must not be consumed"];
		await fire(state, "session_start", { type: "session_start", reason: "startup" }, { ...makeCtx(state), cwd });
		await flush();
		assert.equal(recipeRuntime().activeName, undefined);
		assert.equal(state.selectReturns.length, 1);
		assert.equal(recipeFileTrust(join(cwd, ".pi-recipe")), "unknown", "skip is not remembered");
	} finally {
		process.chdir(original);
	}
});

test("without a launch prompt the session UI asks; trust activates, never is remembered", async () => {
	const cwd = makeRepo("repo-session", {
		defaultRecipe: "repo",
		recipes: { repo: { description: "Repo stack" } },
	});
	const file = join(cwd, ".pi-recipe");
	writeRecipesFile({ recipes: { home: {} } }); // no global default

	const first = makeMocks();
	await registerRecipes(first.pi as never);
	let title = "";
	const ctx = {
		...makeCtx(first.state),
		cwd,
		mode: "rpc",
		ui: {
			...makeCtx(first.state).ui,
			select: async (t: string) => {
				title = t;
				return TRUST_CHOICE_LABELS.trust;
			},
		},
	};
	await fire(first.state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await flush();
	assert.match(title, /Trust this recipe file\?/);
	assert.match(title, /default recipe: repo/);
	assert.equal(recipeFileTrust(file), "trusted");
	assert.equal(recipeRuntime().activeName, "repo");
	assert.equal(recipeRuntime().source, "directory");

	// Editing the file asks again; "never" is remembered for that version.
	writeFileSync(file, JSON.stringify({ defaultRecipe: "repo", recipes: { repo: { model: "x/y" } } }));
	resetRecipeRuntimeForTests();
	const second = makeMocks();
	await registerRecipes(second.pi as never);
	second.state.selectReturns = [TRUST_CHOICE_LABELS.deny];
	await fire(second.state, "session_start", { type: "session_start", reason: "startup" }, { ...makeCtx(second.state), cwd });
	await flush();
	assert.equal(recipeFileTrust(file), "denied");
	assert.equal(recipeRuntime().activeName, undefined);

	// /recipe trust overrides a remembered "never"; /recipe untrust forgets.
	const completions = (await second.state.commands.get("recipe")!.getArgumentCompletions?.("")) as Array<{ value: string }>;
	assert.ok(completions.some((c) => c.value === "trust"));
	assert.ok(completions.some((c) => c.value === "untrust"));
	assert.ok(!completions.some((c) => c.value === "init"), "no init while a file exists");
	await second.state.commands.get("recipe")!.handler("trust", { ...makeCtx(second.state), cwd });
	assert.equal(recipeFileTrust(file), "trusted");
	assert.equal(recipeRuntime().activeName, "repo");
	await second.state.commands.get("recipe")!.handler("untrust", { ...makeCtx(second.state), cwd });
	assert.equal(recipeFileTrust(file), "unknown");
	assert.match(second.state.notifications.at(-1)!.message, /next start asks again/);
});

test("/recipe init always scaffolds a full, self-contained, trusted .pi-recipe and refuses to overwrite", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const fresh = join(tmp, "My Repo");
	rmSync(fresh, { recursive: true, force: true });
	mkdirSync(fresh, { recursive: true });
	const ctx = { ...makeCtx(state), cwd: fresh };
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const completions = (await state.commands.get("recipe")!.getArgumentCompletions?.("in")) as Array<{ value: string }>;
	assert.deepEqual(completions.map((c) => c.value), ["init"]);

	// UI path: blank template, name suggested from the folder.
	let pickerOptions: string[] = [];
	let placeholder: string | undefined;
	await state.commands.get("recipe")!.handler("init", {
		...ctx,
		ui: {
			...ctx.ui,
			select: async (_t: string, options: string[]) => {
				pickerOptions = options;
				return options[0];
			},
			input: async (_t: string, p?: string) => { placeholder = p; return ""; },
		},
	});
	assert.deepEqual(pickerOptions, [
		"Blank recipe (current model)",
		"Copy home — Personal stack",
		"Copy work — Work subscriptions",
	]);
	assert.equal(placeholder, "my-repo");
	const file = join(fresh, ".pi-recipe");
	const written = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(written.defaultRecipe, "my-repo");
	assert.equal(written.recipes["my-repo"].model, "anthropic/claude-5");
	// Seeded from the live session (startup applied home's `:high`).
	assert.equal(written.recipes["my-repo"].thinkingLevel, "high");
	assert.deepEqual(Object.keys(written.recipes["my-repo"]), [
		"description", "model", "thinkingLevel", "models", "mcpServers", "extensions",
	]);
	assert.deepEqual(written.recipes["my-repo"].extensions, []);
	// Scoped to its own model: an empty `models` would leave every
	// settings.json enabledModels entry selectable.
	assert.deepEqual(written.recipes["my-repo"].models, ["anthropic/claude-5"]);
	assert.equal(recipeFileTrust(file), "trusted", "a file you created is trusted");
	assert.equal(recipeRuntime().recipes.recipes["my-repo"]?.source, "directory");

	await state.commands.get("recipe")!.handler("init", ctx);
	assert.match(state.notifications.at(-1)!.message, /already exists/);

	// A name matching a global recipe still gets its own full definition
	// (it overrides the global one in this folder) — never a reference.
	rmSync(file);
	state.selectReturns = ["Blank recipe (current model)"];
	await state.commands.get("recipe")!.handler("init work", ctx);
	const named = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(named.defaultRecipe, "work");
	assert.equal(named.recipes.work.model, "anthropic/claude-5");
	assert.equal(recipeRuntime().recipes.recipes.work?.source, "directory");
	assert.equal(recipeFileTrust(file), "trusted");

	// Reserved or malformed names are refused.
	rmSync(file);
	await state.commands.get("recipe")!.handler("init off", ctx);
	assert.match(state.notifications.at(-1)!.message, /Invalid recipe name "off"/);
	await state.commands.get("recipe")!.handler("init a b", ctx);
	assert.match(state.notifications.at(-1)!.message, /Invalid recipe name/);
	assert.equal(existsSync(file), false);
	assert.equal(state.selectReturns.length, 0, "bad names fail before the template picker");

	// Cancelling the picker writes nothing.
	state.selectReturns = [undefined];
	await state.commands.get("recipe")!.handler("init", ctx);
	assert.equal(existsSync(file), false);
});

test("/recipe init copies a home recipe as a self-contained template (picker or --from)", async () => {
	writeRecipesFile({
		recipes: {
			work: {
				description: "Work subscriptions",
				model: "openai-codex/gpt-5:medium",
				models: ["openai-codex/*"],
				instructions: "Ship carefully.",
				skills: ["skills/work.md", "/abs/skill.md"],
				prompts: ["prompts/work.md"],
				themes: ["theme.json"],
				tools: ["read"],
				mcpServers: { linear: { url: "https://mcp.example.com/linear" } },
				extensions: ["otty-integration", "npm:pi-web-access"],
			},
		},
	});
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	const repo = join(tmp, "template-repo");
	rmSync(repo, { recursive: true, force: true });
	mkdirSync(repo, { recursive: true });
	const ctx = { ...makeCtx(state), cwd: repo };
	const file = join(repo, ".pi-recipe");

	// Picker path.
	state.selectReturns = ["Copy work — Work subscriptions"];
	await state.commands.get("recipe")!.handler("init", {
		...ctx,
		ui: { ...ctx.ui, input: async () => "team" },
	});
	const written = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(written.defaultRecipe, "team");
	const team = written.recipes.team;
	assert.equal(team.description, "Work subscriptions");
	assert.equal(team.model, "openai-codex/gpt-5:medium");
	assert.deepEqual(team.models, ["openai-codex/*"]);
	assert.deepEqual(team.extensions, ["otty-integration", "npm:pi-web-access"]);
	assert.deepEqual(team.mcpServers, { linear: { url: "https://mcp.example.com/linear" } });
	for (const key of ["tools", "instructions", "skills", "prompts", "themes"]) {
		assert.equal(Object.hasOwn(team, key), false, key);
	}

	// A template without its own scope gets scoped to its model (suffix stripped).
	assert.deepEqual(
		JSON.parse(recipeScaffold("x", {}, { model: "openai-codex/gpt-5:medium" })).recipes.x.models,
		["openai-codex/gpt-5"],
	);
	assert.equal(Object.hasOwn(written, "extends"), false);
	assert.equal(recipeRuntime().recipes.recipes.team?.source, "directory");
	assert.equal(recipeRuntime().recipes.defaultSource, "directory", "self-contained default");
	assert.match(state.notifications.at(-2)!.message, /copied from your "work" recipe/);
	assert.match(state.notifications.at(-1)!.message, /MCP server configs copied verbatim/);

	// Argument path, no prompts at all.
	rmSync(file);
	state.selectReturns = ["must not be consumed"];
	await state.commands.get("recipe")!.handler("init repo --from work", ctx);
	assert.equal(state.selectReturns.length, 1);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")).recipes.repo.extensions, [
		"otty-integration",
		"npm:pi-web-access",
	]);

	rmSync(file);
	await state.commands.get("recipe")!.handler("init --from ghost", ctx);
	assert.match(state.notifications.at(-1)!.message, /Unknown home recipe "ghost". Available: work/);
	assert.equal(existsSync(file), false);

	const completions = (await state.commands.get("recipe")!.getArgumentCompletions?.("init x --from w")) as Array<{ value: string }>;
	assert.deepEqual(completions.map((c) => c.value), ["init x --from work"]);
});

test("/recipe trust leaves an active recipe alone and explains when there is no file", async () => {
	const cwd = makeRepo("repo-busy", { defaultRecipe: "repo", recipes: { repo: {} } });
	recordRecipeFileTrust(join(cwd, ".pi-recipe"), false); // no session prompt
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	state.flagValues.set(RECIPE_FLAG, "home");
	const ctx = { ...makeCtx(state), cwd };
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await state.commands.get("recipe")!.handler("trust", ctx);
	assert.equal(recipeRuntime().activeName, "home");
	assert.match(state.notifications.at(-1)!.message, /starts automatically on the next fresh `pi`/);

	const empty = join(tmp, "repo-empty");
	mkdirSync(empty, { recursive: true });
	await state.commands.get("recipe")!.handler("trust", { ...makeCtx(state), cwd: empty });
	assert.match(state.notifications.at(-1)!.message, /No \.pi-recipe or \.pi-recipe\.json .*\/recipe init/);
});
