import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseRecipeConfig, RECIPE_STATE_ENTRY } from "./config.ts";
import {
	applyRecipe,
	buildRecipeContext,
	deactivateRecipe,
	filterRecipeContext,
	findRecipeModel,
	latestPersistedRecipe,
	matchToolPattern,
	recipeRuntime,
	resetRecipeRuntimeForTests,
	resolveRecipePaths,
	resolveToolSet,
	updateRecipeStatus,
} from "./apply.ts";

// ---------------------------------------------------------------------------
// Harness: a minimal pi + ctx pair shaped like permission-modes' test mock,
// recording everything the engine may touch.
// ---------------------------------------------------------------------------

interface ToolInfo {
	name: string;
}

interface Harness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	state: {
		activeTools: string[];
		allTools: ToolInfo[];
		setActiveCalls: string[][];
		setModelCalls: Array<{ provider: string; id: string }>;
		setModelOk: boolean;
		thinkingCalls: string[];
		thinkingThrows: boolean;
		registeredMcp: Map<string, unknown>;
		unregisteredMcp: string[];
		entries: Array<{ customType: string; data: unknown }>;
		notifications: Array<{ message: string; type: string }>;
		statuses: Map<string, string | undefined>;
		events: Map<string, Array<(payload: unknown) => void>>;
		selectReturns: Array<string | undefined>;
	};
}

function makeHarness(overrides: Record<string, unknown> = {}): Harness {
	const state: Harness["state"] = {
		activeTools: ["read", "bash", "edit", "write"],
		allTools: [
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "grep" },
			{ name: "find" },
			{ name: "ls" },
			{ name: "codemode" },
			{ name: "hypa_search" },
			{ name: "hypa_grep" },
		].map((t) => ({ ...t }) as ToolInfo),
		setActiveCalls: [],
		setModelCalls: [],
		setModelOk: true,
		thinkingCalls: [],
		thinkingThrows: false,
		registeredMcp: new Map(),
		unregisteredMcp: [],
		entries: [],
		notifications: [],
		statuses: new Map(),
		events: new Map(),
		selectReturns: [],
	};

	const pi = {
		getActiveTools: () => [...state.activeTools],
		getAllTools: () => state.allTools.map((t) => ({ ...t })),
		setActiveTools: (names: string[]) => {
			state.activeTools = [...names];
			state.setActiveCalls.push([...names]);
		},
		setModel: async (model: { provider: string; id: string }) => {
			state.setModelCalls.push({ provider: model.provider, id: model.id });
			return state.setModelOk;
		},
		setThinkingLevel: (level: string) => {
			if (state.thinkingThrows) throw new Error("level rejected");
			state.thinkingCalls.push(level);
		},
		registerMcpServer: (name: string, config: unknown) => {
			// Mirror pi's validation: invalid configs throw at registration.
			const valid =
				typeof config === "object" &&
				config !== null &&
				(typeof (config as { url?: unknown; command?: unknown }).url === "string" ||
					typeof (config as { url?: unknown; command?: unknown }).command ===
						"string");
			if (!valid) {
				state.notifications.push({
					message: `mcp server "${name}" rejected`,
					type: "mock",
				});
				throw new Error("invalid MCP server configuration");
			}
			state.registeredMcp.set(name, config);
		},
		unregisterMcpServer: (name: string) => {
			state.registeredMcp.delete(name);
			state.unregisteredMcp.push(name);
		},
		appendEntry: (customType: string, data: unknown) => {
			state.entries.push({ customType, data });
		},
		getFlag: () => undefined,
		events: {
			emit: (name: string, payload: unknown) => {
				for (const handler of state.events.get(name) ?? []) handler(payload);
			},
		},
	};

	const models = [
		{ provider: "anthropic", id: "claude-5" },
		{ provider: "openai-codex", id: "gpt-5.2-codex" },
		{ provider: "synthetic", id: "hf:zai-org/GLM-5.3" },
	];

	const ctx = {
		ui: {
			notify: (message: string, type?: string) =>
				state.notifications.push({ message, type: type ?? "info" }),
			setStatus: (key: string, text: string | undefined) =>
				state.statuses.set(key, text),
			select: async (_title: string, _options: string[]) =>
				state.selectReturns.shift(),
			theme: { fg: (role: string, text: string) => `${role}:${text}` },
		},
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/project",
		modelRegistry: {
			find: (provider: string, id: string) =>
				models.find((m) => m.provider === provider && m.id === id),
			getModelsOfType: (type: string) => (type === "chat" ? models : []),
		},
		scopedModels: [],
		sessionManager: {
			getBranch: () => [] as unknown[],
		},
		isProjectTrusted: () => true,
		model: models[0],
	};

	return { pi: { ...pi, ...overrides }, ctx, state };
}

