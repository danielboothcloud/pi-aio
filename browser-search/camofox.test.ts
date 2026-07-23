import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

let healthDelayMs = 0;
let closedTabs = 0;
const server = createServer(async (request, response) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = chunks.length
		? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
				string,
				unknown
			>)
		: {};
	response.setHeader("content-type", "application/json");

	if (request.method === "GET" && request.url?.startsWith("/health")) {
		if (healthDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
		}
		response.end(JSON.stringify({ browserRunning: true }));
		return;
	}
	if (request.method === "POST" && request.url === "/tabs") {
		response.end(JSON.stringify({ tabId: "tab-1", url: body.url }));
		return;
	}
	if (request.method === "POST" && request.url === "/tabs/tab-1/evaluate") {
		response.end(
			JSON.stringify({
				result: JSON.stringify({
					title: "Mock article",
					text: "Readable body",
					excerpt: "Readable",
					length: 13,
				}),
			}),
		);
		return;
	}
	if (request.method === "DELETE" && request.url === "/tabs/tab-1") {
		closedTabs++;
		response.end(JSON.stringify({ closed: true }));
		return;
	}

	response.statusCode = 404;
	response.end(JSON.stringify({ error: request.url }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
process.env.BROWSER_SEARCH_CAMOFOX_BASE = `http://127.0.0.1:${address.port}`;

const { health, readability } = await import("./camofox.ts");

after(async () => {
	delete process.env.BROWSER_SEARCH_CAMOFOX_BASE;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

test("Camofox readability extracts an article and closes its tab", async () => {
	const [result] = await readability(["https://8.8.8.8/article"]);
	assert.equal(result.error, undefined);
	assert.equal(result.readability?.title, "Mock article");
	assert.equal(result.readability?.text, "Readable body");
	assert.equal(closedTabs, 1);
});

test("Camofox HTTP calls honor cancellation", async () => {
	healthDelayMs = 1_000;
	const controller = new AbortController();
	const pending = health(controller.signal);
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(pending, (error: any) => error?.name === "AbortError");
	healthDelayMs = 0;
});
