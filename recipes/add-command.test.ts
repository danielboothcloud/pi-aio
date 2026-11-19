import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { registerRecipes } from "./index.ts";
import {
	ACTIVE_RECIPE_ENV,
	RECIPE_ORIGIN_ENV,
	RECIPE_STAGE_ENV,
	RECIPE_STATE_ENTRY,
	RECIPES_FILE_ENV,
} from "./config.ts";
import { recipeRuntime, resetRecipeRuntimeForTests } from "./apply.ts";
import { RECIPE_TRUST_FILE_ENV, recipeFileTrust, recordRecipeFileTrust } from "./trust.ts";
import type { RelaunchSpec } from "./trampoline.ts";

// `/recipe add|remove` end to end against sandboxed recipe, trust, and settings files.
const tmp = mkdtempSync(join(process.cwd(), "test/.recipes-add-"));
const agentDir = join(tmp, "agent");
const cwd = join(tmp, "project");
const GLOBAL_FILE = join(agentDir, "aio-recipes.json");
const SESSION_FILE = join(tmp, "session.jsonl");
const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	RECIPES_FILE_ENV,
	RECIPE_TRUST_FILE_ENV,
	ACTIVE_RECIPE_ENV,
	RECIPE_ORIGIN_ENV,
	RECIPE_STAGE_ENV,
	"AIO_RECIPE_INJECTED_ARGS",
	"AIO_SUBAGENT_CHILD",
	"PIG_HARNESS_BINARY",
] as const;
const SAVED = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

test.after(() => {
	for (const key of ENV_KEYS) {
		if (SAVED[key] === undefined) delete process.env[key];
		else process.env[key] = SAVED[key];
	}
	rmSync(tmp, { recursive: true, force: true });
});

const GLOBAL_CONFIG = {
	recipes: {
		home: { model: "anthropic/claude-5:high", models: ["anthropic/*"] },
		work: { mcpServers: { linear: { url: "https://mcp.example.com/linear" } } },
	},
};

test.beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env[RECIPES_FILE_ENV] = GLOBAL_FILE;
	process.env[RECIPE_TRUST_FILE_ENV] = join(agentDir, "aio-recipe-trust.json");
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(GLOBAL_FILE, `${JSON.stringify(GLOBAL_CONFIG, null, 2)}\n`);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["openai/*"], packages: ["npm:pi-web-access"] }));
	writeFileSync(SESSION_FILE, "{}\n");
	resetRecipeRuntimeForTests();
});

const MODELS = [
	{ provider: "anthropic", id: "claude-5" },
	{ provider: "openai", id: "gpt-5" },
	{ provider: "zeta", id: "z-1" },
];

interface Harness {
	run: (args: string) => Promise<void>;
	selects: Array<string | undefined>;
	selectTitles: string[];
	selectOptions: string[][];
	confirms: boolean[];
	confirmMessages: string[];
	inputs: Array<string | undefined>;
	notifications: Array<{ message: string; type: string }>;
	setModelCalls: Array<{ provider: string; id: string }>;
	thinkingCalls: string[];
	entries: Array<{ customType: string; data: unknown }>;
	registeredMcp: Map<string, unknown>;
	relaunches: RelaunchSpec[];
	ctx: Record<string, unknown>;
}

