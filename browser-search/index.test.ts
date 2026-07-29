import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectChallenge } from "./challenges.ts";
import {
	fetchSingleUrl,
	isLikelyChallengeContent,
	registerBrowserSearch,
	type BrowserSearchDependencies,
} from "./index.ts";
import type { FetchResult, SearxngSearchOutcome } from "./types.ts";

interface TestTool {
	name: string;
	parameters: { properties: Record<string, unknown> };
	execute: (
		callId: string,
		params: Record<string, any>,
		signal?: AbortSignal,
		onUpdate?: (update: unknown) => void,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, any>;
	}>;
}

function searchOutcome(
	query: string,
	urls: string[] = ["https://8.8.8.8/a"],
): SearxngSearchOutcome {
	return {
		ok: true,
		query,
		parameters: {
			lang: null,
			categories: "general",
			timeRange: null,
			engines: null,
			page: 1,
		},
		resultCount: urls.length,
		results: urls.map((url, index) => ({
			title: `Result ${index + 1}`,
			url,
			snippet: `Snippet ${index + 1}`,
			engine: "mock",
			category: "general",
			publishedDate: null,
		})),
	};
}

function fetched(url: string, content = `Body for ${url}`): FetchResult {
	return {
		url,
		title: url.endsWith("/a") ? "Page A" : "Page B",
		content,
		format: "markdown",
		chars: content.length,
		truncated: false,
		tier: "camofox",
	};
}

function failed(url: string, message = "backend down"): FetchResult {
	return {
		url,
		content: "",
		format: "markdown",
		chars: 0,
		truncated: false,
		tier: "none",
		error: message,
	};
}

function createHarness(dependencies: BrowserSearchDependencies = {}) {
	const tools = new Map<string, TestTool>();
	const pi = {
		registerTool(tool: TestTool) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerBrowserSearch(pi, dependencies);
	return { tools };
}

function getTool(tools: Map<string, TestTool>, name: string): TestTool {
	const tool = tools.get(name);
	assert.ok(tool, `${name} should be registered`);
	return tool;
}

test("registerBrowserSearch exposes only the two drop-in tool names", () => {
	const { tools } = createHarness();
	assert.deepEqual([...tools.keys()], ["web_search", "fetch_content"]);
});

test("the root AIO extension wires browser-search registration", () => {
	const rootSource = readFileSync(
		new URL("../index.ts", import.meta.url),
		"utf8",
	);
	assert.match(rootSource, /import \{ registerBrowserSearch \}/);
	assert.match(rootSource, /registerBrowserSearch\(pi\)/);
});

test("schemas retain pi-web-access compatibility fields", () => {
	const { tools } = createHarness();
	const searchProperties = getTool(tools, "web_search").parameters.properties;
	for (const field of [
		"query",
		"queries",
		"numResults",
		"includeContent",
		"recencyFilter",
		"domainFilter",
		"provider",
		"workflow",
	]) {
		assert.ok(field in searchProperties, `web_search.${field}`);
	}

	const fetchProperties = getTool(tools, "fetch_content").parameters.properties;
	for (const field of [
		"url",
		"urls",
		"prompt",
		"forceClone",
		"timestamp",
		"frames",
		"model",
	]) {
		assert.ok(field in fetchProperties, `fetch_content.${field}`);
	}
});

test("an already-aborted fetch rejects before invoking a backend", async () => {
	let calls = 0;
	const { tools } = createHarness({
		fetchUrl: async (url) => {
			calls++;
			return fetched(url);
		},
	});
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		getTool(tools, "fetch_content").execute(
			"fetch-aborted",
			{ url: "https://8.8.8.8/a" },
			controller.signal,
		),
		(error: any) => error?.name === "AbortError",
	);
	assert.equal(calls, 0);
});

test("backend failures reject instead of returning error-shaped successes", async () => {
	const { tools } = createHarness({
		search: async () => {
			throw new Error("searx unavailable");
		},
		fetchUrl: async (url) => failed(url, "browsers unavailable"),
	});

	await assert.rejects(
		getTool(tools, "web_search").execute("search-fail", { query: "test" }),
		/SearXNG search failed.*searx unavailable/,
	);
	await assert.rejects(
		getTool(tools, "fetch_content").execute("fetch-fail", {
			url: "https://8.8.8.8/a",
		}),
		/Failed to fetch.*browsers unavailable/,
	);
});

