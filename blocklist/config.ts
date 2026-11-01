// ---------------------------------------------------------------------------
// aio-blocklist.json config loader
//
// Two-tier config with UNION semantics (unlike goal-loop's per-key override):
// the effective rule set is the global entries plus the project entries —
// both apply. Each file's own `enabled` flag (default true) gates only that
// file's entries.
//
//   Global:  <agentDir>/aio-blocklist.json      (getAgentDir(), ~/.pi/agent)
//   Project: <cwd>/.pi/aio-blocklist.json       (CONFIG_DIR_NAME)
//   Recipe:  the active recipe's `blocklist` key (recipes/config.ts); the
//            recipes feature publishes it via setRecipeBlocklist and mirrors
//            it into AIO_RECIPE_BLOCKLIST so subagent children inherit it.
//
// File format:
//   {
//     "enabled": true,
//     "match": "command",                             // file default; optional
//     "entries": [
//       "rm -rf /",                                  // case-insensitive substring
//       { "pattern": "kubectl delete", "reason": "no cluster deletions" },
//       { "pattern": "\\bgit push --force\\b", "regex": true, "reason": "no force push" },
//       { "pattern": "^vault\\b", "regex": true, "match": "command" }
//     ]
//   }
//
// `match` (entry wins over the file default; anything unknown = "text"):
//   "text"    — today's behaviour: the rule tests the whole command text.
//   "command" — the rule tests each simple command the shell would run
//               (segments.ts), on its `program` and `full` forms. When the
//               command cannot be segmented safely the command is blocked
//               outright (fail closed).
//
// Matching is case-insensitive for both plain strings and regexes: shell
// commands are typed in any case and a blocklist that misses `RM -RF /`
// would be a footgun.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { segmentCommand, type SegmentResult } from "./segments.js";

export const BLOCKLIST_FILE_NAME = "aio-blocklist.json";
/** The active recipe's blocklist, inherited by subagent children. */
export const RECIPE_BLOCKLIST_ENV = "AIO_RECIPE_BLOCKLIST";

export type BlocklistMatchMode = "text" | "command";

/** One config file entry: a plain substring, or an object with an optional
 * `regex` flag, optional `reason`, and optional `match` mode. Parsed entries
 * carry `match` only when it resolves to "command" (the file default is
 * already folded in), so text entries keep their historical shape. */
export type BlocklistEntry =
	| string
	| {
			pattern: string;
			regex?: boolean;
			reason?: string;
			match?: BlocklistMatchMode;
	  };

export type BlocklistSource = "global" | "project" | "recipe";

/** A compiled, ready-to-match rule. */
export interface BlocklistRule {
	source: BlocklistSource;
	/** Recipe name when source is "recipe". */
	recipe?: string;
	pattern: string;
	match: BlocklistMatchMode;
	/** Full user-facing reason, already prefixed with "Blocked by aio blocklist". */
	reason: string;
	/** Test one subject: the whole command (text) or one segment form (command). */
	matches: (subject: string) => boolean;
}

export interface BlocklistHit {
	source: BlocklistSource;
	recipe?: string;
	pattern: string;
	reason: string;
	match: BlocklistMatchMode;
	/** Command mode: the segment (its `full` form) that matched. */
	segment?: string;
	/** Command mode: why the command could not be segmented (fail closed). */
	unsegmentable?: string;
}

/** Result of reading one file: entries in file order plus that file's gate. */
export interface FileBlocklist {
	enabled: boolean;
	entries: BlocklistEntry[];
}

export const EMPTY_BLOCKLIST: FileBlocklist = { enabled: true, entries: [] };

/** The active recipe's entries (already parsed), published by recipes/apply.ts. */
export interface RecipeBlocklist {
	recipe: string;
	entries: BlocklistEntry[];
}

let activeRecipeBlocklist: RecipeBlocklist | undefined;

/**
 * Publish (or clear) the active recipe's blocklist. Mirrored into
 * AIO_RECIPE_BLOCKLIST so spawned subagent children — which never activate
 * recipes themselves — keep enforcing it.
 */
