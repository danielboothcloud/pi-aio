import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseRecipeConfig } from "./config.ts";
import { recipeRuntime, resetRecipeRuntimeForTests } from "./apply.ts";
import { buildRecipeStatus, formatRecipeStatus, renderRecipeStatusRows, showRecipeStatus, RECIPE_STATUS_ENTRY } from "./status.ts";

function fixture() {
	const model = { provider: "cursor", id: "grok-4.7", api: "cursor-native" };
	const other = { provider: "anthropic", id: "other", api: "anthropic-messages" };
	const cursorSource = { path: "/cache/node_modules/cursor/dist/index.js", source: "npm:cursor", scope: "temporary", origin: "package" };
	const aioSource = { path: "/checkout/aio/index.ts", source: "cli", scope: "temporary", origin: "top-level" };
	const state = {
		tools: ["read", "bash"],
		entries: [] as Array<{ type: string; data: unknown }>,
		notices: [] as string[],
	};
	const forbidden = () => { throw new Error("Status must not mutate runtime or call a provider"); };
	const pi = {
		getCommands: () => [
			{ name: "recipe", source: "extension", sourceInfo: aioSource },
			{ name: "cursor.models", source: "extension", sourceInfo: cursorSource },
			{ name: "cursor.doctor", source: "extension", sourceInfo: cursorSource },
			{ name: "prompt-only", source: "prompt", sourceInfo: { ...aioSource, path: "/prompts/review.md" } },
		],
		getAllTools: () => [
			{ name: "read", sourceInfo: aioSource },
			{ name: "bash", sourceInfo: { ...aioSource, path: "builtin:bash" } },
			{ name: "deferred_search", sourceInfo: cursorSource },
		],
		getActiveTools: () => state.tools,
		getThinkingLevel: () => "xhigh",
		appendEntry: (type: string, data: unknown) => { state.entries.push({ type, data }); },
		setModel: forbidden, setActiveTools: forbidden, sendMessage: forbidden, sendUserMessage: forbidden,
	};
	const ctx = {
		model,
		scopedModels: [{ model }],
		modelRegistry: {
			find: (provider: string, id: string) => [model, other].find(m => m.provider === provider && m.id === id),
			getModelsOfType: () => [model, other],
			getRegisteredProviderIds: () => ["cursor"],
			refresh: forbidden, getApiKeyForProvider: forbidden, streamSimple: forbidden, complete: forbidden,
		},
		mode: "rpc",
		ui: { notify: (text: string) => { state.notices.push(text); } },
	};
	const def = parseRecipeConfig("work", "global", "/agent", {
		model: "cursor/grok-4.7", thinkingLevel: "xhigh", models: ["cursor/grok-4.7"], extensions: ["npm:cursor"],
		instructions: "TOP-SECRET-INSTRUCTIONS", mcpServers: { private: { command: "private", env: { TOKEN: "TOP-SECRET-MCP" } } },
	});
	assert.ok(def);
	Object.assign(recipeRuntime(), { activeName: "work", active: def, source: "env" });
	const launch = {
		argv: ["bun", "/$bunfs/root/pi", "-ne", "-e", "/checkout/aio/index.ts", "-e", "npm:cursor", "--models", "cursor/grok-4.7", "--api-key", "TOP-SECRET-KEY", "--append-system-prompt", "TOP-SECRET-PROMPT"],
		env: { AIO_RECIPE_STAGE: "1", AIO_RECIPE_ACTIVE: "work", TOKEN: "TOP-SECRET-ENV" },
	};
	return { pi, ctx, state, model, other, def, launch, cursorSource };
}

test.beforeEach(() => resetRecipeRuntimeForTests());

