import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
	ACTIVE_RECIPE_ENV,
	RECIPE_ORIGIN_ENV,
	RECIPE_STAGE_ENV,
	RECIPES_FILE_ENV,
	directoryRecipesPath,
	loadRecipes,
	parseRecipeConfig,
	projectRecipesPath,
	type RecipeDefinition,
} from "./config.ts";
import {
	RECIPE_TRUST_FILE_ENV,
	describeRecipeFile,
	forgetRecipeFileTrust,
	parseTrustAnswer,
	promptRecipeTrust,
	recipeFileTrust,
	recordRecipeFileTrust,
} from "./trust.ts";
import {
	canPromptAtLaunch,
	decideRelaunch,
	relaunchNotice,
	type TrampolineOptions,
} from "./trampoline.ts";

// `.pi-recipe` / `.pi-recipe.json`: per-directory recipes gated by explicit,
// content-pinned trust. Everything is sandboxed: agent dir, AIO trust store,
// and the global recipes file live under a temp root.
const tmp = mkdtempSync(join(tmpdir(), "aio-recipes-directory-"));
const agentDir = join(tmp, "agent");
const dir = join(tmp, "repo");
const GLOBAL_FILE = join(agentDir, "aio-recipes.json");
const TRUST_FILE = join(agentDir, "aio-recipe-trust.json");
const SAVED = {
	agentDir: process.env.PI_CODING_AGENT_DIR,
	recipesFile: process.env[RECIPES_FILE_ENV],
	trustFile: process.env[RECIPE_TRUST_FILE_ENV],
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env[RECIPES_FILE_ENV] = GLOBAL_FILE;
process.env[RECIPE_TRUST_FILE_ENV] = TRUST_FILE;

test.after(() => {
	if (SAVED.trustFile === undefined) delete process.env[RECIPE_TRUST_FILE_ENV];
	else process.env[RECIPE_TRUST_FILE_ENV] = SAVED.trustFile;
	if (SAVED.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = SAVED.agentDir;
	if (SAVED.recipesFile === undefined) delete process.env[RECIPES_FILE_ENV];
	else process.env[RECIPES_FILE_ENV] = SAVED.recipesFile;
	rmSync(tmp, { recursive: true, force: true });
});

test.beforeEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		GLOBAL_FILE,
		JSON.stringify({
			defaultRecipe: "home",
			recipes: { home: { model: "anthropic/claude-5" }, work: { models: ["openai-codex/*"] } },
		}),
	);
});

function writeDirectory(name: string, config: unknown): void {
	writeFileSync(join(dir, name), JSON.stringify(config));
}

// -- discovery + loading -----------------------------------------------------

test("both file names are found; .pi-recipe wins when both exist", () => {
	assert.equal(directoryRecipesPath(dir), undefined);
	writeDirectory(".pi-recipe.json", { defaultRecipe: "work" });
	assert.equal(directoryRecipesPath(dir), join(dir, ".pi-recipe.json"));
	writeDirectory(".pi-recipe", { defaultRecipe: "home" });
	assert.equal(directoryRecipesPath(dir), join(dir, ".pi-recipe"));
	// A directory with the name is not a recipe file.
	rmSync(join(dir, ".pi-recipe"));
	rmSync(join(dir, ".pi-recipe.json"));
	mkdirSync(join(dir, ".pi-recipe"));
	assert.equal(directoryRecipesPath(dir), undefined);
});

test("an untrusted directory file is located but never loaded", () => {
	writeDirectory(".pi-recipe", {
		defaultRecipe: "repo",
		recipes: { repo: { model: "openai-codex/gpt-5" } },
	});
	const loaded = loadRecipes(dir, { projectTrusted: true, directoryTrusted: false });
	assert.equal(loaded.directoryFile, join(dir, ".pi-recipe"));
	assert.equal(loaded.recipes.repo, undefined);
	assert.equal(loaded.defaultRecipe, "home");
	assert.equal(loaded.defaultSource, "global");
});

test("a trusted directory file overrides recipes and the default of every other tier", () => {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		projectRecipesPath(dir),
		JSON.stringify({ defaultRecipe: "home", recipes: { home: { model: "google/gemini-3" } } }),
	);
	writeDirectory(".pi-recipe.json", {
		defaultRecipe: "repo",
		recipes: {
			repo: { model: "openai-codex/gpt-5", skills: ["skills/repo"] },
			work: { description: "repo flavored work" },
		},
	});
	const loaded = loadRecipes(dir, { projectTrusted: true, directoryTrusted: true });
	assert.equal(loaded.defaultRecipe, "repo");
	assert.equal(loaded.defaultSource, "directory");
	assert.equal(loaded.recipes.repo.source, "directory");
	assert.equal(loaded.recipes.repo.baseDir, dir, "resource paths resolve from the folder");
	assert.equal(loaded.recipes.work.config.description, "repo flavored work");
	assert.equal(loaded.recipes.home.source, "project");
});