function recipe(raw: Record<string, unknown>, baseDir = "/agent") {
	const parsed = parseRecipeConfig("work", "global", baseDir, raw);
	assert.ok(parsed);
	return parsed;
}

test.beforeEach(() => {
	resetRecipeRuntimeForTests();
});

// ---------------------------------------------------------------------------
// matchToolPattern
// ---------------------------------------------------------------------------

test("matchToolPattern: exact, case-insensitive, and glob forms", () => {
	assert.equal(matchToolPattern("bash", "bash"), true);
	assert.equal(matchToolPattern("Bash", "BASH"), true);
	assert.equal(matchToolPattern("bash", "write"), false);
	assert.equal(matchToolPattern("hypa_search", "hypa_*"), true);
	assert.equal(matchToolPattern("hypa_grep", "hypa_*"), true);
	assert.equal(matchToolPattern("read", "hypa_*"), false);
	assert.equal(matchToolPattern("hypa_search", "hypa*_search"), true);
	assert.equal(matchToolPattern("hypa_search", "h*p*a*ch"), true);
	assert.equal(matchToolPattern("hypa_search", "*search"), true);
	assert.equal(matchToolPattern("hypa_search", "hypa"), false);
	assert.equal(matchToolPattern("anything", "*"), true);
	// A suffix must not match before the remaining text runs out.
	assert.equal(matchToolPattern("hypa", "hypa*_search"), false);
});

// ---------------------------------------------------------------------------
// resolveToolSet
// ---------------------------------------------------------------------------

test("resolveToolSet: +name/-name deltas change the inherited selection", () => {
	const active = ["read", "bash", "edit", "write"];
	const ALL = ["read", "bash", "grep", "find", "ls", "edit", "write", "codemode", "hypa_search", "hypa_grep"];
	const result = resolveToolSet(active, ALL, ["+codemode", "-write"]);
	assert.deepEqual(result.error, undefined);
	assert.deepEqual(result.tools, ["read", "bash", "edit", "codemode"]);
	assert.deepEqual(result.unmatched, []);
});

test("resolveToolSet: delta +glob adds every registered match once, in order", () => {
	const ALL = ["read", "ls", "codemode", "hypa_search", "hypa_grep"];
	const result = resolveToolSet(["read"], ALL, ["+hypa_*", "+codemode", "+read"]);
	assert.deepEqual(result.tools, ["read", "hypa_search", "hypa_grep", "codemode"]);
});

test("resolveToolSet: plain names replace the selection; globs expand in order", () => {
	const ALL = ["read", "bash", "grep", "find", "ls", "hypa_search"];
	const result = resolveToolSet(["read", "edit", "write"], ALL, ["read", "hypa_*", "grep"]);
	assert.deepEqual(result.tools, ["read", "hypa_search", "grep"]);
	assert.deepEqual(result.unmatched, []);
});

