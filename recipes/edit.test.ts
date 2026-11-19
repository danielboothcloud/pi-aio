import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RECIPES_FILE_ENV, parseRecipeConfig, type RecipeDefinition } from "./config.ts";
import {
	applyRecipeEdit,
	detectIndent,
	extensionCandidates,
	mcpConfigFromInput,
	modelPatternMatches,
	orderModelChoices,
	parseRecipeEditKey,
	readRecipeFileForEdit,
	resolveRecipeEditTarget,
	writeRecipeFileAtomic,
} from "./edit.ts";

const tmp = mkdtempSync(join(process.cwd(), "test/.recipes-edit-"));
const SAVED_RECIPES_FILE = process.env[RECIPES_FILE_ENV];

test.after(() => {
	if (SAVED_RECIPES_FILE === undefined) delete process.env[RECIPES_FILE_ENV];
	else process.env[RECIPES_FILE_ENV] = SAVED_RECIPES_FILE;
	rmSync(tmp, { recursive: true, force: true });
});

function sample(): Record<string, unknown> {
	return {
		defaultRecipe: "home",
		recipes: {
			home: { description: "Home", model: "anthropic/claude-5:high", models: ["anthropic/*"], extra: 1 },
			work: { model: "openai/gpt-5", mcpServers: { linear: { url: "https://x" } }, extensions: ["npm:a"] },
		},
	};
}

function def(name: string, source: RecipeDefinition["source"]): RecipeDefinition {
	// SAFETY: a non-null object always parses to a definition.
	return parseRecipeConfig(name, source, tmp, {}) as RecipeDefinition;
}

test("key aliases map to the catalog keys", () => {
	assert.equal(parseRecipeEditKey("models"), "scope");
	assert.equal(parseRecipeEditKey("thinkingLevel"), "thinking");
	assert.equal(parseRecipeEditKey("permissionMode"), "mode");
	assert.equal(parseRecipeEditKey("extensions"), "extension");
	assert.equal(parseRecipeEditKey("bogus"), undefined);
});

test("set model keeps the :thinking suffix and leaves a covering scope alone", () => {
	const data = sample();
	const result = applyRecipeEdit(data, "home", { action: "set", key: "model", value: "anthropic/claude-6" });
	const home = (data.recipes as Record<string, Record<string, unknown>>).home;
	assert.equal(home.model, "anthropic/claude-6:high");
	assert.deepEqual(home.models, ["anthropic/*"]);
	assert.equal(result.restart, false);
	assert.deepEqual(Object.keys(home), ["description", "model", "models", "extra"], "key order kept");
	assert.deepEqual((data.recipes as Record<string, unknown>).work, (sample().recipes as Record<string, unknown>).work);
});

test("set model outside the scope appends it to models (restart-scoped)", () => {
	const data = sample();
	const result = applyRecipeEdit(data, "home", { action: "set", key: "model", value: "openai/gpt-5" });
	const home = (data.recipes as Record<string, Record<string, unknown>>).home;
	assert.deepEqual(home.models, ["anthropic/*", "openai/gpt-5"]);
	assert.equal(result.restart, true);
	assert.deepEqual(result.changes, ["model → openai/gpt-5:high", "models += openai/gpt-5"]);
});

test("a recipe without a models list never gains one from set model", () => {
	const data = sample();
	const result = applyRecipeEdit(data, "work", { action: "set", key: "model", value: "google/gemini-3" });
	const work = (data.recipes as Record<string, Record<string, unknown>>).work;
	assert.equal(work.models, undefined);
	assert.equal(result.restart, false);
});

test("scalar keys replace; unchanged values report no change", () => {
	const data = sample();
	assert.equal(applyRecipeEdit(data, "home", { action: "set", key: "thinking", value: "low" }).changed, true);
	assert.equal(applyRecipeEdit(data, "home", { action: "set", key: "thinking", value: "low" }).changed, false);
	assert.throws(() => applyRecipeEdit(data, "home", { action: "set", key: "thinking", value: "huge" }), /not a thinking level/);
	applyRecipeEdit(data, "home", { action: "set", key: "style", value: "concise" });
	applyRecipeEdit(data, "home", { action: "set", key: "advisor", value: "openai/gpt-5:xhigh" });
	const home = (data.recipes as Record<string, Record<string, unknown>>).home;
	assert.equal(home.thinkingLevel, "low");
	assert.equal(home.style, "concise");
	assert.equal(home.advisor, "openai/gpt-5:xhigh");
});

