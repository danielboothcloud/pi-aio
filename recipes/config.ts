// ---------------------------------------------------------------------------
// aio-recipes.json config loader — recipes are named launch configurations.
//
// Two-tier config with OVERRIDE semantics (unlike blocklist's per-entry
// union): a project recipe with the same name replaces the global one, and
// every other global recipe stays. Project recipes are only read for trusted
// projects (same gate as browser-search's aio.browserSearch).
//
//   Global:    <agentDir>/aio-recipes.json      (getAgentDir(), ~/.pi/agent)
//   Project:   <cwd>/.pi/aio-recipes.json       (CONFIG_DIR_NAME)
//   Directory: <cwd>/.pi-recipe or <cwd>/.pi-recipe.json (same JSON shape;
//              launch cwd only, no parent walk). Gated by explicit,
//              content-pinned per-file trust (trust.ts) — folder trust never
//              covers it. Its defaultRecipe wins over the other tiers
//              and starts like `pi --recipe <name>` (see trampoline.ts).
//
// AIO_RECIPES_FILE replaces the global file path (tests + sandboxes), the
// same contract goal-settings and YSK use for their settings files.
//
// File format:
// {
//   "defaultRecipe": "home",
//   "recipes": {
//     "home": {
//       "description": "Personal Claude/Codex subscriptions",
//       "model": "anthropic/claude-5:high",   // startup model id; optional
//                                            // `:thinking` suffix honored
//       "thinkingLevel": "high",              // off|minimal|low|medium|high|xhigh|max
//       "models": ["anthropic/*", "openai-codex/*"], // --models scope (restart-scoped)
//       "mcpServers": { "linear": { "url": "https://mcp.example.com/linear" } },
//       "extensions": ["otty-integration", "npm:pi-web-access"] // restart-scoped
//     }
//   }
// }
//
// Tolerant by design: a missing file, unparseable JSON, or a malformed recipe
// never throws — broken config yields an empty recipe set (with one stderr
// warning per unreadable file so the user can fix it).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type McpServerConfig,
} from "@earendil-works/pi-coding-agent";

export const RECIPES_FILE_NAME = "aio-recipes.json";
/** Replaces the global recipes file (tests + sandboxes). */
export const RECIPES_FILE_ENV = "AIO_RECIPES_FILE";
/** Set by the relaunch bridge on the child process: its active recipe name. */
export const ACTIVE_RECIPE_ENV = "AIO_RECIPE_ACTIVE";
/** Guard env: set on the relaunched child so it never relaunches again. */
export const RECIPE_STAGE_ENV = "AIO_RECIPE_STAGE";
/** The CLI flag name (`--recipe`). */
export const RECIPE_FLAG = "recipe";
/** Session entry that pins the active recipe on the branch. */
export const RECIPE_STATE_ENTRY = "recipe-state";
/** Legacy recipe instruction messages, stripped from resumed/forked context. */
export const RECIPE_CONTEXT_TYPE = "recipe-context";
/** Footer status key (status-line's `statuses` segment renders it). */
export const RECIPE_STATUS_KEY = "recipe";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Names pi dispatches as subcommands before any session can start. */
export const PI_SUBCOMMANDS: readonly string[] = [
	"install",
	"remove",
	"uninstall",
	"update",
	"list",
	"config",
	"auth",
	"mcp",
];

export type RecipeSource = "global" | "project" | "directory";

/** Per-directory recipe files, checked in this order in the launch cwd only. */
export const DIRECTORY_RECIPE_FILE_NAMES: readonly string[] = [".pi-recipe", ".pi-recipe.json"];
/** Set beside ACTIVE_RECIPE_ENV when the relaunch came from a directory default. */
export const RECIPE_ORIGIN_ENV = "AIO_RECIPE_ORIGIN";

/** One recipe, strictly JSON-native so it round-trips through load/merge. */
export interface RecipeConfig {
	description?: string;
	/** "provider/model-id" or bare model id; an optional `:thinking` suffix is honored. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** `--models` patterns (restart-scoped: applied only by the relaunch bridge). */
	models?: string[];
	/** registerMcpServer configs, validated at registration time. */
	mcpServers: Record<string, McpServerConfig>;
	/** Extension sources for the relaunch bridge (restart-scoped). */
	extensions?: string[];
}

/** A recipe merged across the two config tiers, with provenance. */
export interface RecipeDefinition {
	name: string;
	source: RecipeSource;
	/** Directory of the declaring config, retained for status provenance. */
	baseDir: string;
	config: RecipeConfig;
}

export interface RecipesConfig {
	/** Merged recipes keyed by name; project entries replaced same-name globals. */
	recipes: Record<string, RecipeDefinition>;
	/** Optional recipe that auto-activates on fresh `pi` starts. */
	defaultRecipe?: string;
	/** Which tier supplied defaultRecipe. */
	defaultSource?: RecipeSource;
	/** The cwd's `.pi-recipe`/`.pi-recipe.json`, present whether or not it was trusted. */
	directoryFile?: string;
	/** True when no recipes are configured anywhere. */
	empty: boolean;
}

