// Regenerate golden.json from the TypeScript btw feature (the reference):
//   npx tsx go/internal/btw/testdata/gen-golden.ts [--check]
// It runs the digest, snapshot, prompt, engine, and display functions on
// fixed inputs, and drives the real registerBtw /btw command through a
// scripted harness. Date.now is pinned, so ages and latencies are stable.
// The snapshot fixture is built inside this testdata directory and removed
// afterwards; its path is written as @@ROOT@@.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
delete process.env.AIO_SUBAGENT_CHILD;
const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const context = await import(join(repo, "btw", "context.ts"));
const engine = await import(join(repo, "btw", "engine.ts"));
const display = await import(join(repo, "btw", "display.ts"));
const { registerBtw } = await import(join(repo, "btw", "index.ts"));

const root = join(here, `.fixture-${process.pid}`);
function placeholders<T>(value: T): T {
	const text = JSON.stringify(value ?? null).split(root).join("@@ROOT@@");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`placeholder substitution broke the JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ---- digest ----
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: "message", message: { role, content, ...extra } });
const text = (value: string) => ({ type: "text", text: value });
const call = (name: unknown, args?: unknown) => (args === undefined ? { type: "toolCall", id: "c", name } : { type: "toolCall", id: "c", name, arguments: args });
const BASE = [
	{ type: "session", id: "h" },
	msg("user", "why did it break"),
	msg("assistant", [{ type: "thinking", thinking: "hidden" }, text("Looking into it."), call("bash", { command: "ls -la", timeout: 5 })]),
	msg("toolResult", [text("total 4\nfile.ts")], { toolName: "bash", isError: false }),
	msg("toolResult", [text("boom")], { toolName: "bash", isError: true }),
	msg("assistant", [text("Because the schema changed.")]),
];
const branches: Record<string, unknown[]> = {
	base: BASE,
	empty: [],
	nonMessages: [{ type: "custom", customType: "x", data: {} }, { type: "message" }, { type: "message", message: "str" }, null, 5, "s"],
	blankUser: [msg("user", "   "), msg("user", [text("  "), { type: "image", data: "x" }]), msg("assistant", []), msg("toolResult", [])],
	userBlocks: [msg("user", [text("first block"), { type: "image" }, text("second block")]), msg("user", "  padded  \n")],
	toolCalls: [
		msg("assistant", [
			call("edit", { path: "a.ts", oldText: "x\ny", newText: "é \"q\" \\ \t ✓ 🎉", nested: { b: [1, 2.5, null, true, -0.001, 1e21] } }),
			call(undefined, { z: 1, a: 2 }),
			call("read"),
			call("grep", null),
			call(7, "string-args"),
			call("long", { text: "x".repeat(300) }),
		]),
	],
	toolResultShapes: [
		msg("toolResult", "string content", { toolName: "read" }),
		msg("toolResult", [text("no name")]),
		msg("toolResult", [text("empty name")], { toolName: "" }),
		msg("toolResult", [text("truthy error")], { toolName: "bash", isError: "yes" }),
		msg("toolResult", [text("x".repeat(500))], { toolName: "cat" }),
	],
	long: Array.from({ length: 60 }, (_, i) => msg(i % 2 ? "assistant" : "user", i % 2 ? [text(`answer ${i} ${"y".repeat(i * 7)}`)] : `question ${i} ${"z".repeat(i * 5)}`)),
	unicode: [msg("user", "é".repeat(900)), msg("assistant", [text("🎉".repeat(500))]), msg("user", "日本語のテキスト")],
	huge: [msg("user", "a".repeat(700)), msg("assistant", [text("b".repeat(5000))])],
	mixedRoles: [msg("system", "sys"), msg("bashExecution", "cmd"), msg("custom", "c"), msg("user", "kept")],
};
const digestOptions: Array<Record<string, unknown> | undefined> = [
	undefined,
	{ maxChars: 40 },
	{ maxChars: 100 },
	{ maxMessages: 1 },
	{ maxMessages: 3 },
	{ maxChars: 500, maxMessages: 10 },
	{ perMessageChars: { user: 10, assistant: 12, toolResult: 8, toolCall: 20 } },
	{ maxChars: 16_000, maxMessages: 60 },
];
const digests: unknown[] = [];
for (const [name, branch] of Object.entries(branches)) {
	for (const options of digestOptions) {
		digests.push({ branch: name, options: options ?? null, digest: context.buildFlowDigest(branch, options) });
	}
}

// ---- prompt ----
const promptCases = [
	{ question: "  what is largest?  ", flowDigest: "USER: hi", projectSnapshot: "WORKSPACE: /x" },
	{ question: "q", flowDigest: "", projectSnapshot: "" },
	{ question: "q", flowDigest: "   \n ", projectSnapshot: undefined },
	{ question: "x".repeat(900) },
	{ question: "é".repeat(805) },
	{ question: "q", flowDigest: "d".repeat(30_000), projectSnapshot: "s".repeat(2000) },
	{ question: "q", flowDigest: "é".repeat(20_000) },
	{ question: "q", flowDigest: "🎉".repeat(9000) },
	{ question: "q", flowDigest: "a".repeat(400), maxPromptBytes: 300 },
	{ question: "q", flowDigest: "a".repeat(2000), maxPromptBytes: 1100 },
	{ question: "q", flowDigest: "a".repeat(5000), maxPromptBytes: 200 },
].map((input) => ({ input, prompt: context.buildBtwPrompt(input) }));

// ---- engine ----
const sanitizeCases = [
	["plain", 100],
	["\x1b[31mred\x1b[0m and \x1b]8;;http://x\x07link\x1b]8;;\x07", 100],
	["a\rb\x00c\x7fd\te\x1b", 100],
	["\x1b[2Acursor up kept?", 100],
	["\x1b_apc\x1b\\after", 100],
	["\x1b[unterminated", 100],
	["line  \n  \n", 100],
	["x".repeat(50), 10],
	["é🎉".repeat(10), 7],
	["\u0085c1 control\u009b", 100],
	["trailing\u00a0\u2028", 100],
].map(([value, max]) => ({ text: value, max, out: engine.sanitizeForTerminal(value, max) }));
const textCases = [
	[text("a"), { type: "thinking", text: "b" }, text("c"), { type: "text", text: 5 }, { type: "toolCall" }],
	[],
	null,
	"string",
].map((content) => ({ content, out: engine.textFromContent(content as never) }));
type Response = Record<string, unknown> | { throw: string };
const responses: Response[] = [
	{ stopReason: "stop", content: [text("The answer is 42.")], usage: { input: 1200, output: 34, cost: { total: 0.01 } } },
	{ stopReason: "stop", content: [text("  \n ")] },
	{ stopReason: "stop", content: [text("\x1b[1mbold\x1b[0m\r\nnext"), text("x".repeat(3000))], usage: {} },
	{ stopReason: "error", errorMessage: "rate limited \x1b[31mred\x1b[0m", usage: { input: 5 } },
	{ stopReason: "error" },
	{ stopReason: "error", errorMessage: "" },
	{ stopReason: "aborted" },
	{ throw: "network down" },
	{ throw: "" },
	{ stopReason: "length", content: [text("partial")] },
];
const outcomes: unknown[] = [];
for (const response of responses) {
	let seen: unknown;
	const outcome = await engine.runSideQuestion({
		model: {},
		prompt: "P",
		complete: async (_model: unknown, ctx: unknown) => {
			seen = ctx;
			if ("throw" in response) throw new Error(response.throw as string);
			return response as never;
		},
	});
	outcomes.push({ response, systemPrompt: (seen as { systemPrompt: string }).systemPrompt, outcome: { ...outcome, latencyMs: undefined } });
}

// ---- display ----
const identity = { fg: (_role: string, value: string) => value, bold: (value: string) => value };
const tokenCases = [undefined, { inputTokens: 0, outputTokens: 0, costTotal: 0 }, { inputTokens: 120, outputTokens: 80, costTotal: 0 }, { inputTokens: 999, outputTokens: 0, costTotal: 0 }, { inputTokens: 1000, outputTokens: 0, costTotal: 0 }, { inputTokens: 1200, outputTokens: 50, costTotal: 0 }, { inputTokens: 1249, outputTokens: 1, costTotal: 0 }, { inputTokens: 1350, outputTokens: 0, costTotal: 0 }, { inputTokens: 250_000, outputTokens: 1, costTotal: 0 }].map(
	(usage) => ({ usage: usage ?? null, out: display.formatBtwTokens(usage) }),
);
const secondCases = [0, -5, 49, 50, 150, 250, 1234, 61_000].map((ms) => ({ ms, out: display.formatBtwSeconds(ms) }));
const entry = (overrides: Record<string, unknown> = {}) => ({
	question: "what is the largest file?",
	answer: "The largest file is go/internal/btw/context.go at about 12 KB.",
	model: "anthropic/claude-x",
	answeredMidFlow: false,
	latencyMs: 1234,
	timestamp: NOW,
	...overrides,
});
const entries = [
	entry(),
	entry({ answeredMidFlow: true, usage: { inputTokens: 1200, outputTokens: 30, costTotal: 0 } }),
	entry({ answer: "\n\n   \nsecond line wins\nthird" }),
	entry({ answer: "word ".repeat(60) }),
	entry({ answer: "short\nlines\nthat\nkeep\ngoing\nfor\nseven" }),
	entry({ question: "q".repeat(100), answer: "averyveryverylongtokenwithoutanyspacesthatmustbreakacrossseverallines ok" }),
];
const toasts = entries.map((data) => ({ data, out: display.btwToastText(data) }));
const boxes: unknown[] = [];
const cards: unknown[] = [];
for (const width of [4, 5, 12, 30, 60]) {
	for (const data of entries) boxes.push({ data, width, rows: display.buildBtwBoxRows(identity, data, width) });
	for (const data of entries) {
		const card = { phase: "answered", question: data.question, answer: data.answer, answeredAt: NOW, dismissAt: NOW + 59_500 };
		cards.push({ card, width, now: NOW, rows: display.buildBtwCardRows(identity, card, width, NOW) });
	}
	const pending = { phase: "pending", question: "what now?", model: "openai/gpt-x", startedAt: NOW - 3_700 };
	cards.push({ card: pending, width, now: NOW, rows: display.buildBtwCardRows(identity, pending, width, NOW) });
	const late = { phase: "answered", question: "q", answer: "a", answeredAt: NOW, dismissAt: NOW - 10 };
	cards.push({ card: late, width, now: NOW, rows: display.buildBtwCardRows(identity, late, width, NOW) });
}
// The same rows in the shared chrome colors (a tagged theme).
const tagged = { fg: (role: string, value: string) => `<${role}>${value}</>`, bold: (value: string) => value };
const themed: unknown[] = [];
for (const width of [5, 30, 60]) {
	for (const data of entries) themed.push({ kind: "box", data, width, rows: display.buildBtwBoxRows(tagged, data, width) });
	const answered = { phase: "answered", question: entries[3]!.question, answer: entries[3]!.answer, answeredAt: NOW, dismissAt: NOW + 59_500 };
	const pending = { phase: "pending", question: "what now?", model: "openai/gpt-x", startedAt: NOW - 3_700 };
	for (const card of [answered, pending]) themed.push({ kind: "card", card, width, now: NOW, rows: display.buildBtwCardRows(tagged, card, width, NOW) });
}
const statusLines = [undefined, "claude-x"].map((id) => ({ id: id ?? null, out: display.statusAskingLine(id) }));

// ---- snapshot ----
const FIXTURE = {
	files: [
		{ path: "README.md", size: 120 },
		{ path: "package.json", size: 900 },
		{ path: "src/a.ts", size: 3000 },
		{ path: "src/b.ts", size: 2500 },
		{ path: "src/deep/c.ts", size: 40 },
		{ path: "src/deep/deeper/d.ts", size: 4100 },
		{ path: "src/deep/deeper/deepest/e.ts", size: 10 },
		{ path: "docs/guide.md", size: 700 },
		{ path: "docs/z.md", size: 700 },
		{ path: "node_modules/pkg/index.js", size: 99_999 },
		{ path: ".git/HEAD", size: 50_000 },
		{ path: "dist/out.js", size: 80_000 },
		{ path: "lib/vendor/x.go", size: 60_000 },
		{ path: ".hidden", size: 5 },
	],
	dirs: ["empty"],
	symlinks: [{ path: "link.ts", target: "src/a.ts" }],
};
function buildFixture(dir: string) {
	for (const file of FIXTURE.files) {
		mkdirSync(dirname(join(dir, file.path)), { recursive: true });
		writeFileSync(join(dir, file.path), "x".repeat(file.size));
	}
	for (const sub of FIXTURE.dirs) mkdirSync(join(dir, sub), { recursive: true });
	for (const link of FIXTURE.symlinks) symlinkSync(join(dir, link.target), join(dir, link.path));
}
const snapshots: unknown[] = [];
const snapshotOptions = [undefined, { maxFiles: 3 }, { maxDepth: 1 }, { maxDirs: 2 }, { rootEntries: 3, topFiles: 2 }, { maxDepth: 2, topFiles: 4 }];
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const scenarios: unknown[] = [];
try {
	buildFixture(join(root, "ws"));
	mkdirSync(join(root, "blank"));
	for (const options of snapshotOptions) {
		snapshots.push({ dir: "ws", options: options ?? null, out: await context.buildProjectSnapshot(join(root, "ws"), options) });
	}
	snapshots.push({ dir: "blank", options: null, out: await context.buildProjectSnapshot(join(root, "blank")) });
	snapshots.push({ dir: "missing", options: null, out: await context.buildProjectSnapshot(join(root, "missing")) });

	// ---- /btw command ----
	type Step = { op: "btw"; args: string; streaming?: boolean; noModel?: boolean; reply?: Response } | { op: "shutdown" };
	async function runScenario(name: string, options: { hasUI: boolean; mode: string; answerCardMs?: number }, steps: Step[]) {
		const commands = new Map<string, any>();
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		let log: unknown[] = [];
		let reply: Response = { stopReason: "stop", content: [text("default answer")] };
		const pi = {
			registerEntryRenderer: () => {},
			registerCommand: (n: string, command: unknown) => commands.set(n, command),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			appendEntry: (customType: string, data: unknown) => log.push({ op: "append", customType, data }),
			// Notification protocol signals (emitNotification). The frame
			// capability probe is Go package state, not a bus event.
			events: {
				emit: (name: string, payload: unknown) => {
					if (name.startsWith("aio:notification")) log.push({ op: "event", name, payload });
				},
			},
		};
		const makeCtx = (step: { streaming?: boolean; noModel?: boolean }) => ({
			cwd: join(root, "ws"),
			mode: options.mode,
			hasUI: options.hasUI,
			signal: step.streaming ? new AbortController().signal : undefined,
			model: step.noModel ? undefined : { provider: "anthropic", id: "claude-x" },
			sessionManager: { getBranch: () => BASE, getSessionId: () => "s" },
			modelRegistry: {
				complete: async (_model: unknown, ctx: { systemPrompt: string; messages: Array<{ content: string }> }) => {
					log.push({ op: "complete", systemPrompt: ctx.systemPrompt, prompt: ctx.messages[0].content });
					if ("throw" in reply) throw new Error(reply.throw as string);
					return reply;
				},
			},
			ui: {
				notify: (message: string, level: string) => log.push({ op: "notify", text: message, level }),
				setStatus: (key: string, value: string | undefined) => log.push({ op: "status", key, text: value ?? null }),
				setWidget: (key: string, factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined, widgetOptions?: unknown) =>
					log.push({ op: "widget", key, rows: factory ? factory(undefined, identity).render(50) : null, options: widgetOptions ?? null }),
			},
		});
		registerBtw(pi as never, { answerCardMs: options.answerCardMs });
		const records: unknown[] = [];
		for (const step of steps) {
			log = [];
			if (step.op === "btw") {
				if (step.reply) reply = step.reply;
				await commands.get("btw").handler(step.args, makeCtx(step));
				for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
			} else {
				for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, makeCtx({}));
			}
			records.push({ step, log });
		}
		return placeholders({ name, options, records });
	}
	const answer = { stopReason: "stop", content: [text("It is \x1b[1mcontext.go\x1b[0m.\nSecond line.")], usage: { input: 900, output: 200 } };
	scenarios.push(await runScenario("tui", { hasUI: true, mode: "tui" }, [
		{ op: "btw", args: "   " },
		{ op: "btw", args: "which file is largest?", reply: answer, streaming: true },
		{ op: "btw", args: "no model", noModel: true },
		{ op: "btw", args: "fails", reply: { stopReason: "error", errorMessage: "overloaded" } },
		{ op: "btw", args: "throws", reply: { throw: "socket hang up" } },
		{ op: "btw", args: "empty", reply: { stopReason: "stop", content: [] } },
		{ op: "btw", args: "x".repeat(900), reply: answer },
		{ op: "shutdown" },
	]));
	scenarios.push(await runScenario("rpc", { hasUI: true, mode: "rpc" }, [
		{ op: "btw", args: "q", reply: answer },
		{ op: "btw", args: "f", reply: { stopReason: "aborted" } },
		{ op: "shutdown" },
	]));
	scenarios.push(await runScenario("headless", { hasUI: false, mode: "json" }, [
		{ op: "btw", args: "" },
		{ op: "btw", args: "q", reply: answer },
		{ op: "btw", args: "f", reply: { throw: "boom" } },
		{ op: "shutdown" },
	]));
	scenarios.push(await runScenario("no answer card", { hasUI: true, mode: "tui", answerCardMs: 0 }, [
		{ op: "btw", args: "q", reply: answer },
		{ op: "shutdown" },
	]));
} finally {
	rmSync(root, { recursive: true, force: true });
}

const output = `${JSON.stringify(
	{
		constants: {
			maxQuestionChars: context.MAX_QUESTION_CHARS,
			maxFlowDigestChars: context.MAX_FLOW_DIGEST_CHARS,
			maxMessagesInDigest: context.MAX_MESSAGES_IN_DIGEST,
			maxPromptBytes: context.MAX_PROMPT_BYTES,
			snapshotMaxFiles: context.SNAPSHOT_MAX_FILES,
			snapshotMaxDirs: context.SNAPSHOT_MAX_DIRS,
			snapshotMaxDepth: context.SNAPSHOT_MAX_DEPTH,
			snapshotRootEntries: context.SNAPSHOT_ROOT_ENTRIES,
			snapshotTopFiles: context.SNAPSHOT_TOP_FILES,
			excludeDirs: [...context.SNAPSHOT_EXCLUDE_DIRS],
			systemPrompt: context.BTW_SYSTEM_PROMPT,
			maxAnswerChars: engine.MAX_ANSWER_CHARS,
			maxCardAnswerRows: display.MAX_CARD_ANSWER_ROWS,
			maxCardRows: display.MAX_CARD_ROWS,
			entryType: display.BTW_ENTRY_TYPE,
			widgetKey: display.BTW_WIDGET_KEY,
			statusKey: display.BTW_STATUS_KEY,
			now: NOW,
		},
		branches,
		digests,
		prompts: promptCases,
		sanitize: sanitizeCases,
		texts: textCases,
		outcomes,
		tokens: tokenCases,
		seconds: secondCases,
		toasts,
		boxes,
		cards,
		themed,
		statusLines,
		fixture: FIXTURE,
		snapshots: placeholders(snapshots),
		scenarios,
	},
	null,
	1,
)}\n`;
const goldenPath = join(here, "golden.json");
const counts = `${digests.length} digests, ${promptCases.length} prompts, ${outcomes.length} outcomes, ${boxes.length + cards.length} renders, ${snapshots.length} snapshots, ${scenarios.length} command scenarios`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("btw golden.json is stale: run npx tsx go/internal/btw/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`btw golden.json is current (${counts})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`btw golden.json: ${counts}`);
}
