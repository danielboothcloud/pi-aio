// ---------------------------------------------------------------------------
// recipes — named launch configurations for pi (`--recipe`, `/recipe`).
//
// A recipe bundles the pi settings a user swaps between contexts (work vs
// home subscriptions and models, extension sets, MCP servers) behind one name
// in `<agent-dir>/aio-recipes.json`.
//
// Two engines cooperate:
//
//   trampoline.ts — the relaunch bridge: recipes with restart-scoped keys
//     (extension set, enabled-model scope) restart pi once at factory time
//     with the recipe translated onto pi's own CLI flags, before the TUI or
//     session exist. Runs in the factory, holds the parent while the
//     replacement owns the terminal, and exits with its exit code.
//
//   apply.ts — the in-process engine: model, thinking, MCP servers,
//     and the status pill apply at session_start and
//     on /recipe switches without restarts.
//
// Selection precedence at session_start: --recipe flag > AIO_RECIPE_ACTIVE
// (set on a bridged relaunch child) > the session's persisted recipe-state
// entry (resume) > defaultRecipe on a fresh startup. A trusted `.pi-recipe`
// (or `.pi-recipe.json`) in the cwd supplies the highest-priority default
// and is bridged like --recipe. Each version of that file must be trusted
// explicitly (trust.ts: asked on the terminal before launch, remembered by
// content hash); `/recipe init` scaffolds one; its relaunch marks AIO_RECIPE_ORIGIN=directory
// so the child still treats it as a default, not an override. Subagent children
// register only legacy instruction cleanup and status rendering: their
// workloads are pinned by the parent.
//
// Registration order: recipes registers FIRST in the AIO composition so its
// session_start establishes the baseline recipe state before other features.
// It owns no tool names and gates nothing.
// ---------------------------------------------------------------------------

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { setFrameMetadataContributor } from "../frame/protocol.js";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	ACTIVE_RECIPE_ENV,
	DIRECTORY_RECIPE_FILE_NAMES,
	RECIPES_FILE_NAME,
	RECIPE_FLAG,
	RECIPE_ORIGIN_ENV,
	RECIPE_STAGE_ENV,
	THINKING_LEVELS,
	directoryRecipesPath,
	isRestartScoped,
	loadRecipes,
	parseModelSpec,
	type RecipeConfig,
	type RecipeDefinition,
} from "./config.js";
import {
	TRUST_CHOICE_LABELS,
	forgetRecipeFileTrust,
	promptRecipeTrust,
	recipeFileTrust,
	recordRecipeFileTrust,
	trustPromptTitle,
	type TrustChoice,
} from "./trust.js";
import {
	applyRecipe,
	deactivateRecipe,
	filterRecipeContext,
	latestPersistedRecipe,
	recipeRuntime,
	RECIPE_FRAME_CONTRIBUTOR,
	type ApplyRecipeResult,
	type RecipeSourceMarker,
} from "./apply.js";
import {
	AIO_RECIPE_EXTENSION_PATH,
	SUBAGENT_CHILD_ENV,
	canPromptAtLaunch,
	cliArgsFromArgv,
	decideRelaunch,
	execRelaunch,
	relaunchNotice,
} from "./trampoline.js";

import { registerRecipeStatusRenderer, showRecipeStatus } from "./status.js";
import { continuedRecipeForLaunch } from "./continue.js";

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
	if (isRestartScoped(def.config) && !bridgedRecipe(def.name)) {
		const next =
			source === "directory"
				? "the next fresh `pi` start in this folder"
				: `the next \`pi --recipe "${def.name}"\` start`;
		notify(
			ctx,
			`"${def.name}" also scopes the extension set and enabled models — they apply fully on ${next}`,
			"info",
		);
	}
}

