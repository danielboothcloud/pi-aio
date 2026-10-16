// ---------------------------------------------------------------------------
// recipes — named launch configurations for pi (`--recipe`, `/recipe`).
//
// A recipe bundles the pi settings a user swaps between contexts (work vs
// home subscriptions and models, extension sets, tools, MCP servers, skills,
// instructions) behind one name in `<agent-dir>/aio-recipes.json`.
//
// Two engines cooperate:
//
//   trampoline.ts — the relaunch bridge: recipes with restart-scoped keys
//     (extension set, enabled-model scope) restart pi once at factory time
//     with the recipe translated onto pi's own CLI flags, before the TUI or
//     session exist. Runs in the factory, holds the parent while the
//     replacement owns the terminal, and exits with its exit code.
//
//   apply.ts — the in-process engine: model, thinking, tools, MCP servers,
//     per-turn instructions, and the status pill apply at session_start and
//     on /recipe switches without restarts.
//
// Selection precedence at session_start: --recipe flag > AIO_RECIPE_ACTIVE
// (set on a bridged relaunch child) > the session's persisted recipe-state
// entry (resume) > defaultRecipe on a fresh startup. Subagent children
// register nothing but the inherited-instruction filter: their workloads are
// pinned by the parent.
//
// Registration order: recipes registers FIRST in the AIO composition so its
// session_start establishes the baseline tool set before permission-modes
// snapshots passive-mode restrictions. It owns no tool names and gates
// nothing.
// ---------------------------------------------------------------------------

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { setFrameMetadataContributor } from "../frame/protocol.js";
import {
	ACTIVE_RECIPE_ENV,
	RECIPES_FILE_NAME,
	RECIPE_CONTEXT_TYPE,
	RECIPE_FLAG,
	isRestartScoped,
	loadRecipes,
	type RecipeDefinition,
} from "./config.js";
import {
	activeRecipe,
	applyRecipe,
	buildRecipeContext,
	deactivateRecipe,
	filterRecipeContext,
	latestPersistedRecipe,
	recipeRuntime,
	RECIPE_FRAME_CONTRIBUTOR,
	resolveRecipePaths,
	type ApplyRecipeResult,
	type RecipeSourceMarker,
} from "./apply.js";
import {
	AIO_RECIPE_EXTENSION_PATH,
	SUBAGENT_CHILD_ENV,
	decideRelaunch,
	execRelaunch,
	relaunchNotice,
} from "./trampoline.js";

function isSubagentChild(): boolean {
	return process.env[SUBAGENT_CHILD_ENV] === "1";
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Notification must never break activation.
	}
}

/** One activation notice summarizing what applied and what still needs a restart. */
function notifyActivation(
	ctx: ExtensionContext,
	def: RecipeDefinition,
	result: ApplyRecipeResult,
	source: RecipeSourceMarker,
): void {
	const bits = result.applied.length > 0 ? ` — applied: ${result.applied.join(", ")}` : "";
	let text = `Recipe "${def.name}" active${bits}`;
	if (result.warnings.length > 0) text += `; ${result.warnings.join("; ")}`;
	notify(ctx, text, result.warnings.length > 0 ? "warning" : "info");
	if (isRestartScoped(def.config) && source !== "env") {
		notify(
			ctx,
			`"${def.name}" also scopes the extension set and enabled models — they apply fully on the next \`pi --recipe "${def.name}"\` start`,
			"info",
		);
	}
}

function selectionLabels(
	defs: Record<string, RecipeDefinition>,
): { names: string[]; labels: string[] } {
	const names = Object.keys(defs).sort((a, b) => a.localeCompare(b));
	const labels = names.map((name) => {
		const description = defs[name]?.config.description?.trim();
		if (!description) return name;
		const short = description.length > 42 ? `${description.slice(0, 39)}...` : description;
		return `${name} — ${short}`;
	});
	return { names, labels };
}

function availableNamesText(): string {
	const names = Object.keys(recipeRuntime().recipes.recipes).sort((a, b) =>
		a.localeCompare(b),
	);
	return names.length > 0 ? names.join(", ") : "none configured";
}

/** Reload the recipes for the session cwd (fresh pick for every command run). */
function refreshRecipes(ctx: ExtensionContext): void {
	recipeRuntime().recipes = loadRecipes(ctx.cwd, {
		projectTrusted: ctx.isProjectTrusted(),
	});
}