test("mode writes the legacy alias in place; the object advisor keeps its limits", () => {
	const data = { recipes: { r: { mode: "ask", advisor: { model: "a/b", maxUsesPerRun: 5, enabled: false } } } };
	applyRecipeEdit(data, "r", { action: "set", key: "mode", value: "plan" });
	applyRecipeEdit(data, "r", { action: "set", key: "advisor", value: "c/d:low" });
	assert.deepEqual(data.recipes.r, { mode: "plan", advisor: { model: "c/d", maxUsesPerRun: 5, reasoning: "low" } });
});

test("list keys append without duplicates and remove one entry", () => {
	const data = sample();
	const added = applyRecipeEdit(data, "work", { action: "add", key: "extension", value: "npm:b" });
	assert.equal(added.restart, true);
	assert.equal(applyRecipeEdit(data, "work", { action: "add", key: "extension", value: "npm:b" }).changed, false);
	applyRecipeEdit(data, "work", { action: "add", key: "scope", value: "openai/*" });
	const work = (data.recipes as Record<string, Record<string, unknown>>).work;
	assert.deepEqual(work.extensions, ["npm:a", "npm:b"]);
	assert.deepEqual(work.models, ["openai/*"]);
	const removed = applyRecipeEdit(data, "work", { action: "remove", key: "extension", value: "npm:a" });
	assert.equal(removed.restart, true);
	assert.deepEqual(work.extensions, ["npm:b"]);
});

test("mcp servers are added, replaced, and removed by name", () => {
	const data = sample();
	const work = (): Record<string, unknown> => (data.recipes as Record<string, Record<string, unknown>>).work;
	assert.deepEqual(
		applyRecipeEdit(data, "work", { action: "add", key: "mcp", value: "docs", config: { url: "https://d" } }).changes,
		["mcpServers.docs added"],
	);
	assert.deepEqual(
		applyRecipeEdit(data, "work", { action: "add", key: "mcp", value: "docs", config: { command: "x" } }).changes,
		["mcpServers.docs replaced"],
	);
	applyRecipeEdit(data, "work", { action: "remove", key: "mcp", value: "linear" });
	assert.deepEqual(work().mcpServers, { docs: { command: "x" } });
});

test("remove unsets scalar keys (both mode spellings)", () => {
	const data = { recipes: { r: { model: "a/b", permissionMode: "plan", mode: "ask", models: ["a/*"] } } };
	assert.deepEqual(applyRecipeEdit(data, "r", { action: "remove", key: "mode" }).changes, ["permissionMode removed", "mode removed"]);
	applyRecipeEdit(data, "r", { action: "remove", key: "model" });
	assert.equal(applyRecipeEdit(data, "r", { action: "remove", key: "model" }).changed, false);
	assert.equal(applyRecipeEdit(data, "r", { action: "remove", key: "scope" }).restart, true);
	assert.deepEqual(data.recipes.r, {});
});

test("an unknown recipe or missing recipes object throws", () => {
	assert.throws(() => applyRecipeEdit(sample(), "ghost", { action: "set", key: "thinking", value: "low" }), /not defined/);
	assert.throws(() => applyRecipeEdit({}, "home", { action: "set", key: "thinking", value: "low" }), /no "recipes"/);
	assert.throws(() => applyRecipeEdit(sample(), "home", { action: "add", key: "scope", value: " " }), /empty/);
});

test("scope patterns match exact, glob, and bare ids", () => {
	assert.equal(modelPatternMatches("anthropic/*", "anthropic/claude-5"), true);
	assert.equal(modelPatternMatches("*sonnet*", "anthropic/claude-sonnet-4"), true);
	assert.equal(modelPatternMatches("openai/gpt-5:high", "openai/gpt-5"), true);
	assert.equal(modelPatternMatches("openai/gpt-5", "openai/gpt-5.1"), false);
});

test("model choices: current first, then enabled/scoped, then the rest", () => {
	const models = [
		{ provider: "z", id: "late" },
		{ provider: "a", id: "early" },
		{ provider: "openai", id: "gpt-5" },
		{ provider: "anthropic", id: "claude-5" },
	];
	assert.deepEqual(
		orderModelChoices(models, {
			current: { provider: "anthropic", id: "claude-5" },
			enabled: ["openai/*"],
			scoped: [{ provider: "z", id: "late" }],
		}),
		["anthropic/claude-5", "openai/gpt-5", "z/late", "a/early"],
	);
});