/** True in a relaunched child whose extension set/model scope came from this recipe. */
function bridgedRecipe(name: string): boolean {
	return (
		process.env[RECIPE_STAGE_ENV] === "1" && process.env[ACTIVE_RECIPE_ENV]?.trim() === name
	);
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
	const state = recipeRuntime();
	const file = directoryRecipesPath(ctx.cwd);
	state.directoryTrust = file
		? recipeFileTrust(file, { cliArgs: cliArgsFromArgv(process.argv) })
		: undefined;
	state.recipes = loadRecipes(ctx.cwd, {
		projectTrusted: ctx.isProjectTrusted(),
		directoryTrusted: state.directoryTrust === "trusted",
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Start a freshly trusted `.pi-recipe` default unless a recipe is already active. */
async function activateDirectoryDefault(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	fileName: string,
): Promise<void> {
	const state = recipeRuntime();
	const name = state.recipes.defaultSource === "directory" ? state.recipes.defaultRecipe : undefined;
	const def = name ? state.recipes.recipes[name] : undefined;
	if (!name || !def) {
		notify(ctx, `${fileName} is trusted; its recipes are available in /recipe (no valid defaultRecipe)`, "info");
		return;
	}
	if (state.activeName) {
		notify(
			ctx,
			`${fileName} is trusted; "${name}" starts automatically on the next fresh \`pi\` here (active recipe "${state.activeName}" unchanged — /recipe ${name} switches now)`,
			"info",
		);
		return;
	}
	const result = await applyRecipe(pi, ctx, def, { source: "directory", persist: true });
	notifyActivation(ctx, def, result, "directory");
}

/** `/recipe trust`: trust the `.pi-recipe` as it is now and start its default. */
async function trustDirectoryRecipe(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const file = recipeRuntime().recipes.directoryFile;
	if (!file) {
		notify(ctx, `No ${DIRECTORY_RECIPE_FILE_NAMES.join(" or ")} in ${ctx.cwd} — /recipe init creates one`, "info");
		return;
	}
	const fileName = basename(file);
	try {
		recordRecipeFileTrust(file, true);
	} catch (error) {
		notify(ctx, `recipes: could not save trust for ${file}: ${errorText(error)}`, "error");
		return;
	}
	refreshRecipes(ctx);
	if (recipeRuntime().directoryTrust !== "trusted") {
		notify(ctx, `Trusted ${fileName}, but --no-approve skips it for this run; it applies on the next start`, "warning");
		return;
	}
	await activateDirectoryDefault(pi, ctx, fileName);
}

/** `/recipe untrust`: forget the decision; the next start asks again. */
function untrustDirectoryRecipe(ctx: ExtensionContext): void {
	const file = recipeRuntime().recipes.directoryFile;
	if (!file) {
		notify(ctx, `No ${DIRECTORY_RECIPE_FILE_NAMES.join(" or ")} in ${ctx.cwd}`, "info");
		return;
	}
	try {
		const forgot = forgetRecipeFileTrust(file);
		refreshRecipes(ctx);
		notify(
			ctx,
			forgot
				? `Forgot the trust decision for ${basename(file)} — the next start asks again (the active recipe stays for this session)`
				: `${basename(file)} has no saved trust decision`,
			"info",
		);
	} catch (error) {
		notify(ctx, `recipes: could not update trust for ${file}: ${errorText(error)}`, "error");
	}
}

/** Session-side trust question (RPC, or a TUI whose launch could not ask). */
async function askDirectoryTrust(pi: ExtensionAPI, ctx: ExtensionContext, file: string): Promise<void> {
	const order: TrustChoice[] = ["trust", "skip", "deny"];
	const labels = order.map((choice) => TRUST_CHOICE_LABELS[choice]);
	const picked = await ctx.ui.select(trustPromptTitle(file), labels);
	const choice = order[labels.indexOf(picked ?? "")] ?? "skip";
	if (choice === "skip") return;
	recordRecipeFileTrust(file, choice === "trust");
	refreshRecipes(ctx);
	if (choice === "trust") await activateDirectoryDefault(pi, ctx, basename(file));
}

// -- /recipe init -------------------------------------------------------------

/** `/recipe <word>` subcommands; a recipe literally named one keeps switching. */
const RESERVED_NAMES = new Set(["off", "none", "status", "trust", "untrust", "init"]);
const RECIPE_NAME = /^[A-Za-z0-9][\w.-]*$/;

export function suggestRecipeName(cwd: string): string {
	const base = basename(cwd)
		.toLowerCase()
		.replace(/[^\w.-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "");
	return base && !RESERVED_NAMES.has(base) ? base : "project";
}

/** The `.pi-recipe` scaffold: every key present, empty values are no-ops. */
export function recipeScaffold(
	name: string,
	seed: { description?: string; model?: string; thinkingLevel?: string } = {},
	template?: Partial<RecipeConfig>,
): string {
	const recipe: Record<string, unknown> = {
		description: template?.description ?? seed.description ?? `Recipe for ${name}`,
	};
	const model = template ? template.model : seed.model;
	const thinkingLevel = template ? template.thinkingLevel : seed.thinkingLevel;
	if (model) recipe.model = model;
	if (thinkingLevel) recipe.thinkingLevel = thinkingLevel;
	// An empty `models` means "no scope": pi falls back to settings.json
	// enabledModels, so other models stay selectable. Scope the scaffold to
	// its own model so the file alone decides what is available.
	const models = template?.models?.length
		? template.models
		: model
			? [parseModelSpec(model).model]
			: [];
	Object.assign(recipe, {
		models,
		mcpServers: template?.mcpServers ?? {},
		extensions: template?.extensions ?? [],
	});
	return `${JSON.stringify({ defaultRecipe: name, recipes: { [name]: recipe } }, null, 2)}\n`;
}

function validRecipeName(name: string): boolean {
	return RECIPE_NAME.test(name) && !RESERVED_NAMES.has(name.toLowerCase());
}

function notifyInvalidName(ctx: ExtensionContext, name: string): void {
	notify(
		ctx,
		`Invalid recipe name "${name}" — use letters, digits, ".", "_" or "-" (not ${[...RESERVED_NAMES].join("/")})`,
		"error",
	);
}

/** Parse `init [name] [--from <recipe>]`. */
export function parseInitArgs(arg: string): { name: string; from?: string; error?: string } {
	const tokens = arg.trim().split(/\s+/).filter(Boolean);
	let from: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "--from") {
			from = tokens[++i];
			if (!from) return { name: "", error: "--from needs one of your recipe names" };
		} else if (token.startsWith("--from=")) {
			from = token.slice("--from=".length);
		} else {
			rest.push(token);
		}
	}
	return { name: rest.join(" "), from };
}

/** Recipes in the user's home (global) file — the templates `/recipe init` offers. */
function homeRecipes(): Record<string, RecipeDefinition> {
	return loadRecipes(undefined).recipes;
}

async function initDirectoryRecipe(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	arg: string,
): Promise<void> {
	const existing = directoryRecipesPath(ctx.cwd);
	if (existing) {
		notify(ctx, `${basename(existing)} already exists in ${ctx.cwd} — edit it, or delete it to start over`, "warning");
		return;
	}
	// A `.pi-recipe` is portable: it always carries its own full recipe
	// definition — a home recipe can seed it as a template (copied), but it
	// never references the user's global recipes.
	const parsed = parseInitArgs(arg);
	if (parsed.error) {
		notify(ctx, `recipes: ${parsed.error}`, "error");
		return;
	}
	if (parsed.name && !validRecipeName(parsed.name)) {
		notifyInvalidName(ctx, parsed.name);
		return;
	}
	const templates = homeRecipes();
	let template: RecipeDefinition | undefined;
	if (parsed.from) {
		template = templates[parsed.from];
		if (!template) {
			const names = Object.keys(templates).sort().join(", ") || "none configured";
			notify(ctx, `Unknown home recipe "${parsed.from}". Available: ${names}`, "error");
			return;
		}
	} else if (ctx.hasUI && Object.keys(templates).length > 0) {
		const { names, labels } = selectionLabels(templates);
		const blank = "Blank recipe (current model)";
		const choice = await ctx.ui.select("Create .pi-recipe — start from:", [
			blank,
			...labels.map((label) => `Copy ${label}`),
		]);
		if (!choice) return;
		if (choice !== blank) {
			template = templates[names[labels.indexOf(choice.slice("Copy ".length))] ?? ""];
		}
	}

	const suggestion = suggestRecipeName(ctx.cwd);
	let name = parsed.name;
	if (!name && ctx.hasUI) {
		const typed = await ctx.ui.input("Recipe name for this folder's .pi-recipe", suggestion);
		if (typed === undefined) return;
		name = typed.trim();
	}
	if (!name) name = suggestion;
	if (!validRecipeName(name)) {
		notifyInvalidName(ctx, name);
		return;
	}

	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const level = pi.getThinkingLevel();
	const content = recipeScaffold(
		name,
		{
			description: `Recipe for ${basename(ctx.cwd) || name}`,
			model,
			thinkingLevel: THINKING_LEVELS.includes(level) ? level : undefined,
		},
		template ? structuredClone(template.config) : undefined,
	);
	const file = join(ctx.cwd, DIRECTORY_RECIPE_FILE_NAMES[0] ?? ".pi-recipe");
	try {
		writeFileSync(file, content, { encoding: "utf-8", flag: "wx" });
	} catch (error) {
		notify(ctx, `recipes: could not create ${file}: ${errorText(error)}`, "error");
		return;
	}
	// You created it yourself: this exact version is trusted.
	let trusted = true;
	try {
		recordRecipeFileTrust(file, true);
	} catch {
		trusted = false;
	}
	refreshRecipes(ctx);
	const trustNote = trusted ? "trusted" : "trust not saved — run /recipe trust";
	const seeded = template
		? `copied from your "${template.name}" recipe`
		: "seeded from the current model";
	notify(
		ctx,
		`Created ${file} with recipe "${name}" ${seeded} (${trustNote}). Fill in the fields you need; after you edit it, the next start asks once to trust the new version. /recipe ${name} switches now.`,
		"info",
	);
	if (template && Object.keys(template.config.mcpServers).length > 0) {
		notify(
			ctx,
			`${basename(file)} includes MCP server configs copied verbatim from "${template.name}" — remove any tokens or headers before committing it`,
			"warning",
		);
	}
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
	const messages = filterRecipeContext(event.messages);
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
	exitOnInvalidScope: (code: number) => never,
): Promise<void> {
	const state = recipeRuntime();
	refreshRecipes(ctx);

	// A new or changed `.pi-recipe` the launch could not ask about (RPC,
	// print/JSON, an unusual TTY setup): ask through the session UI without
	// blocking startup, or leave a one-line hint where no UI exists.
	const directoryFile = state.recipes.directoryFile;
	if (
		directoryFile &&
		state.directoryTrust === "unknown" &&
		event.reason === "startup" &&
		!state.directoryAsked
	) {
		state.directoryAsked = true;
		if (ctx.hasUI) {
			void askDirectoryTrust(pi, ctx, directoryFile).catch((error: unknown) => {
				notify(ctx, `recipes: trust prompt failed: ${errorText(error)}`, "warning");
			});
		} else {
			process.stderr.write(
				`recipes: ${directoryFile} is new or changed and not trusted yet — skipped (run pi interactively, or /recipe trust)\n`,
			);
		}
	}

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
	// Directory defaults and --continue bridges must not outrank the branch
	// restored by an in-process /resume (including an explicit recipe off).
	const envName = process.env[ACTIVE_RECIPE_ENV]?.trim();
	const envIsDefault = process.env[RECIPE_ORIGIN_ENV] === "directory";
	const envIsSession = process.env[RECIPE_ORIGIN_ENV] === "session";
	if (name === undefined && envName && !envIsDefault && !envIsSession) {
		name = envName;
		source = "env";
	}
	if (name === undefined) {
		const persisted = persistedRecipeFor(ctx);
		if (persisted.present) {
			name = persisted.name;
			source = "session";
		}
	}
	if (name === undefined && source === undefined && event.reason === "startup") {
		if (envName && envIsDefault) {
			name = envName;
			source = "directory";
		} else if (state.recipes.defaultRecipe) {
			name = state.recipes.defaultRecipe;
			source = state.recipes.defaultSource === "directory" ? "directory" : "default";
		}
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
	// Pi interprets an empty resolved scope as "all models". A missing
	// provider or stale catalog must not silently turn a scoped startup into
	// an unrestricted session. Check the actual CLI scope (including explicit
	// --models overrides), not just the recipe's configured patterns.
	const requestedModels = parseArgs(process.argv.slice(2)).models;
	if (event.reason === "startup" && requestedModels?.length && !ctx.scopedModels?.length) {
		deactivateRecipe(pi, ctx, { persist: false });
		const message = `Recipe "${name}": no available models matched ${requestedModels.join(", ")}. Check that its provider extension loaded, authentication is available, and the model ID exists in its catalog. Stopping instead of enabling all models.`;
		notify(ctx, message, "error");
		process.stderr.write(`recipes: ${message}\n`);
		// ctx.shutdown() is only a deferred request in TUI/RPC and is ignored
		// by print mode. A startup configuration error must stop BEFORE any
		// supplied prompt can reach the fallback provider, in every mode.
		exitOnInvalidScope(1);
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

export async function registerRecipes(
	pi: ExtensionAPI,
	options: {
		exitOnInvalidScope?: (code: number) => never;
		/** Test seam: the before-launch terminal trust question. */
		promptTrust?: (file: string) => Promise<TrustChoice>;
		/** Test seam: whether this launch may ask on the terminal. */
		interactiveLaunch?: boolean;
	} = {},
): Promise<void> {
	const exitOnInvalidScope = options.exitOnInvalidScope ?? ((code: number): never => process.exit(code));
	pi.registerFlag(RECIPE_FLAG, {
		description:
			"Start with a named recipe from aio-recipes.json (extensions, model scope, MCP)",
		type: "string",
	});

	// Old sessions may contain recipe instruction messages. Strip them in
	// every process, including forked children, even when a recipe is active.
	pi.on("context", recipeContextHandler);
	registerRecipeStatusRenderer(pi);

	// Everything below is interactive-session surface; children are pinned
	// workloads whose agent config owns model, thinking, and tools.
	if (isSubagentChild()) {
		pi.on("session_shutdown", clearFramePill);
		return;
	}

	// ---- Factory-time relaunch bridge: only recipes with restart-scoped
	// keys reach the relaunch at all, and the decision sees the global file
	// plus a `.pi-recipe` whose current contents were explicitly trusted
	// (trust.ts) — pi's project trust is not resolved while extension
	// factories run, so `.pi/aio-recipes.json` is never consulted. A new or
	// changed `.pi-recipe` is asked about HERE, on the terminal, before the
	// TUI starts, so a just-trusted restart-scoped recipe can still relaunch.
	let launchNotice: string | undefined;
	try {
		const launchCwd = process.cwd();
		const launchFile = directoryRecipesPath(launchCwd);
		let launchTrust = launchFile
			? recipeFileTrust(launchFile, { cliArgs: cliArgsFromArgv(process.argv) })
			: undefined;
		const interactive =
			options.interactiveLaunch ??
			canPromptAtLaunch({
				argv: process.argv,
				env: process.env,
				stdinIsTTY: process.stdin.isTTY === true,
				stdoutIsTTY: process.stdout.isTTY === true,
			});
		if (launchFile && launchTrust === "unknown" && interactive) {
			recipeRuntime().directoryAsked = true;
			const choice = await (options.promptTrust ?? promptRecipeTrust)(launchFile);
			if (choice !== "skip") {
				try {
					recordRecipeFileTrust(launchFile, choice === "trust");
				} catch (error) {
					process.stderr.write(`recipes: could not save trust for ${launchFile}: ${errorText(error)}\n`);
				}
			}
			if (choice === "trust") launchTrust = "trusted";
		}
		const launch = loadRecipes(launchCwd, {
			projectTrusted: false,
			directoryTrusted: launchTrust === "trusted",
		});
		const decision = decideRelaunch({
			argv: process.argv,
			command: process.execPath,
			env: { ...process.env },
			recipes: launch.recipes,
			directoryRecipe: launch.defaultSource === "directory" ? launch.defaultRecipe : undefined,
			continuedRecipe: continuedRecipeForLaunch({
				argv: process.argv, env: process.env, cwd: launchCwd,
			}),
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
			await sessionStart(pi, event, ctx, exitOnInvalidScope);
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

	pi.registerCommand("recipe", {
		description:
			"Show, switch, or clear the active launch recipe (aio-recipes.json); init/trust/untrust manage this folder's .pi-recipe",
		getArgumentCompletions: (prefix) => {
			// `init [name] --from <home recipe>`: complete the template name.
			const fromMatch = /^(init\b.*--from\s+)(\S*)$/.exec(prefix.trimStart());
			if (fromMatch) {
				const [, head = "", partial = ""] = fromMatch;
				const options = Object.entries(homeRecipes())
					.filter(([name]) => name.startsWith(partial))
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, def]) => ({
						label: name,
						value: `${head}${name}`,
						description: def.config.description?.trim() || "home recipe template",
					}));
				return options.length > 0 ? options : null;
			}
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
			const runtime = recipeRuntime();
			const file = runtime.recipes.directoryFile;
			const subcommands: Array<[string, boolean, string]> = [
				["init", !file, "create a .pi-recipe for this folder"],
				["trust", file !== undefined && runtime.directoryTrust !== "trusted", "trust this folder's .pi-recipe and start its default"],
				["untrust", file !== undefined && runtime.directoryTrust !== "unknown", "forget the .pi-recipe trust decision"],
			];
			for (const [word, offered, description] of subcommands) {
				if (offered && word.startsWith(wanted) && !runtime.recipes.recipes[word]) {
					items.push({ label: word, value: word, description });
				}
			}
			if ("status".startsWith(wanted) && !recipeRuntime().recipes.recipes.status) {
				items.push({ label: "status", value: "status", description: "inspect actual runtime (no model request)" });
			}
			if (wanted.startsWith("status ") && "status --json".startsWith(wanted)) {
				items.push({ label: "status --json", value: "status --json", description: "runtime report as JSON" });
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			refreshRecipes(ctx);
			const state = recipeRuntime();
			const requested = (args ?? "").trim();
			if ((requested === "status" || requested === "status --json") && !state.recipes.recipes[requested]) {
				showRecipeStatus(pi, ctx, { format: requested.endsWith("--json") ? "json" : "text" });
				return;
			}
			// Like `status`, a recipe literally named trust/untrust/init keeps switching.
			if (!state.recipes.recipes[requested]) {
				if (requested === "trust") {
					await trustDirectoryRecipe(pi, ctx);
					return;
				}
				if (requested === "untrust") {
					untrustDirectoryRecipe(ctx);
					return;
				}
				if (requested === "init" || requested.startsWith("init ")) {
					await initDirectoryRecipe(pi, ctx, requested.slice("init".length));
					return;
				}
			}

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
						"Recipe: off — MCP servers cleared; model keeps its current state",
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
					"Recipe: off — MCP servers cleared; model keeps its current state",
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

	// Dedicated spelling stays available even when a user named a recipe
	// "status"; the existing /recipe <name> behavior remains compatible.
	pi.registerCommand("recipe-status", {
		description: "Inspect actual recipe runtime, model scope, tools, and registration sources (no model request)",
		getArgumentCompletions: (prefix) => "--json".startsWith(prefix.trim())
			? [{ label: "--json", value: "--json", description: "runtime report as JSON" }]
			: null,
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value && value !== "--json") {
				notify(ctx, "Use /recipe-status [--json]", "error");
				return;
			}
			showRecipeStatus(pi, ctx, { format: value === "--json" ? "json" : "text" });
		},
	});

	pi.on("session_shutdown", clearFramePill);
}
