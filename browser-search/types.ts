/**
 * Shared types for the browser-search module.
 *
 * These mirror the field names the upstream `browser-search` scripts emit on
 * stdout, so anything consuming the original JSON output sees a familiar shape.
 */

/** A single SearXNG search hit. */
export interface SearchResult {
	title: string | null;
	url: string;
	snippet: string | null;
	engine: string | null;
	category: string | null;
	publishedDate: string | null;
}

/** Normalized result of a SearXNG search call. */
export interface SearxngSearchOutcome {
	ok: true;
	query: string;
	parameters: {
		lang: string | null;
		categories: string | null;
		timeRange: string | null;
		engines: string | null;
		page: number;
	};
	resultCount: number;
	results: SearchResult[];
}

/** Output of the Readability extraction (matches Mozilla Readability's Article). */
export interface ReadabilityArticle {
	title: string | null;
	text: string | null;
	excerpt: string | null;
	length: number;
	/** Source HTML length in chars (for truncation decisions). */
	htmlLength: number;
}

/** Result of browsing a single URL through Camofox + Cloak fallback. */
export interface FetchResult {
	url: string;
	/** Final URL after redirects, when known. */
	finalUrl?: string;
	title?: string;
	content: string;
	/** "markdown" | "text" | "html" — what `content` is. */
	format: "markdown" | "text" | "html";
	chars: number;
	truncated: boolean;
	/** Which tier produced the content, or none when every backend failed. */
	tier: "camofox" | "cloak" | "none";
	/** If the cloak tier handled an anti-bot challenge. */
	challengeStrategy?: string | null;
	challengeResolved?: boolean;
	error?: string;
}

/** Search options accepted by the SearXNG client. */
export interface SearxngOptions {
	lang?: string;
	categories?: string;
	timeRange?: string;
	engines?: string;
	page?: number;
	numResults?: number;
}
