// Regenerate golden.json from the TypeScript frame feature (the reference):
//   npx tsx go/internal/frame/testdata/gen-golden.ts [--check]
// It drives the real modules: style.ts, format.ts, render.ts (the frame at
// many widths, narrow ones included), editor.ts (MinimalistFrameEditor over
// scripted base editors that render as pi-tui's Editor does, with
// autocomplete rows and viewport rules), protocol.ts, git.ts (parse cases
// and real `git` runs in a fixture repository), codex-quota.ts (parsing,
// routing, account ids, retry delays, and collector runs over a mocked
// fetch), and registerFrameEditor through a scripted host. HOME is a
// fixture directory in testdata/.fixture-<pid>, removed afterwards; its
// path is written as @@ROOT@@.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
const NOW = 1_700_000_000_000;
let clock = NOW;
Date.now = () => clock;

const style = await import(join(repo, "frame", "style.ts"));
const format = await import(join(repo, "frame", "format.ts"));
const render = await import(join(repo, "frame", "render.ts"));
const editorMod = await import(join(repo, "frame", "editor.ts"));
const protocol = await import(join(repo, "frame", "protocol.ts"));
const git = await import(join(repo, "frame", "git.ts"));
const codex = await import(join(repo, "frame", "codex-quota.ts"));
const { registerFrameEditor } = await import(join(repo, "frame", "index.ts"));
const tui = await import("@earendil-works/pi-tui");

function placeholders<T>(value: T): T {
	const text = JSON.stringify(value ?? null).split(root).join("@@ROOT@@");
	return JSON.parse(text) as T;
}

