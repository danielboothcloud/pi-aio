// ---------------------------------------------------------------------------
// recipes/apply — the in-process application engine.
//
// The bridge (trampoline.ts) covers the two keys pi fixes before extensions
// run (extension set, enabled-model scope). Everything else a recipe declares
// is applied here, at session_start and on `/recipe` switches:
//
//   model / thinkingLevel -> pi.setModel + pi.setThinkingLevel
//   tools                -> pi.setActiveTools over pi.getAllTools
//   mcpServers           -> pi.registerMcpServer / unregisterMcpServer (ours only)
//   instructions         -> hidden per-turn recipe-context message
//   skills/prompts/themes -> resources_discover paths (read by index.ts)
//
// The module keeps runtime state (active recipe, provenance, launch notice,
// recipes registered by this feature) with a test reset hook, and exports
// pure helpers (tool-set grammar, context filter, restore scan) so tests can
// drive the engine without a live pi session.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	emitAioUiState,
	probeFrameEditor,
	requestFrameRepaint,
	setFrameMetadataContributor,
} from "../frame/protocol.js";
import {
	RECIPE_CONTEXT_TYPE,
	RECIPE_STATUS_KEY,
	RECIPE_STATE_ENTRY,
	parseModelSpec,
	type RecipeDefinition,
	type RecipesConfig,
} from "./config.js";

/** Session model type narrowed the way YSK narrows it. */
export type SessionModel = NonNullable<ExtensionContext["model"]>;

/** The registry slice the engine needs (kept narrow for test harnesses). */
export interface ModelRegistryLike {
	find(provider: string, modelId: string): SessionModel | undefined;
	getModelsOfType(type: "chat"): SessionModel[];
}

/** Frame metadata contributor key (read by index.ts cleanup too). */
export const RECIPE_FRAME_CONTRIBUTOR = "recipe";

export type RecipeSourceMarker =
	| "flag" // --recipe on this launch
	| "env" // set by the relaunch bridge on the child process
	| "session" // restored from the session's recipe-state entry
	| "default" // auto-activated defaultRecipe on a fresh startup
	| "command"; // switched mid-session via /recipe

export interface RecipeRuntimeState {
	/** Recipes for the current cwd; reloaded on every session_start. */
	recipes: RecipesConfig;
	activeName: string | undefined;
	active: RecipeDefinition | undefined;
	source: RecipeSourceMarker | undefined;
	/** Set by the factory when the bridge stood down or failed. */
	launchNotice: string | undefined;
	launchNoticeFired: boolean;
	/** MCP servers this feature registered (never any other origin's). */
	registeredMcp: Set<string>;
}

function freshRuntime(): RecipeRuntimeState {
	return {
		recipes: { recipes: {}, empty: true },
		activeName: undefined,
		active: undefined,
		source: undefined,
		launchNotice: undefined,
		launchNoticeFired: false,
		registeredMcp: new Set(),
	};
}

let runtimeState: RecipeRuntimeState = freshRuntime();

export function recipeRuntime(): RecipeRuntimeState {
	return runtimeState;
}

export function resetRecipeRuntimeForTests(): void {
	runtimeState = freshRuntime();
}

export function activeRecipe(): RecipeDefinition | undefined {
	return runtimeState.active;
}

// ---------------------------------------------------------------------------
// Pure helpers: tool grammar
// ---------------------------------------------------------------------------

/**
 * Case-insensitive `*` glob over tool names, mirroring the `--tools`/
 * `defaultTools` pattern semantics ("`*` matches any characters").
 */
export function matchToolPattern(name: string, pattern: string): boolean {
	const target = name.toLowerCase();
	const expr = pattern.toLowerCase();
	if (!expr.includes("*")) return target === expr;
	if (expr === "*") return true;
	const parts = expr.split("*");
	const head = parts[0] ?? "";
	if (!target.startsWith(head)) return false;
	let cursor = head.length;
	// Middle segments must appear in order after the cursor.
	for (const middle of parts.slice(1, -1)) {
		if (!middle) continue;
		const at = target.indexOf(middle, cursor);
		if (at === -1) return false;
		cursor = at + middle.length;
	}
	const tail = parts.at(-1) ?? "";
	if (!tail) return true;
	const remaining = target.slice(cursor);
	return remaining.length >= tail.length && remaining.endsWith(tail);
}