/** Switch the live session onto a recipe (the /recipe command path). */
async function switchRecipe(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: string,
): Promise<void> {
	// Reload on every switch: the user may have edited aio-recipes.json since
	// the session started, and a mid-session switch should honor it.
	refreshRecipes(ctx);
	const def = recipeRuntime().recipes.recipes[name];
	if (!def) {
		notify(ctx, `Unknown recipe "${name}". Available: ${availableNamesText()}`, "error");
		return;
	}
	const result = await applyRecipe(pi, ctx, def, { source: "command", persist: true });
	notifyActivation(ctx, def, result, "command");
}

function clearFramePill(): void {
	setFrameMetadataContributor(RECIPE_FRAME_CONTRIBUTOR, undefined);
}

// -- Context filter -----------------------------------------------------------

interface ContextFilterEvent {
	messages: AgentMessage[];
}

function recipeContextHandler(
	event: ContextFilterEvent,
): { messages: AgentMessage[] } | undefined {
	const messages = filterRecipeContext(event.messages, recipeRuntime().activeName);
	return messages ? { messages } : undefined;
}

// -- session_start ------------------------------------------------------------

function persistedRecipeFor(
	ctx: ExtensionContext,
): { name: string | undefined; present: boolean } {
	try {
		return latestPersistedRecipe(ctx.sessionManager.getBranch());
	} catch {
		return { name: undefined, present: false };
	}
}

async function sessionStart(
	pi: ExtensionAPI,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const state = recipeRuntime();
	refreshRecipes(ctx);

	if (state.launchNotice && !state.launchNoticeFired) {
		state.launchNoticeFired = true;
		// The bridge already wrote this to stderr; the session gets the same
		// story once, as a visible warning.
		notify(ctx, state.launchNotice, "warning");
	}

	// Selection precedence: flag > bridge env > session entry > startup default.
	let name: string | undefined;
	let source: RecipeSourceMarker | undefined;
	const flag = pi.getFlag(RECIPE_FLAG);
	if (typeof flag === "string" && flag.trim()) {
		name = flag.trim();
		source = "flag";
	} else if (flag === true) {
		notify(ctx, "recipes: --recipe needs a recipe name (see /recipe)", "warning");
	}
	if (name === undefined) {
		const envName = process.env[ACTIVE_RECIPE_ENV]?.trim();
		if (envName) {
			name = envName;
			source = "env";
		}
	}
	if (name === undefined) {
		const persisted = persistedRecipeFor(ctx);
		if (persisted.present) {
			name = persisted.name;
			source = "session";
		}
	}
	if (name === undefined && event.reason === "startup" && state.recipes.defaultRecipe) {
		name = state.recipes.defaultRecipe;
		source = "default";
	}

	if (name === undefined) {
		deactivateRecipe(pi, ctx, { persist: false });
		return;
	}
	const def = state.recipes.recipes[name];
	if (!def) {
		deactivateRecipe(pi, ctx, { persist: false });
		notify(ctx, `Unknown recipe "${name}". Available: ${availableNamesText()}`, "warning");
		return;
	}
	const result = await applyRecipe(pi, ctx, def, {
		source: source ?? "session",
		persist: source !== "session",
	});
	notifyActivation(ctx, def, result, source ?? "session");
}

/** Tree navigation re-resolves the recipe from the branch's own entries. */
async function restoreFromBranch(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const state = recipeRuntime();
	const persisted = persistedRecipeFor(ctx);
	const name = persisted.present ? persisted.name : undefined;
	if (!name) {
		deactivateRecipe(pi, ctx, { persist: false });
		return;
	}
	const def = state.recipes.recipes[name];
	if (!def) {
		deactivateRecipe(pi, ctx, { persist: false });
		return;
	}
	await applyRecipe(pi, ctx, def, { source: "session", persist: false });
}

// -- registration -------------------------------------------------------------

