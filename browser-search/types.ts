/** Shared normalized types for the browser-search module. */

/** A single normalized search hit from any configured provider. */
export interface SearchResult {
	title: string | null;
	url: string;
	snippet: string | null;
	engine: string | null;
	category: string | null;
	publishedDate: string | null;
}

/** Search options shared by provider adapters. */
export interface SearchOptions {
	lang?: string;
	categories?: string;
	timeRange?: string;
	engines?: string;
	page?: number;
	numResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	baseUrl?: string;
}

/** Normalized result of a provider search call. */
export interface SearchOutcome {
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

/** Backward-compatible names for the SearXNG adapter's public types. */
export type SearxngOptions = SearchOptions;
export type SearxngSearchOutcome = SearchOutcome;

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
