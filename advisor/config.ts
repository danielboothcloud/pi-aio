// ---------------------------------------------------------------------------
// advisor/config — the advisor's settings, their recipe parser, and the
// narrow cross-feature channel recipes publish through.
//
// Recipe key (session-scoped; absent = off):
//
//   "advisor": "anthropic/claude-opus-4-5:xhigh"   // model + optional reasoning
//   "advisor": {                                   // or the full form
//     "model": "anthropic/claude-opus-4-5",
//     "reasoning": "high",                         // alias: thinkingLevel
//     "maxUsesPerRun": 3,
//     "maxTokens": 16384,
//     "maxContextMessages": 18
//   }
//   "advisor": false | "off" | null                // explicit off
//
// Effective state: a session override from `/advisor on|off` beats the
// recipe; a live recipe switch clears that override. The parent mirrors its
// effective settings into AIO_ADVISOR so subagent children (which never
// activate recipes) get the same advisor. Pure: no Pi runtime imports.
// ---------------------------------------------------------------------------

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ADVISOR_TOOL_NAME = "advisor";
/** Effective advisor settings mirrored for subagent children. */
export const ADVISOR_ENV = "AIO_ADVISOR";
/** Session entry that pins a `/advisor on|off` override on the branch. */
export const ADVISOR_STATE_ENTRY = "advisor-state";

export const ADVISOR_REASONING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type AdvisorReasoning = (typeof ADVISOR_REASONING_LEVELS)[number];

export interface AdvisorSettings {
	/** "provider/model-id" (or a bare id the session scope can resolve). */
	model: string;
	reasoning: AdvisorReasoning;
	maxUsesPerRun: number;
	maxTokens: number;
	maxContextMessages: number;
}

export const ADVISOR_DEFAULTS: Omit<AdvisorSettings, "model"> = {
	reasoning: "high",
	maxUsesPerRun: 3,
	// Adaptive-thinking models count thinking tokens against the output cap.
	maxTokens: 16384,
	maxContextMessages: 18,
};

const LIMITS = {
	maxUsesPerRun: { min: 1, max: 20 },
	maxTokens: { min: 256, max: 200_000 },
	maxContextMessages: { min: 4, max: 200 },
} as const;

function parseReasoning(value: unknown): AdvisorReasoning | undefined {
	if (typeof value !== "string") return undefined;
	const level = value.trim().toLowerCase();
	return (ADVISOR_REASONING_LEVELS as readonly string[]).includes(level)
		? (level as AdvisorReasoning)
		: undefined;
}

function parseLimit(value: unknown, key: keyof typeof LIMITS): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const n = Math.trunc(value);
	const { min, max } = LIMITS[key];
	return Math.min(max, Math.max(min, n));
}

/**
 * Split "provider/model[:reasoning]". Model ids may contain colons
 * (`hf:zai-org/GLM-5.3`), so only a LAST-colon suffix that names a known
 * level counts as reasoning.
 */
export function parseAdvisorModelSpec(spec: string): { model: string; reasoning?: AdvisorReasoning } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const reasoning = parseReasoning(trimmed.slice(colon + 1));
		if (reasoning) return { model: trimmed.slice(0, colon).trim(), reasoning };
	}
	return { model: trimmed };
}

const OFF_WORDS = new Set(["", "off", "none", "false", "disabled"]);

/**
 * Parse a recipe's `advisor` value. Tolerant like the rest of the recipe
 * parser: anything malformed means "off", never a thrown error.
 */
export function parseAdvisorSetting(value: unknown): AdvisorSettings | undefined {
	if (typeof value === "string") {
		if (OFF_WORDS.has(value.trim().toLowerCase())) return undefined;
		const spec = parseAdvisorModelSpec(value);
		if (!spec.model) return undefined;
		return { ...ADVISOR_DEFAULTS, model: spec.model, reasoning: spec.reasoning ?? ADVISOR_DEFAULTS.reasoning };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.enabled === false) return undefined;
	if (typeof raw.model !== "string") return undefined;
	const base = parseAdvisorSetting(raw.model);
	if (!base) return undefined;
	const reasoning = parseReasoning(raw.reasoning ?? raw.thinkingLevel);
	return {
		model: base.model,
		reasoning: reasoning ?? base.reasoning,
		maxUsesPerRun: parseLimit(raw.maxUsesPerRun, "maxUsesPerRun") ?? ADVISOR_DEFAULTS.maxUsesPerRun,
		maxTokens: parseLimit(raw.maxTokens, "maxTokens") ?? ADVISOR_DEFAULTS.maxTokens,
		maxContextMessages:
			parseLimit(raw.maxContextMessages, "maxContextMessages") ?? ADVISOR_DEFAULTS.maxContextMessages,
	};
}

