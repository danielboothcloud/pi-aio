/** Exa API adapter: search normalized like SearXNG, and page contents for fetch_content. */

import { abortError, throwIfAborted, withTimeoutSignal } from "./abort.js";
import {
	EXA_BASE,
	EXA_REQUEST_TIMEOUT_MS,
	type ExaProviderConfig,
} from "./config.js";
import type {
	FetchResult,
	SearchOptions,
	SearchOutcome,
	SearchResult,
} from "./types.js";

interface ExaRawResult {
	title?: string | null;
	url?: string;
	publishedDate?: string | null;
	text?: string;
	summary?: string;
	highlights?: string[];
}

interface ExaRawResponse {
	results?: ExaRawResult[];
}

export class ExaError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ExaError";
	}
}

function startPublishedDate(timeRange: string | undefined): string | undefined {
	let days: number | undefined;
	switch (timeRange) {
		case "day":
			days = 1;
			break;
		case "week":
			days = 7;
			break;
		case "month":
			days = 30;
			break;
		case "year":
			days = 365;
			break;
		default:
			return undefined;
	}
	if (!days) return undefined;
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function snippet(result: ExaRawResult): string | null {
	const highlights = result.highlights?.filter(Boolean).join(" … ").trim();
	if (highlights) return highlights;
	if (result.summary?.trim()) return result.summary.trim();
	if (result.text?.trim()) return result.text.trim().slice(0, 1_000);
	return null;
}

/** POST a JSON body to an Exa endpoint and return its parsed JSON response. */
async function exaPost<T>(
	path: string,
	body: Record<string, unknown>,
	label: string,
	signal: AbortSignal | undefined,
	config: ExaProviderConfig,
	fallbackBaseUrl?: string,
): Promise<T> {
	throwIfAborted(signal);
	const apiKeyEnv = config.apiKeyEnv ?? "EXA_API_KEY";
	const apiKey = process.env[apiKeyEnv]?.trim();
	if (!apiKey) {
		throw new ExaError(
			`Exa API key is missing. Set ${apiKeyEnv} or configure aio.browserSearch.exa.apiKeyEnv.`,
		);
	}

	const base = config.baseUrl ?? fallbackBaseUrl ?? EXA_BASE;
	const requestSignal = withTimeoutSignal(signal, EXA_REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.aborted) {
			throw new ExaError(`Exa ${label} timed out after ${EXA_REQUEST_TIMEOUT_MS}ms`);
		}
		throw new ExaError(
			`Connection to Exa failed at ${base}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!response.ok) {
		throw new ExaError(`Exa returned HTTP ${response.status}`, response.status);
	}

	try {
		return (await response.json()) as T;
	} catch {
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.aborted) {
			throw new ExaError(
				`Exa response timed out after ${EXA_REQUEST_TIMEOUT_MS}ms`,
			);
		}
		throw new ExaError("Exa returned a non-JSON response");
	}
}

interface ExaContentsResponse {
	results?: { url?: string; title?: string | null; text?: string }[];
	statuses?: { id?: string; status?: string; error?: { tag?: string } }[];
}

/**
 * Fetch one page through Exa's contents API. Exa crawls the page itself (or
 * serves its cached copy), so no local browser is involved. `html` returns
 * Exa's simplified HTML, not the page's original markup.
 */
export async function exaContents(
	url: string,
	format: FetchResult["format"],
	signal?: AbortSignal,
	config: ExaProviderConfig = {},
): Promise<FetchResult> {
	const data = await exaPost<ExaContentsResponse>(
		"/contents",
		{ urls: [url], text: format === "html" ? { includeHtmlTags: true } : true },
		"contents",
		signal,
		config,
	);
	const page = data.results?.[0];
	const content = page?.text ?? "";
	if (!content.trim()) {
		const tag = data.statuses?.find((entry) => entry.status === "error")?.error?.tag;
		throw new ExaError(
			tag ? `Exa could not fetch the page (${tag})` : "Exa returned no content for the page",
		);
	}
	return {
		url,
		finalUrl: page?.url,
		title: page?.title ?? undefined,
		content,
		format,
		chars: content.length,
		truncated: false,
		tier: "exa",
	};
}

/** Search Exa and normalize its results for the shared `web_search` tool. */
export async function exaSearch(
	query: string,
	opts: SearchOptions = {},
	signal?: AbortSignal,
	config: ExaProviderConfig = {},
): Promise<SearchOutcome> {
	const body: Record<string, unknown> = {
		query,
		type: config.searchType ?? "auto",
		numResults: opts.numResults ?? 5,
		contents: {
			highlights: { maxCharacters: 1_000 },
		},
	};
	if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
	if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
	const publishedAfter = startPublishedDate(opts.timeRange);
	if (publishedAfter) body.startPublishedDate = publishedAfter;

	const data = await exaPost<ExaRawResponse>(
		"/search",
		body,
		"search",
		signal,
		config,
		opts.baseUrl,
	);

	const results: SearchResult[] = [];
	for (const result of data.results ?? []) {
		if (!result.url) continue;
		results.push({
			title: result.title ?? null,
			url: result.url,
			snippet: snippet(result),
			engine: "exa",
			category: null,
			publishedDate: result.publishedDate ?? null,
		});
	}

	return {
		ok: true,
		query,
		parameters: {
			lang: null,
			categories: null,
			timeRange: opts.timeRange ?? null,
			engines: null,
			page: 1,
		},
		resultCount: results.length,
		results,
	};
}
