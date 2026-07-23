/**
 * Self-hosted web search + browsing for Pi.
 *
 * `web_search` routes to SearXNG. `fetch_content` validates each initial URL,
 * then tries Camofox Readability/snapshot extraction before escalating blocked
 * or empty pages to CloakBrowser. Results are returned inline; this intentionally
 * does not provide pi-web-access's curator or response-id storage workflow.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { abortError, throwIfAborted } from "./abort.js";
import {
	readability as camofoxReadability,
	CamofoxError,
	evaluateUrl as camofoxEvaluateUrl,
} from "./camofox.js";
import { detectChallenge } from "./challenges.js";
import { cloakFetch, type CloakFetchOptions } from "./cloak.js";
import { MAX_INLINE_CONTENT } from "./config.js";
import { searxngSearch, SearxngError } from "./searxng.js";
import type {
	FetchResult,
	ReadabilityArticle,
	SearchResult,
	SearxngOptions,
	SearxngSearchOutcome,
} from "./types.js";
import { validateUrlWithDns } from "./url-validation.js";

type OutputFormat = "markdown" | "text" | "html";
type SearchFn = (
	query: string,
	opts?: SearxngOptions,
	signal?: AbortSignal,
) => Promise<SearxngSearchOutcome>;
type FetchUrlFn = (
	url: string,
	format: OutputFormat,
	signal?: AbortSignal,
) => Promise<FetchResult>;

export interface BrowserSearchDependencies {
	search?: SearchFn;
	fetchUrl?: FetchUrlFn;
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const normalized = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed) normalized.add(trimmed);
	}
	return [...normalized];
}

function normalizeSingleString(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const normalized = value.trim();
	return normalized ? [normalized] : [];
}

function normalizeInputList(many: unknown, one: unknown): string[] {
	const list = normalizeStringList(many);
	return list.length > 0 ? list : normalizeSingleString(one);
}

function formatSearchHits(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No results for "${query}".`;
	const lines = [`## "${query}" — ${results.length} result(s)\n`];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		const snippet = result.snippet ? `\n  ${result.snippet}` : "";
		const metadata = [result.engine, result.publishedDate]
			.filter(Boolean)
			.join(" · ");
		const suffix = metadata ? ` _(${metadata})_` : "";
		lines.push(
			`${index + 1}. [${result.title ?? result.url}](${result.url})${suffix}${snippet}`,
		);
	}
	return lines.join("\n");
}

function truncateForInline(
	content: string,
	limit = MAX_INLINE_CONTENT,
): { text: string; truncated: boolean; fullChars: number } {
	const fullChars = content.length;
	if (fullChars <= limit) return { text: content, truncated: false, fullChars };
	return {
		text:
			content.slice(0, limit) +
			`\n\n[Content truncated… ${limit}/${fullChars} chars shown]`,
		truncated: true,
		fullChars,
	};
}

function articleToContent(
	article: ReadabilityArticle,
	format: Exclude<OutputFormat, "html">,
): string {
	const text = article.text ?? "";
	if (format === "text") {
		return article.title ? `${article.title}\n\n${text}` : text;
	}
	return article.title ? `# ${article.title}\n\n${text}` : text;
}

function snapshotToText(snapshot: unknown): string {
	return typeof snapshot === "string"
		? snapshot
		: JSON.stringify(snapshot, null, 2);
}

export function isLikelyChallengeContent(
	url: string,
	title: string | null | undefined,
	content: string,
): boolean {
	const combined = `${title ?? ""}\n${content}`;
	if (detectChallenge({ url, html: combined })) return true;
	if (combined.length > 10_000) return false;
	const normalized = combined.toLowerCase();
	return [
		"checking your browser",
		"just a moment",
		"attention required",
		"verify you are human",
		"enable javascript and cookies",
		"security check required",
	].some((phrase) => normalized.includes(phrase));
}

function failedFetch(
	url: string,
	format: OutputFormat,
	message: string,
): FetchResult {
	return {
		url,
		content: "",
		format,
		chars: 0,
		truncated: false,
		tier: "none",
		error: message,
	};
}

/** Fetch one URL through Camofox, escalating blocked/empty pages to CloakBrowser. */
export async function fetchSingleUrl(
	url: string,
	format: OutputFormat,
	signal?: AbortSignal,
): Promise<FetchResult> {
	throwIfAborted(signal);
	const validation = await validateUrlWithDns(url);
	throwIfAborted(signal);
	if (!validation.valid) throw new Error(`URL blocked: ${validation.reason}`);

	let camofoxFailure = "Camofox returned no usable content";
	try {
		if (format === "html") {
			const page = await camofoxEvaluateUrl(
				url,
				"document.documentElement?.outerHTML || ''",
				signal,
			);
			if (page.error) {
				camofoxFailure = page.error;
			} else {
				const html =
					typeof page.result === "string"
						? page.result
						: JSON.stringify(page.result ?? "");
				if (html.trim() && !isLikelyChallengeContent(url, null, html)) {
					return {
						url,
						content: html,
						format: "html",
						chars: html.length,
						truncated: false,
						tier: "camofox",
					};
				}
				camofoxFailure = html.trim()
					? "Camofox returned an anti-bot challenge"
					: "Camofox returned empty HTML";
			}
		} else {
			const [page] = await camofoxReadability([url], signal);
			if (page?.error) {
				camofoxFailure = page.error;
			} else if (page?.readability?.text) {
				const content = articleToContent(page.readability, format);
				if (!isLikelyChallengeContent(url, page.readability.title, content)) {
					return {
						url,
						title: page.readability.title ?? undefined,
						content,
						format,
						chars: content.length,
						truncated: false,
						tier: "camofox",
					};
				}
				camofoxFailure = "Camofox returned an anti-bot challenge";
			} else if (page?.snapshot) {
				const content = snapshotToText(page.snapshot);
				if (content.trim() && !isLikelyChallengeContent(url, null, content)) {
					return {
						url,
						content,
						format,
						chars: content.length,
						truncated: false,
						tier: "camofox",
					};
				}
				camofoxFailure = content.trim()
					? "Camofox snapshot contained an anti-bot challenge"
					: "Camofox snapshot was empty";
			}
		}
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		camofoxFailure = errorMessage(error);
		if (!(error instanceof CamofoxError)) {
			process.stderr.write(
				`[browser-search] Camofox failed for ${url}: ${camofoxFailure}\n`,
			);
		}
	}

	throwIfAborted(signal);
	const cloakOptions: CloakFetchOptions = { url, format, signal };
	try {
		return await cloakFetch(cloakOptions);
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
		return failedFetch(
			url,
			format,
			`Camofox failed: ${camofoxFailure}. CloakBrowser failed: ${errorMessage(error)}`,
		);
	}
}

