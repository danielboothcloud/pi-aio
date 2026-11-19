// ---------------------------------------------------------------------------
// recipes/add-command — `/recipe add <key>` and `/recipe remove <key>`.
//
// Edits the ACTIVE recipe in the file that defines it (edit.ts resolves and
// writes), after an explicit confirm naming the file and the change. Then it
// re-applies the recipe the way a live `/recipe <name>` switch does, and for
// restart-scoped keys reuses the /resume relaunch (TUI only; RPC and PiG get
// an exact restart hint, never a competing process).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyRecipe, recipeRuntime } from "./apply.js";
import type { RecipeDefinition } from "./config.js";
import {
	KEY_CHOICES,
	RECIPE_EDIT_KEYS,
	applyRecipeEdit,
	extensionCandidates,
	mcpConfigFromInput,
	orderModelChoices,
	parseRecipeEditKey,
	rawRecipeEntry,
	readRecipeFileForEdit,
	recipeEditKeyInfo,
	recipeListValues,
	resolveRecipeEditTarget,
	writeRecipeFileAtomic,
	type RecipeEdit,
	type RecipeEditKey,
} from "./edit.js";
import { selectedSessionRelaunch, relaunchFromSession } from "./resume.js";
import { execRelaunch, relaunchNotice } from "./trampoline.js";
import { recordRecipeFileTrust } from "./trust.js";

export type RecipeEditAction = "add" | "remove";

