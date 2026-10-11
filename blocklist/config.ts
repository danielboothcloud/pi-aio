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
//
// File format:
//   {
//     "enabled": true,
//     "entries": [
//       "rm -rf /",                                  // case-insensitive substring
//       { "pattern": "kubectl delete", "reason": "no cluster deletions" },
//       { "pattern": "\\bgit push --force\\b", "regex": true, "reason": "no force push" }
//     ]
//   }
//
// Matching is case-insensitive for both plain strings and regexes: shell
// commands are typed in any case and a blocklist that misses `RM -RF /`
// would be a footgun.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const BLOCKLIST_FILE_NAME = "aio-blocklist.json";

/** One config file entry: a plain substring, or an object with an optional
 * `regex` flag and optional `reason`. */
export type BlocklistEntry =
	| string
	| { pattern: string; regex?: boolean; reason?: string };

export type BlocklistSource = "global" | "project";

/** A compiled, ready-to-match rule. */
export interface BlocklistRule {
	source: BlocklistSource;
	pattern: string;
	/** Full user-facing reason, already prefixed with "Blocked by aio blocklist". */
	reason: string;
	matches: (command: string) => boolean;
}

export interface BlocklistHit {
	source: BlocklistSource;
	pattern: string;
	reason: string;
}

/** Result of reading one file: entries in file order plus that file's gate. */
export interface FileBlocklist {
	enabled: boolean;
	entries: BlocklistEntry[];
}

export const EMPTY_BLOCKLIST: FileBlocklist = { enabled: true, entries: [] };

export function globalBlocklistPath(): string {
	return join(getAgentDir(), BLOCKLIST_FILE_NAME);
}

export function projectBlocklistPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, BLOCKLIST_FILE_NAME);
}

function parseEntry(entry: unknown): BlocklistEntry | undefined {
	if (typeof entry === "string") {
		const pattern = entry.trim();
		return pattern ? pattern : undefined;
	}
	if (typeof entry !== "object" || entry === null) return undefined;
	const obj = entry as { pattern?: unknown; regex?: unknown; reason?: unknown };
	if (typeof obj.pattern !== "string") return undefined;
	const pattern = obj.pattern.trim();
	if (!pattern) return undefined;
	const reason =
		typeof obj.reason === "string" && obj.reason.trim()
			? obj.reason.trim()
			: undefined;
	if (obj.regex === true)
		return { pattern, regex: true, ...(reason ? { reason } : {}) };
	return { pattern, ...(reason ? { reason } : {}) };
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
		if (typeof parsed !== "object" || parsed === null) return EMPTY_BLOCKLIST;
		const raw = parsed as { enabled?: unknown; entries?: unknown };

		const entries: BlocklistEntry[] = [];
		if (Array.isArray(raw.entries)) {
			for (const entry of raw.entries) {
				const parsedEntry = parseEntry(entry);
				if (parsedEntry) entries.push(parsedEntry);
			}
		}

		return { enabled: raw.enabled !== false, entries };
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
): BlocklistRule | undefined {
	const pattern = typeof entry === "string" ? entry : entry.pattern;
	const customReason = typeof entry === "object" ? entry.reason : undefined;
	const reason = customReason ?? defaultReason(pattern);

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
		pattern,
		reason: `Blocked by aio blocklist: ${reason}`,
		matches,
	};
}

/**
 * Load the effective rule set for a cwd: global entries + project entries
 * (union), each gated by its own file's `enabled` flag.
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
	return rules;
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
	for (const rule of loadBlocklist(cwd)) {
		if (rule.matches(command)) {
			return {
				source: rule.source,
				pattern: rule.pattern,
				reason: rule.reason,
			};
		}
	}
	return undefined;
}
