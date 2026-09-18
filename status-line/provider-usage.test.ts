import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsageEndpointConfig } from "./config.ts";
import {
	fetchProviderUsage,
	formatProviderUsage,
	mapProviderUsage,
	resolveEnvironmentTemplate,
} from "./provider-usage.ts";

const config: ProviderUsageEndpointConfig = {
	endpoint: "https://api.synthetic.new/v2/quotas",
	label: "Synthetic",
	headers: { Authorization: "Bearer ${SYNTHETIC_API_KEY}" },
	mapping: {
		used: "subscription.requests",
		limit: "subscription.limit",
		renewsAt: "subscription.renewsAt",
	},
};

test("mapProviderUsage maps nested quota values", () => {
	const usage = mapProviderUsage("synthetic", config, {
		subscription: {
			limit: 135,
			requests: 27,
			renewsAt: "2030-01-02T00:00:00.000Z",
		},
	});

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

test("fetchProviderUsage resolves environment-backed headers", async () => {
	const previous = process.env.SYNTHETIC_API_KEY;
	process.env.SYNTHETIC_API_KEY = "test-key";
	try {
		let authorization: string | null = null;
		const usage = await fetchProviderUsage(
			"synthetic",
			config,
			1_000,
			async (_input, init) => {
				authorization = new Headers(init?.headers).get("Authorization");
				return new Response(
					JSON.stringify({
						subscription: { limit: 135, requests: 0 },
					}),
					{ status: 200 },
				);
			},
		);
		assert.equal(authorization, "Bearer test-key");
		assert.equal(usage?.remainingPercent, 100);
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
		formatProviderUsage(
			{
				provider: "custom",
				label: "Custom",
				remainingPercent: 25,
				renewsAt: "2030-01-03T00:00:00.000Z",
			},
			Date.parse("2030-01-01T00:00:00.000Z"),
		),
		"Custom 25% left, resets 2d",
	);
});

test("formatProviderUsage strips terminal controls from mapped text", () => {
	assert.equal(
		formatProviderUsage({
			provider: "custom",
			label: "Custom\nQuota",
			text: "ok\u001b[31m\rnow",
		}),
		"Custom Quota ok [31m now",
	);
});