export function setRecipeBlocklist(value: RecipeBlocklist | undefined): void {
	activeRecipeBlocklist = value && value.entries.length > 0 ? value : undefined;
	if (activeRecipeBlocklist) {
		process.env[RECIPE_BLOCKLIST_ENV] = JSON.stringify(activeRecipeBlocklist);
	} else {
		delete process.env[RECIPE_BLOCKLIST_ENV];
	}
}

/** In-process state first; a subagent child falls back to the inherited env. */
export function recipeBlocklist(): RecipeBlocklist | undefined {
	if (activeRecipeBlocklist) return activeRecipeBlocklist;
	if (process.env.AIO_SUBAGENT_CHILD !== "1") return undefined;
	const raw = process.env[RECIPE_BLOCKLIST_ENV];
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { recipe?: unknown; entries?: unknown };
		const recipe = typeof parsed.recipe === "string" ? parsed.recipe : "inherited";
		const { entries } = parseBlocklistConfig({ entries: parsed.entries });
		return entries.length > 0 ? { recipe, entries } : undefined;
	} catch {
		return undefined;
	}
}

export function globalBlocklistPath(): string {
	return join(getAgentDir(), BLOCKLIST_FILE_NAME);
}

export function projectBlocklistPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, BLOCKLIST_FILE_NAME);
}

/** Tolerant: only the literal "command" selects command mode. */
function parseMatchMode(value: unknown): BlocklistMatchMode {
	return value === "command" ? "command" : "text";
}

function parseEntry(
	entry: unknown,
	fileMatch: BlocklistMatchMode,
): BlocklistEntry | undefined {
	if (typeof entry === "string") {
		const pattern = entry.trim();
		if (!pattern) return undefined;
		return fileMatch === "command" ? { pattern, match: "command" } : pattern;
	}
	if (typeof entry !== "object" || entry === null) return undefined;
	const obj = entry as {
		pattern?: unknown;
		regex?: unknown;
		reason?: unknown;
		match?: unknown;
	};
	if (typeof obj.pattern !== "string") return undefined;
	const pattern = obj.pattern.trim();
	if (!pattern) return undefined;
	const reason =
		typeof obj.reason === "string" && obj.reason.trim()
			? obj.reason.trim()
			: undefined;
	// An entry's own `match` wins; a missing one inherits the file default.
	const match = "match" in obj ? parseMatchMode(obj.match) : fileMatch;
	return {
		pattern,
		...(obj.regex === true ? { regex: true } : {}),
		...(reason ? { reason } : {}),
		...(match === "command" ? { match } : {}),
	};
}

/**
 * Validate an already-parsed blocklist object (a blocklist file, or a
 * recipe's `blocklist` key). A bare array is shorthand for `{ entries }`.
 * Never throws; junk yields an empty blocklist.
 */
export function parseBlocklistConfig(raw: unknown): FileBlocklist {
	if (Array.isArray(raw)) raw = { entries: raw };
	if (typeof raw !== "object" || raw === null) return EMPTY_BLOCKLIST;
	const obj = raw as { enabled?: unknown; entries?: unknown; match?: unknown };
	const fileMatch = parseMatchMode(obj.match);
	const entries: BlocklistEntry[] = [];
	if (Array.isArray(obj.entries)) {
		for (const entry of obj.entries) {
			const parsedEntry = parseEntry(entry, fileMatch);
			if (parsedEntry) entries.push(parsedEntry);
		}
	}
	return { enabled: obj.enabled !== false, entries };
}

/**
 * Read and validate one blocklist file. Tolerant by design: a missing file,
 * unparseable JSON, or malformed entries yield an empty blocklist rather than
 * throwing — a broken config file must never take down the gate. `enabled` is
 * only false for the literal JSON `false`; anything else (missing, true, junk)
 * leaves the file's entries active.
 */
export function readBlocklistFile(file: string): FileBlocklist {
	try {
		if (!existsSync(file)) return EMPTY_BLOCKLIST;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		// A file must be an object; the bare-array shorthand is recipe-only.
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return EMPTY_BLOCKLIST;
		}
		return parseBlocklistConfig(parsed);
	} catch {
		return EMPTY_BLOCKLIST;
	}
}

function defaultReason(pattern: string): string {
	return `matches blocked pattern "${pattern}"`;
}

