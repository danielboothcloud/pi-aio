import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { exaSearch } from "./exa.ts";

let delayMs = 0;
let lastApiKey = "";
let lastBody: Record<string, any> = {};
const server = createServer(async (request, response) => {
	lastApiKey = String(request.headers["x-api-key"] ?? "");
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	response.setHeader("content-type", "application/json");
	response.end(
		JSON.stringify({
			results: [
				{
					title: "Exa result",
					url: "https://example.com/exa",
					publishedDate: "2026-01-01",
					highlights: ["First highlight", "Second highlight"],
				},
				{ title: "Missing URL" },
			],
		}),
	);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
process.env.TEST_EXA_API_KEY = "test-key";

after(async () => {
	delete process.env.TEST_EXA_API_KEY;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

test("exaSearch maps filters and normalizes search results", async () => {
	const result = await exaSearch(
		"release notes",
		{
			numResults: 3,
			timeRange: "month",
			includeDomains: ["example.com"],
			excludeDomains: ["ads.example.com"],
		},
		undefined,
		{
			baseUrl,
			apiKeyEnv: "TEST_EXA_API_KEY",
			searchType: "fast",
		},
	);

	assert.equal(lastApiKey, "test-key");
	assert.equal(lastBody.query, "release notes");
	assert.equal(lastBody.type, "fast");
	assert.equal(lastBody.numResults, 3);
	assert.deepEqual(lastBody.includeDomains, ["example.com"]);
	assert.deepEqual(lastBody.excludeDomains, ["ads.example.com"]);
	assert.match(lastBody.startPublishedDate, /^\d{4}-\d{2}-\d{2}$/);
	assert.deepEqual(lastBody.contents, {
		highlights: { maxCharacters: 1_000 },
	});
	assert.equal(result.resultCount, 1);
	assert.equal(result.results[0].engine, "exa");
	assert.equal(
		result.results[0].snippet,
		"First highlight … Second highlight",
	);
});

test("exaSearch fails clearly when its configured API key is missing", async () => {
	await assert.rejects(
		exaSearch("test", {}, undefined, {
			baseUrl,
			apiKeyEnv: "MISSING_EXA_API_KEY",
		}),
		/MISSING_EXA_API_KEY/,
	);
});

test("exaSearch honors cancellation while awaiting the backend", async () => {
	delayMs = 1_000;
	const controller = new AbortController();
	const pending = exaSearch("slow", {}, controller.signal, {
		baseUrl,
		apiKeyEnv: "TEST_EXA_API_KEY",
	});
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(pending, (error: any) => error?.name === "AbortError");
	delayMs = 0;
});
