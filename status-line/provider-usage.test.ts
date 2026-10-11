import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderUsageEndpointConfig } from "./config.ts";
import {
	fetchProviderUsage,
	formatProviderUsage,
	mapProviderUsage,
	providerUsageLine,
	providerUsageWindows,
	readPiOAuthToken,
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

test("mapProviderUsage inverts usedPercent into a remaining percentage", () => {
	const usage = mapProviderUsage(
		"anthropic",
		"Claude",
		{
			usedPercent: "five_hour.utilization",
			renewsAt: "five_hour.resets_at",
		},
		{
			five_hour: {
				utilization: 37,
				resets_at: "2030-01-01T05:00:00.000Z",
			},
		},
	);
	assert.equal(usage?.remainingPercent, 63);
	assert.equal(usage?.renewsAt, "2030-01-01T05:00:00.000Z");
	assert.equal(
		mapProviderUsage("anthropic", "Claude", { usedPercent: "u" }, { u: 140 })
			?.remainingPercent,
		0,
	);
});

const anthropicWindowsConfig: ProviderUsageEndpointConfig = {
	endpoint: "https://api.anthropic.com/api/oauth/usage",
	headers: {},
	auth: "pi-oauth",
	windows: {
		fiveHour: {
			label: "5h",
			mapping: {
				usedPercent: "five_hour.utilization",
				renewsAt: "five_hour.resets_at",
			},
		},
		sevenDay: {
			label: "7d",
			mapping: {
				usedPercent: "seven_day.utilization",
				renewsAt: "seven_day.resets_at",
			},
		},
	},
};

const anthropicPayload = JSON.stringify({
	five_hour: { utilization: 37, resets_at: "2030-01-01T05:00:00.000Z" },
	seven_day: { utilization: 4, resets_at: "2030-01-02T05:00:00.000Z" },
});

test("fetchProviderUsage authenticates pi-oauth endpoints from auth.json", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "aio-status-line-oauth-"));
	try {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				anthropic: { type: "oauth", access: "sk-ant-oat-test" },
			}),
			"utf-8",
		);
		const usages = await fetchProviderUsage(
			"anthropic",
			anthropicWindowsConfig,
			1_000,
			async (_input, init) => {
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("Authorization"), "Bearer sk-ant-oat-test");
				assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
				return new Response(anthropicPayload, { status: 200 });
			},
			undefined,
			(account) => readPiOAuthToken(account, agentDir),
		);
		assert.equal(usages.length, 2);
		assert.equal(usages[0]?.label, "5h");
		assert.equal(usages[0]?.remainingPercent, 63);
		assert.equal(usages[0]?.renewsAt, "2030-01-01T05:00:00.000Z");
		assert.equal(usages[1]?.label, "7d");
		assert.equal(usages[1]?.remainingPercent, 96);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("fetchProviderUsage fails closed when the pi-oauth token is missing", async () => {
	let requested = 0;
	await assert.rejects(
		fetchProviderUsage(
			"anthropic",
			anthropicWindowsConfig,
			1_000,
			async () => {
				requested += 1;
				return new Response(anthropicPayload, { status: 200 });
			},
			undefined,
			() => undefined,
		),
		/No pi OAuth token for provider anthropic/,
	);
	assert.equal(requested, 0);
});

test("readPiOAuthToken reads oauth credentials and skips api keys", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "aio-status-line-token-"));
	try {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				anthropic: { type: "oauth", access: "sk-ant-oat-test" },
				cursor: { type: "api_key", key: "sk-key" },
			}),
			"utf-8",
		);
		assert.equal(readPiOAuthToken("anthropic", agentDir), "sk-ant-oat-test");
		assert.equal(readPiOAuthToken("cursor", agentDir), undefined);
		assert.equal(readPiOAuthToken("missing", agentDir), undefined);
		assert.equal(readPiOAuthToken("anthropic", join(agentDir, "nope")), undefined);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("providerUsageLine joins windows and tiers by lowest remaining", () => {
	const now = Date.parse("2030-01-01T00:00:00.000Z");
	assert.equal(providerUsageLine([], now), undefined);
	assert.deepEqual(providerUsageLine([
		{ provider: "synthetic", label: "synthetic", remainingPercent: 100, renewsAt: "2030-01-01T05:00:00.000Z" },
		{ provider: "synthetic", label: "wk", text: "$23.88", renewsAt: "2030-01-01T02:00:00.000Z" },
	], now), {
		text: "synthetic 100% →5h · wk $23.88 →2h",
		role: "muted",
	});
	assert.equal(
		providerUsageLine([{ provider: "p", label: "p", remainingPercent: 10 }], now)?.role,
		"error",
	);
	assert.equal(
		providerUsageLine([{ provider: "p", label: "p", remainingPercent: 40 }], now)?.role,
		"warning",
	);
});

test("formatProviderUsage includes compact reset timing", () => {
	assert.equal(
		formatProviderUsage({
			provider: "custom",
			label: "Custom",
			remainingPercent: 25,
			renewsAt: "2030-01-03T00:00:00.000Z",
		}, Date.parse("2030-01-01T00:00:00.000Z")),
		"Custom 25% →2d",
	);
});
