// ---------------------------------------------------------------------------
// recipes/edit — pure helpers behind `/recipe add` and `/recipe remove`.
//
// The commands edit the ACTIVE recipe in the file that defines it (the cwd
// `.pi-recipe`, the trusted project `.pi/aio-recipes.json`, or the global
// `aio-recipes.json`). This module owns the key catalog, the JSON object
// edit, target-file resolution, and the atomic write; the UI lives in
// add-command.ts. Only keys the loader understands are ever written.
// ---------------------------------------------------------------------------

import {
	copyFileSync,
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ADVISOR_REASONING_LEVELS, parseAdvisorModelSpec } from "../advisor/config.js";
import { PERMISSION_MODES } from "../permission-modes/mode-access.js";
import { STYLES } from "../styles/style-access.js";
import {
	THINKING_LEVELS,
	globalRecipesPath,
	parseModelSpec,
	projectRecipesPath,
	type RecipeDefinition,
} from "./config.js";

export type RecipeEditKey =
	| "model"
	| "scope"
	| "thinking"
	| "advisor"
	| "extension"
	| "mcp"
	| "style"
	| "mode";

export interface RecipeEditKeyInfo {
	key: RecipeEditKey;
	/** The recipe JSON field it writes. */
	field: string;
	description: string;
	/** Changing it needs a relaunch (extension set / model scope). */
	restart: boolean;
	/** A list/map key: remove picks one entry instead of unsetting the field. */
	list: boolean;
}

export const RECIPE_EDIT_KEYS: readonly RecipeEditKeyInfo[] = [
	{ key: "model", field: "model", description: "startup model", restart: false, list: false },
	{ key: "scope", field: "models", description: "model scope for Ctrl+P (restart)", restart: true, list: true },
	{ key: "thinking", field: "thinkingLevel", description: "thinking level", restart: false, list: false },
	{ key: "advisor", field: "advisor", description: "advisor model", restart: false, list: false },
	{ key: "extension", field: "extensions", description: "extension sources (restart)", restart: true, list: true },
	{ key: "mcp", field: "mcpServers", description: "MCP servers", restart: false, list: true },
	{ key: "style", field: "style", description: "interaction style", restart: false, list: false },
	{ key: "mode", field: "permissionMode", description: "starting permission mode", restart: false, list: false },
];

const KEY_ALIASES: Record<string, RecipeEditKey> = {
	model: "model",
	scope: "scope",
	models: "scope",
	thinking: "thinking",
	thinkinglevel: "thinking",
	advisor: "advisor",
	extension: "extension",
	extensions: "extension",
	ext: "extension",
	mcp: "mcp",
	mcpservers: "mcp",
	style: "style",
	mode: "mode",
	permissionmode: "mode",
};

export function parseRecipeEditKey(word: string): RecipeEditKey | undefined {
	return KEY_ALIASES[word.trim().toLowerCase()];
}

export function recipeEditKeyInfo(key: RecipeEditKey): RecipeEditKeyInfo {
	// SAFETY: RECIPE_EDIT_KEYS lists every RecipeEditKey.
	return RECIPE_EDIT_KEYS.find((info) => info.key === key) as RecipeEditKeyInfo;
}

/** Allowed values for the closed-set keys, in picker order. */
export const KEY_CHOICES = {
	thinking: THINKING_LEVELS,
	style: STYLES,
	mode: PERMISSION_MODES,
	reasoning: ADVISOR_REASONING_LEVELS,
} as const;

export type RecipeEdit =
	| { action: "set"; key: "model" | "thinking" | "advisor" | "style" | "mode"; value: string }
	| { action: "add"; key: "scope" | "extension"; value: string }
	| { action: "add"; key: "mcp"; value: string; config: Record<string, unknown> }
	/** `value` names the list entry (or MCP server); absent unsets the field. */
	| { action: "remove"; key: RecipeEditKey; value?: string };

export interface RecipeEditResult {
	changed: boolean;
	/** Human-readable one-liners for the confirm dialog and notice. */
	changes: string[];
	/** A restart-scoped field (`models`/`extensions`) changed. */
	restart: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
}

