// ---------------------------------------------------------------------------
// loop-police configuration: defaults, persistent JSON, live tuning.
//
// Ported from pi-loop-police (MIT, sebaxzero) — see UPSTREAM.md. Adapted to
// aio conventions: the persistent file lives at getAgentDir()/
// aio-loop-police.json (same pattern as aio-blocklist.json), loads
// tolerant-and-fail-open (a broken file must never take down detection),
// and values are range-checked both here and on load; invalid persisted
// values fall back to the corresponding default.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const LOOP_POLICE_FILE_NAME = "aio-loop-police.json";

/** Numeric config keys with [default, min, max] ranges. */
export const NUMERIC_DEFAULTS = {
	THINKING_WINDOW: 80,
	OUTPUT_WINDOW: 100,
	MAX_WINDOW: 4000,
	STRIDE: 50,
	PARA_MIN_LEN: 40,
	FINGERPRINT_LEN: 60,
	SEMANTIC_THRESHOLD: 3,
	STAGNATION_WINDOW: 4,
	STAGNATION_THRESHOLD: 0.85,
	FILE_SCAN_LIMIT: 20,
	SEARCH_EXPAND_LIMIT: 3,
	REREAD_WINDOW: 10,
	REREAD_RATIO: 0.4,
	CONSECUTIVE_LOOP_LIMIT: 2,
	TOOL_LOOP_BAN: 1,
	REDERIVE_THRESHOLD: 0.85,
	HOOK_TIMEOUT_MS: 5000,
} as const;

export type NumericKey = keyof typeof NUMERIC_DEFAULTS;

/** [min, max] inclusive range per numeric key; a detector disabled with 0 bypasses the range. */
export const NUMERIC_RANGES: Record<NumericKey, [number, number]> = {
	THINKING_WINDOW: [1, 2000],
	OUTPUT_WINDOW: [1, 2000],
	MAX_WINDOW: [100, 100_000],
	STRIDE: [1, 2000],
	PARA_MIN_LEN: [1, 2000],
	FINGERPRINT_LEN: [1, 2000],
	SEMANTIC_THRESHOLD: [2, 20],
	STAGNATION_WINDOW: [2, 50],
	STAGNATION_THRESHOLD: [0.1, 1],
	FILE_SCAN_LIMIT: [1, 1000],
	SEARCH_EXPAND_LIMIT: [1, 100],
	REREAD_WINDOW: [2, 100],
	REREAD_RATIO: [0, 1],
	CONSECUTIVE_LOOP_LIMIT: [1, 100],
	TOOL_LOOP_BAN: [0, 2],
	REDERIVE_THRESHOLD: [0.1, 1],
	HOOK_TIMEOUT_MS: [100, 60_000],
};

/** String config keys; TOOL_LOOP_EXEMPT is live-tunable, HOOK_* are file-only. */
export const STRING_KEYS = ["TOOL_LOOP_EXEMPT", "HOOK_CMD", "HOOK_LOG"] as const;
export type StringKey = (typeof STRING_KEYS)[number];

/** Recovery-message templates edited in the JSON file only. */
export const MSG_KEYS = [
	"MSG_THINKING_LOOP",
	"MSG_SEMANTIC_LOOP",
	"MSG_OUTPUT_LOOP",
	"MSG_OUTPUT_SEMANTIC_LOOP",
	"MSG_CONSECUTIVE_LOOP",
	"MSG_STAGNATION",
	"MSG_FILE_SCAN_LOOP",
	"MSG_SEARCH_SPIRAL",
	"MSG_REREAD",
	"MSG_TOOL_LOOP",
	"MSG_REDERIVED",
	"MSG_STUCK",
	"MSG_SUFFIX",
] as const;
export type MsgKey = (typeof MSG_KEYS)[number];

export const MSG_DEFAULTS: Record<MsgKey, string> = {
	MSG_THINKING_LOOP:
		"⚠️ Loop detected: your thinking block ended in the same verbatim content twice in a row. The repetition was trimmed. Continue from where your reasoning stopped with a fresh angle.",
	MSG_SEMANTIC_LOOP:
		"⚠️ Loop detected: your thinking block repeated the same paragraph 3 times. The repetition was trimmed. Pick a different line of attack.",
	MSG_OUTPUT_LOOP:
		"⚠️ Loop detected: your answer ended in the same verbatim content twice in a row. The repetition was truncated. Continue the answer past that point.",
	MSG_OUTPUT_SEMANTIC_LOOP:
		"⚠️ Loop detected: your answer repeated the same paragraph 3 times. The repetition was truncated. Continue with new content.",
	MSG_CONSECUTIVE_LOOP:
		"⚠️ {count} turns in a row have ended in detected loops. Stop repeating the same approach entirely: reread your last working step once, then choose a fundamentally different method.",
	MSG_STAGNATION:
		"⚠️ Your last {window} turns of reasoning have been near-identical. Your reasoning has been refreshed. Make concrete progress this turn: run one action, or write down one finding.",
	MSG_FILE_SCAN_LOOP:
		"⚠️ You have already read {path} {count} times this session. Blocked. Work from context, or search the file for the specific content you need.",
	MSG_SEARCH_SPIRAL:
		"⚠️ The pattern '{pattern}' has already been searched across {paths} locations. Blocked. Narrow the search (add a glob or path filter) or try a different pattern.",
	MSG_REREAD:
		"⚠️ Blocked a redundant re-read of {path}: {count} of your last {window} reads were re-reads of unchanged files. You already have that file in context; work from context, or write down your progress instead of paging back.",
	MSG_TOOL_LOOP:
		"⚠️ Blocked an identical sequence of {windowSize} tool calls repeating back-to-back. The call did not run. If a real change preceded this, state it explicitly; otherwise choose a different action.",
	MSG_REDERIVED:
		"⚠️ Your reasoning re-derived the same plan that led to the blocked action. The stale reasoning was trimmed. Do not reconstruct it; act differently.",
	MSG_STUCK:
		"⚠️ STUCK: the same blocked plan re-derived {count} times in a row. Stop trying to reach the same goal with the same method. Ask the user for guidance.",
	MSG_SUFFIX: "",
};