function compileRule(
	entry: BlocklistEntry,
	source: BlocklistSource,
	recipe?: string,
): BlocklistRule | undefined {
	const pattern = typeof entry === "string" ? entry : entry.pattern;
	const customReason = typeof entry === "object" ? entry.reason : undefined;
	const reason = customReason ?? defaultReason(pattern);
	const match: BlocklistMatchMode =
		typeof entry === "object" && entry.match === "command" ? "command" : "text";

	let matches: (command: string) => boolean;
	if (typeof entry === "object" && entry.regex) {
		let re: RegExp;
		try {
			re = new RegExp(entry.pattern, "i");
		} catch {
			// Malformed regex — skip the rule rather than blocking every command.
			return undefined;
		}
		matches = (command) => re.test(command);
	} else {
		const needle = pattern.toLowerCase();
		matches = (command) => command.toLowerCase().includes(needle);
	}

	return {
		source,
		...(recipe ? { recipe } : {}),
		pattern,
		match,
		reason: `Blocked by aio blocklist: ${reason}`,
		matches,
	};
}

/** Human label for a rule's origin: `global`, `project`, `recipe:<name>`. */
export function blocklistSourceLabel(rule: {
	source: BlocklistSource;
	recipe?: string;
}): string {
	return rule.source === "recipe" ? `recipe:${rule.recipe ?? "?"}` : rule.source;
}

/**
 * Load the effective rule set for a cwd: global entries + project entries +
 * the active recipe's entries (union), each file gated by its own `enabled`.
 */
export function loadBlocklist(cwd: string): BlocklistRule[] {
	const globalFile = readBlocklistFile(globalBlocklistPath());
	const projectFile = readBlocklistFile(projectBlocklistPath(cwd));

	const rules: BlocklistRule[] = [];
	if (globalFile.enabled) {
		for (const entry of globalFile.entries) {
			const rule = compileRule(entry, "global");
			if (rule) rules.push(rule);
		}
	}
	if (projectFile.enabled) {
		for (const entry of projectFile.entries) {
			const rule = compileRule(entry, "project");
			if (rule) rules.push(rule);
		}
	}
	const recipe = recipeBlocklist();
	if (recipe) {
		for (const entry of recipe.entries) {
			const rule = compileRule(entry, "recipe", recipe.recipe);
			if (rule) rules.push(rule);
		}
	}
	return rules;
}

function hitFor(
	rule: BlocklistRule,
	extra: Pick<BlocklistHit, "segment" | "unsegmentable"> = {},
): BlocklistHit {
	return {
		source: rule.source,
		...(rule.recipe ? { recipe: rule.recipe } : {}),
		pattern: rule.pattern,
		reason: rule.reason,
		match: rule.match,
		...extra,
	};
}

/**
 * Evaluate a command against compiled rules, in order. Text rules test the
 * whole command. Command rules test every segment's `program` and `full`
 * forms; if the command cannot be segmented, the first command rule blocks
 * it outright (fail closed) unless a text rule produces a specific hit.
 */
export function evaluateBlocklist(
	command: string,
	rules: readonly BlocklistRule[],
): BlocklistHit | undefined {
	if (!command.trim()) return undefined;
	let segmented: SegmentResult | undefined;
	let failClosed: BlocklistHit | undefined;
	for (const rule of rules) {
		if (rule.match === "text") {
			if (rule.matches(command)) return hitFor(rule);
			continue;
		}
		segmented ??= segmentCommand(command);
		if (!segmented.ok) {
			failClosed ??= {
				...hitFor(rule, { unsegmentable: segmented.reason }),
				reason: `Blocked by aio blocklist: the command could not be checked against command-mode rules (${segmented.reason}); simplify it so each command is visible`,
			};
			continue;
		}
		for (const segment of segmented.segments) {
			for (const subject of [segment.program, segment.full]) {
				if (subject && rule.matches(subject)) {
					return hitFor(rule, { segment: segment.full });
				}
			}
		}
	}
	return failClosed;
}

/**
 * Check a shell command against the effective blocklist. Returns the first
 * matching rule as a BlocklistHit, or undefined when the command may run.
 */
export function checkBlocklist(
	command: string,
	cwd: string,
): BlocklistHit | undefined {
	if (!command.trim()) return undefined;
	return evaluateBlocklist(command, loadBlocklist(cwd));
}