export interface ToolSetResult {
	/** The resolved active tool set (only meaningful when error is undefined). */
	tools: string[];
	/** Entries (or patterns) that matched nothing, for a warning notice. */
	unmatched: string[];
	/** Pi forbids mixing plain names with +name/-name deltas in one list. */
	error: "mixed" | undefined;
}

/**
 * Apply the defaultTools grammar to the active tool set:
 * - a list of only `+name`/`-name` entries changes the inherited selection
 *   (`+` adds registered matches in order, `-` removes matches by pattern),
 * - anything else is an absolute selection: plain names and `*` patterns
 *   replace the active set with every registered match, in list order.
 */
export function resolveToolSet(
	active: string[],
	allNames: string[],
	entries: string[],
): ToolSetResult {
	const trimmed = entries.map((entry) => entry.trim()).filter(Boolean);
	if (trimmed.length === 0) {
		return { tools: [...active], unmatched: [], error: undefined };
	}
	const deltas = trimmed.filter((entry) => entry.startsWith("+") || entry.startsWith("-"));
	const plains = trimmed.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-"));
	if (deltas.length > 0 && plains.length > 0) {
		return { tools: [...active], unmatched: [], error: "mixed" };
	}

	if (deltas.length > 0) {
		let tools = [...active];
		const unmatched: string[] = [];
		for (const delta of deltas) {
			const pattern = delta.slice(1).trim();
			if (!pattern) continue;
			if (delta.startsWith("+")) {
				const matches = allNames.filter((name) => matchToolPattern(name, pattern));
				if (matches.length === 0 && !pattern.includes("*")) unmatched.push(pattern);
				for (const match of matches) {
					if (!tools.includes(match)) tools.push(match);
				}
			} else {
				tools = tools.filter((name) => !matchToolPattern(name, pattern));
			}
		}
		return { tools, unmatched, error: undefined };
	}

	const tools: string[] = [];
	const unmatched: string[] = [];
	for (const pattern of plains) {
		const matches = allNames.filter((name) => matchToolPattern(name, pattern));
		if (matches.length === 0 && !pattern.includes("*")) unmatched.push(pattern);
		for (const match of matches) {
			if (!tools.includes(match)) tools.push(match);
		}
	}
	return { tools, unmatched, error: undefined };
}

// ---------------------------------------------------------------------------
// Pure helpers: context filter + restore scan
// ---------------------------------------------------------------------------

/**
 * Keep only the latest recipe-context block while a recipe is active, and
 * drop every one once no recipe is active — so a cleared or switched recipe
 * never lingers in the model's context (mirror of styles' contract). Returns
 * undefined when nothing needs filtering.
 */
export function filterRecipeContext(
	messages: AgentMessage[],
	activeName: string | undefined,
): AgentMessage[] | undefined {
	const isRecipeMessage = (message: AgentMessage) =>
		(message as AgentMessage & { customType?: string }).customType === RECIPE_CONTEXT_TYPE;
	let latest = -1;
	let count = 0;
	for (const [index, message] of messages.entries()) {
		if (!isRecipeMessage(message)) continue;
		latest = index;
		count++;
	}
	const keepLatest = activeName !== undefined;
	if (count === 0 || (keepLatest && count === 1)) return undefined;
	return messages.filter(
		(message, index) =>
			!isRecipeMessage(message) || (keepLatest && index === latest),
	);
}

/**
 * The latest recipe-state entry on the current branch: the active recipe
 * name, null when it was explicitly cleared, undefined when the session never
 * had one.
 */
export function latestPersistedRecipe(
	entries: ReadonlyArray<unknown>,
): { name: string | undefined; present: boolean } {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			customType?: string;
			data?: { name?: unknown };
		};
		if (entry.type !== "custom" || entry.customType !== RECIPE_STATE_ENTRY) {
			continue;
		}
		const name = entry.data?.name;
		if (typeof name === "string" && name.trim()) {
			return { name: name.trim(), present: true };
		}
		// `{ name: null }` pins "recipe off" on the branch.
		return { name: undefined, present: true };
	}
	return { name: undefined, present: false };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model spec ("provider/id" or bare id; ids may themselves contain
 * colons) against the registry, the session's scoped models, and the catalog
 * — the lookup order YSK's auditor pin uses.
 */
