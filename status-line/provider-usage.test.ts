import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsageEndpointConfig } from "./config.ts";
import {
	fetchProviderUsage,
	formatProviderUsage,
	mapProviderUsage,
	providerUsageWindows,
	resolveEnvironmentTemplate,
} from "./provider-usage.ts";

const subscriptionMapping = {
	used: "subscription.requests",
	limit: "subscription.limit",
	renewsAt: "subscription.renewsAt",
};

const config: ProviderUsageEndpointConfig = {
	endpoint: "https://api.synthetic.new/v2/quotas",
	label: "Synthetic",
	headers: { Authorization: "Bearer ${SYNTHETIC_API_KEY}" },
	mapping: subscriptionMapping,
};

const windowsConfig: ProviderUsageEndpointConfig = {
	endpoint: config.endpoint,
	headers: config.headers,
	windows: {
		requests: { label: "synthetic", mapping: subscriptionMapping },
		weekly: {
			label: "wk",
			mapping: {
				text: "weeklyTokenLimit.remainingCredits",
				renewsAt: "weeklyTokenLimit.nextRegenAt",
			},
		},
	},
};

test("providerUsageWindows expands legacy mapping and named windows", () => {
	assert.deepEqual(providerUsageWindows(config), [
		{ name: "default", label: "Synthetic", mapping: subscriptionMapping },
	]);
	assert.deepEqual(
		providerUsageWindows(windowsConfig).map((window) => window.name),
		["requests", "weekly"],
	);
	assert.deepEqual(providerUsageWindows({ endpoint: "https://x.dev", headers: {} }), []);
});

test("mapProviderUsage maps nested quota values", () => {
	const usage = mapProviderUsage(
		"synthetic",
		"Synthetic",
		subscriptionMapping,
		{
			subscription: {
				limit: 135,
				requests: 27,
				renewsAt: "2030-01-02T00:00:00.000Z",
			},
		},
	);

	assert.deepEqual(usage, {
		provider: "synthetic",
		label: "Synthetic",
		used: 27,
		limit: 135,
		remaining: 108,
		remainingPercent: 80,
		renewsAt: "2030-01-02T00:00:00.000Z",
		text: undefined,
	});
});

test("fetchProviderUsage maps every window from one request", async () => {
	const previous = process.env.SYNTHETIC_API_KEY;
	process.env.SYNTHETIC_API_KEY = "test-key";
	try {
		let requests = 0;
		const usages = await fetchProviderUsage(
			"synthetic",
			windowsConfig,
			1_000,
			async (_input, init) => {
				requests += 1;
				assert.equal(
					new Headers(init?.headers).get("Authorization"),
					"Bearer test-key",
				);
				return new Response(
					JSON.stringify({
						subscription: { limit: 135, requests: 0 },
						weeklyTokenLimit: {
							remainingCredits: "$23.21",
							nextRegenAt: "2030-01-02T18:55:08.000Z",
						},
					}),
					{ status: 200 },
				);
			},
		);
		assert.equal(requests, 1);
		assert.equal(usages.length, 2);
		assert.equal(usages[0]?.remainingPercent, 100);
		assert.equal(usages[1]?.label, "wk");
		assert.equal(usages[1]?.text, "$23.21");
	} finally {
		if (previous === undefined) delete process.env.SYNTHETIC_API_KEY;
		else process.env.SYNTHETIC_API_KEY = previous;
	}
});

test("resolveEnvironmentTemplate fails closed for missing variables", () => {
	const name = "AIO_STATUS_LINE_DEFINITELY_MISSING";
	const previous = process.env[name];
	delete process.env[name];
	try {
		assert.equal(resolveEnvironmentTemplate(`Bearer ${"${"}${name}}`), undefined);
		assert.equal(resolveEnvironmentTemplate("cost $$5"), "cost $5");
	} finally {
		if (previous !== undefined) process.env[name] = previous;
	}
});

test("formatProviderUsage includes compact reset timing", () => {
	assert.equal(
		formatProviderUsage({
			provider: "custom",
			label: "Custom",
			remainingPercent: 25,
			renewsAt: "2030-01-03T00:00:00.000Z",
		}, Date.parse("2030-01-01T00:00:00.000Z")),
		"Custom 25% left, resets 2d",
	);
});