test("a directory default must be defined in the file itself, never a global recipe", () => {
	// "work" exists globally, but a portable file cannot reference it.
	writeDirectory(".pi-recipe", { defaultRecipe: "work" });
	const reference = loadRecipes(dir, { directoryTrusted: true });
	assert.equal(reference.defaultSource, "global", "falls back to the user's own default");
	assert.equal(reference.defaultRecipe, "home");

	writeDirectory(".pi-recipe", { defaultRecipe: "ghost", recipes: { other: {} } });
	const ghost = loadRecipes(dir, { directoryTrusted: true });
	assert.equal(ghost.defaultSource, "global");
	assert.ok(ghost.recipes.other, "its recipes still load");

	// Defined in the file (even shadowing a global name): it is the default.
	writeDirectory(".pi-recipe", { defaultRecipe: "work", recipes: { work: { model: "x/y" } } });
	const own = loadRecipes(dir, { directoryTrusted: true });
	assert.equal(own.defaultRecipe, "work");
	assert.equal(own.defaultSource, "directory");
	assert.equal(own.recipes.work.source, "directory");
});

// -- trust ---------------------------------------------------------------------

test("trust: a recipe file is unknown until explicitly trusted — a trusted folder is not enough", () => {
	writeDirectory(".pi-recipe", { defaultRecipe: "work" });
	const file = join(dir, ".pi-recipe");
	new ProjectTrustStore(agentDir).set(dir, true);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	assert.equal(recipeFileTrust(file), "unknown");
	assert.equal(recipeFileTrust(file, { cliArgs: ["--approve"] }), "unknown");

	recordRecipeFileTrust(file, true);
	assert.equal(recipeFileTrust(file), "trusted");
	assert.ok(existsSync(TRUST_FILE), "remembered in the AIO trust store");
});

test("trust: is pinned to the file contents — an edit asks again", () => {
	writeDirectory(".pi-recipe", { defaultRecipe: "work" });
	const file = join(dir, ".pi-recipe");
	recordRecipeFileTrust(file, true);
	writeDirectory(".pi-recipe", { defaultRecipe: "work", recipes: { work: { extensions: ["npm:evil"] } } });
	assert.equal(recipeFileTrust(file), "unknown");

	recordRecipeFileTrust(file, false);
	assert.equal(recipeFileTrust(file), "denied", "never is remembered for this version");
	assert.equal(forgetRecipeFileTrust(file), true);
	assert.equal(recipeFileTrust(file), "unknown");
	assert.equal(forgetRecipeFileTrust(file), false);
});

test("trust: --no-approve skips even a trusted file; a corrupt store is no decision", () => {
	writeDirectory(".pi-recipe", { defaultRecipe: "work" });
	const file = join(dir, ".pi-recipe");
	recordRecipeFileTrust(file, true);
	assert.equal(recipeFileTrust(file, { cliArgs: ["--no-approve"] }), "denied");
	writeFileSync(TRUST_FILE, "{broken");
	assert.equal(recipeFileTrust(file), "unknown");
	recordRecipeFileTrust(file, true);
	assert.equal(recipeFileTrust(file), "trusted", "a corrupt store is rewritten");
});

test("trust prompt: summarizes what the file would change", () => {
	writeDirectory(".pi-recipe", {
		defaultRecipe: "repo",
		recipes: {
			repo: {
				model: "openai-codex/gpt-5",
				models: ["openai-codex/*"],
				extensions: ["npm:pi-thing"],
				mcpServers: { linear: { url: "https://x" } },
				instructions: "Be careful.",
			},
		},
	});
	const lines = describeRecipeFile(join(dir, ".pi-recipe"));
	assert.equal(lines[0], "default recipe: repo");
	assert.equal(
		lines[1],
		"repo: model openai-codex/gpt-5 · models openai-codex/* · extensions npm:pi-thing · MCP linear · instructions",
	);
	writeDirectory(".pi-recipe", { defaultRecipe: "work" });
	assert.deepEqual(describeRecipeFile(join(dir, ".pi-recipe")), [
		"default recipe: work (not defined in this file — ignored)",
	]);
	writeFileSync(join(dir, ".pi-recipe"), "{nope");
	assert.match(describeRecipeFile(join(dir, ".pi-recipe"))[0]!, /not valid JSON/);
});

test("trust prompt: terminal answers map to trust / skip / deny; EOF is skip", async () => {
	writeDirectory(".pi-recipe", { defaultRecipe: "work" });
	const file = join(dir, ".pi-recipe");
	for (const [answer, expected] of [
		["y", "trust"],
		["Trust", "trust"],
		["", "skip"],
		["n", "skip"],
		["d", "deny"],
		["never", "deny"],
	] as const) {
		assert.equal(parseTrustAnswer(answer), expected, answer);
	}

	const input = new PassThrough();
	const output = new PassThrough();
	let shown = "";
	output.on("data", (chunk) => (shown += String(chunk)));
	const pending = promptRecipeTrust(file, { input, output });
	input.write("y\n");
	assert.equal(await pending, "trust");
	assert.match(shown, /Trust this recipe file\?/);
	assert.ok(shown.includes(file));
	assert.match(shown, /default recipe: work/);

	const closed = new PassThrough();
	const eof = promptRecipeTrust(file, { input: closed, output: new PassThrough() });
	closed.end();
	assert.equal(await eof, "skip");
});

