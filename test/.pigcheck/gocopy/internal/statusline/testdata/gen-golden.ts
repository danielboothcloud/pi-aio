// Regenerate golden.json from the TypeScript status-line feature (the
// reference):
//   npx tsx go/internal/statusline/testdata/gen-golden.ts [--check]
// It drives the real config.ts (settings loads over fixture agent and
// project folders), render.ts (the footer row at many widths with the ANSI
// test theme), and provider-usage.ts (mappings, environment templates,
// auth.json tokens, fetches over a mocked fetch, and the display text with
// a pinned clock). Fixtures live in testdata/.fixture-<pid>, removed
// afterwards; their path is written as @@ROOT@@.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const NOW = 1_700_000_000_000;
Date.now = () => NOW;
process.env.HOME = join(root, "home");

const config = await import(join(repo, "status-line", "config.ts"));
const render = await import(join(repo, "status-line", "render.ts"));
const usage = await import(join(repo, "status-line", "provider-usage.ts"));
const { CONFIG_DIR_NAME } = await import("@earendil-works/pi-coding-agent");

function placeholders<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null).split(root).join("@@ROOT@@")) as T;
}
const ROLE_CODES = (JSON.parse(readFileSync(join(repo, "go", "internal", "chrome", "testdata", "golden.json"), "utf8")) as { roleCodes: Record<string, number> }).roleCodes;
const ansi = { fg: (role: string, text: string) => `\x1b[${ROLE_CODES[role] ?? 37}m${text}\x1b[39m` };
const plain = { fg: (_role: string, text: string) => text };
const themes: Record<string, { fg(role: string, text: string): string }> = { ansi, plain };

const fileText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
const write = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, fileText(value));
};

// ---- config ----
const anthropic = {
	endpoint: "https://api.anthropic.com/api/oauth/usage", auth: "pi-oauth", label: "Claude",
	refreshIntervalMs: 120_000.4,
	windows: {
		"5h": { label: "5h", mapping: { usedPercent: "five_hour.utilization", renewsAt: "five_hour.resets_at" } },
		week: { label: "week", mapping: { usedPercent: "seven_day.utilization" } },
		"2": { mapping: { used: "x" } },
		empty: { mapping: {} },
		bad: "nope",
		"": { mapping: { used: "y" } },
	},
};
const globalSettings: Record<string, unknown> = {
	none: { theme: "dark" },
	basic: { aio: { statusLine: { enabled: false, segments: ["model", "bogus", "cost"], path: "full", workingMessage: "verbose", statusKeys: ["rtk", "", 5, "fff"] } } },
	invalid: { aio: { statusLine: { enabled: "yes", segments: ["bogus"], path: "tiny", workingMessage: "loud", statusKeys: "rtk" } } },
	emptySegments: { aio: { statusLine: { segments: [], statusKeys: [] } } },
	usage: {
		aio: {
			statusLine: {
				providerUsage: {
					refreshIntervalMs: 1000, timeoutMs: 99_999,
					providers: {
						anthropic,
						synthetic: { endpoint: "https://api.synthetic.new/v2/quotas", headers: { Authorization: "Bearer ${SYN_KEY}", " X-Empty ": " ", "": "x" }, mapping: { remainingPercent: "plan.weekly", text: "", renewsAt: "plan.reset" } },
						ftp: { endpoint: "ftp://example.com/usage", mapping: { used: "a" } },
						broken: { endpoint: "not a url", mapping: { used: "a" } },
						nomapping: { endpoint: "https://example.com/u" },
						" ": { endpoint: "https://example.com/u", mapping: { used: "a" } },
						arr: [1, 2],
					},
				},
			},
		},
	},
	notObject: { aio: { statusLine: "on" } },
	badJson: "{ not json",
	arrayAio: { aio: [1] },
};
const projectSettings: Record<string, unknown> = {
	none: undefined,
	override: { aio: { statusLine: { enabled: true, path: "abbreviated", providerUsage: { timeoutMs: 100, providers: { synthetic: { endpoint: "http://localhost:9999/q", mapping: { used: "u", limit: "l" } }, extra: { endpoint: "https://x.dev/u", mapping: { remaining: "r" } } } } } } },
	segmentsOnly: { aio: { statusLine: { segments: ["tokens", "cost", "tokens"] } } },
};
const loads: unknown[] = [];
for (const [gName, gValue] of Object.entries(globalSettings)) {
	for (const [pName, pValue] of Object.entries(projectSettings)) {
		const dir = join(root, "cfg", `${gName}-${pName}`);
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "work");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		write(join(agentDir, "settings.json"), gValue);
		if (pValue !== undefined) write(join(cwd, CONFIG_DIR_NAME, "settings.json"), pValue);
		for (const includeProject of [true, false]) {
			const loaded = config.loadStatusLineConfig(cwd, { includeProject, globalDir: agentDir });
			const windows = Object.fromEntries(Object.entries(loaded.providerUsage?.providers ?? {}).map(([id, c]) => [id, usage.providerUsageWindows(c)]));
			loads.push({ global: gName, project: pName, includeProject, agentDir, cwd, config: loaded, windows });
		}
	}
}
loads.push({ global: "none", project: "none", includeProject: true, agentDir: join(root, "missing"), cwd: "", config: config.loadStatusLineConfig("", { globalDir: join(root, "missing") }), windows: {} });

