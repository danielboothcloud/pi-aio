import assert from "node:assert/strict";
import test from "node:test";
import {
	codexQuotaRole,
	codexQuotaText,
	hasNativeCodexRoute,
	parseCodexQuota,
	resolveCodexToken,
} from "./codex-quota.ts";

function payload(usedPercent: number, seconds: number): unknown {
	return { rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: seconds } } };
}

test("parseCodexQuota maps the 5h and weekly windows to remaining percent", () => {
	// used_percent 12 → 88% remaining; 3 → 97% remaining.
	assert.deepEqual(
		parseCodexQuota({
			rate_limit: {
				primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 3, limit_window_seconds: 604_800 },
			},
		}),
		{ fiveHour: 88, week: 97 },
	);
});

test("parseCodexQuota ignores unrecognized windows and missing limits", () => {
	// A window with an unknown duration must not inherit a label.
	assert.equal(parseCodexQuota(payload(10, 60)), undefined);
	// A single recognized window is enough; the other stays absent.
	assert.deepEqual(parseCodexQuota(payload(10, 18_000)), { fiveHour: 90 });
	assert.equal(parseCodexQuota({}), undefined);
	assert.equal(parseCodexQuota({ rate_limit: {} }), undefined);
	assert.equal(parseCodexQuota(null), undefined);
	// Out-of-range percentages are rejected rather than clamped.
	assert.equal(
		parseCodexQuota({ rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 18_000 } } }),
		undefined,
	);
});

test("codexQuotaText renders compact 5h/week windows with staleness", () => {
	assert.equal(codexQuotaText({ fiveHour: 88, week: 97 }), "5h 88% | week 97%");
	assert.equal(codexQuotaText({ fiveHour: 88 }), "5h 88% | week --");
	assert.equal(codexQuotaText({ fiveHour: 88, week: 97, stale: true }), "5h 88% | week 97% stale");
	assert.equal(codexQuotaText(undefined), "");
});

test("codexQuotaRole tiers by the lowest remaining window", () => {
	assert.equal(codexQuotaRole({ fiveHour: 88, week: 97 }), "muted");
	assert.equal(codexQuotaRole({ fiveHour: 40, week: 97 }), "warning");
	assert.equal(codexQuotaRole({ fiveHour: 15, week: 97 }), "error");
	// Staleness downgrades a healthy reading to warning, never to error.
	assert.equal(codexQuotaRole({ fiveHour: 88, week: 97, stale: true }), "warning");
});

test("hasNativeCodexRoute requires provider id, api, and both native base URLs", () => {
	const native = (baseUrl: string) => ({
		getProvider: () => ({ id: "openai-codex", baseUrl }),
	});
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api/codex",
	};

	assert.equal(hasNativeCodexRoute(native("https://chatgpt.com/backend-api/codex") as never, model as never), true);
	// A proxied base URL (extension override) is not the native route.
	assert.equal(hasNativeCodexRoute(native("https://proxy.example.com") as never, model as never), false);
	assert.equal(hasNativeCodexRoute(undefined, model as never), false);
	assert.equal(
		hasNativeCodexRoute(native("https://chatgpt.com/x") as never, { ...model, provider: "openrouter" } as never),
		false,
	);
	assert.equal(
		hasNativeCodexRoute(native("https://chatgpt.com/x") as never, { ...model, api: "openai-responses" } as never),
		false,
	);
});

function nativeModel() {
	return {
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api/codex",
	};
}

function nativeRegistry(apiKey?: string) {
	return {
		getProvider: () => ({ id: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" }),
		getApiKeyAndHeaders: async () =>
			apiKey ? { ok: true, apiKey, headers: undefined } : { ok: false, error: "none" },
	};
}

test("resolveCodexToken reads the OAuth bearer from the host auth surface", async () => {
	const token = await resolveCodexToken(
		nativeRegistry("oauth-access-token") as never,
		nativeModel() as never,
	);
	assert.equal(token, "oauth-access-token");

	// No auth resolved: no token, no fallback into private storage.
	assert.equal(
		await resolveCodexToken(nativeRegistry(undefined) as never, nativeModel() as never),
		undefined,
	);
	// A non-native (proxied) route never yields the token.
	const proxied = nativeRegistry("secret");
	(proxied.getProvider as () => unknown) = () => ({
		id: "openai-codex",
		baseUrl: "https://proxy.example.com",
	});
	assert.equal(await resolveCodexToken(proxied as never, nativeModel() as never), undefined);
	// Registry without auth accessors (older/foreign surface): undefined.
	assert.equal(
		await resolveCodexToken({ getProvider: () => ({ id: "openai-codex", baseUrl: "https://chatgpt.com/x" }) } as never, nativeModel() as never),
		undefined,
	);
});