test("multi-URL fetch returns bounded content for every successful URL", async () => {
	const urls = ["https://8.8.8.8/a", "https://8.8.8.8/b"];
	const { tools } = createHarness({
		fetchUrl: async (url) => fetched(url),
	});
	const result = await getTool(tools, "fetch_content").execute("fetch-many", {
		urls,
	});

	assert.match(result.content[0].text, /Body for https:\/\/8\.8\.8\.8\/a/);
	assert.match(result.content[0].text, /Body for https:\/\/8\.8\.8\.8\/b/);
	assert.equal(result.details.successful, 2);
	assert.equal(result.details.urlCount, 2);
});

test("multi-URL fetch preserves successful content alongside per-URL errors", async () => {
	const { tools } = createHarness({
		fetchUrl: async (url) =>
			url.endsWith("/a") ? fetched(url) : failed(url, "blocked"),
	});
	const result = await getTool(tools, "fetch_content").execute(
		"fetch-partial",
		{
			urls: ["https://8.8.8.8/a", "https://8.8.8.8/b"],
		},
	);

	assert.match(result.content[0].text, /Body for https:\/\/8\.8\.8\.8\/a/);
	assert.match(result.content[0].text, /Error: blocked/);
	assert.equal(result.details.successful, 1);
});

test("web_search applies compatibility filters and can include fetched content", async () => {
	let receivedQuery = "";
	let receivedOptions: Record<string, unknown> = {};
	const search: NonNullable<BrowserSearchDependencies["search"]> = async (
		query,
		options,
	) => {
		receivedQuery = query;
		receivedOptions = options;
		return searchOutcome(query);
	};
	const { tools } = createHarness({
		search,
		fetchUrl: async (url) => fetched(url, "Fetched article"),
	});
	const result = await getTool(tools, "web_search").execute("search-content", {
		query: "release notes",
		domainFilter: ["example.com", "-ads.example.com"],
		recencyFilter: "month",
		provider: "brave",
		includeContent: true,
	});

	assert.match(receivedQuery, /site:example\.com/);
	assert.match(receivedQuery, /-site:ads\.example\.com/);
	assert.equal(receivedOptions.timeRange, "month");
	assert.match(result.content[0].text, /Fetched article/);
	assert.equal(result.details.provider, "searxng");
	assert.equal(result.details.requestedProvider, "brave");
});

test("unsupported video and clone options fail clearly", async () => {
	const { tools } = createHarness({ fetchUrl: async (url) => fetched(url) });
	await assert.rejects(
		getTool(tools, "fetch_content").execute("fetch-video", {
			url: "https://8.8.8.8/a",
			frames: 2,
		}),
		/web pages only/,
	);
});

test("fetchSingleUrl blocks loopback before contacting browser backends", async () => {
	await assert.rejects(
		fetchSingleUrl("http://127.0.0.1/private", "markdown"),
		/URL blocked: Blocked IP/,
	);
});

test("challenge detection recognizes anti-bot pages and ignores articles", () => {
	assert.equal(
		isLikelyChallengeContent(
			"https://example.com",
			"Just a moment",
			"Checking your browser before accessing the site",
		),
		true,
	);
	assert.equal(
		detectChallenge({
			url: "https://example.com/cdn-cgi/challenge",
			cookies: [{ name: "__cf_bm" }],
			html: "<title>Just a moment</title><script src='/cdn-cgi/challenge-platform/x.js'></script>",
		})?.name,
		"cloudflare",
	);
	assert.equal(
		detectChallenge({
			url: "https://example.com",
			cookies: [{ name: "ak_bmsc" }],
			html: "Akamai challenge",
		})?.name,
		"akamai",
	);
	assert.equal(
		detectChallenge({
			url: "https://example.com/article",
			html: "<article><h1>Normal page</h1><p>Readable text</p></article>",
		}),
		null,
	);
});
