import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_STATUS_LINE_CONFIG, loadStatusLineConfig } from "./config.ts";

test("loadStatusLineConfig returns defaults when settings are absent", () => {
	assert.deepEqual(
		loadStatusLineConfig("/does/not/exist", { includeGlobal: false }),
		DEFAULT_STATUS_LINE_CONFIG,
	);
});

test("loadStatusLineConfig ignores invalid segment names", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "aio-status-line-config-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						segments: ["mode", "invalid", "model"],
					},
				},
			}),
			"utf-8",
		);

		const config = loadStatusLineConfig(tmpDir, { includeGlobal: false });
		assert.deepEqual(config.segments, ["mode", "model"]);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("loadStatusLineConfig merges global and project provider usage", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "aio-status-line-merge-config-"));
	try {
		const globalDir = join(tmpDir, "agent");
		const projectDir = join(tmpDir, "project");
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(globalDir, "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						providerUsage: {
							refreshIntervalMs: 30_000,
							providers: {
								synthetic: {
									endpoint: "https://api.synthetic.new/v2/quotas",
									mapping: { used: "subscription.requests" },
								},
							},
						},
					},
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						providerUsage: {
							timeoutMs: 2_000,
							providers: {
								custom: {
									endpoint: "https://quota.example.test",
									mapping: { remaining: "quota.remaining" },
								},
							},
						},
					},
				},
			}),
			"utf-8",
		);

		const config = loadStatusLineConfig(projectDir, { globalDir });
		assert.equal(config.providerUsage?.refreshIntervalMs, 30_000);
		assert.equal(config.providerUsage?.timeoutMs, 2_000);
		assert.deepEqual(Object.keys(config.providerUsage?.providers ?? {}).sort(), [
			"custom",
			"synthetic",
		]);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("loadStatusLineConfig parses provider usage endpoints and mappings", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "aio-status-line-usage-config-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						providerUsage: {
							refreshIntervalMs: 30_000,
							timeoutMs: 2_000,
							providers: {
								synthetic: {
									endpoint: "https://api.synthetic.new/v2/quotas",
									headers: { Authorization: "Bearer ${SYNTHETIC_API_KEY}" },
									mapping: {
										used: "subscription.requests",
										limit: "subscription.limit",
										renewsAt: "subscription.renewsAt",
									},
								},
							},
						},
					},
				},
			}),
			"utf-8",
		);

		const config = loadStatusLineConfig(tmpDir, { includeGlobal: false });
		assert.equal(config.providerUsage?.refreshIntervalMs, 30_000);
		assert.equal(config.providerUsage?.timeoutMs, 2_000);
		assert.deepEqual(config.providerUsage?.providers.synthetic?.mapping, {
			used: "subscription.requests",
			limit: "subscription.limit",
			renewsAt: "subscription.renewsAt",
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("loadStatusLineConfig parses named provider usage windows", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "aio-status-line-usage-windows-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "settings.json"),
			JSON.stringify({
				aio: {
					statusLine: {
						providerUsage: {
							providers: {
								custom: {
									endpoint: "https://quota.custom.dev/v2/usage",
									headers: { Authorization: "Bearer ${CUSTOM_KEY}" },
									windows: {
										credits: {
											label: "credits",
											mapping: { text: "wallet.remaining" },
										},
										rate: {
											mapping: {
												used: "limits.used",
												limit: "limits.max",
											},
										},
									},
								},
							},
						},
					},
				},
			}),
			"utf-8",
		);

		const config = loadStatusLineConfig(tmpDir, { includeGlobal: false });
		assert.deepEqual(
			config.providerUsage?.providers.custom?.windows?.credits,
			{ label: "credits", mapping: { text: "wallet.remaining" } },
		);
		assert.deepEqual(
			config.providerUsage?.providers.custom?.windows?.rate?.mapping,
			{ used: "limits.used", limit: "limits.max" },
		);
		assert.equal(config.providerUsage?.providers.custom?.mapping, undefined);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