const warnedFiles = new Set<string>();

function warnOnce(message: string): void {
	process.stderr.write(`[recipes] ${message}\n`);
}

export function globalRecipesPath(): string | undefined {
	const override = process.env[RECIPES_FILE_ENV]?.trim();
	if (override) return override;
	try {
		return join(getAgentDir(), RECIPES_FILE_NAME);
	} catch {
		return undefined;
	}
}

export function projectRecipesPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, RECIPES_FILE_NAME);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The cwd's directory recipe file: `.pi-recipe` first, then
 * `.pi-recipe.json`. When both exist the first wins and the other is
 * reported once, so a stale copy never silently shadows edits.
 */
export function directoryRecipesPath(cwd: string): string | undefined {
	const found = DIRECTORY_RECIPE_FILE_NAMES.map((name) => join(cwd, name)).filter(isFile);
	const ignored = found[1];
	if (ignored && !warnedFiles.has(ignored)) {
		warnedFiles.add(ignored);
		warnOnce(`both ${found[0]} and ${ignored} exist; using the first and ignoring ${ignored}`);
	}
	return found[0];
}

function agentDirFor(extensionName: string): string {
	const candidates = [
		join("extensions", `${extensionName}.ts`),
		join("extensions", `${extensionName}.js`),
		join("extensions", `${extensionName}`, "index.ts"),
		join("extensions", `${extensionName}`, "index.js"),
	];
	try {
		for (const candidate of candidates) {
			const resolved = join(getAgentDir(), candidate);
			if (existsSync(resolved)) return resolved;
		}
		return join(getAgentDir(), "extensions", extensionName);
	} catch {
		return join(homedir(), ".pi", "agent", "extensions", extensionName);
	}
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const level = value.trim().toLowerCase() as ThinkingLevel;
	return THINKING_LEVELS.includes(level) ? level : undefined;
}

function parseStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
	return entries.length > 0 ? entries : undefined;
}

function parseMcpServers(value: unknown): Record<string, McpServerConfig> {
	const servers: Record<string, McpServerConfig> = {};
	if (typeof value !== "object" || value === null) return servers;
	for (const [name, config] of Object.entries(value as Record<string, unknown>)) {
		if (!name.trim()) continue;
		if (typeof config !== "object" || config === null) continue;
		servers[name] = config as McpServerConfig;
	}
	return servers;
}

/**
 * Parse one `recipes.<name>` entry. Unknown keys are dropped, malformed values
 * default to "absent" — a broken recipe never takes down registration. A
 * completely malformed entry yields an object with no restart-scoped or
 * session-scoped keys, so it activates as a no-op.
 */
export function parseRecipeConfig(
	name: string,
	source: RecipeSource,
	baseDir: string,
	raw: unknown,
): RecipeDefinition | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const entry = raw as Record<string, unknown>;

	const config: RecipeConfig = { mcpServers: {} };

	if (typeof entry.description === "string" && entry.description.trim()) {
		config.description = entry.description.trim();
	}
	if (typeof entry.model === "string" && entry.model.trim()) {
		config.model = entry.model.trim();
	}
	const thinkingLevel = parseThinkingLevel(entry.thinkingLevel);
	if (thinkingLevel) config.thinkingLevel = thinkingLevel;
	config.models = parseStringList(entry.models);
	config.mcpServers = parseMcpServers(entry.mcpServers);
	config.extensions = parseStringList(entry.extensions);

	return { name, source, baseDir, config };
}

/**
 * Split a model spec into its model id and an optional trailing thinking
 * level. Model ids may themselves contain colons (`hf:zai-org/GLM-5.3`), so
 * only a LAST-colon suffix matching a known level is treated as one.
 */
export function parseModelSpec(spec: string): { model: string; thinking?: ThinkingLevel } {
	const colon = spec.lastIndexOf(":");
	if (colon > 0) {
		const suffix = spec.slice(colon + 1).trim().toLowerCase() as ThinkingLevel;
		if (THINKING_LEVELS.includes(suffix)) {
			return { model: spec.slice(0, colon).trim(), thinking: suffix };
		}
	}
	return { model: spec.trim() };
}

/** A recipe needs the relaunch bridge when it declares restart-scoped keys. */
export function isRestartScoped(recipe: RecipeConfig): boolean {
	return (recipe.models?.length ?? 0) > 0 || (recipe.extensions?.length ?? 0) > 0;
}

/** Where an `extensions` entry points: pass sources through, resolve names. */
export function resolveExtensionSource(
	source: string,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	const entry = source.trim();
	if (!entry) return undefined;
	if (entry === "aio") return undefined; // always injected first by the bridge
	if (
		entry.startsWith("npm:") ||
		entry.startsWith("git:") ||
		entry.startsWith("builtin:") ||
		entry.startsWith("http://") ||
		entry.startsWith("https://") ||
		entry.startsWith("/") ||
		entry.startsWith("./") ||
		entry.startsWith("../") ||
		entry.startsWith("~")
	) {
		return entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
	}
	// A bare name resolves against <agent-dir>/extensions (the same place
	// `~/.pi/agent/extensions/otty-integration.ts` lives). A dangling name is
	// skipped with a warning rather than launching a pi that fails to load.
	const resolved = agentDirFor(entry);
	if (!exists(resolved)) {
		warnOnce(
			`recipe extension "${entry}" was not found (looked in <agent-dir>/extensions); skipping it`,
		);
		return undefined;
	}
	return resolved;
}