test("resolveToolSet: unknown plain names are reported, globs stay silent", () => {
	const plain = resolveToolSet(["read"], ["read"], ["read", "missing"]);
	assert.deepEqual(plain.tools, ["read"]);
	assert.deepEqual(plain.unmatched, ["missing"]);
	const wildcard = resolveToolSet(["read"], ["read"], ["zzz_*"]);
	assert.deepEqual(wildcard.tools, []);
	assert.deepEqual(wildcard.unmatched, []);
});

test("resolveToolSet: mixing plain names and deltas is rejected wholesale", () => {
	const result = resolveToolSet(["read"], ["read"], ["read", "+codemode"]);
	assert.equal(result.error, "mixed");
	assert.deepEqual(result.tools, ["read"]);
});

test("resolveToolSet: empty entries keep the active set", () => {
	const result = resolveToolSet(["read", "bash"], ["read"], []);
	assert.deepEqual(result.tools, ["read", "bash"]);
});

// ---------------------------------------------------------------------------
// filterRecipeContext + latestPersistedRecipe
// ---------------------------------------------------------------------------

function message(customType: string): AgentMessage & { customType: string } {
	return { role: "user", content: [], customType } as AgentMessage & {
		customType: string;
	};
}

test("filterRecipeContext keeps only the latest block while a recipe is active", () => {
	const messages = [message("a"), message("recipe-context"), message("b"), message("recipe-context")];
	const filtered = filterRecipeContext(messages, "work");
	assert.ok(filtered);
	assert.deepEqual(filtered.map((m) => (m as { customType: string }).customType), [
		"a",
		"b",
		"recipe-context",
	]);
	assert.equal(filterRecipeContext([message("recipe-context")], "work"), undefined);
	assert.equal(filterRecipeContext([message("a")], "work"), undefined);
});

test("filterRecipeContext strips every block once no recipe is active", () => {
	const messages = [message("recipe-context"), message("a"), message("recipe-context")];
	const filtered = filterRecipeContext(messages, undefined);
	assert.ok(filtered);
	assert.deepEqual(filtered.map((m) => (m as { customType: string }).customType), ["a"]);
	assert.equal(filterRecipeContext([message("a")], undefined), undefined);
});

test("latestPersistedRecipe reads the branch's latest entry, off included", () => {
	type Entry = { type?: string; customType?: string; data?: { name?: unknown } };
	const entries: Entry[] = [
		{ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name: "home" } },
		{ type: "message" },
		{ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name: "work" } },
	];
	assert.deepEqual(latestPersistedRecipe(entries), { name: "work", present: true });
	entries.push({ type: "custom", customType: RECIPE_STATE_ENTRY, data: { name: null } });
	assert.deepEqual(latestPersistedRecipe(entries), { name: undefined, present: true });
	assert.deepEqual(latestPersistedRecipe([]), { name: undefined, present: false });
	// Non-recipe custom entries never count.
	entries[entries.length - 1] = { type: "custom", customType: "other", data: { name: "x" } };
	assert.deepEqual(latestPersistedRecipe(entries), { name: "work", present: true });
});

// ---------------------------------------------------------------------------
// findRecipeModel
// ---------------------------------------------------------------------------

test("findRecipeModel resolves provider/id, bare ids, colon ids, and scoped sets", () => {
	const { ctx } = makeHarness();
	assert.deepEqual(findRecipeModel(ctx as never, "anthropic/claude-5"), {
		provider: "anthropic",
		id: "claude-5",
	});
	assert.deepEqual(findRecipeModel(ctx as never, "claude-5"), { provider: "anthropic", id: "claude-5" });
	assert.deepEqual(findRecipeModel(ctx as never, "hf:zai-org/GLM-5.3"), {
		provider: "synthetic",
		id: "hf:zai-org/GLM-5.3",
	});
	assert.equal(findRecipeModel(ctx as never, "nope/nope"), undefined);

	// Scoped models win the bare-id path when the catalog misses.
	const scopedCtx = {
		modelRegistry: { find: () => undefined, getModelsOfType: () => [] },
		scopedModels: [{ model: { provider: "router", id: "pinned-model" } }],
	};
	assert.deepEqual(findRecipeModel(scopedCtx as never, "pinned-model"), {
		provider: "router",
		id: "pinned-model",
	});
});