/** The raw `recipes.<name>` object to edit; throws when the file does not define it. */
export function rawRecipeEntry(data: Record<string, unknown>, name: string): Record<string, unknown> {
	if (!isRecord(data.recipes)) throw new Error('the file has no "recipes" object');
	const entry = data.recipes[name];
	if (!isRecord(entry)) throw new Error(`recipe "${name}" is not defined in this file`);
	return entry;
}

/** Current entries of a list key, for the remove picker. */
export function recipeListValues(entry: Record<string, unknown>, key: RecipeEditKey): string[] {
	if (key === "scope") return stringList(entry.models);
	if (key === "extension") return stringList(entry.extensions);
	if (key === "mcp") return isRecord(entry.mcpServers) ? Object.keys(entry.mcpServers) : [];
	return [];
}

/** The field a scalar key currently uses (`mode` is a legacy alias of `permissionMode`). */
function scalarField(entry: Record<string, unknown>, key: RecipeEditKey): string {
	if (key === "mode" && entry.permissionMode === undefined && entry.mode !== undefined) return "mode";
	return recipeEditKeyInfo(key).field;
}

function globToRegExp(glob: string): RegExp {
	const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${body}$`, "i");
}

/**
 * Does a `--models` pattern already cover `provider/id`? An approximation of
 * Pi's scope matcher (exact or `*`/`?` glob on full or bare id); a miss only
 * means a redundant exact entry gets appended.
 */
export function modelPatternMatches(pattern: string, spec: string): boolean {
	const glob = parseModelSpec(pattern).model;
	const slash = spec.indexOf("/");
	const id = slash > 0 ? spec.slice(slash + 1) : spec;
	const re = globToRegExp(glob);
	return re.test(spec) || re.test(id);
}

function appendUnique(entry: Record<string, unknown>, field: string, value: string): boolean {
	const current = Array.isArray(entry[field]) ? (entry[field] as unknown[]) : [];
	if (current.some((item) => item === value)) return false;
	entry[field] = [...current, value];
	return true;
}

function removeFromList(entry: Record<string, unknown>, field: string, value: string): boolean {
	if (!Array.isArray(entry[field])) return false;
	const current = entry[field] as unknown[];
	const next = current.filter((item) => item !== value);
	if (next.length === current.length) return false;
	entry[field] = next;
	return true;
}

/** Apply one edit to the parsed file (mutates `data`). Other recipes and keys stay untouched. */
export function applyRecipeEdit(data: Record<string, unknown>, name: string, edit: RecipeEdit): RecipeEditResult {
	const entry = rawRecipeEntry(data, name);
	const changes: string[] = [];
	let restart = false;
	const value = edit.value?.trim() ?? "";
	if (edit.action !== "remove" && !value) throw new Error("an empty value cannot be added");

	if (edit.action === "set") {
		const info = recipeEditKeyInfo(edit.key);
		if (edit.key === "thinking" && !(THINKING_LEVELS as readonly string[]).includes(value)) {
			throw new Error(`"${value}" is not a thinking level`);
		}
		if (edit.key === "style" && !(STYLES as readonly string[]).includes(value)) {
			throw new Error(`"${value}" is not a style`);
		}
		if (edit.key === "mode" && !(PERMISSION_MODES as readonly string[]).includes(value)) {
			throw new Error(`"${value}" is not a permission mode`);
		}
		let next: unknown = value;
		if (edit.key === "model") {
			// Keep an existing `:thinking` suffix so a model swap never changes the level.
			const previous = typeof entry.model === "string" ? parseModelSpec(entry.model) : undefined;
			const picked = parseModelSpec(value);
			next = previous?.thinking && !picked.thinking ? `${value}:${previous.thinking}` : value;
		}
		if (edit.key === "advisor" && isRecord(entry.advisor)) {
			// The object form keeps its limits; only model + reasoning change.
			const advisor = { ...entry.advisor };
			const spec = parseAdvisorModelSpec(value);
			advisor.model = spec.model;
			if (spec.reasoning) {
				advisor.reasoning = spec.reasoning;
				delete advisor.thinkingLevel;
			}
			if (advisor.enabled === false) delete advisor.enabled;
			next = advisor;
		}
		const field = scalarField(entry, edit.key);
		if (JSON.stringify(entry[field]) !== JSON.stringify(next)) {
			entry[field] = next;
			changes.push(`${info.field} → ${typeof next === "string" ? next : JSON.stringify(next)}`);
		}
		if (edit.key === "model") {
			// A scoped recipe must also allow its startup model, or Ctrl+P skips it.
			const scope = stringList(entry.models);
			const modelId = parseModelSpec(value).model;
			if (scope.length > 0 && !scope.some((pattern) => modelPatternMatches(pattern, modelId))) {
				appendUnique(entry, "models", modelId);
				changes.push(`models += ${modelId}`);
				restart = true;
			}
		}
	} else if (edit.action === "add") {
		if (edit.key === "mcp") {
			const servers = isRecord(entry.mcpServers) ? { ...entry.mcpServers } : {};
			const replaced = servers[value] !== undefined;
			if (JSON.stringify(servers[value]) !== JSON.stringify(edit.config)) {
				servers[value] = edit.config;
				entry.mcpServers = servers;
				changes.push(`mcpServers.${value} ${replaced ? "replaced" : "added"}`);
			}
		} else {
			const field = recipeEditKeyInfo(edit.key).field;
			if (appendUnique(entry, field, value)) {
				changes.push(`${field} += ${value}`);
				restart = true;
			}
		}
	} else {
		const info = recipeEditKeyInfo(edit.key);
		if (info.list && value) {
			if (edit.key === "mcp") {
				if (isRecord(entry.mcpServers) && entry.mcpServers[value] !== undefined) {
					const servers = { ...entry.mcpServers };
					delete servers[value];
					entry.mcpServers = servers;
					changes.push(`mcpServers.${value} removed`);
				}
			} else if (removeFromList(entry, info.field, value)) {
				changes.push(`${info.field} -= ${value}`);
				restart = info.restart;
			}
		} else {
			const fields = edit.key === "mode" ? ["permissionMode", "mode"] : [info.field];
			for (const field of fields) {
				if (entry[field] === undefined) continue;
				delete entry[field];
				changes.push(`${field} removed`);
				if (info.restart) restart = true;
			}
		}
	}
	return { changed: changes.length > 0, changes, restart };
}

// -- target file -----------------------------------------------------------------

export type RecipeEditTarget =
	| { ok: true; file: string; source: RecipeDefinition["source"] }
	| { ok: false; reason: string };

/** The file that defines `def` (the effective, highest-tier definition), if it may be written. */
export function resolveRecipeEditTarget(
	def: RecipeDefinition,
	options: { cwd: string; projectTrusted: boolean; directoryFile?: string; directoryTrusted: boolean },
): RecipeEditTarget {
	if (def.source === "directory") {
		if (!options.directoryFile) return { ok: false, reason: `no .pi-recipe in ${options.cwd}` };
		if (!options.directoryTrusted) {
			return { ok: false, reason: `${basename(options.directoryFile)} is not trusted — run /recipe trust first` };
		}
		return { ok: true, file: options.directoryFile, source: "directory" };
	}
	if (def.source === "project") {
		if (!options.projectTrusted) return { ok: false, reason: "this project is not trusted, so its recipes are read-only" };
		return { ok: true, file: projectRecipesPath(options.cwd), source: "project" };
	}
	const file = globalRecipesPath();
	if (!file) return { ok: false, reason: "the agent directory is unavailable" };
	return { ok: true, file, source: "global" };
}

export type RecipeFileRead =
	| { ok: true; data: Record<string, unknown>; indent: string | number; text: string }
	| { ok: false; reason: string };

/** The file's indentation unit (first indented line), defaulting to 2 spaces. */
export function detectIndent(text: string): string | number {
	const match = /^([ \t]+)\S/m.exec(text);
	if (!match?.[1]) return 2;
	return match[1].startsWith("\t") ? "\t" : match[1].length;
}

/** Strict JSON only: comments or trailing commas would be lost on rewrite, so refuse. */
export function readRecipeFileForEdit(file: string): RecipeFileRead {
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch (error) {
		return { ok: false, reason: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `${file} is not strict JSON (${message}); fix it by hand — AIO never rewrites a file it cannot parse` };
	}
	if (!isRecord(data)) return { ok: false, reason: `${file} is not a JSON object` };
	return { ok: true, data, indent: detectIndent(text), text };
}

/** Write via a same-directory temp file + rename; a symlinked config keeps its link. */
export function writeRecipeFileAtomic(
	file: string,
	data: Record<string, unknown>,
	indent: string | number,
	options: { backup?: boolean } = {},
): void {
	let target = file;
	try {
		target = realpathSync(file);
	} catch {
		// New file: write the path as given.
	}
	if (options.backup && existsSync(target)) copyFileSync(target, `${file}.bak`);
	let mode: number | undefined;
	try {
		mode = statSync(target).mode & 0o777;
	} catch {
		mode = undefined;
	}
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmp, `${JSON.stringify(data, null, indent)}\n`, { encoding: "utf-8", mode });
		renameSync(tmp, target);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// Nothing was written.
		}
		throw error;
	}
}

// -- candidate lists ---------------------------------------------------------------

interface ModelLike {
	provider: string;
	id: string;
}

/**
 * Model picker order: the current model, then settings `enabledModels` and the
 * session scope, then everything else alphabetically. Duplicates collapse.
 */
export function orderModelChoices(
	models: readonly ModelLike[],
	options: { current?: ModelLike; enabled?: readonly string[]; scoped?: readonly ModelLike[] } = {},
): string[] {
	const specs = new Map<string, number>();
	const rank = (model: ModelLike): number => {
		const spec = `${model.provider}/${model.id}`;
		if (options.current && options.current.provider === model.provider && options.current.id === model.id) return 0;
		if (options.scoped?.some((s) => s.provider === model.provider && s.id === model.id)) return 1;
		if (options.enabled?.some((pattern) => modelPatternMatches(pattern, spec))) return 1;
		return 2;
	};
	const all = options.current ? [options.current, ...models] : [...models];
	for (const model of all) {
		const spec = `${model.provider}/${model.id}`;
		const r = rank(model);
		specs.set(spec, Math.min(r, specs.get(spec) ?? r));
	}
	return [...specs.entries()]
		.sort(([a, ra], [b, rb]) => ra - rb || a.localeCompare(b))
		.map(([spec]) => spec);
}

/**
 * Extension sources offered by `/recipe add extension`: global settings
 * `packages` and `extensions`, minus exclusions; relative paths are made
 * absolute against the settings directory (Pi resolves them there).
 */
export function extensionCandidates(settings: unknown, settingsDir: string): string[] {
	if (!isRecord(settings)) return [];
	const out: string[] = [];
	const add = (raw: string): void => {
		const entry = raw.trim();
		if (!entry || entry.startsWith("-") || entry.startsWith("!")) return;
		const source = entry.startsWith("+") ? entry.slice(1) : entry;
		const absolute = /^\.\.?[/\\]/.test(source) ? resolve(settingsDir, source) : source;
		if (!out.includes(absolute)) out.push(absolute);
	};
	for (const pkg of Array.isArray(settings.packages) ? settings.packages : []) {
		if (typeof pkg === "string") add(pkg);
		else if (isRecord(pkg) && typeof pkg.source === "string") add(pkg.source);
	}
	for (const ext of Array.isArray(settings.extensions) ? settings.extensions : []) {
		if (typeof ext === "string") add(ext);
	}
	return out;
}

/** `name` + "URL or command line" → an MCP server config (http when it looks like a URL). */
export function mcpConfigFromInput(target: string): Record<string, unknown> | undefined {
	const value = target.trim();
	if (!value) return undefined;
	if (/^https?:\/\//i.test(value)) return { url: value };
	const [command, ...args] = value.split(/\s+/);
	if (!command) return undefined;
	return args.length > 0 ? { command, args } : { command };
}