const ROLE_CODES = (JSON.parse(readFileSync(join(repo, "go", "internal", "chrome", "testdata", "golden.json"), "utf8")) as {
	roleCodes: Record<string, number>;
}).roleCodes;
const code = (role: string) => ROLE_CODES[role] ?? 37;
const ansi = {
	fg: (role: string, text: string) => `\x1b[${code(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
};
const plain = { fg: (_role: string, text: string) => text };
const themes: Record<string, typeof ansi | typeof plain> = { ansi, plain };

// ---- style ----
const styleSpecs = ["", "  ", "bold", "red", "bold red", "dim", "dimmed underline", "italic bright-cyan", "syntaxKeyword", "BOLD Green", "dim yellow", "unknownToken bold", "underline italic bold white"];
const styles = Object.entries(themes).flatMap(([theme, t]) => styleSpecs.map((spec) => ({ theme, spec, out: style.renderThemeStyle(t, spec, "txt") })));

// ---- format ----
const bashLabels = ["", "ls", "!ls", "!!ls", "  !x", "\t!!y", "! ", "x!"].map((text) => ({ text, out: format.bashModeLabel(text) }));
const counts = [0, 5, 999, 1000, 1049, 1050, 9999, 10_000, 10_499, 10_500, 999_999, 1_000_000, 1_050_000, 9_999_999, 10_000_000, 15_500_000].map((value) => ({ value, out: format.formatCount(value) }));
const durations = [-5, 0, 999, 1000, 59_999, 60_000, 61_500, 3_599_000, 3_600_000, 3_661_000, 90_061_000].map((ms) => ({ ms, out: format.formatElapsedDuration(ms) }));
const tiers = [null, 0, 49.9, 50, 74, 75, 100, Number.NaN].flatMap((percent) =>
	[{ warning: 50, error: 75 }, { warning: 70, error: 90 }].map((thresholds) => ({ percent: Number.isNaN(percent) ? "NaN" : percent, thresholds, out: format.contextColorTier(percent as number | null, thresholds) })));
const gauges = [-10, 0, 9, 10, 50, 55, 99, 100, 140].flatMap((percent) => [5, 10].flatMap((width) => [false, true].map((ascii) => ({ percent, width, ascii, out: format.buildContextGauge(percent, width, ascii) }))));
const usageEntries = [
	{ type: "session", id: "h" },
	{ type: "message", id: "1", message: { role: "user", usage: { input: 999 } } },
	{ type: "message", id: "2", message: { role: "assistant", usage: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 10, cost: { total: 0.0123 } } } },
	{ type: "message", id: "3", message: { role: "toolResult", usage: { input: 5, output: -2, cost: { total: "x" } } } },
	{ type: "compaction", id: "4", usage: { input: 10, output: 20, cost: { total: 0.5 } } },
	{ type: "branch_summary", id: "5", usage: { output: 7, cacheRead: 3, cost: 4 } },
	{ type: "message", id: "6", message: { role: "assistant" } },
	{ type: "custom", id: "7", usage: { input: 1000 } },
];
const usageCases = [usageEntries, [], usageEntries.slice(0, 3), [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1e308 } } } }, { type: "message", message: { role: "assistant", usage: { cost: { total: 1e308 } } } }]].map((entries) => {
	format.invalidateUsageTotalsCache();
	const totals = format.getUsageTotals({ sessionManager: { getEntries: () => entries, getBranch: () => [] } });
	return { entries, totals, cost: format.buildCostLabel(totals) };
});
const home = process.env.HOME!;
const cwdLabels = [
	{ cwd: `${home}/projects/app`, mode: "compact" }, { cwd: `${home}/projects/app`, mode: "full" }, { cwd: home, mode: "full" },
	{ cwd: "/srv/data", mode: "full" }, { cwd: "/", mode: "compact" }, { cwd: "", mode: "compact" },
	{ cwd: `${home}/projects/app/src/ui`, mode: "project", projectRoot: `${home}/projects/app` },
	{ cwd: `${home}/projects/app`, mode: "project", projectRoot: `${home}/projects/app` },
	{ cwd: "/elsewhere/x", mode: "project", projectRoot: `${home}/projects/app` },
	{ cwd: `${home}/projects/app`, mode: "project" },
	{ cwd: `${home}x/other`, mode: "full" },
].map((c) => ({ ...c, out: format.formatCwdLabel(c.cwd, c.mode, c.projectRoot) }));

// ---- render ----
const widths = [0, 1, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120];
const full = {
	cwd: `${home}/projects/app`, branch: "main", dirty: true, ahead: 2, behind: 1, costLabel: "$0.123", modelLabel: "claude-sonnet-4",
	thinkingLevel: "high", contextPercent: 42.4, sessionName: "fix the login bug", agentDurationMs: 65_000, agentActive: true,
	mode: { icon: "?", label: "Ask", role: "accent" }, style: { icon: "✎", label: "Tutor", role: "accent" },
	recipe: { icon: "✦", label: "work", role: "accent" }, btw: { icon: "?", label: "btw asking", role: "warning" },
	quota: { text: "Claude 5h 80% →2h", role: "muted" }, codexQuota: { text: "5h 88% | week 97%", role: "warning" },
};
const metadatas: Record<string, Record<string, unknown>> = {
	empty: { cwd: "" },
	minimal: { cwd: "/repo/app", modelLabel: "m1" },
	full,
	warn: { ...full, contextPercent: 60, thinkingLevel: "XHIGH", agentActive: false, mode: undefined, btw: undefined },
	error: { cwd: "/r", contextPercent: 1500, thinkingLevel: "turbo", branch: "feature/a-very-long-branch-name-for-truncation", sessionName: "日本語のセッション名", agentDurationMs: 3_700_000 },
	off: { cwd: "/r", thinkingLevel: "off", contextPercent: Number.NaN, branch: "  ", costLabel: "  ", modelLabel: "  " },
	negative: { cwd: "/r", contextPercent: -5, ahead: 0, behind: 3, dirty: false, branch: "dev" },
};
const styleVariants: Record<string, Record<string, unknown>> = {
	default: {},
	gauge: { contextGauge: true },
	ascii: { contextGauge: true, ascii: true },
	sparse: { showSessionName: false, showTimer: false, showCost: false, showGit: false },
	full: { pathDisplay: "full", viewportIndicators: false },
	project: { pathDisplay: "project" },
};
const renders: unknown[] = [];
const addRender = (args: { metadata: string; style: string; inputText: string; editorLines: string[]; panelLines?: string[]; viewport?: unknown; theme: string }, width: number) => {
	const out = render.renderMinimalistFrame({
		width, editorLines: args.editorLines, panelLines: args.panelLines, viewport: args.viewport, inputText: args.inputText,
		metadata: metadatas[args.metadata], uiTheme: themes[args.theme], style: { ...render.DEFAULT_FRAME_STYLE, ...styleVariants[args.style] },
	});
	renders.push({ ...args, width, out });
};
for (const metadata of Object.keys(metadatas)) {
	for (const width of widths) addRender({ metadata, style: "default", inputText: "", editorLines: ["hello world", ""], theme: "ansi" }, width);
}
for (const s of Object.keys(styleVariants)) {
	for (const width of [8, 30, 60, 120]) addRender({ metadata: "full", style: s, inputText: "", editorLines: ["x"], theme: "ansi" }, width);
}
for (const inputText of ["!ls -la", "!!secret", "  !x"]) {
	for (const width of [10, 30, 60, 100]) addRender({ metadata: "full", style: "default", inputText, editorLines: [inputText], theme: "ansi" }, width);
}
const panel = ["queue · 2 pending messages · Enter sends next", "1 first queued message", "2 second · steer", "\x1b[36m→ /resume\x1b[39m   Resume a session"];
for (const width of [4, 5, 12, 40, 80]) {
	addRender({ metadata: "minimal", style: "default", inputText: "", editorLines: ["a", "b"], panelLines: panel, viewport: { above: "3", below: "12" }, theme: "ansi" }, width);
	addRender({ metadata: "full", style: "default", inputText: "", editorLines: ["wide 漢字 text 🙂 and more text that overflows the frame"], viewport: { above: "0", below: "x" }, theme: "plain" }, width);
	addRender({ metadata: "warn", style: "default", inputText: "", editorLines: ["a"], viewport: { below: "7" }, theme: "ansi" }, width);
}
for (const width of [24, 33, 45, 70]) addRender({ metadata: "error", style: "default", inputText: "", editorLines: [""], viewport: { below: "99" }, theme: "plain" }, width);

// ---- parseBaseBorderRule ----
const ruleLines = ["────", "  ────  ", "\x1b[90m──────\x1b[39m", "─── ↑ 3 more ──", "─ ↑ 12 more ─", "─── ↓ 4 more ──", "─── ↓ 0 more ──", "─ ↑ 3 more", "text", "", "──x──", "─── ↑ 3 more ──────────"];
const borderRules = ruleLines.flatMap((line) => (["above", "below"] as const).map((direction) => ({ line, direction, out: editorMod.parseBaseBorderRule(line, direction) ?? null })));

// ---- MinimalistFrameEditor ----
type BaseSpec = {
	name: string; lines: string[]; paddingX: number; above?: number; below?: number; autocomplete?: string[]; text?: string;
	unframed?: boolean; frameChrome?: boolean; single?: boolean; nonRule?: boolean;
};
function makeBase(spec: BaseSpec) {
	const calls: Array<{ op: string; width: number; out: string[] }> = [];
	const rule = (width: number, count: number | undefined, arrow: string) => {
		if (!count) return "─".repeat(Math.max(0, width));
		const label = ` ${arrow} ${count} more `;
		const left = Math.max(1, Math.floor((width - label.length) / 2));
		return tui.truncateToWidth(`${"─".repeat(left)}${label}${"─".repeat(Math.max(0, width - left - label.length))}`, width, "");
	};
	const base: Record<string, unknown> = {
		frameChromeCalls: [] as boolean[],
		getText: () => spec.text ?? spec.lines.join("\n"),
		setText() {},
		handleInput() {},
		invalidate() {},
		isShowingAutocomplete: () => Boolean(spec.autocomplete),
		autocompleteList: spec.autocomplete ? { render: (width: number) => spec.autocomplete!.map((row) => tui.truncateToWidth(row, width, "")) } : undefined,
		render(this: { autocompleteList?: { render(width: number): string[] } }, width: number) {
			if (spec.single) {
				const out = ["only one row"];
				calls.push({ op: "render", width, out });
				return out;
			}
			const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
			const paddingX = Math.min(spec.paddingX, maxPadding);
			const contentWidth = Math.max(1, width - paddingX * 2);
			const pad = " ".repeat(paddingX);
			const out = [spec.nonRule ? "╌╌ custom top ╌╌" : rule(width, spec.above, "↑")];
			for (const line of spec.lines) {
				const fitted = tui.truncateToWidth(line, contentWidth, "");
				out.push(`${pad}${fitted}${" ".repeat(Math.max(0, contentWidth - tui.visibleWidth(fitted)))}${pad}`);
			}
			out.push(rule(width, spec.below, "↓"));
			if (spec.autocomplete && this.autocompleteList) {
				for (const row of this.autocompleteList.render(contentWidth)) {
					out.push(`${pad}${row}${" ".repeat(Math.max(0, contentWidth - tui.visibleWidth(row)))}${pad}`);
				}
			}
			calls.push({ op: "render", width, out });
			return out;
		},
	};
	if (spec.unframed) {
		base.renderUnframed = (width: number) => {
			const out = [`─ ! bash ${"─".repeat(Math.max(0, width - 10))}`, ...spec.lines, "─".repeat(Math.max(0, width))].map((l) => tui.truncateToWidth(l, width, ""));
			calls.push({ op: "renderUnframed", width, out });
			return out;
		};
		base.setFrameChrome = (active: boolean) => (base.frameChromeCalls as boolean[]).push(active);
	}
	return { base, calls };
}
const baseSpecs: BaseSpec[] = [
	{ name: "plain", lines: ["hello world"], paddingX: 1 },
	{ name: "multi", lines: ["first line", "second line", "third"], paddingX: 1, above: 3, below: 5 },
	{ name: "nopad", lines: ["no padding"], paddingX: 0 },
	{ name: "autocomplete", lines: ["/re"], paddingX: 1, autocomplete: ["\x1b[36m→ resume\x1b[39m  Resume a session", "  reload    Reload extensions", "  rewind"] },
	{ name: "autocomplete-pad2", lines: ["/x"], paddingX: 2, autocomplete: ["→ one", "  two two two two two two two two two two"] },
	{ name: "bash", lines: ["!ls -la"], paddingX: 1, unframed: true, text: "!ls -la" },
	{ name: "bash-hidden", lines: ["!!env"], paddingX: 1, unframed: true, text: "!!env", above: 2 },
	{ name: "single", lines: [], paddingX: 1, single: true },
	{ name: "nonrule", lines: ["x"], paddingX: 1, nonRule: true },
	{ name: "nonrule-unframed", lines: ["!x"], paddingX: 1, nonRule: true, unframed: true, text: "!x" },
];
const editorWidths = [1, 4, 5, 6, 8, 12, 20, 40, 72];
const editorMetadata = { cwd: "/repo/app", branch: "main", modelLabel: "m1", thinkingLevel: "medium", contextPercent: 12, sessionName: "s" };
const editors: unknown[] = [];
protocol.setFrameMetadataContributor("mode", () => ({ mode: { icon: "▶", label: "Auto", role: "accent" } }));
for (const spec of baseSpecs) {
	for (const panelLines of [[], ["queue · 1 pending message · Enter sends next", "1 do the thing"]]) {
		for (const width of editorWidths) {
			const { base, calls } = makeBase(spec);
			const editor = new editorMod.MinimalistFrameEditor(base, {
				uiTheme: ansi, style: render.DEFAULT_FRAME_STYLE, getMetadata: () => editorMetadata, getPanelLines: () => panelLines,
			});
			const out = editor.render(width);
			editors.push({ spec, panelLines, width, calls, frameChrome: base.frameChromeCalls, out });
		}
	}
}
protocol.setFrameMetadataContributor("mode", undefined);

// ---- protocol ----
const protocolSteps: unknown[] = [];
{
	const record = (op: string) => protocolSteps.push({ op, merged: protocol.contributedFrameMetadata(), panel: protocol.getQueuePanelLines() });
	protocol.setFrameMetadataContributor("mode", () => ({ mode: { icon: "●", label: "Default", role: "muted" } }));
	record("mode");
	protocol.setFrameMetadataContributor("quota", () => ({ quota: { text: "q", role: "muted" } }));
	record("quota");
	protocol.setFrameMetadataContributor("bad", () => { throw new Error("broken"); });
	record("bad");
	protocol.setFrameMetadataContributor("override", () => ({ mode: { icon: "▶", label: "Auto", role: "accent" } }));
	record("override");
	protocol.setFrameMetadataContributor("mode", () => ({ mode: { icon: "?", label: "Ask", role: "accent" } }));
	record("mode-again (keeps position)");
	protocol.setFrameMetadataContributor("override", undefined);
	record("override removed");
	protocol.setQueuePanelLinesProvider(() => ["row"]);
	record("panel");
	protocol.setQueuePanelLinesProvider(() => { throw new Error("x"); });
	record("panel throws");
	for (const key of ["mode", "quota", "bad"]) protocol.setFrameMetadataContributor(key, undefined);
	protocol.setQueuePanelLinesProvider(undefined);
	record("cleared");
}

// ---- git ----
const gitParses = [
	"# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n",
	"# branch.head (detached)\n",
	"# branch.head feature/x\r\n1 .M N... 100644 100644 100644 a b file.ts\r\n",
	"# branch.head \n? untracked.txt\n",
	"# branch.head dev\n# branch.ab +0 -0\n# stash 1\n",
	"",
	"# branch.ab +x -y\n",
].map((stdout) => ({ stdout, out: git.parseGitFrameStatus(stdout) }));
const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), LC_ALL: "C" };
writeFileSync(join(root, "gitconfig"), "[user]\n\tname = t\n\temail = t@e\n[init]\n\tdefaultBranch = main\n");
const runGit = (cwd: string, args: string[]) => {
	try {
		// The commit id varies (signing configs); the parser ignores it.
		const stdout = execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, stdout: stdout.replace(/# branch\.oid [0-9a-f]+/, "# branch.oid 0000"), stderr: "" };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
	}
};
const repoDir = join(root, "repo");
mkdirSync(repoDir, { recursive: true });
runGit(repoDir, ["init", "-q"]);
writeFileSync(join(repoDir, "a.txt"), "a\n");
runGit(repoDir, ["add", "a.txt"]);
runGit(repoDir, ["commit", "-q", "-m", "init"]);
const plainDir = join(root, "plain");
mkdirSync(plainDir, { recursive: true });
const gitReads: unknown[] = [];
const prevEnv = { ...process.env };
Object.assign(process.env, { GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), LC_ALL: "C" });
for (const [name, dir, prepare] of [
	["clean", repoDir, () => {}],
	["dirty", repoDir, () => writeFileSync(join(repoDir, "b.txt"), "b\n")],
	["not-a-repo", plainDir, () => {}],
	["missing-dir", join(root, "missing"), () => {}],
] as Array<[string, string, () => void]>) {
	prepare();
	const commands = [["status", "--porcelain=2", "--branch"], ["rev-parse", "--is-inside-work-tree"]].map((args) => ({ args, ...runGit(dir, args) }));
	gitReads.push({ name, commands, out: await git.readGitFrameStatus(dir) });
}
process.env = prevEnv;

// ---- codex quota ----
const codexParses = [
	{ rate_limit: { primary_window: { used_percent: 12.4, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 3, limit_window_seconds: 604_800 } } },
	{ rate_limit: { primary_window: { used_percent: 50.5, limit_window_seconds: 18_000 } } },
	{ rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 18_000 }, secondary_window: { used_percent: -1, limit_window_seconds: 604_800 } } },
	{ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600 } } },
	{ rate_limit: { primary_window: { used_percent: "10", limit_window_seconds: 18_000 } } },
	{ rate_limit: { secondary_window: { used_percent: 99.5, limit_window_seconds: 604_800 }, primary_window: null } },
	{ rate_limit: [] }, { rate_limit: null }, null, "x", {}, { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: "18000" } } },
].map((value) => ({ value, out: codex.parseCodexQuota(value) ?? null }));
const quotaSamples = [undefined, {}, { fiveHour: 88, week: 97 }, { fiveHour: 15 }, { week: 45 }, { fiveHour: 60, week: 70, stale: true }, { fiveHour: 20, week: 100 }, { fiveHour: 21, stale: true }];
const codexTexts = quotaSamples.map((quota) => ({ quota: quota ?? null, text: codex.codexQuotaText(quota), role: quota ? codex.codexQuotaRole(quota) : null }));
const urls = ["https://chatgpt.com/backend-api", "https://chatgpt.com", "https://CHATGPT.com:443/x", "https://chatgpt.com:8443/x", "http://chatgpt.com/", "https://user:pw@chatgpt.com/", "https://api.openai.com/v1", "not a url", "https://chatgpt.com.evil.com/"];
const codexUrls = urls.map((url) => ({ url, out: codex.hasNativeCodexRoute({ getProvider: () => ({ id: "openai-codex", baseUrl: url }) }, { provider: "openai-codex", api: "openai-codex-responses", baseUrl: url }) }));
const nativeModel = { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const nativeProvider = { id: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" };
const routeCases = [
	{ name: "native", model: nativeModel, provider: nativeProvider },
	{ name: "no-model", model: null, provider: nativeProvider },
	{ name: "other-provider", model: { ...nativeModel, provider: "openai" }, provider: nativeProvider },
	{ name: "other-api", model: { ...nativeModel, api: "openai-responses" }, provider: nativeProvider },
	{ name: "proxied-model", model: { ...nativeModel, baseUrl: "https://proxy.example/backend-api" }, provider: nativeProvider },
	{ name: "proxied-provider", model: nativeModel, provider: { ...nativeProvider, baseUrl: "http://localhost:9000" } },
	{ name: "no-provider", model: nativeModel, provider: null },
	{ name: "wrong-provider-id", model: nativeModel, provider: { ...nativeProvider, id: "x" } },
].map((c) => ({ ...c, out: codex.hasNativeCodexRoute({ getProvider: () => c.provider ?? undefined }, c.model ?? undefined) }));
const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const tokens = [
	jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123-AB" } }),
	jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "bad id!" } }),
	jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 5 } }),
	jwt({ other: 1 }),
	"plain-token",
	"a.!!!.c",
	`h.${Buffer.from("not json").toString("base64url")}.s`,
];
// accountId is module-private: observe it through the collector's request headers below.
const retryValues = [null, "", "5", "120", "0.5", "61.5", "abc", new Date(NOW + 300_000).toUTCString(), new Date(NOW - 5_000).toUTCString(), "-3"];

type FetchStep = { status?: number; body?: unknown; rawBody?: string; retryAfter?: string; throws?: string };
async function runCollector(name: string, options: { token?: string | null; tokenThrows?: boolean; route?: boolean; fetches: FetchStep[]; advanceBefore?: number[] }) {
	clock = NOW;
	const requests: unknown[] = [];
	let changed = 0;
	let route = options.route ?? true;
	let fetchIndex = 0;
	const registry = {
		getProvider: () => (route ? nativeProvider : { id: "openai-codex", baseUrl: "http://x" }),
		getApiKeyAndHeaders: async () => {
			if (options.tokenThrows) throw new Error("auth failed");
			return options.token === null ? { ok: false } : { ok: true, apiKey: options.token ?? tokens[0] };
		},
	};
	const ctx = { modelRegistry: registry, model: nativeModel };
	const fetchUsage = async (url: string, init: { headers: Record<string, string> }) => {
		const step = options.fetches[fetchIndex++] ?? { status: 500 };
		requests.push({ url, headers: init.headers });
		if (step.throws) throw new Error(step.throws);
		const status = step.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (key: string) => (key === "retry-after" ? (step.retryAfter ?? null) : null) },
			body: { cancel: async () => {} },
			json: async () => (step.rawBody !== undefined ? JSON.parse(step.rawBody) : step.body),
		};
	};
	const collector = new codex.CodexQuotaCollector(() => ctx, () => changed++, fetchUsage);
	const steps: unknown[] = [];
	const settle = async () => {
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	collector.reconcile();
	await settle();
	steps.push({ op: "reconcile", get: collector.get() ?? null, next: (collector as unknown as { nextRefresh: number }).nextRefresh - clock });
	for (let i = 1; i < options.fetches.length; i++) {
		clock += options.advanceBefore?.[i] ?? 60_000;
		void (collector as unknown as { refresh(): Promise<void> }).refresh();
		await settle();
		steps.push({ op: "refresh", advance: options.advanceBefore?.[i] ?? 60_000, get: collector.get() ?? null, next: (collector as unknown as { nextRefresh: number }).nextRefresh - clock });
	}
	clock += 120_000;
	steps.push({ op: "later", get: collector.get() ?? null });
	route = false;
	steps.push({ op: "off-route", get: collector.get() ?? null });
	collector.stop();
	return { name, options, requests, steps, changed };
}
const okBody = { rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 3, limit_window_seconds: 604_800 } } };
const collectors = [
	await runCollector("ok", { fetches: [{ body: okBody }, { body: { rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18_000 } } } }] }),
	await runCollector("no-account", { token: "plain-token", fetches: [{ body: okBody }] }),
	await runCollector("unauthorized", { fetches: [{ body: okBody }, { status: 401 }] }),
	await runCollector("rate-limited", { fetches: [{ body: okBody }, { status: 429, retryAfter: "300" }, { status: 429, retryAfter: "abc" }] }),
	await runCollector("server-error", { fetches: [{ body: okBody }, { status: 503 }] }),
	await runCollector("invalid-body", { fetches: [{ body: okBody }, { body: { nothing: true } }, { rawBody: "not json" }] }),
	await runCollector("network-error", { fetches: [{ throws: "ECONNRESET" }, { body: okBody }] }),
	await runCollector("no-token", { token: null, fetches: [] }),
	await runCollector("token-throws", { tokenThrows: true, fetches: [] }),
	await runCollector("off-route", { route: false, fetches: [] }),
	await runCollector("bad-account", { token: tokens[1], fetches: [{ body: okBody }] }),
];
// Retry-After delays observed through a 429 refresh each.
const retryDelays: unknown[] = [];
for (const value of retryValues) {
	const result = await runCollector(`retry ${value}`, { fetches: [{ status: 429, retryAfter: value ?? undefined }] });
	retryDelays.push({ value, next: (result.steps[0] as { next: number }).next });
}
const accountIds: unknown[] = [];
for (const token of tokens) {
	const result = await runCollector("token", { token, fetches: [{ body: okBody }] });
	accountIds.push({ token, headers: (result.requests[0] as { headers: unknown } | undefined)?.headers ?? null });
}
clock = NOW;

// ---- registerFrameEditor through a scripted host ----
async function runRegistrar() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	let installed: ((tui: unknown, theme: unknown, keys: unknown) => { render(width: number): string[] }) | undefined;
	let existing: unknown = () => makeBase({ name: "queue", lines: ["draft text"], paddingX: 1 }).base;
	const state = {
		model: { id: "m1", provider: "fixture", contextWindow: 1000 } as Record<string, unknown> | undefined,
		thinking: "high",
		percent: 25 as number | null,
		sessionName: "named session" as string | undefined,
		entries: usageEntries,
		editorText: "",
	};
	const ctx = {
		mode: "tui", hasUI: true, cwd: `${home}/projects/app`,
		get model() { return state.model; },
		modelRegistry: { getProvider: () => undefined },
		getContextUsage: () => ({ percent: state.percent, contextWindow: 1000, tokens: 250 }),
		sessionManager: { getSessionName: () => state.sessionName, getEntries: () => state.entries, getBranch: () => [] },
		ui: {
			theme: ansi,
			getEditorComponent: () => existing,
			setEditorComponent: (factory: typeof installed) => { installed = factory; existing = factory; },
			getEditorText: () => state.editorText,
			setEditorText: (text: string) => { state.editorText = text; },
		},
	};
	const pi = {
		events: {
			on: (channel: string, fn: (value: unknown) => void) => listeners.set(channel, [...(listeners.get(channel) ?? []), fn]),
			emit: (channel: string, value: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(value); },
		},
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		getThinkingLevel: () => state.thinking,
	};
	registerFrameEditor(pi as never, { menuComponents: [], readGit: async () => ({ branch: "main", dirty: true, ahead: 1, behind: 0 }) });
	const fire = async (name: string) => {
		for (const fn of handlers.get(name) ?? []) await fn({}, ctx);
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	const probe = () => {
		const cap = { supported: false, active: false };
		pi.events.emit(protocol.FRAME_CAPABILITY_EVENT, cap);
		return cap;
	};
	const steps: unknown[] = [];
	const snap = (op: string) => steps.push({ op, clock: clock - NOW, probe: probe(), render: installed ? installed(undefined, ansi, {}).render(72) : null });
	snap("registered");
	await fire("session_start");
	snap("session_start");
	clock += 1000;
	await fire("agent_start");
	clock += 65_000;
	snap("agent running 65s");
	state.thinking = "off";
	state.percent = 80;
	await fire("message_end");
	snap("thinking off, 80%");
	clock += 4000;
	await fire("agent_end");
	snap("agent_end");
	clock += 10_000;
	snap("idle later");
	state.model = undefined;
	state.sessionName = undefined;
	state.percent = null;
	await fire("model_select");
	snap("no model");
	await fire("session_shutdown");
	snap("shutdown");
	return steps;
}
const registrar = await runRegistrar();
clock = NOW;

rmSync(root, { recursive: true, force: true });

const output = `${JSON.stringify(placeholders({
	roleCodes: ROLE_CODES,
	defaultStyle: render.DEFAULT_FRAME_STYLE,
	metadatas,
	styleVariants,
	styles,
	bashLabels, counts, durations, tiers, gauges, usageCases, cwdLabels,
	renders, borderRules, editors, protocolSteps,
	gitParses, gitReads,
	codexParses, codexTexts, codexUrls, routeCases, retryDelays, accountIds, collectors,
	registrar,
}), null, 1)}\n`;
const goldenPath = join(here, "golden.json");
const summary = `${styles.length} styles, ${counts.length + durations.length + tiers.length + gauges.length + bashLabels.length + cwdLabels.length} format cases, ${usageCases.length} usage totals, ${renders.length} frame renders, ${borderRules.length} border rules, ${editors.length} editor renders, ${protocolSteps.length} protocol steps, ${gitParses.length} git parses, ${gitReads.length} git reads, ${codexParses.length + codexTexts.length + codexUrls.length + routeCases.length} codex cases, ${retryDelays.length} retry delays, ${accountIds.length} account ids, ${collectors.length} collector runs, ${registrar.length} registrar steps`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("frame golden.json is stale: run npx tsx go/internal/frame/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`frame golden.json is current (${summary})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`frame golden.json: ${summary}`);
}
