import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBrowserSearchConfig } from "./config.ts";

test("Pi project settings override and extend global browser-search settings", () => {
	const config = resolveBrowserSearchConfig(
		{
			aio: {
				browserSearch: {
					provider: "exa",
					exa: {
						apiKeyEnv: "CUSTOM_EXA_KEY",
						searchType: "fast",
					},
				},
			},
		},
		{
			aio: {
				browserSearch: {
					provider: "searxng",
					searxng: { baseUrl: "https://search.example.com/" },
				},
			},
		},
	);

	assert.equal(config.provider, "searxng");
	assert.equal(config.searxng?.baseUrl, "https://search.example.com");
	assert.equal(config.exa?.apiKeyEnv, "CUSTOM_EXA_KEY");
	assert.equal(config.exa?.searchType, "fast");
});

test("missing or invalid provider leaves web search disabled", () => {
	assert.equal(resolveBrowserSearchConfig({}).provider, undefined);
	assert.equal(
		resolveBrowserSearchConfig({
			aio: { browserSearch: { provider: "automatic" } },
		}).provider,
		undefined,
	);
});

test("invalid nested settings are ignored safely", () => {
	const config = resolveBrowserSearchConfig({
		aio: {
			browserSearch: {
				provider: "exa",
				exa: { apiKeyEnv: 42, searchType: "unsupported" },
				searxng: "not-an-object",
			},
		},
	});

	assert.equal(config.provider, "exa");
	assert.equal(config.exa?.apiKeyEnv, undefined);
	assert.equal(config.exa?.searchType, undefined);
	assert.equal(config.searxng?.baseUrl, undefined);
});