export interface LoopPoliceConfig {
	readonly numeric: Record<NumericKey, number>;
	readonly strings: Record<StringKey, string>;
	readonly messages: Record<MsgKey, string>;
}

export function defaultConfig(): LoopPoliceConfig {
	return {
		numeric: { ...NUMERIC_DEFAULTS },
		strings: {
			TOOL_LOOP_EXEMPT: "",
			HOOK_CMD: "",
			HOOK_LOG: "",
		},
		messages: { ...MSG_DEFAULTS },
	};
}

export function loopPoliceFilePath(): string {
	return join(getAgentDir(), LOOP_POLICE_FILE_NAME);
}

function coerceNumber(value: unknown, key: NumericKey): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const [min, max] = NUMERIC_RANGES[key];
	if (value === 0) return 0; // 0 disables a detector; bypasses the range
	if (value < min || value > max) return undefined;
	return value;
}

function coerceString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value;
}

/**
 * Parse one config JSON object over a base config. Unknown keys are ignored
 * (forward compatible); invalid values fall back to the base so a broken
 * file degrades to defaults rather than breaking detection.
 */
export function parseConfigOver(base: LoopPoliceConfig, parsed: Record<string, unknown>): LoopPoliceConfig {
	const numeric = { ...base.numeric };
	for (const key of Object.keys(NUMERIC_DEFAULTS) as NumericKey[]) {
		const coerced = coerceNumber(parsed[key], key);
		if (coerced !== undefined) numeric[key] = coerced;
	}

	const strings = { ...base.strings };
	for (const key of STRING_KEYS) {
		const coerced = coerceString(parsed[key]);
		if (coerced !== undefined) strings[key] = coerced;
	}

	const messages = { ...base.messages };
	for (const key of MSG_KEYS) {
		const coerced = coerceString(parsed[key]);
		if (coerced !== undefined) messages[key] = coerced;
	}

	return { numeric, strings, messages };
}

/** Parse config JSON text; tolerant — unparseable text returns the base. */
export function parseConfigText(base: LoopPoliceConfig, text: string): LoopPoliceConfig {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return base;
		}
		return parseConfigOver(base, parsed as Record<string, unknown>);
	} catch {
		return base;
	}
}

/**
 * Read the persistent config. Tolerant by design: a missing file or
 * unparseable JSON yields defaults rather than throwing — detection must
 * start even when the config file is broken.
 */
export function readLoopPoliceConfig(file: string = loopPoliceFilePath()): LoopPoliceConfig {
	try {
		if (!existsSync(file)) return defaultConfig();
		return parseConfigText(defaultConfig(), readFileSync(file, "utf8"));
	} catch {
		return defaultConfig();
	}
}

/** Write the persistent config (mode 0600, same as other aio agent files). */
export function writeLoopPoliceConfig(config: LoopPoliceConfig, file: string = loopPoliceFilePath()): void {
	const payload = {
		...config.numeric,
		...config.strings,
		...config.messages,
	};
	const dir = file.slice(0, file.lastIndexOf("/"));
	writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, {
		encoding: "utf8",
		...(dir === file.slice(0, 0) ? {} : { flag: "w" }),
	});
}

/** True when the key is live-tunable through /loop-police set. */
export function isSettableKey(key: string): key is NumericKey | "TOOL_LOOP_EXEMPT" {
	return key in NUMERIC_DEFAULTS || key === "TOOL_LOOP_EXEMPT";
}

/** Substitute {token} placeholders; unknown tokens stay visible so typos show. */
export function substitutePlaceholders(
	template: string,
	tokens: Record<string, string | number>,
): string {
	return template.replaceAll(/\{(\w+)\}/g, (match, token: string) => {
		const value = tokens[token];
		return value === undefined ? match : String(value);
	});
}