// ---- render ----
const statusSets: Record<string, Array<[string, string]>> = {
	none: [],
	mixed: [["zeta", "\x1b[35mZ\x1b[39m"], ["rtk", "rtk on"], ["modes", "hidden"], ["effort", "effort:high"], ["cursor", "L1"], ["style", "\x1b[36m✎ Tutor\x1b[39m"], ["Alpha", "A"], ["codex-quota", "cq"], ["user-bash", "!bash"], ["fff", "fff ok"], ["empty", ""], ["beta", "B"]],
	effortOnly: [["effort", "effort:low"]],
};
const providerUsages: Record<string, unknown[]> = {
	none: [],
	two: [
		{ provider: "anthropic", label: "5h", remainingPercent: 30, renewsAt: new Date(NOW + 2 * 3600_000 + 5000).toISOString() },
		{ provider: "anthropic", label: "week", remainingPercent: 8 },
	],
	text: [{ provider: "x", label: "Pl\x07an\u0085  ", text: "  12 credits\nleft\t " }],
};
const renderInputs: Record<string, Record<string, unknown>> = {
	defaults: { config: config.DEFAULT_STATUS_LINE_CONFIG, cwd: `${process.env.HOME}/projects/app`, model: { provider: "anthropic", id: "claude" }, mode: "default", gitBranch: "main", contextPercent: 42, statuses: "mixed", usageStats: { input: 1234, output: 56, cost: 0.1 }, providerUsage: "two" },
	allSegments: { config: { ...config.DEFAULT_STATUS_LINE_CONFIG, segments: [...config.STATUS_LINE_SEGMENTS], path: "abbreviated" }, cwd: `${process.env.HOME}/a/b/c`, model: { id: "solo" }, mode: "plan", gitBranch: null, contextPercent: 95, statuses: "effortOnly", usageStats: { input: 12_345_678, output: 999, cost: 12.34567 }, providerUsage: "text" },
	statusKeys: { config: { ...config.DEFAULT_STATUS_LINE_CONFIG, statusKeys: ["beta", "rtk", "missing"], path: "full" }, cwd: "C:\\Users\\x\\proj", model: null, mode: "ask", gitBranch: "dev", contextPercent: 72, statuses: "mixed", usageStats: { input: 0, output: 0, cost: 0 }, providerUsage: "none" },
	empty: { config: { ...config.DEFAULT_STATUS_LINE_CONFIG, segments: ["git", "quota", "effort"] }, cwd: "", model: undefined, mode: "auto", gitBranch: null, contextPercent: 0, statuses: "none", usageStats: { input: 0, output: 0, cost: 0 }, providerUsage: "none" },
	abbrevShort: { config: { ...config.DEFAULT_STATUS_LINE_CONFIG, segments: ["path", "tokens", "cost"], path: "abbreviated" }, cwd: `${process.env.HOME}/x`, model: { provider: "p" }, mode: "default", gitBranch: null, contextPercent: 5, statuses: "none", usageStats: { input: 9999, output: 10_000, cost: 1 }, providerUsage: "none" },
};
const renders: unknown[] = [];
for (const [name, input] of Object.entries(renderInputs)) {
	for (const [themeName, theme] of Object.entries(themes)) {
		for (const width of [0, 1, 5, 10, 20, 40, 80, 160, 300]) {
			const out = render.renderStatusLine({
				...input, width, theme,
				extensionStatuses: new Map(statusSets[input.statuses as string]),
				providerUsage: providerUsages[input.providerUsage as string],
			});
			renders.push({ name, theme: themeName, width, out });
		}
	}
}
const contextPercents = [undefined, {}, { tokens: 0, contextWindow: 100 }, { tokens: 50, contextWindow: 0 }, { tokens: 333, contextWindow: 1000 }, { tokens: 125, contextWindow: 1000 }, { tokens: null, contextWindow: 10 }, { tokens: 2000, contextWindow: 1000 }]
	.map((u) => ({ usage: u ?? null, out: render.computeContextPercent({ getContextUsage: () => u }) }));
