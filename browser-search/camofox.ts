/**
 * Native Camofox client.
 *
 * Ports `browser-search/scripts/camofox/camofox-client.mjs` (the typed REST
 * wrapper over the camofox-browser container on :9377) and the high-level
 * `readability` / `evaluate` / `snapshot` orchestration from `camofox.mjs`,
 * executing every HTTP call in-process instead of spawning `node scripts/...`.
 *
 * Behavioral parity notes with the upstream scripts:
 *  - `createTab` POSTs `{ userId, sessionKey, url }`. GET endpoints echo
 *    `userId` (and any extra fields) as query params — exactly how the CLI
 *    helper built them.
 *  - `evaluate` injects Mozilla's Readability over a cloned document to
 *    produce `{ title, text, excerpt, length }`. We do this by shipping the
 *    vendored Readability source from `@mozilla/readability` instead of the
 *    repo's hand-checked-in `Readability.js`, so we don't need a sibling file.
 *  - `ensureBrowser()` mirrors the upstream recovery dance: probe `/health`,
 *    and on 503 "recovering" optionally `docker restart camofox-browser`
 *    (gated behind CAMOFOX_AUTO_RESTART), then poll up to 30s.
 */

import {
	abortError,
	sleep,
	throwIfAborted,
	withTimeoutSignal,
} from "./abort.js";
import type { ReadabilityArticle } from "./types.js";

import {
	CAMOFOX_API_KEY,
	CAMOFOX_AUTO_RESTART,
	CAMOFOX_BASE,
	CAMOFOX_REQUEST_TIMEOUT_MS,
	CAMOFOX_SESSION_KEY,
	CAMOFOX_USER_ID,
} from "./config.js";

export class CamofoxError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CamofoxError";
	}
}

const logStep = (msg: string): void => {
	process.stderr.write(`[camofox] ${msg}\n`);
};