export function findRecipeModel(
	ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
	spec: string,
): SessionModel | undefined {
	// SAFETY: mapped slice of the ModelRegistry surface, intentionally erased to
	// the session-model type (same narrowing YSK's auditor pin uses) so test
	// harnesses can supply a minimal object here.
	const registry = ctx.modelRegistry as unknown as ModelRegistryLike | undefined;
	const slash = spec.indexOf("/");
	const split = slash > 0 ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) } : undefined;
	if (registry && split) {
		try {
			const direct = registry.find(split.provider, split.id);
			if (direct) return direct;
		} catch {
			// Narrowed harnesses may not implement find; fall through.
		}
	}
	const scoped = (ctx.scopedModels ?? []) as Array<{ model?: SessionModel }>;
	if (scoped.length > 0) {
		if (!split) {
			const byBareId = scoped.find((entry) => entry.model?.id === spec)?.model;
			if (byBareId) return byBareId;
		}
		const bySplit = scoped.find(
			(entry) =>
				split &&
				entry.model?.provider === split.provider &&
				entry.model?.id === split.id,
		)?.model;
		if (bySplit) return bySplit;
	}
	if (!registry) return undefined;
	try {
		// A colon-bearing id (
		// "hf:zai-org/GLM-5.3") also splits on its first slash, so both the
		// split form and the whole spec are tried as catalog ids, matching
		// YSK's auditor-pin lookup.
		return registry.getModelsOfType("chat").find((model) =>
			split
				? (model.provider === split.provider && model.id === split.id) ||
					model.id === spec
				: model.id === spec,
		);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Resource paths
// ---------------------------------------------------------------------------

export interface RecipeResourcePaths {
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
}

/**
 * Resolve a recipe's skill/prompt/theme paths: `~` expands, relative entries
 * resolve from the file that declared them (agent dir or project `.pi`), and
 * missing paths are dropped silently — a stale path must never break
 * resource discovery.
 */
export function resolveRecipePaths(
	def: RecipeDefinition,
	exists: (path: string) => boolean = existsSync,
): RecipeResourcePaths {
	const resolve = (raw: string): string | undefined => {
		const entry = raw.trim();
		if (!entry) return undefined;
		let expanded = entry;
		if (entry === "~") {
			expanded = homedir();
		} else if (entry.startsWith("~/")) {
			expanded = join(homedir(), entry.slice(2));
		}
		const absolute = isAbsolute(expanded) ? expanded : join(def.baseDir, expanded);
		return exists(absolute) ? absolute : undefined;
	};
	const files = (entries: string[] | undefined): string[] => {
		if (!entries) return [];
		const out: string[] = [];
		for (const entry of entries) {
			const resolved = resolve(entry);
			if (resolved) out.push(resolved);
		}
		return out;
	};
	return {
		skillPaths: files(def.config.skills),
		promptPaths: files(def.config.prompts),
		themePaths: files(def.config.themes),
	};
}

// ---------------------------------------------------------------------------
// Status surfaces
// ---------------------------------------------------------------------------

export function formatRecipeStatus(ctx: ExtensionContext, name: string): string {
	return ctx.ui.theme.fg("accent", `✦ recipe:${name}`);
}

/**
 * Mirror of the styles/permission-modes dual-channel pattern: while the
 * minimalist frame owns the surface, the recipe pill rides the top border as
 * a frame metadata contribution and the footer status is cleared; without a
 * frame, the status row's `statuses` segment carries the pill.
 */
export function updateRecipeStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const name = runtimeState.activeName;
	emitAioUiState(pi, { recipe: name });
	if (!ctx.hasUI) return;
	const framed = probeFrameEditor(pi).supported;
	if (framed && name) {
		const meta = { icon: "✦", label: name, role: "accent" as const };
		setFrameMetadataContributor(RECIPE_FRAME_CONTRIBUTOR, () => ({ recipe: meta }));
		requestFrameRepaint();
	} else {
		setFrameMetadataContributor(RECIPE_FRAME_CONTRIBUTOR, undefined);
	}
	// The frame owns the pill while present; the footer status is the
	// unframed fallback and stays cleared otherwise.
	let statusText: string | undefined;
	if (!framed && name) {
		statusText = formatRecipeStatus(ctx, name);
	}
	ctx.ui.setStatus(RECIPE_STATUS_KEY, statusText);
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export interface ApplyRecipeResult {
	/** Key names applied (subset of model | thinking | tools | mcp). */
	applied: string[];
	/** Warnings raised; never fatal. */
	warnings: string[];
}

function registryWarningsFrom(result: ToolSetResult): string[] {
	const warnings: string[] = [];
	if (result.error === "mixed") {
		warnings.push(
			"tools list mixes plain names with +name/-name entries; tool selection unchanged",
		);
	} else if (result.unmatched.length > 0) {
		warnings.push(`unknown or inactive tools: ${result.unmatched.join(", ")}`);
	}
	return warnings;
}

/** Register/replace a recipe's MCP servers, unregistering only this feature's stale ones. */
export function syncRecipeMcpServers(
	pi: ExtensionAPI,
	recipe: RecipeDefinition,
): string[] {
	const warnings: string[] = [];
	const wanted = recipe.config.mcpServers ?? {};
	const wantedNames = new Set(Object.keys(wanted));
	for (const name of runtimeState.registeredMcp) {
		if (wantedNames.has(name)) continue;
		try {
			pi.unregisterMcpServer(name);
		} catch {
			// Already gone — nothing to clean.
		}
		runtimeState.registeredMcp.delete(name);
	}
	for (const [name, config] of Object.entries(wanted)) {
		try {
			pi.registerMcpServer(name, config);
			runtimeState.registeredMcp.add(name);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`mcp server "${name}": ${message}`);
		}
	}
	return warnings;
}