const statsBranch = [
	{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.25 } } } },
	{ type: "message", message: { role: "user", usage: { input: 99 } } },
	{ type: "message", message: { role: "assistant" } },
	{ type: "message", message: { role: "assistant", usage: { output: 7 } } },
	{ type: "compaction", usage: { input: 1000 } },
];
const usageStats = { branch: statsBranch, out: render.computeUsageStats(statsBranch) };
const working = ["off", "minimal", "verbose"].flatMap((mode) => [
	{ input: 1234, output: 56_789, cost: 0, contextPercent: 33, elapsedSec: 12.345, tps: 4.25 },
	{ input: 0, output: 0, cost: 0, contextPercent: 0, elapsedSec: 0.001, tps: 0 },
].map((stats) => ({ mode, stats, out: render.formatWorkingMessage(mode, stats) ?? null })));

// ---- provider usage ----
const payload = {
	five_hour: { utilization: 23.6, resets_at: new Date(NOW + 90 * 60_000).toISOString() },
	seven_day: { utilization: "71.2" },
	plan: { weekly: 44.4, reset: "2023-11-20T00:00:00Z", text: "\u0007weird\u0085text  " },
	counts: { used: 30, limit: 120, remaining: "15", zero: 0, hex: "0x10", inf: "Infinity", blank: "  " },
	list: [5, { v: 6 }],
	nested: { "a.b": 1, __proto__value: 2 },
};
const mappings = [
	{ usedPercent: "five_hour.utilization", renewsAt: "five_hour.resets_at" },
	{ usedPercent: "seven_day.utilization" },
	{ remainingPercent: "plan.weekly", text: "plan.text" },
	{ used: "counts.used", limit: "counts.limit" },
	{ used: "counts.used", limit: "counts.limit", remaining: "counts.remaining" },
	{ used: "counts.used", limit: "counts.zero" },
	{ limit: "counts.hex" },
	{ used: "counts.inf" },
	{ used: "counts.blank" },
	{ used: "list.0", limit: "list.length" },
	{ used: "list.1.v" },
	{ used: "list.2" },
	{ used: "__proto__.x" },
	{ used: "constructor" },
	{ used: "counts..used" },
	{ text: "five_hour" },
	{ remaining: "counts.remaining" },
	{ remainingPercent: "counts.limit" },
	{ usedPercent: "counts.limit" },
	{},
];
const mapped = mappings.flatMap((mapping) => [undefined, "Label"].map((label) => ({ mapping, label: label ?? null, out: usage.mapProviderUsage("prov", label, mapping, payload) ?? null })));
process.env.UL_TOKEN = "tok";
process.env.UL_EMPTY = "";
delete process.env.UL_MISSING;
const templates = ["plain", "Bearer $UL_TOKEN", "Bearer ${UL_TOKEN}!", "$$UL_TOKEN", "$UL_EMPTY-x", "${UL_MISSING}", "$UL_TOKEN$UL_MISSING", "$1abc", "${bad-name}", "a$", "$$$$"]
	.map((value) => ({ value, out: usage.resolveEnvironmentTemplate(value) ?? null }));
const authDir = join(root, "auth");
write(join(authDir, "auth.json"), { anthropic: { type: "oauth", access: "acc-123" }, key: { type: "api_key", key: "k" }, blank: { type: "oauth", access: "   " }, num: { type: "oauth", access: 5 } });
const badAuthDir = join(root, "badauth");
write(join(badAuthDir, "auth.json"), "[oops");
const tokens = [["anthropic", authDir], ["key", authDir], ["blank", authDir], ["num", authDir], ["absent", authDir], ["anthropic", badAuthDir], ["anthropic", join(root, "none")]]
	.map(([account, dir]) => ({ account, dir, out: usage.readPiOAuthToken(account, dir) ?? null }));