// ---------------------------------------------------------------------------
// resolveRecipePaths
// ---------------------------------------------------------------------------

test("resolveRecipePaths expands ~, resolves from baseDir, drops missing paths", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "aio-recipes-paths-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	writeFileSync(join(agentDir, "skills", "home.md"), "# home skill");
	writeFileSync(join(agentDir, "theme.json"), "{}");

	const def = recipe(
		{
			skills: ["skills/home.md", "skills/missing.md"],
			themes: ["theme.json"],
			prompts: ["~/definitely-not-here.md"],
		},
		agentDir,
	);
	const paths = resolveRecipePaths(def);
	assert.deepEqual(paths.skillPaths, [join(agentDir, "skills", "home.md")]);
	assert.deepEqual(paths.promptPaths, []);
	assert.deepEqual(paths.themePaths, [join(agentDir, "theme.json")]);
});

// ---------------------------------------------------------------------------
// applyRecipe / deactivateRecipe
// ---------------------------------------------------------------------------

test("applyRecipe applies model, thinking, tools, and MCP servers", async () => {
	const h = makeHarness();
	const def = recipe({
		model: "anthropic/claude-5:high",
		tools: ["+codemode", "-hypa_*"],
		mcpServers: { linear: { url: "https://mcp.example.com/linear" } },
	});
	const result = await applyRecipe(h.pi as never, h.ctx as never, def, {
		source: "flag",
		persist: true,
	});
	assert.deepEqual(result.applied, ["model", "thinking", "tools", "mcp"]);
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(h.state.setModelCalls, [{ provider: "anthropic", id: "claude-5" }]);
	assert.deepEqual(h.state.thinkingCalls, ["high"]);
	assert.deepEqual(h.state.setActiveCalls, [
		["read", "bash", "edit", "write", "codemode"],
	]);
	assert.deepEqual([...h.state.registeredMcp.keys()], ["linear"]);
	assert.deepEqual(h.state.entries, [{ customType: RECIPE_STATE_ENTRY, data: { name: "work" } }]);

	const runtime = recipeRuntime();
	assert.equal(runtime.activeName, "work");
	assert.equal(runtime.source, "flag");
	assert.deepEqual([...runtime.registeredMcp], ["linear"]);
});

test("applyRecipe: unknown model and rejected secrets surface as warnings", async () => {
	const h = makeHarness({
		setModel: async () => false,
	});
	const def = recipe({ model: "nope/ghost" });
	const result = await applyRecipe(h.pi as never, h.ctx as never, def, {
		source: "command",
		persist: false,
	});
	assert.deepEqual(result.applied, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0]!, /model "nope\/ghost" not found/);
	assert.deepEqual(h.state.setModelCalls, []);

	// A model that exists but lacks credentials: setModel answered false.
	const h2 = makeHarness({ setModel: async () => false });
	const cred = recipe({ model: "anthropic/claude-5" });
	const r2 = await applyRecipe(h2.pi as never, h2.ctx as never, cred, {
		source: "command",
		persist: false,
	});
	assert.deepEqual(r2.applied, []);
	assert.match(r2.warnings[0]!, /no API key/);

	// A throwing setThinkingLevel warns instead of failing activation.
	const h3 = makeHarness({ setThinkingLevel: () => {
		throw new Error("level rejected");
	} });
	const think = recipe({ thinkingLevel: "max" });
	const r3 = await applyRecipe(h3.pi as never, h3.ctx as never, think, {
		source: "command",
		persist: false,
	});
	assert.deepEqual(r3.applied, []);
	assert.match(r3.warnings[0]!, /thinking level "max" not applied/);
});