interface RawRecipesFile {
	defaultRecipe?: unknown;
	recipes?: unknown;
}

function readRecipesFile(file: string, source: RecipeSource): RawRecipesFile {
	try {
		if (!existsSync(file)) return {};
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		return parsed as RawRecipesFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (file && !warnedFiles.has(file)) {
			warnedFiles.add(file);
			warnOnce(`could not read ${source} recipes from ${file}: ${message}`);
		}
		return {};
	}
}

function collectRecipes(
	file: string,
	source: RecipeSource,
	baseDir: string,
): Record<string, RecipeDefinition> {
	const raw = readRecipesFile(file, source);
	if (typeof raw.recipes !== "object" || raw.recipes === null) return {};
	const recipes: Record<string, RecipeDefinition> = {};
	for (const [name, entry] of Object.entries(raw.recipes as Record<string, unknown>)) {
		const recipe = parseRecipeConfig(name, source, baseDir, entry);
		if (recipe) recipes[name] = recipe;
	}
	return recipes;
}

/**
 * Load the effective recipes for a cwd. Same-name project recipes override
 * global ones; other global recipes survive (an override, not a union — a
 * work recipe can neutralize a home MCP server by redefining the recipe).
 * `loadRecipes` itself reads the project file only when `projectTrusted` is
 * true, mirroring browser-search's config gate, and the directory file
 * (`.pi-recipe`) only when `directoryTrusted` is true (see trust.ts).
 * Override order: global < project < directory, for recipes and default.
 */
export function loadRecipes(
	cwd?: string,
	options: { projectTrusted?: boolean; directoryTrusted?: boolean } = {},
): RecipesConfig {
	const globalPath = globalRecipesPath();
	const recipes: Record<string, RecipeDefinition> = {};
	let globalDir = homedir();
	if (globalPath) {
		// Record the declaring agent dir (or the sandbox root AIO_RECIPES_FILE
		// points into) for status provenance.
		globalDir = globalRecipesBaseDir(globalPath);
		Object.assign(recipes, collectRecipes(globalPath, "global", globalDir));
	}
	if (cwd && options.projectTrusted) {
		const projectPath = projectRecipesPath(cwd);
		Object.assign(
			recipes,
			collectRecipes(projectPath, "project", join(cwd, CONFIG_DIR_NAME)),
		);
	}

	const directoryFile = cwd ? directoryRecipesPath(cwd) : undefined;
	let directoryRecipes: Record<string, RecipeDefinition> = {};
	if (cwd && directoryFile && options.directoryTrusted) {
		// Directory recipes retain the folder itself as their config source.
		directoryRecipes = collectRecipes(directoryFile, "directory", cwd);
		Object.assign(recipes, directoryRecipes);
	}

	let defaultRecipe: string | undefined;
	let defaultSource: RecipeSource | undefined;
	if (globalPath) {
		defaultRecipe = readDefaultRecipe(globalPath, "global");
		if (defaultRecipe) defaultSource = "global";
	}
	if (cwd && options.projectTrusted) {
		const projectDefault = readDefaultRecipe(projectRecipesPath(cwd), "project");
		if (projectDefault) {
			defaultRecipe = projectDefault;
			defaultSource = "project";
		}
	}
	if (directoryFile && options.directoryTrusted) {
		// A `.pi-recipe` is portable: its default must be defined in the file
		// itself, never resolved against this user's global/project recipes.
		const directoryDefault = readDefaultRecipe(directoryFile, "directory");
		if (directoryDefault && directoryRecipes[directoryDefault]) {
			defaultRecipe = directoryDefault;
			defaultSource = "directory";
		} else if (directoryDefault && !warnedFiles.has(`${directoryFile}#default`)) {
			warnedFiles.add(`${directoryFile}#default`);
			warnOnce(
				`${directoryFile}: defaultRecipe "${directoryDefault}" must be defined in that file's "recipes"; ignoring it`,
			);
		}
	}
	if (defaultRecipe && !recipes[defaultRecipe]) {
		defaultRecipe = undefined;
		defaultSource = undefined;
	}

	return {
		recipes,
		defaultRecipe,
		defaultSource,
		directoryFile,
		empty: Object.keys(recipes).length === 0,
	};
}

function globalRecipesBaseDir(globalPath: string): string {
	if (process.env[RECIPES_FILE_ENV]?.trim()) {
		return dirname(globalPath);
	}
	try {
		return getAgentDir();
	} catch {
		return homedir();
	}
}

function readDefaultRecipe(file: string, source: RecipeSource): string | undefined {
	const raw = readRecipesFile(file, source);
	if (typeof raw.defaultRecipe !== "string") return undefined;
	const name = raw.defaultRecipe.trim();
	return name || undefined;
}
