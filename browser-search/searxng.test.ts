import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

let delayMs = 0;
let lastUrl = "";
const server = createServer(async (request, response) => {
	lastUrl = request.url ?? "";
	if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	response.setHeader("content-type", "application/json");
	response.end(
		JSON.stringify({
			query: "normalized query",
			results: [
				{
					title: "One",
					url: "https://example.com/1",
					content: "First",
					engine: "mock",
					category: "general",
				},
				{
					title: "Two",
					url: "https://example.com/2",
					content: "Second",
					engine: "mock",
					category: "general",
				},
				{ title: "Missing URL" },
			],
		}),
	);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
process.env.BROWSER_SEARCH_SEARXNG_BASE = `http://127.0.0.1:${address.port}`;

const { searxngSearch } = await import("./searxng.ts");

after(async () => {
	delete process.env.BROWSER_SEARCH_SEARXNG_BASE;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

test("searxngSearch maps options, normalizes hits, and applies result limits", async () => {
	const result = await searxngSearch("release notes", {
		lang: "en",
		categories: "news",
		timeRange: "month",
		engines: "google,wikipedia",
		page: 2,
		numResults: 1,
	});
	const requested = new URL(lastUrl, "http://localhost");

	assert.equal(requested.searchParams.get("q"), "release notes");
	assert.equal(requested.searchParams.get("language"), "en");
	assert.equal(requested.searchParams.get("categories"), "news");
	assert.equal(requested.searchParams.get("time_range"), "month");
	assert.equal(requested.searchParams.get("engines"), "google,wikipedia");
	assert.equal(requested.searchParams.get("pageno"), "2");
	assert.equal(result.query, "normalized query");
	assert.equal(result.resultCount, 1);
	assert.equal(result.results[0].title, "One");
});

test("searxngSearch honors cancellation while awaiting the backend", async () => {
	delayMs = 1_000;
	const controller = new AbortController();
	const pending = searxngSearch("slow", {}, controller.signal);
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(pending, (error: any) => error?.name === "AbortError");
	delayMs = 0;
});
