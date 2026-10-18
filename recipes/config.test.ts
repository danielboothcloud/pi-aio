import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	RECIPES_FILE_ENV,
	RECIPES_FILE_NAME,
	isRestartScoped,
	loadRecipes,
	parseModelSpec,
	parseRecipeConfig,
	projectRecipesPath,
	resolveExtensionSource,
} from "./config.ts";

// Isolated agent dir + project cwd per test file, exactly like the blocklist
// suite. getAgentDir() honors PI_CODING_AGENT_DIR, so point it at a temp dir
// instead of the real ~/.pi; AIO_RECIPES_FILE then anchors the global file.
const tmp = mkdtempSync(join(tmpdir(), "aio-recipes-config-"));
const agentDir = join(tmp, "agent");
const projectDir = join(tmp, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;
const GLOBAL_FILE = join(agentDir, RECIPES_FILE_NAME);
process.env[RECIPES_FILE_ENV] = GLOBAL_FILE;

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env[RECIPES_FILE_ENV];
	rmSync(tmp, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(GLOBAL_FILE, JSON.stringify(config));
}

function writeProject(cwd: string, config: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(projectRecipesPath(cwd), JSON.stringify(config));
}

function clearConfigs(): void {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
}

test("paths: global under agent dir, project under cwd/.pi", () => {
	assert.equal(
		projectRecipesPath(projectDir),
		join(projectDir, ".pi", RECIPES_FILE_NAME),
	);
});

test("no config files -> empty recipe set, no default", () => {
	clearConfigs();
	const loaded = loadRecipes(projectDir);
	assert.equal(loaded.empty, true);
	assert.equal(loaded.defaultRecipe, undefined);
	assert.deepEqual(Object.keys(loaded.recipes), []);
});

test("global recipes load with their fields parsed", () => {
	clearConfigs();
	writeGlobal({
		defaultRecipe: "home",
		recipes: {
			home: {
				description: "Personal stack",
				model: "anthropic/claude-5:high",
				models: ["anthropic/*", "openai-codex/*"],
				tools: ["+codemode", "-hypa_*"],
				instructions: "Ship carefully.",
				skills: ["skills/home/", " ~/extra-skill.md "],
				prompts: [],
				themes: ["/tmp/themes/home.json"],
				mcpServers: { linear: { url: "https://mcp.example.com/linear" } },
				extensions: ["otty-integration"],
			},
		},
	});
	const loaded = loadRecipes(projectDir);
	assert.equal(loaded.empty, false);
	assert.equal(loaded.defaultRecipe, "home");

	const home = loaded.recipes.home;
	assert.ok(home, "home recipe exists");
	assert.equal(home.source, "global");
	assert.equal(home.baseDir, agentDir);
	assert.equal(home.config.description, "Personal stack");
	// The model spec stays verbatim — parseModelSpec (called at apply time)
	// splits the `:high` suffix and applies it as the thinking-level fallback.
	assert.equal(home.config.model, "anthropic/claude-5:high");
	// The suffix splits only at apply time — the config field stays verbatim.
	assert.equal(home.config.thinkingLevel, undefined);
	assert.equal(parseModelSpec(home.config.model!).thinking, "high");
	assert.deepEqual(home.config.models, ["anthropic/*", "openai-codex/*"]);
	assert.deepEqual(home.config.tools, ["+codemode", "-hypa_*"]);
	assert.equal(home.config.instructions, "Ship carefully.");
	// Whitespace-only entries are dropped; "~" paths stay verbatim for the
	// apply step to expand.
	assert.deepEqual(home.config.skills, ["skills/home/", "~/extra-skill.md"]);
	assert.equal(home.config.prompts, undefined);
	assert.deepEqual(home.config.themes, ["/tmp/themes/home.json"]);
	assert.deepEqual(Object.keys(home.config.mcpServers), ["linear"]);
	assert.deepEqual(home.config.extensions, ["otty-integration"]);
});

test("defaultRecipe not offered when the named recipe is missing or invalid", () => {
	clearConfigs();
	writeGlobal({ defaultRecipe: "ghost", recipes: { home: {} } });
	const loaded = loadRecipes(projectDir);
	assert.equal(loaded.defaultRecipe, undefined);
	assert.ok(loaded.recipes.home);
});

test("project recipes override same-name globals; others survive; default can flip", () => {
	clearConfigs();
	writeGlobal({
		defaultRecipe: "home",
		recipes: {
			home: { model: "anthropic/claude-5", extensions: ["global-ext"] },
			coding: { model: "openai-codex/gpt-5.2-codex" },
		},
	});
	writeProject(projectDir, {
		defaultRecipe: "coding",
		recipes: {
			home: { model: "google/gemini-3-pro", description: "corporate rebrand" },
		},
	});

	const loaded = loadRecipes(projectDir, { projectTrusted: true });
	assert.equal(loaded.defaultRecipe, "coding");
	assert.equal(loaded.recipes.home.source, "project");
	assert.equal(loaded.recipes.home.config.model, "google/gemini-3-pro");
	assert.equal(loaded.recipes.home.config.description, "corporate rebrand");
	assert.equal(loaded.recipes.home.config.extensions, undefined);
	assert.equal(loaded.recipes.coding.source, "global");
	assert.equal(loaded.recipes.coding.baseDir, agentDir);
	assert.equal(loaded.recipes.home.baseDir, join(projectDir, ".pi"));
});

test("project recipes are ignored without trust", () => {
	clearConfigs();
	writeGlobal({ recipes: { home: { model: "anthropic/claude-5" } } });
	writeProject(projectDir, { recipes: { work: { model: "openai-codex/gpt-5.2-codex" } } });

	const untrusted = loadRecipes(projectDir, { projectTrusted: false });
	assert.ok(untrusted.recipes.home);
	assert.equal(untrusted.recipes.work, undefined);
	const trusted = loadRecipes(projectDir, { projectTrusted: true });
	assert.ok(trusted.recipes.work);
});

test("invalid JSON yields an empty recipe set, not a throw", () => {
	clearConfigs();
	writeFileSync(GLOBAL_FILE, "{not json");
	const loaded = loadRecipes(projectDir);
	assert.equal(loaded.empty, true);
});

test("malformed recipes are skipped; malformed fields default to absent", () => {
	clearConfigs();
	writeGlobal({
		recipes: {
			nulled: null,
			notObject: 42,
			fine: {
				description: 7,
				thinkingLevel: "ultra",
				tools: ["ok", 3, ""],
				models: [] as string[],
				mcpServers: { good: { url: "https://x.example" }, bad: "nope", "": {} },
			},
		},
	});
	const loaded = loadRecipes(projectDir);
	assert.equal(Object.keys(loaded.recipes).length, 1);
	const fine = loaded.recipes.fine;
	assert.ok(fine);
	assert.equal(fine.config.description, undefined);
	assert.equal(fine.config.thinkingLevel, undefined);
	assert.deepEqual(fine.config.tools, ["ok"]);
	assert.equal(fine.config.models, undefined);
	assert.deepEqual(Object.keys(fine.config.mcpServers), ["good"]);
	const good = fine.config.mcpServers.good as { url?: string };
	assert.equal(good.url, "https://x.example");
});

test("parseRecipeConfig drops entries that are not objects", () => {
	assert.equal(parseRecipeConfig("x", "global", "/base", "nope"), undefined);
	assert.equal(parseRecipeConfig("x", "global", "/base", null), undefined);
	assert.equal(
		parseRecipeConfig("x", "global", "/base", [1, 2])?.config.model,
		undefined,
	);
});

test("parseModelSpec splits only a known trailing :thinking level", () => {
	assert.deepEqual(parseModelSpec("anthropic/claude-5:high"), {
		model: "anthropic/claude-5",
		thinking: "high",
	});
	assert.deepEqual(parseModelSpec("anthropic/claude-5"), {
		model: "anthropic/claude-5",
	});
	// Model ids may contain colons — those are never treated as levels.
	assert.deepEqual(parseModelSpec("hf:zai-org/GLM-5.3:off"), {
		model: "hf:zai-org/GLM-5.3",
		thinking: "off",
	});
	assert.deepEqual(parseModelSpec("hf:zai-org/GLM-5.3"), {
		model: "hf:zai-org/GLM-5.3",
	});
	assert.deepEqual(parseModelSpec(":high"), { model: ":high" });
});

test("isRestartScoped: only models and extensions need the bridge", () => {
	assert.equal(isRestartScoped({ mcpServers: {} }), false);
	assert.equal(isRestartScoped({ mcpServers: {}, tools: ["bash"] }), false);
	assert.equal(
		isRestartScoped({ mcpServers: {}, models: ["anthropic/*"] }),
		true,
	);
	assert.equal(
		isRestartScoped({ mcpServers: {}, extensions: ["ext-x"] }),
		true,
	);
});

test("resolveExtensionSource passes package forms and paths through", () => {
	assert.equal(resolveExtensionSource("npm:pi-web-access"), "npm:pi-web-access");
	assert.equal(resolveExtensionSource("git:github.com/x/y@v1"), "git:github.com/x/y@v1");
	assert.equal(resolveExtensionSource("builtin:mcp"), "builtin:mcp");
	assert.equal(resolveExtensionSource("./local.ts"), "./local.ts");
	assert.equal(resolveExtensionSource("/abs/ext.ts"), "/abs/ext.ts");
	const home = process.env.HOME ?? "";
	if (home) {
		assert.equal(resolveExtensionSource("~/subs/x.ts"), join(home, "subs/x.ts"));
	}
});

test("resolveExtensionSource resolves names against the agent extensions dir; missing names skip", () => {
	try {
		clearConfigs();
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "otty-integration.ts"),
			"export default () => {};",
		);
		assert.equal(
			resolveExtensionSource("otty-integration"),
			join(agentDir, "extensions", "otty-integration.ts"),
		);
		// Missing name: skipped with the documented warning (writes to stderr).
		assert.equal(resolveExtensionSource("does-not-exist"), undefined);
		// "aio" is reserved: always injected by the bridge itself.
		assert.equal(resolveExtensionSource("aio"), undefined);
		assert.equal(resolveExtensionSource("  "), undefined);
	} finally {
		rmSync(join(agentDir, "extensions"), { recursive: true, force: true });
	}
	// Sanity: the global file paths anchor to the temp agent dir.
	assert.equal(dirname(GLOBAL_FILE), agentDir);
});