/**
 * Activate a recipe in the current session. Only the session-scoped keys are
 * touched here; restart-scoped keys (extension set, model scope) belong to
 * the bridge and surface as an advisory rather than doing anything.
 */
export async function applyRecipe(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	def: RecipeDefinition,
	options: { source: RecipeSourceMarker; persist: boolean },
): Promise<ApplyRecipeResult> {
	runtimeState.activeName = def.name;
	runtimeState.active = def;
	runtimeState.source = options.source;

	const applied: string[] = [];
	const warnings: string[] = [];
	const config = def.config;

	// Model first, then thinking level: pi clamps the level to the new model.
	let thinkingLevel: ThinkingLevel | undefined = config.thinkingLevel;
	if (config.model) {
		const spec = parseModelSpec(config.model);
		thinkingLevel = config.thinkingLevel ?? spec.thinking;
		const model = findRecipeModel(ctx, spec.model);
		if (!model) {
			warnings.push(
				`model "${spec.model}" not found — model left as the session default`,
			);
		} else {
			try {
				const ok = await pi.setModel(model);
				if (ok) {
					applied.push("model");
				} else {
					warnings.push(
						`no API key for ${model.provider}/${model.id} — model left unchanged`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`model switch failed: ${message}`);
			}
		}
	}
	if (thinkingLevel) {
		try {
			pi.setThinkingLevel(thinkingLevel);
			applied.push("thinking");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`thinking level "${thinkingLevel}" not applied: ${message}`);
		}
	}

	if ((config.tools?.length ?? 0) > 0) {
		const allNames = pi.getAllTools().map((tool) => tool.name);
		const result = resolveToolSet(pi.getActiveTools(), allNames, config.tools ?? []);
		warnings.push(...registryWarningsFrom(result));
		if (!result.error) {
			pi.setActiveTools(result.tools);
			applied.push("tools");
		}
	}

	if (Object.keys(config.mcpServers ?? {}).length > 0) {
		warnings.push(...syncRecipeMcpServers(pi, def));
		applied.push("mcp");
	}

	updateRecipeStatus(pi, ctx);
	if (options.persist) {
		pi.appendEntry(RECIPE_STATE_ENTRY, { name: def.name });
	}
	return { applied, warnings };
}

/** Clear the active recipe: status, this feature's MCP servers, and instructions. */
export function deactivateRecipe(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { persist: boolean } = { persist: true },
): void {
	runtimeState.activeName = undefined;
	runtimeState.active = undefined;
	runtimeState.source = undefined;
	for (const name of runtimeState.registeredMcp) {
		try {
			pi.unregisterMcpServer(name);
		} catch {
			// Already gone — nothing to clean.
		}
	}
	runtimeState.registeredMcp.clear();
	updateRecipeStatus(pi, ctx);
	if (options.persist) {
		pi.appendEntry(RECIPE_STATE_ENTRY, { name: null });
	}
}

/** The hidden per-turn block injected for the active recipe's instructions. */
export function buildRecipeContext(name: string, instructions: string): string {
	return `[RECIPE "${name}" ACTIVE]\n\n${instructions}`;
}
