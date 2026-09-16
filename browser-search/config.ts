/** Runtime configuration for browser-search backends. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type SearchProvider = "searxng" | "exa";
export type ExaSearchType =
	| "auto"
	| "keyword"
	| "neural"
	| "hybrid"
	| "fast"
	| "instant"
	| "deep-lite"
	| "deep"
	| "deep-reasoning";

export interface SearxngProviderConfig {
	baseUrl?: string;
}

export interface ExaProviderConfig {
	baseUrl?: string;
	apiKeyEnv?: string;
	searchType?: ExaSearchType;
}

export interface BrowserSearchConfig {
	provider?: SearchProvider;
	searxng?: SearxngProviderConfig;
	exa?: ExaProviderConfig;
}

function localHttpEndpoint(port: number): string {
	return `http://${"localhost"}:${port}`;
}

function endpoint(value: string | undefined, fallback: string): string {
	return (value?.trim() || fallback).replace(/\/+$/, "");
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return plainObject(JSON.parse(readFileSync(path, "utf8"))) ?? {};
	} catch (error) {
		process.stderr.write(
			`[browser-search] Invalid Pi settings at ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return {};
	}
}

function browserSearchSection(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	return plainObject(plainObject(settings.aio)?.browserSearch) ?? {};
}

/** Validate and merge the `aio.browserSearch` section from Pi settings. */
export function resolveBrowserSearchConfig(
	globalSettings: Record<string, unknown>,
	projectSettings: Record<string, unknown> = {},
): BrowserSearchConfig {
	const globalConfig = browserSearchSection(globalSettings);
	const projectConfig = browserSearchSection(projectSettings);
	const merged = {
		...globalConfig,
		...projectConfig,
		provider: projectConfig.provider ?? globalConfig.provider,
		searxng: {
			...(plainObject(globalConfig.searxng) ?? {}),
			...(plainObject(projectConfig.searxng) ?? {}),
		},
		exa: {
			...(plainObject(globalConfig.exa) ?? {}),
			...(plainObject(projectConfig.exa) ?? {}),
		},
	};

	const provider =
		merged.provider === "searxng" || merged.provider === "exa"
			? merged.provider
			: undefined;
	const searchType = optionalString(merged.exa.searchType);
	const validSearchTypes = new Set<ExaSearchType>([
		"auto",
		"keyword",
		"neural",
		"hybrid",
		"fast",
		"instant",
		"deep-lite",
		"deep",
		"deep-reasoning",
	]);

	return {
		provider,
		searxng: {
			baseUrl: optionalString(merged.searxng.baseUrl)?.replace(/\/+$/, ""),
		},
		exa: {
			baseUrl: optionalString(merged.exa.baseUrl)?.replace(/\/+$/, ""),
			apiKeyEnv: optionalString(merged.exa.apiKeyEnv),
			searchType:
				searchType && validSearchTypes.has(searchType as ExaSearchType)
					? (searchType as ExaSearchType)
					: undefined,
		},
	};
}

/** Load global Pi settings plus trusted project settings. */
export function loadBrowserSearchConfig(
	cwd: string,
	projectTrusted: boolean,
): BrowserSearchConfig {
	const globalSettings = readSettings(join(getAgentDir(), "settings.json"));
	const projectSettings = projectTrusted
		? readSettings(join(cwd, CONFIG_DIR_NAME, "settings.json"))
		: {};
	return resolveBrowserSearchConfig(globalSettings, projectSettings);
}

/** SearXNG metasearch endpoint (JSON API on /search). */
export const SEARXNG_BASE = endpoint(
	process.env.BROWSER_SEARCH_SEARXNG_BASE ?? process.env.SEARXNG_BASE,
	localHttpEndpoint(8080),
);

/** Exa Search API endpoint. */
export const EXA_BASE = endpoint(
	process.env.BROWSER_SEARCH_EXA_BASE,
	"https://api.exa.ai",
);

/** Camofox browser REST API base. */
export const CAMOFOX_BASE = endpoint(
	process.env.BROWSER_SEARCH_CAMOFOX_BASE ?? process.env.CAMOFOX_BASE,
	localHttpEndpoint(9377),
);

/** Optional Camofox bearer keys (mirror the upstream CAMOFOX_API_KEY scheme). */
export const CAMOFOX_API_KEY = process.env.CAMOFOX_API_KEY ?? "";

/** Camofox session identity. */
export const CAMOFOX_USER_ID = process.env.CAMOFOX_USER_ID ?? "pi-bot";
export const CAMOFOX_SESSION_KEY = "default";

/**
 * Opt-in container restart for Camofox's 503 recovering state. Disabled by
 * default so browser-search never shells out to Docker unexpectedly.
 */
export const CAMOFOX_AUTO_RESTART = /^(1|true|yes)$/i.test(
	process.env.BROWSER_SEARCH_CAMOFOX_AUTO_RESTART ?? "",
);

/** Network timeout for SearXNG HTTP calls. */
export const SEARXNG_REQUEST_TIMEOUT_MS = positiveInteger(
	process.env.BROWSER_SEARCH_SEARXNG_TIMEOUT_MS,
	20_000,
);

/** Network timeout for Exa HTTP calls. */
export const EXA_REQUEST_TIMEOUT_MS = positiveInteger(
	process.env.BROWSER_SEARCH_EXA_TIMEOUT_MS,
	20_000,
);

/** Network timeout for each Camofox REST call. */
export const CAMOFOX_REQUEST_TIMEOUT_MS = positiveInteger(
	process.env.BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS,
	30_000,
);

/** Maximum model-facing characters returned by either tool. */
export const MAX_INLINE_CONTENT = positiveInteger(
	process.env.BROWSER_SEARCH_MAX_INLINE_CONTENT,
	40_000,
);

/** Default CloakBrowser extraction cap before model-facing truncation. */
export const CLOAK_MAX_CHARS = positiveInteger(
	process.env.BROWSER_SEARCH_CLOAK_MAX_CHARS,
	100_000,
);