async function harness(options: { mode?: "tui" | "rpc"; hasUI?: boolean; projectTrusted?: boolean } = {}): Promise<Harness> {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const h = {
		selects: [], selectTitles: [], selectOptions: [], confirms: [], confirmMessages: [], inputs: [],
		notifications: [], setModelCalls: [], thinkingCalls: [], entries: [], registeredMcp: new Map(), relaunches: [],
	} as unknown as Harness;
	const pi = {
		registerFlag: () => {},
		registerEntryRenderer: () => {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, command);
		},
		getFlag: () => undefined,
		on: () => {},
		appendEntry: (customType: string, data: unknown) => h.entries.push({ customType, data }),
		getThinkingLevel: () => "medium",
		setModel: async (model: { provider: string; id: string }) => {
			h.setModelCalls.push({ provider: model.provider, id: model.id });
			return true;
		},
		setThinkingLevel: (level: string) => h.thinkingCalls.push(level),
		registerMcpServer: (name: string, config: unknown) => h.registeredMcp.set(name, config),
		unregisterMcpServer: (name: string) => h.registeredMcp.delete(name),
		events: { emit: () => {} },
	};
	await registerRecipes(pi as never, {
		relaunch: async (spec) => {
			h.relaunches.push(spec);
			return true;
		},
	});
	h.ctx = {
		ui: {
			notify: (message: string, type?: string) => h.notifications.push({ message, type: type ?? "info" }),
			setStatus: () => {},
			select: async (title: string, opts: string[]) => {
				h.selectTitles.push(title);
				h.selectOptions.push(opts);
				return h.selects.shift();
			},
			confirm: async (_title: string, message: string) => {
				h.confirmMessages.push(message);
				return h.confirms.shift() ?? false;
			},
			input: async () => h.inputs.shift(),
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => Promise<unknown>) => {
				let result: unknown;
				const tui = { stop: () => {}, start: () => {}, requestRender: () => {} };
				await factory(tui, {}, {}, (value) => { result = value; });
				return result;
			},
			theme: { fg: (_role: string, text: string) => text },
		},
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => options.projectTrusted ?? true,
		sessionManager: { getBranch: () => [], getSessionFile: () => SESSION_FILE },
		modelRegistry: {
			getAvailable: () => MODELS,
			find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id),
			getModelsOfType: () => MODELS,
		},
		scopedModels: [],
		model: MODELS[0],
	};
	h.run = (args: string) => commands.get("recipe")!.handler(args, h.ctx);
	return h;
}

function globalRecipe(name: string): Record<string, unknown> {
	return (JSON.parse(readFileSync(GLOBAL_FILE, "utf-8")) as { recipes: Record<string, Record<string, unknown>> }).recipes[name] ?? {};
}

test("declined confirm writes nothing", async () => {
	const h = await harness();
	await h.run("home");
	h.selects.push("low");
	h.confirms.push(false);
	await h.run("add thinking");
	assert.match(h.confirmMessages[0] ?? "", /aio-recipes\.json\n {2}thinkingLevel → low/);
	assert.equal(readFileSync(GLOBAL_FILE, "utf-8"), `${JSON.stringify(GLOBAL_CONFIG, null, 2)}\n`);
	assert.equal(existsSync(`${GLOBAL_FILE}.bak`), false);
	assert.match(h.notifications.at(-1)!.message, /unchanged/);
});

test("without UI or an active recipe nothing is asked or written", async () => {
	const noUi = await harness({ hasUI: false });
	await noUi.run("add model");
	assert.equal(noUi.notifications.at(-1)!.type, "error");
	assert.match(noUi.notifications.at(-1)!.message, /interactive session/);

	const idle = await harness();
	await idle.run("add model");
	assert.match(idle.notifications.at(-1)!.message, /No active recipe .*\/recipe init/);
	assert.equal(idle.selectTitles.length, 0);
	assert.equal(existsSync(`${GLOBAL_FILE}.bak`), false);
});

test("add model writes the global file with a backup and switches the live model", async () => {
	const h = await harness();
	await h.run("home");
	h.setModelCalls.length = 0;
	h.selects.push("openai/gpt-5");
	h.confirms.push(true);
	// Outside `anthropic/*`, so the scope grows too: a restart in TUI.
	await h.run("add model");
	assert.deepEqual(h.selectOptions[0]?.slice(0, 3), ["anthropic/claude-5 (current)", "openai/gpt-5", "zeta/z-1"]);
	assert.deepEqual(globalRecipe("home"), { model: "openai/gpt-5:high", models: ["anthropic/*", "openai/gpt-5"] });
	assert.equal(readFileSync(`${GLOBAL_FILE}.bak`, "utf-8"), `${JSON.stringify(GLOBAL_CONFIG, null, 2)}\n`);
	assert.deepEqual(h.setModelCalls, [{ provider: "openai", id: "gpt-5" }]);
	assert.equal(h.thinkingCalls.at(-1), "high");
	assert.deepEqual(h.entries.at(-1), { customType: RECIPE_STATE_ENTRY, data: { name: "home" } });
	assert.ok(h.notifications.some((n) => /updated in agent\/aio-recipes\.json: model → openai\/gpt-5:high, models \+= openai\/gpt-5 — applied: model, thinking/.test(n.message)));
	// TUI: the /resume relaunch reopens this exact session with the new scope.
	assert.equal(h.relaunches.length, 1);
	const spec = h.relaunches[0]!;
	assert.ok(spec.args.includes("--session") && spec.args.includes(SESSION_FILE));
	assert.equal(spec.args[spec.args.indexOf("--models") + 1], "anthropic/*,openai/gpt-5");
	assert.equal(spec.env[ACTIVE_RECIPE_ENV], "home");
});

