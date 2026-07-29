/** Runtime configuration for the self-hosted browser-search backends. */

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

/** SearXNG metasearch endpoint (JSON API on /search). */
export const SEARXNG_BASE = endpoint(
	process.env.BROWSER_SEARCH_SEARXNG_BASE ?? process.env.SEARXNG_BASE,
	localHttpEndpoint(8080),
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