test("applyRecipe syncs MCP servers between recipes, unregistering only its own", async () => {
	const h = makeHarness();
	const first = recipe({ mcpServers: { linear: { url: "https://l" }, extra: { url: "https://e" } } });
	await applyRecipe(h.pi as never, h.ctx as never, first, { source: "command", persist: false });
	assert.deepEqual([...h.state.registeredMcp.keys()].sort(), ["extra", "linear"]);

	// Switch: `extra` goes away (ours), `linear` is replaced, and a config
	// pi rejects (an object without url/command, exactly what
	// validateMcpServerConfig throws for) surfaces as a warning.
	const second = recipe({
		mcpServers: {
			linear: { url: "https://l2" },
			broken: {},
		},
	});
	const result = await applyRecipe(h.pi as never, h.ctx as never, second, {
		source: "command",
		persist: false,
	});
	assert.equal(result.applied.includes("mcp"), true);
	assert.deepEqual([...h.state.registeredMcp.keys()], ["linear"]);
	assert.equal((h.state.registeredMcp.get("linear") as { url: string }).url, "https://l2");
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0]!, /mcp server "broken"/);
});

test("deactivateRecipe clears state, unregisters this feature's MCP servers, and persists off", async () => {
	const h = makeHarness();
	const def = recipe({ mcpServers: { linear: { url: "https://l" } } });
	await applyRecipe(h.pi as never, h.ctx as never, def, { source: "command", persist: true });
	assert.equal(recipeRuntime().activeName, "work");

	deactivateRecipe(h.pi as never, h.ctx as never, { persist: true });
	assert.equal(recipeRuntime().activeName, undefined);
	assert.equal(recipeRuntime().registeredMcp.size, 0);
	assert.equal(h.state.registeredMcp.has("linear"), false);
	assert.deepEqual(h.state.entries.at(-1), {
		customType: RECIPE_STATE_ENTRY,
		data: { name: null },
	});
	// The status pill and frame contribution are gone.
	assert.equal(h.state.statuses.get("recipe"), undefined);
});

// ---------------------------------------------------------------------------
// updateRecipeStatus
// ---------------------------------------------------------------------------

test("updateRecipeStatus paints the footer pill when no frame owns the surface", async () => {
	const h = makeHarness();
	const def = recipe({ tools: ["+codemode"] });
	await applyRecipe(h.pi as never, h.ctx as never, def, { source: "flag", persist: false });
	updateRecipeStatus(h.pi as never, h.ctx as never);
	const status = h.state.statuses.get("recipe");
	assert.ok(status);
	assert.match(status, /recipe:work/);

	deactivateRecipe(h.pi as never, h.ctx as never, { persist: false });
	updateRecipeStatus(h.pi as never, h.ctx as never);
	assert.equal(h.state.statuses.get("recipe"), undefined);
});

test("updateRecipeStatus: a frame-capable host hides the footer fallback", async () => {
	const h = makeHarness();
	// The frame probe emits its capability event; answer it to claim support.
	h.state.events.set("aio:minimal-frame-capability", [
		(payload: unknown) => {
			// SAFETY: probeFrameEditor hands the probe object itself to handlers.
			const capability = payload as { supported?: boolean };
			capability.supported = true;
		},
	]);
	const def = recipe({});
	await applyRecipe(h.pi as never, h.ctx as never, def, { source: "flag", persist: false });
	updateRecipeStatus(h.pi as never, h.ctx as never);
	assert.equal(h.state.statuses.get("recipe"), undefined, "framed hosts use the border pill");
});

// ---------------------------------------------------------------------------
// instructions block
// ---------------------------------------------------------------------------

test("buildRecipeContext wraps instructions in the recipe header", () => {
	const text = buildRecipeContext("work", "Always run tests.");
	assert.equal(text, '[RECIPE "work" ACTIVE]\n\nAlways run tests.');
});
