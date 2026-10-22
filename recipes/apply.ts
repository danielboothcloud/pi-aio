// ---------------------------------------------------------------------------
// recipes/apply — the in-process application engine.
//
// The bridge (trampoline.ts) covers the two keys pi fixes before extensions
// run (extension set, enabled-model scope). Everything else a recipe declares
// is applied here, at session_start and on `/recipe` switches:
//
//   model / thinkingLevel -> pi.setModel + pi.setThinkingLevel
//   mcpServers           -> pi.registerMcpServer / unregisterMcpServer (ours only)
//
// The module keeps runtime state (active recipe, provenance, launch notice,
// recipes registered by this feature) with a test reset hook, and exports
// pure helpers (legacy context filter, restore scan) so tests can
// drive the engine without a live pi session.
// ---------------------------------------------------------------------------

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
import type { RecipeFileTrust } from "./trust.js";

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
	| "directory" // the cwd's .pi-recipe defaultRecipe on a fresh startup
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
	/** Trust of the cwd's `.pi-recipe` (current contents) at the last reload. */
	directoryTrust: RecipeFileTrust | undefined;
	/** The `.pi-recipe` trust question (or its hint) is raised once per process. */
	directoryAsked: boolean;
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
		directoryTrust: undefined,
		directoryAsked: false,
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
// Pure helpers: context filter + restore scan
// ---------------------------------------------------------------------------

/** Strip legacy recipe instructions from resumed/forked sessions. */
export function filterRecipeContext(
	messages: AgentMessage[],
): AgentMessage[] | undefined {
	const filtered = messages.filter(
		(message) =>
			(message as AgentMessage & { customType?: string }).customType !== RECIPE_CONTEXT_TYPE,
	);
	return filtered.length === messages.length ? undefined : filtered;
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
	/** Key names applied (subset of model | thinking | mcp). */
	applied: string[];
	/** Warnings raised; never fatal. */
	warnings: string[];
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

/** Clear the active recipe: status and this feature's MCP servers. */
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
