/**
 * Native SearXNG client — a thin wrapper around the `/search?format=json`
 * endpoint exposed by a self-hosted SearXNG Docker container.
 *
 * Ports `browser-search/scripts/searxng/searxng.mjs` to TypeScript, executing
 * the HTTP fetch in-process (no node subprocess). URL encoding is delegated to
 * `URLSearchParams`, mirroring the original script's behavior.
 */

import { abortError, throwIfAborted, withTimeoutSignal } from "./abort.js";
import { SEARXNG_BASE, SEARXNG_REQUEST_TIMEOUT_MS } from "./config.js";
import type {
	SearchResult,
	SearxngOptions,
	SearxngSearchOutcome,
} from "./types.js";

interface SearxngRawResult {
	title?: string;
	url?: string;
	content?: string;
	engine?: string;
	category?: string;
	publishedDate?: string;
}

interface SearxngRawResponse {
	query?: string;
	results?: SearxngRawResult[];
}

export class SearxngError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "SearxngError";
	}
}

function buildUrl(query: string, opts: SearxngOptions): string {
	const params = new URLSearchParams();
	params.set("q", query);
	params.set("format", "json");
	if (opts.lang) params.set("language", opts.lang);
	if (opts.categories) params.set("categories", opts.categories);
	if (opts.timeRange) params.set("time_range", opts.timeRange);
	if (opts.engines) params.set("engines", opts.engines);
	if (opts.page) params.set("pageno", String(opts.page));
	return `${SEARXNG_BASE}/search?${params.toString()}`;
}

/** Search SearXNG and normalize the JSON response. */
export async function searxngSearch(
	query: string,
	opts: SearxngOptions = {},
	signal?: AbortSignal,
): Promise<SearxngSearchOutcome> {
	throwIfAborted(signal);
	const url = buildUrl(query, opts);
	const requestSignal = withTimeoutSignal(signal, SEARXNG_REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(url, { signal: requestSignal });
	} catch (err) {
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.aborted) {
			throw new SearxngError(
				`SearXNG search timed out after ${SEARXNG_REQUEST_TIMEOUT_MS}ms`,
			);
		}
		throw new SearxngError(
			`Connection to SearXNG failed at ${SEARXNG_BASE}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		throw new SearxngError(`SearXNG returned HTTP ${res.status}`, res.status);
	}

	let data: SearxngRawResponse;
	try {
		data = (await res.json()) as SearxngRawResponse;
	} catch {
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.aborted) {
			throw new SearxngError(
				`SearXNG response timed out after ${SEARXNG_REQUEST_TIMEOUT_MS}ms`,
			);
		}
		throw new SearxngError(
			"SearXNG returned non-JSON — is format=json enabled?",
		);
	}

	const raw = data.results ?? [];
	const results: SearchResult[] = [];
	for (const result of raw) {
		if (!result?.url) continue;
		results.push({
			title: result.title ?? null,
			url: result.url,
			snippet: result.content ?? null,
			engine: result.engine ?? null,
			category: result.category ?? null,
			publishedDate: result.publishedDate ?? null,
		});
	}

	const max =
		opts.numResults && opts.numResults > 0 ? opts.numResults : results.length;
	const limited = max < results.length ? results.slice(0, max) : results;

	return {
		ok: true,
		query: data.query ?? query,
		parameters: {
			lang: opts.lang ?? null,
			categories: opts.categories ?? "general",
			timeRange: opts.timeRange ?? null,
			engines: opts.engines ?? null,
			page: opts.page ?? 1,
		},
		resultCount: limited.length,
		results: limited,
	};
}