test("extension candidates come from packages and extensions, minus exclusions", () => {
	const settings = {
		packages: ["npm:pi-web-access", { source: "git:github.com/x/y" }, "./local-pkg"],
		extensions: ["otty.ts", "-builtin:mcp", "!skip", "npm:pi-web-access"],
	};
	assert.deepEqual(extensionCandidates(settings, "/agent"), [
		"npm:pi-web-access",
		"git:github.com/x/y",
		"/agent/local-pkg",
		"otty.ts",
	]);
	assert.deepEqual(extensionCandidates(null, "/agent"), []);
});

test("mcp input: URLs become http servers, other text a command line", () => {
	assert.deepEqual(mcpConfigFromInput("https://mcp.example.com"), { url: "https://mcp.example.com" });
	assert.deepEqual(mcpConfigFromInput("npx -y server ."), { command: "npx", args: ["-y", "server", "."] });
	assert.equal(mcpConfigFromInput("  "), undefined);
});

// -- target resolution + file IO ------------------------------------------------

test("target: directory, project, and global (AIO_RECIPES_FILE) files", () => {
	const cwd = join(tmp, "target");
	const directoryFile = join(cwd, ".pi-recipe");
	process.env[RECIPES_FILE_ENV] = join(tmp, "global.json");
	const base = { cwd, projectTrusted: true, directoryFile, directoryTrusted: true };
	assert.deepEqual(resolveRecipeEditTarget(def("r", "directory"), base), { ok: true, file: directoryFile, source: "directory" });
	assert.deepEqual(resolveRecipeEditTarget(def("r", "project"), base), {
		ok: true,
		file: join(cwd, ".pi", "aio-recipes.json"),
		source: "project",
	});
	assert.deepEqual(resolveRecipeEditTarget(def("r", "global"), base), {
		ok: true,
		file: join(tmp, "global.json"),
		source: "global",
	});
	const untrustedProject = resolveRecipeEditTarget(def("r", "project"), { ...base, projectTrusted: false });
	assert.equal(untrustedProject.ok, false);
	assert.match(untrustedProject.ok ? "" : untrustedProject.reason, /not trusted/);
	const untrustedDirectory = resolveRecipeEditTarget(def("r", "directory"), { ...base, directoryTrusted: false });
	assert.match(untrustedDirectory.ok ? "" : untrustedDirectory.reason, /\/recipe trust/);
});

test("reading refuses comments/unparseable JSON; indentation is detected", () => {
	const jsonc = join(tmp, "commented.json");
	writeFileSync(jsonc, '{\n  // note\n  "recipes": {}\n}\n');
	const read = readRecipeFileForEdit(jsonc);
	assert.equal(read.ok, false);
	assert.match(read.ok ? "" : read.reason, /not strict JSON/);
	assert.equal(readRecipeFileForEdit(join(tmp, "missing.json")).ok, false);
	assert.equal(detectIndent('{\n\t"a": 1\n}'), "\t");
	assert.equal(detectIndent('{\n    "a": 1\n}'), 4);
	assert.equal(detectIndent("{}"), 2);
});

test("atomic write keeps indentation, writes a backup, and follows symlinks", () => {
	const real = join(tmp, "real.json");
	const link = join(tmp, "link.json");
	writeFileSync(real, '{\n\t"recipes": {\n\t\t"r": {}\n\t}\n}\n');
	symlinkSync(real, link);
	const read = readRecipeFileForEdit(link);
	assert.ok(read.ok);
	applyRecipeEdit(read.data, "r", { action: "set", key: "thinking", value: "low" });
	writeRecipeFileAtomic(link, read.data, read.indent, { backup: true });
	assert.equal(lstatSync(link).isSymbolicLink(), true, "the link survives");
	assert.equal(readFileSync(real, "utf-8"), '{\n\t"recipes": {\n\t\t"r": {\n\t\t\t"thinkingLevel": "low"\n\t\t}\n\t}\n}\n');
	assert.equal(readFileSync(`${link}.bak`, "utf-8"), read.text);
	mkdirSync(join(tmp, "plain"), { recursive: true });
	const plain = join(tmp, "plain", "p.json");
	writeRecipeFileAtomic(plain, { a: 1 }, 2);
	assert.equal(readFileSync(plain, "utf-8"), '{\n  "a": 1\n}\n');
	assert.equal(existsSync(`${plain}.bak`), false);
});