export async function registerRecipes(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag(RECIPE_FLAG, {
		description:
			"Start with a named recipe from aio-recipes.json (extensions, model scope, tools, MCP, skills)",
		type: "string",
	});

	// The context filter is registered in every process (subagent children
	// included): a forked child inherits the parent's history, and with no
	// active recipe of its own this strips the parent's recipe instructions
	// out of its context — the same contract /style keeps.
	pi.on("context", recipeContextHandler);

	// Everything below is interactive-session surface; children are pinned
	// workloads whose agent config owns model, thinking, and tools.
	if (isSubagentChild()) {
		pi.on("session_shutdown", clearFramePill);
		return;
	}

	// ---- Factory-time relaunch bridge: only recipes with restart-scoped
	// keys reach the relaunch at all, and the decision sees the global file
	// only — project trust is not resolved while extension factories run,
	// so launch decisions never depend on untrusted project files.
	let launchNotice: string | undefined;
	try {
		const decision = decideRelaunch({
			argv: process.argv,
			command: process.execPath,
			env: { ...process.env },
			recipes: loadRecipes(process.cwd(), { projectTrusted: false }).recipes,
			aioExtensionPath: AIO_RECIPE_EXTENSION_PATH,
		});
		if (decision.action === "relaunch") {
			process.stderr.write(`${relaunchNotice(decision.spec)}\n`);
			const tookOver = await execRelaunch(decision.spec);
			if (!tookOver) {
				launchNotice = `recipe "${decision.spec.recipeName}" relaunch failed — continuing in-session; extension set and model scope stay unchanged`;
			}
		} else if (decision.action === "session-apply" && decision.note) {
			launchNotice = decision.note;
		}
		// "unknown-recipe" and the sessionless guards need no factory-time
		// story: the flag survives to session_start, which reports there.
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		launchNotice = `recipe bridge skipped (${message}) — continuing in-session`;
	}
	recipeRuntime().launchNotice = launchNotice;

	pi.on("session_start", async (event, ctx) => {
		try {
			await sessionStart(pi, event, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `recipes: session activation failed: ${message}`, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			await restoreFromBranch(pi, ctx);
		} catch {
			// Tree restore is best-effort; the pill and MCP state reset even
			// when the apply path fails mid-flight.
			deactivateRecipe(pi, ctx, { persist: false });
		}
	});

	pi.on("resources_discover", async () => {
		const def = activeRecipe();
		if (!def) return undefined;
		const paths = resolveRecipePaths(def);
		if (
			paths.skillPaths.length + paths.promptPaths.length + paths.themePaths.length ===
			0
		) {
			return undefined;
		}
		return paths;
	});

	pi.on("before_agent_start", async () => {
		const def = activeRecipe();
		if (!def?.config.instructions) return undefined;
		return {
			message: {
				customType: RECIPE_CONTEXT_TYPE,
				content: buildRecipeContext(def.name, def.config.instructions),
				display: false,
			},
		};
	});

	pi.registerCommand("recipe", {
		description: "Show, switch, or clear the active launch recipe (aio-recipes.json)",
		getArgumentCompletions: (prefix) => {
			const wanted = prefix.trim().toLowerCase();
			const entries = Object.entries(recipeRuntime().recipes.recipes);
			const items: Array<{ label: string; value: string; description: string }> = [];
			for (const [name, def] of entries) {
				if (!name.toLowerCase().startsWith(wanted)) continue;
				items.push({
					label: name,
					value: name,
					description: def.config.description?.trim() || "named launch recipe",
					});
			}
			items.sort((a, b) => a.label.localeCompare(b.label));
			if ("off".startsWith(wanted)) {
				items.push({
					label: "off",
					value: "off",
					description: "clear the active recipe",
				});
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			refreshRecipes(ctx);
		const state = recipeRuntime();
		const requested = (args ?? "").trim();

			if (!requested) {
				const defs = state.recipes.recipes;
				if (Object.keys(defs).length === 0) {
					notify(
						ctx,
						`No recipes configured. Add them to \`<agent-dir>/${RECIPES_FILE_NAME}\` (see the recipes README section)`,
						"info",
					);
					return;
				}
				if (!ctx.hasUI) {
					notify(
						ctx,
						`Recipe: ${state.activeName ?? "none"} — available: ${availableNamesText()}`,
						"info",
					);
					return;
				}
				const { names, labels } = selectionLabels(defs);
				const choice = await ctx.ui.select(
					`Recipe: ${state.activeName ?? "none"} — switch to:`,
					[...labels, "off — clear the active recipe"],
				);
				if (!choice) return;
				if (choice.startsWith("off — ")) {
					deactivateRecipe(pi, ctx, { persist: true });
					notify(
						ctx,
						"Recipe: off — instructions and MCP servers cleared; model and tools keep their current state",
						"info",
					);
					return;
				}
				const picked = names[labels.indexOf(choice)];
				if (picked) await switchRecipe(pi, ctx, picked);
				return;
			}

			const normalized = requested.toLowerCase();
			if (normalized === "off" || normalized === "none") {
				deactivateRecipe(pi, ctx, { persist: true });
				notify(
					ctx,
					"Recipe: off — instructions and MCP servers cleared; model and tools keep their current state",
					"info",
				);
				return;
			}
			try {
				await switchRecipe(pi, ctx, requested);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `recipes: switch failed: ${message}`, "error");
			}
		},
	});

	pi.on("session_shutdown", clearFramePill);
}