test("launch prompt only on an interactive session launch", () => {
	const base = { argv: ["/bin/pi", "/bin/pi"], env: {}, stdinIsTTY: true, stdoutIsTTY: true };
	assert.equal(canPromptAtLaunch(base), true);
	assert.equal(canPromptAtLaunch({ ...base, argv: [...base.argv, "--recipe", "x"] }), true);
	assert.equal(canPromptAtLaunch({ ...base, stdinIsTTY: false }), false);
	assert.equal(canPromptAtLaunch({ ...base, stdoutIsTTY: false }), false);
	for (const args of [["-p", "hi"], ["--mode", "rpc"], ["--mode", "json"], ["--no-approve"], ["--help"], ["list"]]) {
		assert.equal(canPromptAtLaunch({ ...base, argv: [...base.argv, ...args] }), false, args.join(" "));
	}
	assert.equal(canPromptAtLaunch({ ...base, env: { [RECIPE_STAGE_ENV]: "1" } }), false);
	assert.equal(canPromptAtLaunch({ ...base, env: { AIO_SUBAGENT_CHILD: "1" } }), false);
});

// -- relaunch bridge -----------------------------------------------------------

function recipe(name: string, raw: Record<string, unknown>): RecipeDefinition {
	const parsed = parseRecipeConfig(name, "directory", "/repo", raw);
	assert.ok(parsed);
	return parsed;
}

const RECIPES: Record<string, RecipeDefinition> = {
	repo: recipe("repo", { models: ["openai-codex/*"], extensions: ["/opt/repo-ext.ts"] }),
	light: recipe("light", { model: "anthropic/claude-5" }),
	other: recipe("other", { models: ["anthropic/*"] }),
};

function decide(args: string[], overrides: Partial<TrampolineOptions> = {}) {
	return decideRelaunch({
		argv: ["/bin/pi", "/bin/pi", ...args],
		command: "/bin/pi",
		env: { PATH: "/usr/bin" },
		recipes: RECIPES,
		directoryRecipe: "repo",
		aioExtensionPath: "/aio/index.ts",
		...overrides,
	});
}

test("bridge: a fresh start relaunches into the directory default, marked as a default", () => {
	const decision = decide(["-p", "hello"]);
	assert.equal(decision.action, "relaunch");
	assert.ok(decision.action === "relaunch");
	const spec = decision.spec;
	assert.equal(spec.recipeName, "repo");
	assert.equal(spec.origin, "directory");
	assert.deepEqual(spec.args, [
		"/bin/pi",
		"-ne",
		"-e",
		"/aio/index.ts",
		"-e",
		"/opt/repo-ext.ts",
		"--models",
		"openai-codex/*",
		"-p",
		"hello",
	]);
	assert.equal(spec.env[RECIPE_STAGE_ENV], "1");
	assert.equal(spec.env[ACTIVE_RECIPE_ENV], "repo");
	assert.equal(spec.env[RECIPE_ORIGIN_ENV], "directory");
	assert.match(relaunchNotice(spec), /\.pi-recipe default/);
});

test("bridge: --recipe beats the directory default", () => {
	const decision = decide(["--recipe", "other"]);
	assert.ok(decision.action === "relaunch");
	assert.equal(decision.spec.recipeName, "other");
	assert.equal(decision.spec.origin, "flag");
	assert.equal(decision.spec.env[RECIPE_ORIGIN_ENV], "flag");
	assert.equal(decision.spec.args.includes("--recipe"), false);
});

test("bridge: resumes and forks keep their own recipe", () => {
	for (const args of [
		["-c"],
		["--continue"],
		["-r"],
		["--session", "abc"],
		["--session-id", "abc"],
		["--fork", "abc"],
	]) {
		assert.deepEqual(decide(args), { action: "none", reason: "resume" }, args.join(" "));
	}
});

test("bridge: in-session-only defaults, flags, and guards stand down", () => {
	assert.deepEqual(decide([], { directoryRecipe: "light" }), { action: "session-apply", name: "light" });
	assert.deepEqual(decide([], { directoryRecipe: undefined }), { action: "none", reason: "no-recipe" });
	assert.deepEqual(decide(["--help"]), { action: "none", reason: "sessionless" });
	assert.deepEqual(decide(["list"]), { action: "none", reason: "sessionless" });
	assert.deepEqual(decide([], { env: { [RECIPE_STAGE_ENV]: "1" } }), { action: "none", reason: "stage" });
	const pinned = decide(["--models", "x/*", "-e", "/mine.ts"]);
	assert.ok(pinned.action === "session-apply");
	assert.match(pinned.note ?? "", /^\.pi-recipe default "repo": extension set and model scope left unchanged/);
});