export interface RecipeEditDeps {
	/** Reload recipes + `.pi-recipe` trust for the session cwd (index.ts refreshRecipes). */
	refresh: (ctx: ExtensionContext) => void;
	notify: (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error") => void;
	relaunch?: typeof execRelaunch;
}

const CUSTOM_MODEL = "Type a model spec…";
const CUSTOM_EXTENSION = "Type an extension source…";
const NEW_MCP = "New server (URL or command)…";
const DEFAULT_REASONING = "default (high)";

interface ModelLike {
	provider: string;
	id: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readGlobalSettings(): { settings: unknown; dir: string } | undefined {
	try {
		const dir = getAgentDir();
		return { settings: JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")), dir };
	} catch {
		return undefined;
	}
}

function availableModels(ctx: ExtensionContext): ModelLike[] {
	// SAFETY: narrowed slice of ModelRegistry; harnesses may omit either method.
	const registry = ctx.modelRegistry as unknown as {
		getAvailable?: () => ModelLike[];
		getModelsOfType?: (type: "chat") => readonly ModelLike[];
	} | undefined;
	try {
		const authed = registry?.getAvailable?.();
		if (authed && authed.length > 0) return authed;
	} catch {
		// Fall back to the catalog.
	}
	try {
		return [...(registry?.getModelsOfType?.("chat") ?? [])];
	} catch {
		return [];
	}
}

/** Ordered model picker; undefined when cancelled. */
async function pickModel(
	ctx: ExtensionContext,
	title: string,
	exclude: readonly string[] = [],
): Promise<string | undefined> {
	const settings = readGlobalSettings()?.settings as { enabledModels?: unknown } | undefined;
	const enabled = Array.isArray(settings?.enabledModels)
		? settings.enabledModels.filter((v): v is string => typeof v === "string")
		: [];
	const scoped = ((ctx.scopedModels ?? []) as Array<{ model?: ModelLike }>)
		.map((entry) => entry.model)
		.filter((model): model is ModelLike => !!model);
	const current = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const specs = orderModelChoices(availableModels(ctx), { current, enabled, scoped })
		.filter((spec) => !exclude.includes(spec));
	const currentSpec = current ? `${current.provider}/${current.id}` : undefined;
	const labels = specs.map((spec) => (spec === currentSpec ? `${spec} (current)` : spec));
	const choice = await ctx.ui.select(title, [...labels, CUSTOM_MODEL]);
	if (!choice) return undefined;
	if (choice === CUSTOM_MODEL) {
		const typed = await ctx.ui.input("Model spec (provider/id, glob patterns allowed in a scope)", "anthropic/claude-sonnet-4-5");
		return typed?.trim() || undefined;
	}
	return specs[labels.indexOf(choice)];
}

async function pickFrom(ctx: ExtensionContext, title: string, options: readonly string[]): Promise<string | undefined> {
	const choice = await ctx.ui.select(title, [...options]);
	return choice && options.includes(choice) ? choice : undefined;
}

/** MCP servers other recipes already define (the copy source), keyed by label. */
function otherRecipeMcp(name: string, existing: readonly string[]): Map<string, { server: string; config: Record<string, unknown> }> {
	const found = new Map<string, { server: string; config: Record<string, unknown> }>();
	for (const def of Object.values(recipeRuntime().recipes.recipes)) {
		if (def.name === name) continue;
		for (const [server, config] of Object.entries(def.config.mcpServers)) {
			if (existing.includes(server)) continue;
			found.set(`${server} — from recipe "${def.name}"`, {
				server,
				// SAFETY: McpServerConfig came from parsed JSON objects, so it is a plain record.
				config: structuredClone(config) as unknown as Record<string, unknown>,
			});
		}
	}
	return found;
}

async function buildAddEdit(
	ctx: ExtensionContext,
	recipe: string,
	key: RecipeEditKey,
	entry: Record<string, unknown>,
	notify: RecipeEditDeps["notify"],
): Promise<RecipeEdit | undefined> {
	const title = `Recipe "${recipe}" — `;
	switch (key) {
		case "model": {
			const value = await pickModel(ctx, `${title}set model:`);
			return value ? { action: "set", key, value } : undefined;
		}
		case "scope": {
			const value = await pickModel(ctx, `${title}add to model scope:`, recipeListValues(entry, "scope"));
			return value ? { action: "add", key, value } : undefined;
		}
		case "advisor": {
			const model = await pickModel(ctx, `${title}advisor model:`);
			if (!model) return undefined;
			const reasoning = await pickFrom(ctx, `${title}advisor reasoning:`, [DEFAULT_REASONING, ...KEY_CHOICES.reasoning]);
			if (!reasoning) return undefined;
			return { action: "set", key, value: reasoning === DEFAULT_REASONING ? model : `${model}:${reasoning}` };
		}
		case "thinking": {
			const value = await pickFrom(ctx, `${title}thinking level:`, KEY_CHOICES.thinking);
			return value ? { action: "set", key, value } : undefined;
		}
		case "style": {
			const value = await pickFrom(ctx, `${title}style:`, KEY_CHOICES.style);
			return value ? { action: "set", key, value } : undefined;
		}
		case "mode": {
			const value = await pickFrom(ctx, `${title}starting permission mode:`, KEY_CHOICES.mode);
			return value ? { action: "set", key, value } : undefined;
		}
		case "extension": {
			const global = readGlobalSettings();
			const existing = recipeListValues(entry, "extension");
			const candidates = global
				? extensionCandidates(global.settings, global.dir).filter((source) => !existing.includes(source))
				: [];
			const choice = await ctx.ui.select(`${title}add extension:`, [...candidates, CUSTOM_EXTENSION]);
			if (!choice) return undefined;
			let value: string | undefined = choice;
			if (choice === CUSTOM_EXTENSION) {
				value = (await ctx.ui.input("Extension source (npm:, git:, path, or a name in <agent-dir>/extensions)", "npm:"))?.trim();
			}
			return value ? { action: "add", key, value } : undefined;
		}
		case "mcp": {
			const copies = otherRecipeMcp(recipe, recipeListValues(entry, "mcp"));
			const choice = await ctx.ui.select(`${title}add MCP server:`, [...copies.keys(), NEW_MCP]);
			if (!choice) return undefined;
			const copy = copies.get(choice);
			if (copy) return { action: "add", key, value: copy.server, config: copy.config };
			const server = (await ctx.ui.input("MCP server name", "docs"))?.trim();
			if (!server) return undefined;
			if (!/^[\w.-]+$/.test(server)) {
				notify(ctx, `Invalid MCP server name "${server}" — use letters, digits, ".", "_" or "-"`, "error");
				return undefined;
			}
			const target = await ctx.ui.input(`URL or command line for "${server}"`, "https://example.com/mcp");
			const config = mcpConfigFromInput(target ?? "");
			return config ? { action: "add", key, value: server, config } : undefined;
		}
	}
}

async function buildRemoveEdit(
	ctx: ExtensionContext,
	recipe: string,
	key: RecipeEditKey,
	entry: Record<string, unknown>,
	notify: RecipeEditDeps["notify"],
): Promise<RecipeEdit | undefined> {
	const info = recipeEditKeyInfo(key);
	if (info.list) {
		const values = recipeListValues(entry, key);
		if (values.length === 0) {
			notify(ctx, `Recipe "${recipe}" has no ${info.field} entries to remove`, "info");
			return undefined;
		}
		const value = await pickFrom(ctx, `Recipe "${recipe}" — remove from ${info.field}:`, values);
		return value ? { action: "remove", key, value } : undefined;
	}
	const fields = key === "mode" ? ["permissionMode", "mode"] : [info.field];
	if (!fields.some((field) => entry[field] !== undefined)) {
		notify(ctx, `Recipe "${recipe}" does not set ${info.field}`, "info");
		return undefined;
	}
	return { action: "remove", key };
}

function restartHint(def: RecipeDefinition): string {
	return def.source === "directory" ? "the next fresh `pi` in this folder" : `the next \`pi --recipe "${def.name}"\``;
}

/** Restart-scoped change: reuse the /resume relaunch for this exact session file. */
async function applyRestartScoped(
	ctx: ExtensionContext,
	def: RecipeDefinition,
	deps: RecipeEditDeps,
): Promise<void> {
	const file = ctx.sessionManager.getSessionFile?.();
	// Pi writes the session file only after the first message; nothing to reopen yet.
	if (!file || !existsSync(file)) {
		deps.notify(ctx, `Recipe "${def.name}": the extension set and model scope apply on ${restartHint(def)} (this session has no saved file to reopen yet)`, "info");
		return;
	}
	const decision = selectedSessionRelaunch({
		argv: process.argv,
		command: process.execPath,
		env: process.env,
		reason: "resume",
		file,
		def,
	});
	if (decision?.action === "session-apply" && decision.note) {
		deps.notify(ctx, decision.note, "warning");
		return;
	}
	if (decision?.action !== "relaunch") return;
	const hint = `pi --session ${JSON.stringify(file)}`;
	// An in-process RPC relaunch would compete for the JSONL reader (see resume.ts).
	if (ctx.mode !== "tui") {
		deps.notify(ctx, `Recipe "${def.name}" needs a restart for its ${decision.spec.reasons.join(" + ")}: ${hint}`, "warning");
		return;
	}
	if (!ctx.isIdle()) {
		deps.notify(ctx, `Recipe "${def.name}" needs a restart for its ${decision.spec.reasons.join(" + ")} — not restarting mid-run; when idle: ${hint}`, "warning");
		return;
	}
	process.stderr.write(`${relaunchNotice(decision.spec)}\n`);
	if (await relaunchFromSession(ctx, decision.spec, deps.relaunch ?? execRelaunch)) return;
	deps.notify(ctx, `Recipe "${def.name}" relaunch failed — extension set and model scope stay unchanged; restart with ${hint}`, "warning");
}

/** `/recipe add [key]` / `/recipe remove [key]` on the active recipe. */
export async function runRecipeEditCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: RecipeEditAction,
	arg: string,
	deps: RecipeEditDeps,
): Promise<void> {
	const { notify } = deps;
	if (!ctx.hasUI) {
		notify(ctx, `/recipe ${action} needs an interactive session (TUI or RPC)`, "error");
		return;
	}
	deps.refresh(ctx);
	const state = recipeRuntime();
	const name = state.activeName;
	if (!name) {
		notify(ctx, `No active recipe — switch to one with /recipe <name> (or create this folder's with /recipe init), then /recipe ${action}`, "info");
		return;
	}
	const def = state.recipes.recipes[name];
	if (!def) {
		notify(ctx, `Active recipe "${name}" is no longer defined in any recipe file`, "error");
		return;
	}

	let key: RecipeEditKey | undefined;
	const word = arg.trim().split(/\s+/)[0] ?? "";
	if (word) {
		key = parseRecipeEditKey(word);
		if (!key) {
			notify(ctx, `Unknown recipe key "${word}". Use one of: ${RECIPE_EDIT_KEYS.map((info) => info.key).join(", ")}`, "error");
			return;
		}
	} else {
		const labels = RECIPE_EDIT_KEYS.map((info) => `${info.key} — ${info.description}`);
		const choice = await ctx.ui.select(`Recipe "${name}" — ${action}:`, labels);
		if (!choice) return;
		key = RECIPE_EDIT_KEYS[labels.indexOf(choice)]?.key;
		if (!key) return;
	}
	const info = recipeEditKeyInfo(key);

	const target = resolveRecipeEditTarget(def, {
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
		directoryFile: state.recipes.directoryFile,
		directoryTrusted: state.directoryTrust === "trusted",
	});
	if (!target.ok) {
		notify(ctx, `recipes: cannot edit "${name}": ${target.reason}`, "error");
		return;
	}
	// The bridge never reads project recipes, so their restart keys would be dead config.
	if (target.source === "project" && info.restart) {
		notify(ctx, `recipes: "${name}" comes from .pi/aio-recipes.json, whose ${info.field} never change a launch — use a .pi-recipe or your global aio-recipes.json`, "error");
		return;
	}
	const read = readRecipeFileForEdit(target.file);
	if (!read.ok) {
		notify(ctx, `recipes: ${read.reason}`, "error");
		return;
	}
	let entry: Record<string, unknown>;
	try {
		entry = rawRecipeEntry(read.data, name);
	} catch (error) {
		notify(ctx, `recipes: ${target.file}: ${errorText(error)}`, "error");
		return;
	}

	const edit = action === "add"
		? await buildAddEdit(ctx, name, key, entry, notify)
		: await buildRemoveEdit(ctx, name, key, entry, notify);
	if (!edit) return;

	const next = structuredClone(read.data);
	let result: ReturnType<typeof applyRecipeEdit>;
	try {
		result = applyRecipeEdit(next, name, edit);
	} catch (error) {
		notify(ctx, `recipes: ${errorText(error)}`, "error");
		return;
	}
	if (!result.changed) {
		notify(ctx, `Recipe "${name}" already has that ${info.field} — nothing to change`, "info");
		return;
	}
	if (target.source === "project" && result.restart) {
		notify(ctx, `recipes: "${name}" comes from .pi/aio-recipes.json, whose model scope never changes a launch — use a .pi-recipe or your global aio-recipes.json`, "error");
		return;
	}

	const isGlobal = target.source === "global";
	const lines = [
		target.file,
		...result.changes.map((change) => `  ${change}`),
		...(result.restart ? ["Model scope/extensions change: pi restarts on this session where it can."] : []),
		...(isGlobal ? [`The previous file is kept as ${basename(target.file)}.bak.`] : []),
	];
	const confirmed = await ctx.ui.confirm(`Update recipe "${name}"?`, lines.join("\n"));
	if (!confirmed) {
		notify(ctx, `Recipe "${name}" unchanged`, "info");
		return;
	}
	// A file edited while the dialog was open is never overwritten blindly.
	let onDisk: string;
	try {
		onDisk = readFileSync(target.file, "utf-8");
	} catch (error) {
		notify(ctx, `recipes: cannot re-read ${target.file}: ${errorText(error)}`, "error");
		return;
	}
	if (onDisk !== read.text) {
		notify(ctx, `recipes: ${target.file} changed on disk meanwhile — nothing written; run /recipe ${action} again`, "error");
		return;
	}
	try {
		writeRecipeFileAtomic(target.file, next, read.indent, { backup: isGlobal });
	} catch (error) {
		notify(ctx, `recipes: could not write ${target.file}: ${errorText(error)}`, "error");
		return;
	}
	if (target.source === "directory") {
		// You approved this exact edit: keep the new version trusted, like /recipe init.
		try {
			recordRecipeFileTrust(target.file, true);
		} catch (error) {
			notify(ctx, `recipes: ${basename(target.file)} written but trust not saved (${errorText(error)}) — run /recipe trust`, "warning");
		}
	}

	deps.refresh(ctx);
	const updated = recipeRuntime().recipes.recipes[name];
	if (!updated) {
		notify(ctx, `Recipe "${name}" written to ${target.file} but no longer loads — check the file`, "warning");
		return;
	}
	const applied = await applyRecipe(pi, ctx, updated, {
		source: state.source ?? "command",
		persist: true,
		live: true,
	});
	const appliedText = applied.applied.length > 0 ? ` — applied: ${applied.applied.join(", ")}` : "";
	const warnings = applied.warnings.length > 0 ? `; ${applied.warnings.join("; ")}` : "";
	notify(
		ctx,
		`Recipe "${name}" updated in ${basename(dirname(target.file))}/${basename(target.file)}: ${result.changes.join(", ")}${appliedText}${warnings}`,
		applied.warnings.length > 0 ? "warning" : "info",
	);
	if (result.restart) await applyRestartScoped(ctx, updated, deps);
}