test("session-scoped keys re-apply in place without a relaunch", async () => {
	const h = await harness();
	await h.run("work");
	h.selects.push("plan");
	h.confirms.push(true);
	await h.run("add mode");
	assert.equal(globalRecipe("work").permissionMode, "plan");
	h.selects.push("linear");
	h.confirms.push(true);
	await h.run("remove mcp");
	assert.deepEqual(globalRecipe("work").mcpServers, {});
	assert.equal(h.registeredMcp.size, 0, "the removed server is unregistered live");
	assert.equal(h.relaunches.length, 0);
});

test("restart-scoped keys in RPC write the file and hint, never spawn", async () => {
	const h = await harness({ mode: "rpc" });
	await h.run("work");
	h.selects.push("npm:pi-web-access");
	h.confirms.push(true);
	await h.run("add extension");
	assert.deepEqual(globalRecipe("work").extensions, ["npm:pi-web-access"]);
	assert.equal(h.relaunches.length, 0);
	assert.match(h.notifications.at(-1)!.message, new RegExp(`needs a restart for its extension set: pi --session "${SESSION_FILE}"`));
});

test("a recipe literally named add keeps switching; add <key> edits it", async () => {
	writeFileSync(GLOBAL_FILE, JSON.stringify({ recipes: { add: { model: "zeta/z-1" } } }));
	const h = await harness();
	await h.run("add");
	assert.equal(recipeRuntime().activeName, "add");
	assert.equal(h.selectTitles.length, 0);
	h.selects.push("concise");
	h.confirms.push(true);
	await h.run("add style");
	assert.equal(globalRecipe("add").style, "concise");
	assert.match(readFileSync(GLOBAL_FILE, "utf-8"), /^{\n {2}"recipes"/, "rewritten with 2-space indent");
});

test("/recipe add without a key opens the key picker; unknown keys are rejected", async () => {
	const h = await harness();
	await h.run("home");
	await h.run("add");
	assert.match(h.selectOptions[0]?.[0] ?? "", /^model — /);
	await h.run("add colour");
	assert.match(h.notifications.at(-1)!.message, /Unknown recipe key "colour"/);
});

test("editing a trusted .pi-recipe keeps the new version trusted", async () => {
	const file = join(cwd, ".pi-recipe");
	writeFileSync(file, JSON.stringify({ defaultRecipe: "repo", recipes: { repo: { model: "zeta/z-1" } } }, null, "\t"));
	recordRecipeFileTrust(file, true);
	const h = await harness();
	await h.run("repo");
	assert.equal(recipeRuntime().active?.source, "directory");
	h.selects.push("xhigh");
	h.confirms.push(true);
	await h.run("add thinking");
	assert.match(readFileSync(file, "utf-8"), /\n\t\t\t"thinkingLevel": "xhigh"/);
	assert.equal(recipeFileTrust(file), "trusted");
	assert.equal(h.thinkingCalls.at(-1), "xhigh");
	assert.equal(existsSync(`${file}.bak`), false, "only the global file gets a backup");
});

test("project recipes refuse restart-scoped keys", async () => {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const file = join(cwd, ".pi", "aio-recipes.json");
	const original = JSON.stringify({ recipes: { proj: { model: "zeta/z-1" }, home: { model: "zeta/z-1" } } });
	writeFileSync(file, original);
	const globalBefore = readFileSync(GLOBAL_FILE, "utf-8");
	const h = await harness();
	await h.run("proj");
	await h.run("add scope");
	assert.match(h.notifications.at(-1)!.message, /never change a launch/);
	assert.equal(readFileSync(file, "utf-8"), original);
	h.selects.push("concise");
	h.confirms.push(true);
	await h.run("add style");
	assert.equal((JSON.parse(readFileSync(file, "utf-8")) as { recipes: { proj: { style: string } } }).recipes.proj.style, "concise");
	// A project recipe overriding a same-name global edits the project file only.
	await h.run("home");
	h.selects.push("low");
	h.confirms.push(true);
	await h.run("add thinking");
	assert.equal((JSON.parse(readFileSync(file, "utf-8")) as { recipes: { home: { thinkingLevel: string } } }).recipes.home.thinkingLevel, "low");
	assert.equal(readFileSync(GLOBAL_FILE, "utf-8"), globalBefore);
	assert.equal(existsSync(`${GLOBAL_FILE}.bak`), false);
});