/** "provider/model:reasoning" — the compact display form. */
export function describeAdvisor(settings: AdvisorSettings): string {
	return `${settings.model}:${settings.reasoning}`;
}

// ---------------------------------------------------------------------------
// Session override (persisted as an `advisor-state` branch entry)
// ---------------------------------------------------------------------------

/** "on" carries its own settings; "off" disables; undefined follows the recipe. */
export type AdvisorOverride =
	| { mode: "on"; settings: AdvisorSettings }
	| { mode: "off" }
	| undefined;

export interface AdvisorStateData {
	/** null clears the override (follow the recipe again). */
	override: { mode: "on"; settings: AdvisorSettings } | { mode: "off" } | null;
}

/** The newest `advisor-state` entry on the branch, or undefined. */
export function latestAdvisorOverride(entries: ReadonlyArray<unknown>): AdvisorOverride {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: AdvisorStateData };
		if (entry?.type !== "custom" || entry.customType !== ADVISOR_STATE_ENTRY) continue;
		const override = entry.data?.override;
		if (!override) return undefined;
		if (override.mode === "off") return { mode: "off" };
		if (override.mode === "on") {
			const settings = parseAdvisorSetting(override.settings);
			return settings ? { mode: "on", settings } : undefined;
		}
		return undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Recipe channel (recipes registers first and publishes here)
// ---------------------------------------------------------------------------

export interface RecipeAdvisor {
	recipe: string;
	settings: AdvisorSettings;
}

export interface AdvisorAccess {
	/** A live recipe switch: drop the session override and follow the recipe. */
	followRecipe(ctx: ExtensionContext): void;
}

let recipeAdvisor: RecipeAdvisor | undefined;
let access: AdvisorAccess | undefined;

export function setRecipeAdvisor(value: RecipeAdvisor | undefined): void {
	recipeAdvisor = value;
}

export function getRecipeAdvisor(): RecipeAdvisor | undefined {
	return recipeAdvisor;
}

export function setAdvisorAccess(next: AdvisorAccess | undefined): void {
	access = next;
}

export function getAdvisorAccess(): AdvisorAccess | undefined {
	return access;
}

// ---------------------------------------------------------------------------
// Effective settings + subagent mirror
// ---------------------------------------------------------------------------

export type AdvisorSource = "override" | "recipe" | "inherited";

export interface EffectiveAdvisor {
	settings: AdvisorSettings;
	source: AdvisorSource;
	/** Recipe name when source is "recipe". */
	recipe?: string;
}

/** Inherited settings: only a subagent child reads the env mirror. */
export function inheritedAdvisor(env: NodeJS.ProcessEnv = process.env): AdvisorSettings | undefined {
	if (env.AIO_SUBAGENT_CHILD !== "1") return undefined;
	const raw = env[ADVISOR_ENV];
	if (!raw) return undefined;
	try {
		return parseAdvisorSetting(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/** Precedence: session override > recipe > inherited (children only) > off. */
export function resolveAdvisor(
	override: AdvisorOverride,
	recipe: RecipeAdvisor | undefined = recipeAdvisor,
	env: NodeJS.ProcessEnv = process.env,
): EffectiveAdvisor | undefined {
	if (override?.mode === "off") return undefined;
	if (override?.mode === "on") return { settings: override.settings, source: "override" };
	if (recipe) return { settings: recipe.settings, source: "recipe", recipe: recipe.recipe };
	const inherited = inheritedAdvisor(env);
	return inherited ? { settings: inherited, source: "inherited" } : undefined;
}

/** Mirror the effective settings so spawned children inherit them. */
export function mirrorAdvisorEnv(
	effective: EffectiveAdvisor | undefined,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (effective) env[ADVISOR_ENV] = JSON.stringify(effective.settings);
	else delete env[ADVISOR_ENV];
}
