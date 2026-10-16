import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { registerRecipes } from "./index.ts";
import {
	ACTIVE_RECIPE_ENV,
	RECIPE_CONTEXT_TYPE,
	RECIPE_FLAG,
	RECIPE_STATE_ENTRY,
	RECIPES_FILE_ENV,
} from "./config.ts";
import { recipeRuntime, resetRecipeRuntimeForTests } from "./apply.ts";

// Isolated agent dir for loadRecipes (PI_CODING_AGENT_DIR + the
// AIO_RECIPES_FILE scratch contract the same way the blocklist suite does).
const tmp = mkdtempSync(join(tmpdir(), "aio-recipes-registration-"));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "skills"), { recursive: true });
writeFileSync(
	join(agentDir, "skills", "work.md"),
	"# work skill",
);
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
				tools: ["+codemode"],
			},
			work: {
				description: "Work subscriptions",
				instructions: "Ship carefully.",
				skills: ["skills/work.md"],
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
}

function makeMocks(): { pi: Record<string, unknown>; state: MockState } {
	const state: MockState = {
		events: new Map(),
		commands: new Map(),
		flagOptions: new Map(),
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
	};

	const pi = {
		registerFlag: (name: string, options: Record<string, unknown>) => {
			state.flagOptions.set(name, options);
		},
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
		"resources_discover",
		"before_agent_start",
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
	// Model + `:high` suffix thinking + tools delta applied, and the state
	// entry pins the selection on the branch.
	assert.deepEqual(state.setModelCalls, [{ provider: "anthropic", id: "claude-5" }]);
	assert.deepEqual(state.thinkingCalls, ["high"]);
	assert.deepEqual(state.setActiveCalls, [
		["read", "bash", "edit", "write", "codemode"],
	]);
	assert.deepEqual(state.entries, [{ customType: RECIPE_STATE_ENTRY, data: { name: "home" } }]);
	assert.match(
		state.notifications.find((n) =>
			n.message.includes('Recipe "home" active'))!.message,
		/applied: model, thinking, tools/,
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

test("before_agent_start injects instructions and resources_discover exposes active paths", async () => {
	const { pi, state } = makeMocks();
	await registerRecipes(pi as never);
	state.flagValues.set(RECIPE_FLAG, "work");
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));

	const message = (await fire(state, "before_agent_start", {}, makeCtx(state))) as {
		message: { customType: string; content: string; display: boolean };
	};
	assert.equal(message.message.customType, RECIPE_CONTEXT_TYPE);
	assert.equal(message.message.display, false);
	assert.match(message.message.content, /\[RECIPE "work" ACTIVE\]/);

	const discovered = (await fire(
		state,
		"resources_discover",
		{ type: "resources_discover", cwd: "/tmp/project", reason: "startup" },
		makeCtx(state),
	)) as { skillPaths: string[]; promptPaths: string[]; themePaths: string[] };
	assert.deepEqual(discovered.skillPaths, [join(agentDir, "skills", "work.md")]);
	assert.deepEqual(discovered.promptPaths, []);
	assert.deepEqual(discovered.themePaths, []);

	// No active recipe: resources_discover contributes nothing.
	state.flagValues.clear();
	await fire(state, "session_start", { type: "session_start", reason: "startup" }, makeCtx(state));
	assert.equal(await fire(state, "resources_discover", { reason: "reload" }, makeCtx(state)), undefined);
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
		["home", "work", "off"],
	);
	// Each named recipe carries its configured description.
	assert.equal(
		completions.find((c) => c.value === "work")!.description,
		"Work subscriptions",
	);
	const none = await command.getArgumentCompletions?.("zzz");
	assert.equal(none, null, "empty completions yield null");
});