test("status reports actual runtime and launch selection, not saved global settings", () => {
	const f = fixture();
	const report = buildRecipeStatus(f.pi as never, f.ctx as never, f.launch);
	assert.equal(report.recipe, "work");
	assert.equal(report.selection, "env");
	assert.equal(report.runtime.model, "cursor/grok-4.7");
	assert.equal(report.runtime.api, "cursor-native");
	assert.equal(report.runtime.thinking, "xhigh");
	assert.equal(report.runtime.modelMatchesRecipe, true);
	assert.equal(report.runtime.scopeMode, "scoped");
	assert.deepEqual(report.runtime.scopedModels, ["cursor/grok-4.7"]);
	assert.equal(report.launch.extensionPolicy, "explicit-only");
	assert.equal(report.launch.bridged, true);
	assert.deepEqual(report.launch.extensions, ["/checkout/aio/index.ts", "npm:cursor"]);
	assert.deepEqual(report.runtime.registeredProviders, ["cursor"]);
	assert.deepEqual(report.runtime.activeTools, ["read", "bash"]);
	assert.deepEqual(report.observedExtensionSources.map(source => source.path), [f.cursorSource.path, "/checkout/aio/index.ts"]);
	assert.deepEqual(report.observedExtensionSources[0]?.commands, ["cursor.models", "cursor.doctor"]);
	assert.deepEqual(report.observedExtensionSources[0]?.tools, ["deferred_search"]);
	assert.ok(report.notes.some(note => note.includes("not a complete loaded-extension inventory")));
});

test("status distinguishes current model/scope drift from configured expectations", () => {
	const f = fixture();
	const report = buildRecipeStatus(f.pi as never, { ...f.ctx, model: f.other, scopedModels: [] } as never, f.launch);
	assert.equal(report.configured.model, "cursor/grok-4.7");
	assert.equal(report.runtime.model, "anthropic/other");
	assert.equal(report.runtime.modelMatchesRecipe, false);
	assert.equal(report.runtime.scopeMode, "all");
	assert.deepEqual(report.runtime.scopedModels, []);
	assert.match(formatRecipeStatus(report), /ALL available models/);
	assert.ok(report.notes.some(note => note.includes("runtime model differs")));
	assert.ok(report.notes.some(note => note.includes("runtime is unscoped")));
});

test("runtime snapshot does not dump credentials, prompts, instructions, or MCP settings", () => {
	const f = fixture();
	const report = buildRecipeStatus(f.pi as never, f.ctx as never, f.launch);
	assert.equal(JSON.stringify(report).includes("TOP-SECRET"), false);
	assert.equal(JSON.stringify(report).includes("apiKey"), false);
	assert.equal(JSON.stringify(report).includes("mcpServers"), false);
});

test("source URL credentials and terminal control characters are redacted", () => {
	const f = fixture();
	f.cursorSource.source = "git:https://TOP-SECRET-TOKEN@github.com/example/pkg?key=TOP-SECRET-QUERY\u001b";
	f.launch.argv = ["bun", "/$bunfs/root/pi", "-e", f.cursorSource.source];
	f.def.config.extensions = [f.cursorSource.source];
	const report = buildRecipeStatus(f.pi as never, f.ctx as never, f.launch);
	assert.equal(JSON.stringify(report).includes("TOP-SECRET"), false);
	assert.match(JSON.stringify(report), /redacted/);
	assert.equal(formatRecipeStatus(report).includes("\u001b"), false);
});

test("Git shorthand and URL userinfo are redacted before persistence", () => {
	for (const source of [
		"git:TOP-SECRET-TOKEN@github.com/example/pkg",
		"git:github.com/example/pkg?access_token=TOP-SECRET-QUERY",
		"git:https://user:TOP-SECRET-PART@TOP-SECRET-PASSWORD@github.com/example/pkg#TOP-SECRET-FRAGMENT",
	]) {
		const f = fixture();
		f.cursorSource.source = source;
		f.def.config.extensions = [source];
		const report = buildRecipeStatus(f.pi as never, f.ctx as never, { argv: ["node", "/pi/cli.js", "-e", source], env: {} });
		assert.equal(JSON.stringify(report).includes("TOP-SECRET"), false);
		assert.match(JSON.stringify(report), /redacted/);
		showRecipeStatus(f.pi as never, f.ctx as never, { format: "json" });
		assert.equal(JSON.stringify(f.state.entries).includes("TOP-SECRET"), false);
		assert.equal(f.state.notices.join(" ").includes("TOP-SECRET"), false);
	}
});