async function request<T = unknown>(
	method: string,
	path: string,
	{
		body,
		headers: extraHeaders = {},
		rawOutput = false,
		signal,
	}: {
		body?: Record<string, unknown>;
		headers?: Record<string, string>;
		rawOutput?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<T> {
	throwIfAborted(signal);
	// Reject malformed paths / smuggled hosts up front so the fetch below can
	// never escape the configured Camofox backend (SSRF allowlist). `path` is a
	// fixed relative route ("/tabs/<id>/evaluate" etc.) — never a URL — so we
	// assert that shape before it touches the network.
	if (!path.startsWith("/") || path.includes("://") || path.includes("\\")) {
		throw new CamofoxError(`Refusing unsafe Camofox path: ${path}`);
	}
	let baseOrigin: string;
	try {
		baseOrigin = new URL(CAMOFOX_BASE).origin;
	} catch {
		throw new CamofoxError(`Invalid CAMOFOX_BASE: ${CAMOFOX_BASE}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(`${CAMOFOX_BASE}${path}`);
	} catch {
		throw new CamofoxError(`Invalid request path: ${path}`);
	}
	if (parsed.origin !== baseOrigin) {
		throw new CamofoxError(
			`Refusing outbound request to ${parsed.origin} (Camofox allowlist: ${baseOrigin})`,
		);
	}

	const query = parsed.searchParams;
	if (method === "GET" && body) {
		query.set("userId", String(body.userId ?? CAMOFOX_USER_ID));
		for (const [k, v] of Object.entries(body)) {
			if (k !== "userId") query.set(k, String(v));
		}
	}
	// Rebuild the fetch target from the validated constant base + a relative
	// path only, so no attacker-influenced host can reach the network call.
	const qs = query.toString();
	const fetchUrl = `${CAMOFOX_BASE}${path}${qs ? `?${qs}` : ""}`;

	const headers: Record<string, string> = { ...extraHeaders };
	if (body && method !== "GET") headers["Content-Type"] = "application/json";

	// Auth, mirroring the upstream client exactly.
	if (
		CAMOFOX_API_KEY &&
		path.startsWith("/tabs") &&
		method === "POST" &&
		path.endsWith("/evaluate")
	) {
		headers["Authorization"] = `Bearer ${CAMOFOX_API_KEY}`;
	}
	if (CAMOFOX_API_KEY && path.startsWith("/sessions")) {
		headers["Authorization"] = `Bearer ${CAMOFOX_API_KEY}`;
	}
	if (CAMOFOX_API_KEY && path.startsWith("/pressure")) {
		headers["Authorization"] = `Bearer ${CAMOFOX_API_KEY}`;
	}
	const requestSignal = withTimeoutSignal(signal, CAMOFOX_REQUEST_TIMEOUT_MS);
	const opts: RequestInit = { method, headers, signal: requestSignal };
	if (body && method !== "GET") opts.body = JSON.stringify(body);

	logStep(`${method} ${path}`);
	let res: Response;
	try {
		res = await fetch(fetchUrl, opts);
	} catch (err) {
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.aborted) {
			throw new CamofoxError(
				`Camofox request timed out after ${CAMOFOX_REQUEST_TIMEOUT_MS}ms: ${method} ${path}`,
			);
		}
		throw new CamofoxError(
			`Camofox unreachable at ${CAMOFOX_BASE}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (rawOutput) return res as unknown as T;

	let text: string;
	try {
		text = await res.text();
	} catch (err) {
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.aborted) {
			throw new CamofoxError(
				`Camofox response timed out after ${CAMOFOX_REQUEST_TIMEOUT_MS}ms: ${method} ${path}`,
			);
		}
		throw err;
	}
	if (!res.ok) {
		const err = new CamofoxError(
			`${method} ${path} → ${res.status} ${res.statusText}: ${text}`,
			res.status,
		);
		throw err;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as unknown as T;
	}
}

// ---------- Low-level endpoints ----------

interface HealthResponse {
	browserRunning?: boolean;
	[key: string]: unknown;
}

interface CreateTabResponse {
	tabId: string;
	url: string;
	[key: string]: unknown;
}

interface EvaluateResponse {
	result?: string;
	[key: string]: unknown;
}

export async function health(signal?: AbortSignal): Promise<HealthResponse> {
	return request<HealthResponse>("GET", "/health", { signal });
}

async function start(signal?: AbortSignal): Promise<unknown> {
	return request("POST", "/start", { signal });
}

async function createTab(
	url: string,
	signal?: AbortSignal,
): Promise<CreateTabResponse> {
	return request<CreateTabResponse>("POST", "/tabs", {
		body: { userId: CAMOFOX_USER_ID, sessionKey: CAMOFOX_SESSION_KEY, url },
		signal,
	});
}

async function closeTab(tabId: string, signal?: AbortSignal): Promise<unknown> {
	return request("DELETE", `/tabs/${tabId}`, {
		body: { userId: CAMOFOX_USER_ID },
		signal,
	});
}

async function snapshot(
	tabId: string,
	offset?: number,
	signal?: AbortSignal,
): Promise<unknown> {
	const params: Record<string, unknown> = { userId: CAMOFOX_USER_ID };
	if (offset) params.offset = offset;
	return request("GET", `/tabs/${tabId}/snapshot`, { body: params, signal });
}

async function evaluate(
	tabId: string,
	expression: string,
	signal?: AbortSignal,
): Promise<EvaluateResponse> {
	return request<EvaluateResponse>("POST", `/tabs/${tabId}/evaluate`, {
		body: { userId: CAMOFOX_USER_ID, expression },
		signal,
	});
}

// ---------- Readability (injected over the live page) ----------

/**
 * Run Mozilla Readability against the page inside the container's Firefox.
 * We stringify the `@mozilla/readability` ES module and evaluate it, matching
 * the upstream script's "inject Readability, parse a cloned doc" technique —
 * but we ship the source from the npm dep instead of a vendored copy.
 */
async function readabilityRun(
	tabId: string,
	signal?: AbortSignal,
): Promise<{
	title: string | null;
	text: string | null;
	excerpt: string | null;
	length: number;
} | null> {
	// `@mozilla/readability` ships a browser-oriented ESM that runs in the page
	// context once concatenated with a small driver. We import its source text
	// lazily so the dep can stay optional for the Camofox-only path.
	const readabilitySrc = await loadReadabilitySource();
	const expression =
		readabilitySrc +
		"; var a = new Readability(document.cloneNode(true)).parse();" +
		"JSON.stringify({title: a?.title || null, text: a?.textContent || null, excerpt: a?.excerpt || null, length: a?.length || 0})";
	const res = await evaluate(tabId, expression, signal);
	let parsed: {
		title: string | null;
		text: string | null;
		excerpt: string | null;
		length: number;
	} | null = null;
	if (res?.result) {
		try {
			parsed = JSON.parse(res.result);
		} catch {
			parsed = null;
		}
	}
	return parsed;
}

let cachedReadabilitySource: string | null = null;

async function loadReadabilitySource(): Promise<string> {
	if (cachedReadabilitySource) return cachedReadabilitySource;
	// @mozilla/readability's main module constructs `Readability` on the global
	// scope when evaluated as a plain script; importing its dist and stringifying
	// is unreliable across versions, so we read the canonical UMD file directly.
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const { readFileSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const modPath = require.resolve("@mozilla/readability");
	// The package exports ./Readability.js (browser build) — prefer that.
	const pkgDir = dirname(modPath);
	let target = join(pkgDir, "Readability.js");
	try {
		readFileSync(target, "utf-8");
	} catch {
		target = modPath;
	}
	cachedReadabilitySource = readFileSync(target, "utf-8");
	return cachedReadabilitySource;
}

// ---------- High-level orchestration ----------

async function ensureBrowser(signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	try {
		const h = await health(signal);
		if (h.browserRunning) return;
	} catch (err) {
		if (signal?.aborted) throw abortError(signal);
		if (err instanceof CamofoxError && err.status === 503) {
			if (CAMOFOX_AUTO_RESTART) {
				logStep("Browser recovering; restarting container…");
				const { exec } = await import("node:child_process");
				await new Promise<void>((resolve, reject) => {
					exec("docker restart camofox-browser", { signal }, (error) => {
						if (signal?.aborted) {
							reject(abortError(signal));
							return;
						}
						if (error) logStep(`docker restart failed: ${error.message}`);
						resolve();
					});
				});
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline) {
					throwIfAborted(signal);
					try {
						const h2 = await health(signal);
						if (h2.browserRunning) return;
					} catch (pollError) {
						if (signal?.aborted) throw abortError(signal);
						void pollError;
					}
					await sleep(1000, signal);
				}
				throw new CamofoxError(
					"Browser unavailable after container restart (30s timeout)",
				);
			}
			// No auto-restart configured: fall through to start() attempt.
		} else if (!(err instanceof CamofoxError)) {
			throw err;
		}
	}
	throwIfAborted(signal);
	logStep("Browser not running, starting…");
	await start(signal);
	await sleep(2000, signal);
	const h2 = await health(signal);
	if (!h2.browserRunning) {
		throw new CamofoxError("Unable to start the Camofox browser");
	}
}

/** Open a tab, run fn(tabId), and always close it. */
async function runOnTab<T>(
	url: string,
	fn: (tabId: string) => Promise<T>,
	{ waitMs = 0, signal }: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
	throwIfAborted(signal);
	const tab = await createTab(url, signal);
	try {
		if (waitMs > 0) await sleep(waitMs, signal);
		throwIfAborted(signal);
		return await fn(tab.tabId);
	} finally {
		try {
			// Cleanup must still run after cancellation, but keep it bounded.
			await closeTab(tab.tabId, AbortSignal.timeout(2_000));
		} catch {
			// best-effort close
		}
	}
}

export interface ReadabilityPageResult {
	url: string;
	readability: ReadabilityArticle | null;
	snapshot: unknown | null;
	error?: string;
}

/**
 * Extract an article from one or more URLs. Mirrors the upstream
 * `cmdReadability`: two attempts then fallback to a snapshot.
 */
export async function readability(
	urls: string[],
	signal?: AbortSignal,
): Promise<ReadabilityPageResult[]> {
	await ensureBrowser(signal);
	const results: ReadabilityPageResult[] = [];
	for (const url of urls) {
		throwIfAborted(signal);
		try {
			let readabilityResult: ReadabilityArticle | null = null;
			let snapshotResult: unknown | null = null;
			await runOnTab(
				url,
				async (tabId) => {
					const maxAttempts = 2;
					for (let attempt = 1; attempt <= maxAttempts; attempt++) {
						throwIfAborted(signal);
						logStep(`Readability attempt ${attempt}/${maxAttempts}…`);
						const res = await readabilityRun(tabId, signal);
						if (res?.text) {
							readabilityResult = {
								title: res.title,
								text: res.text,
								excerpt: res.excerpt,
								length: res.length,
								htmlLength: 0,
							};
							break;
						}
						if (attempt < maxAttempts) {
							logStep("Readability → null, retrying in 1500ms…");
							await sleep(1500, signal);
						}
					}
					if (!readabilityResult) {
						logStep(
							"Readability → null after 2 attempts, falling back to snapshot…",
						);
						snapshotResult = await snapshot(tabId, undefined, signal);
					}
				},
				{ waitMs: 2000, signal },
			);
			results.push({
				url,
				readability: readabilityResult,
				snapshot: snapshotResult,
			});
		} catch (err) {
			if (signal?.aborted) throw abortError(signal);
			results.push({
				url,
				readability: null,
				snapshot: null,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return results;
}

export interface EvaluatePageResult {
	url: string;
	result: unknown;
	error?: string;
}

/** Navigate to `url`, wait, evaluate an expression, close the tab. */
export async function evaluateUrl(
	url: string,
	expression: string,
	signal?: AbortSignal,
): Promise<EvaluatePageResult> {
	await ensureBrowser(signal);
	try {
		const out = await runOnTab(
			url,
			async (tabId) => {
				const res = await evaluate(tabId, expression, signal);
				return res?.result ?? res;
			},
			{ waitMs: 1000, signal },
		);
		return { url, result: out };
	} catch (err) {
		if (signal?.aborted) throw abortError(signal);
		return {
			url,
			result: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