function applyDomainFilters(query: string, filters: string[]): string {
	if (filters.length === 0) return query;
	const terms = filters.map((filter) => {
		const trimmed = filter.trim();
		if (!trimmed) return "";
		return trimmed.startsWith("-")
			? `-site:${trimmed.slice(1)}`
			: `site:${trimmed}`;
	});
	return `${query} ${terms.filter(Boolean).join(" ")}`.trim();
}

function formatFetchedSources(results: FetchResult[]): string {
	if (results.length === 0) return "";
	const available = results.filter((result) => result.content && !result.error);
	const perSourceLimit = Math.max(
		1_000,
		Math.floor(MAX_INLINE_CONTENT / Math.max(available.length, 1) / 2),
	);
	const sections = results.map((result) => {
		if (result.error || !result.content) {
			return `### ${result.url}\n\nFetch error: ${result.error ?? "no content"}`;
		}
		const { text } = truncateForInline(result.content, perSourceLimit);
		return `### ${result.title ?? result.url}\n\nSource: ${result.finalUrl ?? result.url}\n\n${text}`;
	});
	return `\n\n## In-page content\n\n${sections.join("\n\n---\n\n")}`;
}

export function registerBrowserSearch(
	pi: ExtensionAPI,
	dependencies: BrowserSearchDependencies = {},
): void {
	const search = dependencies.search ?? searxngSearch;
	const fetchUrl = dependencies.fetchUrl ?? fetchSingleUrl;

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search via a self-hosted SearXNG metasearch instance. Returns raw source hits rather than a provider-generated answer. Supports the common pi-web-access query/provider/filter fields for call compatibility; every provider value routes to SearXNG. Set includeContent to browse returned hits through Camofox with CloakBrowser fallback.",
		promptSnippet:
			"Use for web research through self-hosted SearXNG. Prefer queries with 2-4 varied angles.",
		promptGuidelines: [
			"web_search uses the configured SearXNG backend; use varied queries for broad research.",
			"Use includeContent only when the search snippets are insufficient because it launches a browser for each returned hit.",
			"Use fetch_content for specific result URLs that need full in-page extraction.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Single search query. For research, prefer queries with several varied angles.",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple queries searched sequentially.",
				}),
			),
			numResults: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Maximum hits per query (default 5).",
				}),
			),
			includeContent: Type.Optional(
				Type.Boolean({
					description: "Browse each returned hit and append extracted content.",
				}),
			),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"] as const),
			),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Limit to domains; prefix a domain with - to exclude it.",
				}),
			),
			provider: Type.Optional(
				StringEnum(
					[
						"auto",
						"searxng",
						"openai",
						"brave",
						"parallel",
						"tavily",
						"exa",
						"perplexity",
						"gemini",
					] as const,
					{
						description:
							"Accepted for pi-web-access compatibility; all values use SearXNG.",
					},
				),
			),
			workflow: Type.Optional(
				StringEnum(["none", "summary-review", "auto-summary"] as const, {
					description:
						"Accepted for compatibility; self-hosted search returns raw hits without a curator workflow.",
				}),
			),
			lang: Type.Optional(
				Type.String({ description: "SearXNG language code." }),
			),
			categories: Type.Optional(
				Type.String({ description: "SearXNG categories CSV." }),
			),
			timeRange: Type.Optional(
				StringEnum(["day", "week", "month", "year"] as const, {
					description: "SearXNG-native alias for recencyFilter.",
				}),
			),
			engines: Type.Optional(
				Type.String({ description: "Restrict to SearXNG engines (CSV)." }),
			),
			page: Type.Optional(
				Type.Integer({ minimum: 1, description: "Result page." }),
			),
		}),

		async execute(_callId, params, signal, onUpdate) {
			throwIfAborted(signal);
			const queryList = normalizeInputList(params.queries, params.query);
			if (queryList.length === 0) {
				throw new Error("No query provided. Use query or queries.");
			}

			const domainFilters = normalizeStringList(params.domainFilter);
			const options: SearxngOptions = {
				lang: params.lang as string | undefined,
				categories: params.categories as string | undefined,
				timeRange: (params.recencyFilter ?? params.timeRange) as
					| string
					| undefined,
				engines: params.engines as string | undefined,
				page: params.page as number | undefined,
				numResults: (params.numResults as number | undefined) ?? 5,
			};
			const includeContent = params.includeContent === true;
			const perQuery: Array<{
				query: string;
				resultCount: number;
				results: SearchResult[];
				fetched: FetchResult[];
				error?: string;
			}> = [];

			for (let index = 0; index < queryList.length; index++) {
				throwIfAborted(signal);
				const query = queryList[index];
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Searching SearXNG (${index + 1}/${queryList.length}): ${query}`,
						},
					],
					details: { phase: "search", query, index },
				});
				try {
					const outcome = await search(
						applyDomainFilters(query, domainFilters),
						options,
						signal,
					);
					const fetched: FetchResult[] = [];
					if (includeContent) {
						for (const result of outcome.results) {
							throwIfAborted(signal);
							try {
								fetched.push(await fetchUrl(result.url, "markdown", signal));
							} catch (error) {
								if (signal?.aborted) throw abortError(signal);
								fetched.push(
									failedFetch(result.url, "markdown", errorMessage(error)),
								);
							}
						}
					}
					perQuery.push({
						query,
						resultCount: outcome.resultCount,
						results: outcome.results,
						fetched,
					});
				} catch (error) {
					if (signal?.aborted) throw abortError(signal);
					perQuery.push({
						query,
						resultCount: 0,
						results: [],
						fetched: [],
						error:
							error instanceof SearxngError
								? error.message
								: errorMessage(error),
					});
				}
			}

			const successfulQueries = perQuery.filter((result) => !result.error);
			if (successfulQueries.length === 0) {
				throw new Error(
					`SearXNG search failed for all ${queryList.length} query(ies): ${perQuery[0]?.error ?? "unknown error"}`,
				);
			}

			const output = perQuery
				.map((result) =>
					result.error
						? `## "${result.query}" — error\n\n${result.error}`
						: `${formatSearchHits(result.query, result.results)}${formatFetchedSources(result.fetched)}`,
				)
				.join("\n\n---\n\n");
			const inline = truncateForInline(output);
			const totalHits = perQuery.reduce(
				(total, result) => total + result.resultCount,
				0,
			);

			return toolResult(inline.text, {
				tier: "searxng",
				provider: "searxng",
				requestedProvider: params.provider,
				queryCount: perQuery.length,
				totalHits,
				includeContent,
				truncated: inline.truncated,
				queries: perQuery.map((result) => ({
					query: result.query,
					resultCount: result.resultCount,
					fetched: result.fetched.length,
					...(result.error ? { error: result.error } : {}),
				})),
			});
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch HTTP(S) URL(s) with a self-hosted browser and return content inline. The initial URL is SSRF-validated, Camofox provides Readability or accessibility-snapshot extraction, and blocked/empty pages escalate to optional CloakBrowser. This lean backend does not support video frame analysis, repository cloning, response IDs, or get_search_content.",
		promptSnippet:
			"Use to extract readable content from HTTP(S) URL(s) through Camofox with CloakBrowser fallback.",
		promptGuidelines: [
			"fetch_content returns extracted content inline and does not provide get_search_content response IDs.",
			"fetch_content supports web pages only; do not request video frames or repository cloning from it.",
			"Use urls for several pages; the tool includes a bounded content section for every successful URL.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single HTTP(S) URL." })),
			urls: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple HTTP(S) URLs fetched sequentially.",
				}),
			),
			prompt: Type.Optional(
				Type.String({
					description:
						"Accepted for pi-web-access call compatibility; ignored for web pages.",
				}),
			),
			format: Type.Optional(
				StringEnum(["markdown", "text", "html"] as const, {
					description: "Output format (default markdown).",
				}),
			),
			forceClone: Type.Optional(
				Type.Boolean({
					description:
						"Compatibility field; repository cloning is unsupported by this backend.",
				}),
			),
			timestamp: Type.Optional(
				Type.String({
					description:
						"Compatibility field; video timestamps are unsupported by this backend.",
				}),
			),
			frames: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 12,
					description:
						"Compatibility field; video frames are unsupported by this backend.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Compatibility field; video model overrides are unsupported by this backend.",
				}),
			),
		}),

		async execute(_callId, params, signal, onUpdate) {
			throwIfAborted(signal);
			if (
				params.forceClone === true ||
				params.timestamp !== undefined ||
				params.frames !== undefined ||
				params.model !== undefined
			) {
				throw new Error(
					"This self-hosted fetch_content backend supports web pages only; repository cloning and video analysis options are unavailable.",
				);
			}

			const urlList = normalizeInputList(params.urls, params.url);
			if (urlList.length === 0) {
				throw new Error("No URL provided. Use url or urls.");
			}
			const format = (params.format as OutputFormat | undefined) ?? "markdown";

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Fetching ${urlList.length} URL(s) via Camofox → CloakBrowser…`,
					},
				],
				details: { phase: "fetch", urlCount: urlList.length },
			});

			const results: FetchResult[] = [];
			for (let index = 0; index < urlList.length; index++) {
				throwIfAborted(signal);
				const url = urlList[index];
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Fetching (${index + 1}/${urlList.length}) ${url}`,
						},
					],
					details: { phase: "fetch", url, index },
				});
				try {
					results.push(await fetchUrl(url, format, signal));
				} catch (error) {
					if (signal?.aborted) throw abortError(signal);
					results.push(failedFetch(url, format, errorMessage(error)));
				}
			}

			const successful = results.filter(
				(result) => !result.error && result.content,
			);
			if (successful.length === 0) {
				throw new Error(
					`Failed to fetch ${urlList.length} URL(s): ${results.map((result) => `${result.url}: ${result.error ?? "no content"}`).join("; ")}`,
				);
			}

			if (urlList.length === 1) {
				const result = successful[0];
				const inline = truncateForInline(result.content);
				return toolResult(inline.text || "(no content extracted)", {
					url: result.url,
					finalUrl: result.finalUrl,
					title: result.title,
					tier: result.tier,
					format: result.format,
					chars: result.chars,
					truncated: result.truncated || inline.truncated,
					challengeStrategy: result.challengeStrategy,
					challengeResolved: result.challengeResolved,
				});
			}

			const perUrlLimit = Math.max(
				1_000,
				Math.floor(
					(MAX_INLINE_CONTENT - 2_000) / Math.max(successful.length, 1),
				),
			);
			const sections = results.map((result) => {
				if (result.error || !result.content) {
					return `## ${result.url}\n\nError: ${result.error ?? "no content"}`;
				}
				const inline = truncateForInline(result.content, perUrlLimit);
				return [
					`## ${result.title ?? result.url}`,
					`Source: ${result.finalUrl ?? result.url}`,
					`Backend: ${result.tier} · Format: ${result.format} · ${result.chars} chars`,
					inline.text,
				].join("\n\n");
			});
			const combined = truncateForInline(sections.join("\n\n---\n\n"));

			return toolResult(combined.text, {
				urlCount: urlList.length,
				successful: successful.length,
				truncated:
					combined.truncated || results.some((result) => result.truncated),
				results: results.map((result) => ({
					url: result.url,
					finalUrl: result.finalUrl,
					title: result.title,
					tier: result.tier,
					format: result.format,
					chars: result.chars,
					truncated: result.truncated,
					challengeStrategy: result.challengeStrategy,
					challengeResolved: result.challengeResolved,
					...(result.error ? { error: result.error } : {}),
				})),
			});
		},
	});
}