test("launch recipe follows the same trimmed flag-first precedence as activation", () => {
	const f = fixture();
	const report = buildRecipeStatus(f.pi as never, f.ctx as never, {
		argv: ["node", "/pi/cli.js", "--recipe", " work "],
		env: { AIO_RECIPE_STAGE: "1", AIO_RECIPE_ACTIVE: "home" },
	});
	assert.equal(report.launch.recipe, "work");
	assert.equal(report.notes.some(note => note.includes("active recipe differs")), false);
});

test("print/JSON modes emit a visible diagnostic report without touching protocol stdout", () => {
	for (const mode of ["print", "json"]) {
		const f = fixture();
		const lines: string[] = [];
		showRecipeStatus(f.pi as never, { ...f.ctx, mode } as never, { format: "json", stderr: text => lines.push(text) });
		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.startsWith("recipe-status: "));
		assert.equal(JSON.parse(lines[0]!.slice("recipe-status: ".length)).runtime.model, "cursor/grok-4.7");
		assert.deepEqual(f.state.notices, []);
	}
});

test("snapshots keep independent lists when runtime/config change later", () => {
	const f = fixture();
	const report = buildRecipeStatus(f.pi as never, f.ctx as never, f.launch);
	f.state.tools.push("edit");
	f.def.config.models?.push("anthropic/other");
	assert.deepEqual(report.runtime.activeTools, ["read", "bash"]);
	assert.deepEqual(report.configured.models, ["cursor/grok-4.7"]);
});

test("off/unconfigured sessions and unavailable provider metadata are explicit", () => {
	const f = fixture();
	resetRecipeRuntimeForTests();
	const ctx = { ...f.ctx, scopedModels: [], modelRegistry: { find: () => undefined, getModelsOfType: () => [] } };
	const report = buildRecipeStatus(f.pi as never, ctx as never, { argv: ["node", "/pi/cli.js"], env: {} });
	assert.equal(report.recipe, null);
	assert.equal(report.runtime.modelMatchesRecipe, null);
	assert.equal(report.runtime.registeredProviders, null);
	assert.equal(report.launch.extensionPolicy, "configured-plus-explicit");
	assert.match(formatRecipeStatus(report), /Recipe: off/);
});

test("status output is a non-context custom entry, with JSON available to RPC clients", () => {
	const f = fixture();
	showRecipeStatus(f.pi as never, f.ctx as never, { format: "json" });
	assert.equal(recipeRuntime().activeName, "work");
	assert.deepEqual(f.state.tools, ["read", "bash"]);
	assert.equal(f.state.entries.length, 1);
	assert.equal(f.state.entries[0]?.type, RECIPE_STATUS_ENTRY);
	assert.equal(JSON.parse(f.state.notices[0]!).runtime.model, "cursor/grok-4.7");
});

test("TUI reports stay in the transcript rather than a transient notification", () => {
	const f = fixture();
	showRecipeStatus(f.pi as never, { ...f.ctx, mode: "tui" } as never);
	assert.equal(f.state.entries.length, 1);
	assert.deepEqual(f.state.notices, []);
});

test("status chrome fits every supplied width, including narrow terminals", () => {
	const f = fixture();
	const report = buildRecipeStatus(f.pi as never, f.ctx as never, f.launch);
	const theme = { fg: (_role: string, text: string) => text };
	for (const width of [0, 1, 2, 3, 4, 8, 20, 80, 120]) {
		const lines = renderRecipeStatusRows(report, theme, width, true);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
	}
});