type Reply = { status?: number; body?: unknown; raw?: string; throws?: string };
const fetchCases: Array<{ name: string; provider: string; config: Record<string, unknown>; reply: Reply; token?: string | null }> = [
	{ name: "windows", provider: "anthropic", config: { endpoint: "https://a.test/u", headers: { "x-extra": "1" }, auth: "pi-oauth", label: "Claude", windows: { week: anthropic.windows.week, "5h": { ...anthropic.windows["5h"], label: undefined }, "2": anthropic.windows["2"] } }, reply: { body: payload }, token: "acc-123" },
	{ name: "explicit auth header", provider: "anthropic", config: { endpoint: "https://a.test/u", headers: { Authorization: "Bearer $UL_TOKEN", "anthropic-beta": "custom" }, auth: "pi-oauth", authAccount: "other", mapping: mappings[0] }, reply: { body: payload }, token: "zzz" },
	{ name: "no token", provider: "anthropic", config: { endpoint: "https://a.test/u", headers: {}, auth: "pi-oauth", mapping: mappings[0] }, reply: { body: payload }, token: null },
	{ name: "missing env", provider: "s", config: { endpoint: "https://s.test/u", headers: { Authorization: "Bearer ${UL_MISSING}" }, mapping: mappings[2] }, reply: { body: payload } },
	{ name: "http error", provider: "s", config: { endpoint: "https://s.test/u", headers: {}, mapping: mappings[2] }, reply: { status: 429 } },
	{ name: "bad json", provider: "s", config: { endpoint: "https://s.test/u", headers: {}, mapping: mappings[2] }, reply: { raw: "nope" } },
	{ name: "network", provider: "s", config: { endpoint: "https://s.test/u", headers: {}, mapping: mappings[2] }, reply: { throws: "ECONNREFUSED" } },
	{ name: "no match", provider: "s", config: { endpoint: "https://s.test/u", headers: {}, mapping: { used: "zz" } }, reply: { body: payload } },
	{ name: "single", provider: "s", config: { endpoint: "https://s.test/u", headers: { "X-Key": "$UL_TOKEN" }, label: "Syn", mapping: mappings[2] }, reply: { body: payload } },
];
const fetches: unknown[] = [];
for (const c of fetchCases) {
	const requests: unknown[] = [];
	const request = async (url: string, init: { method: string; headers: Record<string, string> }) => {
		requests.push({ url, method: init.method, headers: init.headers });
		if (c.reply.throws) throw new Error(c.reply.throws);
		const status = c.reply.status ?? 200;
		return { ok: status >= 200 && status < 300, status, json: async () => (c.reply.raw !== undefined ? JSON.parse(c.reply.raw) : c.reply.body) };
	};
	try {
		const out = await usage.fetchProviderUsage(c.provider, c.config, 1000, request, undefined, () => c.token ?? undefined);
		fetches.push({ ...c, requests, out, error: null });
	} catch (error) {
		fetches.push({ ...c, requests, out: null, error: error instanceof Error ? error.message : String(error) });
	}
}
const usageSamples = [
	{ provider: "p", label: "5h", remainingPercent: 30, renewsAt: new Date(NOW + 30 * 60_000 - 1).toISOString() },
	{ provider: "p", label: "week", remainingPercent: 55, renewsAt: new Date(NOW + 47 * 3600_000).toISOString() },
	{ provider: "p", label: "month", remaining: 12.5, renewsAt: new Date(NOW + 5 * 86_400_000).toISOString() },
	{ provider: "p", label: "x", used: 3, limit: 10, renewsAt: new Date(NOW - 1000).toISOString() },
	{ provider: "p", label: "y", used: 3 },
	{ provider: "p", label: "z", limit: 7 },
	{ provider: "p", label: "e" },
	{ provider: "p", label: " tab\tlabel ", text: "a\u0000b   c", renewsAt: "garbage" },
	{ provider: "p", label: "pct", remainingPercent: 20 },
	{ provider: "p", label: "pct", remainingPercent: 50.5, renewsAt: new Date(NOW + 60 * 60_000).toISOString() },
];
const formats = usageSamples.map((u) => ({ usage: u, out: usage.formatProviderUsage(u, NOW) }));
const lines = [[], [usageSamples[0]], [usageSamples[1], usageSamples[2]], [usageSamples[8], usageSamples[1]], [usageSamples[9]], [usageSamples[4]]]
	.map((list) => ({ usages: list, out: usage.providerUsageLine(list, NOW) ?? null }));

rmSync(root, { recursive: true, force: true });
const output = `${JSON.stringify(placeholders({
	roleCodes: ROLE_CODES, configDirName: CONFIG_DIR_NAME, now: NOW, home: process.env.HOME,
	settingsFiles: {
		global: Object.fromEntries(Object.entries(globalSettings).map(([k, v]) => [k, fileText(v)])),
		project: Object.fromEntries(Object.entries(projectSettings).filter(([, v]) => v !== undefined).map(([k, v]) => [k, fileText(v)])),
	},
	loads, statusSets, providerUsages, renderInputs, renders, contextPercents, usageStats, working,
	payload, mapped, templates, tokens, fetches, formats, lines,
}), null, 1)}\n`;
const goldenPath = join(here, "golden.json");
const summary = `${loads.length} config loads, ${renders.length} renders, ${contextPercents.length + working.length + 1} stats cases, ${mapped.length} mappings, ${templates.length} templates, ${tokens.length} auth tokens, ${fetches.length} fetches, ${formats.length + lines.length} display cases`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("status-line golden.json is stale: run npx tsx go/internal/statusline/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`status-line golden.json is current (${summary})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`status-line golden.json: ${summary}`);
}
