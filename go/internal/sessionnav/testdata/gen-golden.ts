// Regenerate golden.json from the TypeScript session-nav feature (the
// reference):
//   npx tsx go/internal/sessionnav/testdata/gen-golden.ts [--check]
// It drives the real text.ts, checkpoints.ts, sessions.ts (with fixture
// session files for the tail preview), frame.ts, the RewindPicker and
// ResumePicker with key sequences rendered at several widths, and
// registerSessionNav through a scripted host (double-Esc timing, /resume
// and the resume action, the --sessions flag, settings, and the command
// guards). TZ is UTC and Date.now is pinned. Fixtures live in
// testdata/.fixture-<pid>, removed afterwards; paths are written as
// @@ROOT@@.
process.env.TZ = "UTC";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const NOW = Date.parse("2026-11-02T10:00:00Z");
let clock = NOW;
Date.now = () => clock;
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });

const text = await import(join(repo, "session-nav", "text.ts"));
const checkpoints = await import(join(repo, "session-nav", "checkpoints.ts"));
const sessions = await import(join(repo, "session-nav", "sessions.ts"));
const frame = await import(join(repo, "session-nav", "frame.ts"));
const { RewindPicker } = await import(join(repo, "session-nav", "rewind-view.ts"));
const { ResumePicker } = await import(join(repo, "session-nav", "resume-view.ts"));
const nav = await import(join(repo, "session-nav", "index.ts"));
const intercepts = await import(join(repo, "ui", "editor-intercepts.ts"));
const tui = await import("@earendil-works/pi-tui");
const { CONFIG_DIR_NAME, getAgentDir } = await import("@earendil-works/pi-coding-agent");

function placeholders<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null).split(root).join("@@ROOT@@")) as T;
}
const ROLE_CODES = (JSON.parse(readFileSync(join(repo, "go", "internal", "chrome", "testdata", "golden.json"), "utf8")) as { roleCodes: Record<string, number> }).roleCodes;
const theme = {
	fg: (role: string, t: string) => `\x1b[${ROLE_CODES[role] ?? 37}m${t}\x1b[39m`,
	bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	bg: (role: string, t: string) => `\x1b[${(ROLE_CODES[role] ?? 37) + 10}m${t}\x1b[49m`,
};
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

// ---- keys ----
const KEYS: Record<string, string> = {
	up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", enter: "\r", right: "\x1b[C", left: "\x1b[D",
	backspace: "\x7f", tab: "\t", shiftTab: "\x1b[Z", escape: "\x1b", ctrlC: "\x03", a: "a", t: "t", h: "h", i: "i", r: "r", d: "d", space: " ", one: "1", two: "2", four: "4", nine: "9",
	kittyX: "\x1b[120u", e_acute: "é", emoji: "🙂", del: "\x7f", paste: "abc",
};
const keyIds = ["up", "down", "pageUp", "pageDown", "home", "end", "enter", "right", "left", "backspace", "tab", "shift+tab", "escape", "ctrl+c"];
const keyTable = Object.entries(KEYS).map(([name, data]) => ({ name, data, keyIds: keyIds.filter((id) => tui.matchesKey(data, id)), kitty: tui.decodeKittyPrintable(data) ?? null, printable: frame.printableInput(data) ?? null }));

// ---- text ----
const titles = [
	"plain prompt", "  multi\n\nline   prompt\t", "", '<skill name="review">\nbody\n</skill>\nplease review', '<skill name="x" extra="1">a</skill>', "<skill name=\"bad\">unclosed",
].map((raw) => ({ raw, out: text.cleanPromptTitle(raw) }));
const ages = [0, -5000, 29_000, 31_000, 59 * 60_000, 60 * 60_000, 23 * 3600_000 + 59 * 60_000, 24 * 3600_000, 6 * 86_400_000, 7 * 86_400_000, 40 * 86_400_000, 400 * 86_400_000]
	.map((ago) => ({ ago, short: text.relativeAge(NOW - ago, NOW), long: text.relativeAgeLong(NOW - ago, NOW) }));
const millis = [NOW, "2026-11-02T10:00:00Z", "2026-11-02T10:00:00.123Z", "garbage", null, undefined, true].map((value) => ({ value: value ?? null, out: Number.isNaN(text.toMillis(value)) ? "NaN" : text.toMillis(value) }));
const queries = [["", "anything"], ["fix bug", "Fix the BUG now"], ["fix bug", "fix only"], ["  ", ""], ["a b", "", "b", "A"]].map(([q, ...fields]) => ({ query: q, fields, out: text.matchesQuery(q, ...fields) }));

// ---- checkpoints ----
type N = { entry: Record<string, unknown>; children: N[]; label?: string };
const node = (entry: Record<string, unknown>, ...children: N[]): N => ({ entry, children });
const user = (id: string, content: unknown, minute: number | null, ...children: N[]): N => node({ id, type: "message", timestamp: minute === null ? undefined : at(minute), message: { role: "user", content } }, ...children);
const assistant = (id: string, t: string, tools: string[], minute: number, ...children: N[]): N =>
	node({ id, type: "message", timestamp: at(minute), message: { role: "assistant", content: [...tools.map((name) => ({ type: "toolCall", name, arguments: {} })), ...(t ? [{ type: "text", text: t }] : [])] } }, ...children);
const custom = (id: string, minute: number, ...children: N[]): N => node({ id, type: "custom_message", timestamp: at(minute) }, ...children);
const sample = (): N[] => [
	user("u1", "first prompt", -300,
		custom("ctx", -300,
			assistant("a1", "did it", ["read", "edit"], -299,
				user("u2", [{ type: "text", text: "second " }, { type: "image" }, { type: "text", text: "prompt" }], -298,
					assistant("a2", "answer two", ["bash"], -297,
						user("u3b", "abandoned idea", -296, assistant("a3b", "nope", [], -295)),
						user("u3", '<skill name="deploy">x</skill> ship it', -2, assistant("a3", "answer three\nmore", ["write", "apply_patch", "multi_edit"], -1))))))),
];
const labeled = sample();
labeled[0].label = "start";
const trees: Record<string, { roots: N[]; leaf: string | null }> = {
	sample: { roots: sample(), leaf: "a3" },
	midLeaf: { roots: sample(), leaf: "a2" },
	abandonedLeaf: { roots: sample(), leaf: "a3b" },
	labeled: { roots: labeled, leaf: "u3" },
	noLeaf: { roots: sample(), leaf: null },
	empty: { roots: [], leaf: null },
	odd: {
		roots: [
			user("x1", "", null, assistant("x2", "", [], 1)),
			user("y1", 42, 5),
			node({ id: "z", type: "message", timestamp: at(3), message: { role: "assistant", content: "plain" } }, user("z1", "after assistant", 3)),
		],
		leaf: "z1",
	},
	long: { roots: [Array.from({ length: 30 }, (_, i) => i).reduceRight<N | undefined>((child, i) => user(`p${i}`, `prompt number ${i} with some words`, i - 100, assistant(`r${i}`, `reply ${i}`, i % 3 ? ["edit"] : [], i - 100, ...(child ? [child] : []))), undefined)!], leaf: "r29" },
};
const checkpointCases = Object.entries(trees).map(([name, t]) => {
	const list = checkpoints.buildCheckpoints(t.roots, t.leaf);
	return { name, roots: t.roots, leaf: t.leaf, out: list.map((c) => ({ ...c, timestamp: Number.isNaN(c.timestamp) ? "NaN" : c.timestamp })), options: list.map((c) => checkpoints.rewindOptions(c)) };
});

// ---- sessions ----
const S = (path: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
	path: join(root, "sessions", path), id: path, cwd: `/work/${path.split("-")[0]}`, created: new Date(NOW - minutesAgo * 60_000 - 1000), modified: new Date(NOW - minutesAgo * 60_000),
	messageCount: 3, firstMessage: `first message of ${path}`, ...extra,
});
const sessionList = [
	S("app-a", 5, { name: "  Named   session " }),
	S("app-b", 60 * 9.9),
	S("app-c", 60 * 11, { firstMessage: '<skill name="plan">x</skill>' }),
	S("lib-d", 60 * 30, { messageCount: 1, allMessagesText: "contains needle" }),
	S("lib-e", 60 * 24 * 3),
	S("app-f", 60 * 24 * 8, { firstMessage: "" }),
	S("lib-g", 60 * 24 * 40),
];
const groups = [0, 60 * 10 - 1, 60 * 10, 60 * 11, 60 * 34, 60 * 35, 60 * 24 * 6 + 60 * 10, 60 * 24 * 7].map((m) => ({ minutesAgo: m, out: sessions.groupFor(NOW - m * 60_000, NOW) }));
const titlesS = sessionList.map((s) => ({ path: s.path, out: sessions.sessionTitle(s) }));
const filters = ["", "needle", "named", "lib", "first app", "zzz"].map((q) => ({ query: q, out: sessions.filterSessions(sessionList, q).map((s: { path: string }) => s.path) }));
const grouped = sessions.groupSessions(sessionList, NOW).map((g: { group: string; sessions: Array<{ path: string }> }) => ({ group: g.group, paths: g.sessions.map((s) => s.path) }));
const sessDir = join(root, "sessions");
mkdirSync(sessDir, { recursive: true });
const jsonl = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
const files: Record<string, string> = {
	"app-a": jsonl([{ type: "session", id: "h" }, { type: "message", message: { role: "user", content: "hello there" } }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "  general kenobi  " }] } }]),
	"app-b": jsonl([{ type: "message", message: { role: "user", content: '<skill name="s">x</skill> do it' } }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }, "not json", { type: "custom" }]),
	"app-c": jsonl([{ type: "session" }]),
	"lib-d": jsonl([{ type: "message", message: { role: "user", content: "x".repeat(400) } }, { type: "message", message: { role: "assistant", content: "tail reply" } }]),
	"lib-e": "",
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(sessDir, name), content);
const tails: unknown[] = [];
for (const [name, maxBytes] of [["app-a", undefined], ["app-b", undefined], ["app-c", undefined], ["lib-d", undefined], ["lib-d", 100], ["lib-e", undefined], ["missing", undefined]] as Array<[string, number | undefined]>) {
	try {
		tails.push({ name, maxBytes: maxBytes ?? null, out: await sessions.readLastExchange(join(sessDir, name), maxBytes), error: false });
	} catch {
		tails.push({ name, maxBytes: maxBytes ?? null, out: null, error: true });
	}
}

// ---- frame helpers ----
const frames = [0, 3, 4, 5, 12, 30].flatMap((width) => [
	{ width, title: "▎ TITLE", sections: [{ lines: ["one", "two wide 漢字"] }, { label: "section", lines: ["three"] }, { lines: [] }] },
	{ width, title: "", sections: [] },
].map((c) => ({ ...c, out: frame.renderFrame(theme, c.width, c.title, c.sections) })));
const splits = [["left text", "meta"], ["a much longer left text that needs truncation", "right side"], ["", "r"], ["l", ""], ["l", "rrrrrrrrrrrrrrrr"]].flatMap(([l, r]) => [0, 5, 10, 20, 40].map((width) => ({ left: l, right: r, width, out: frame.splitRow(l, r, width) })));
const wraps = [["short", 10, 2], ["one two three four five six seven eight nine ten", 10, 2], ["one two three", 0, 2], ["one two three", 5, 0], ["  spaced\n\nout  text ", 6, 3], ["supercalifragilistic", 5, 2]].map(([t, w, m]) => ({ text: t, width: w, maxLines: m, out: frame.wrapLimited(t as string, w as number, m as number) }));
const windows = [[5, 2, 10], [20, 0, 5], [20, 10, 5], [20, 19, 5], [20, 3, 4], [7, 6, 3]].map(([total, sel, size]) => ({ total, selected: sel, size, out: frame.visibleWindow(total, sel, size) }));

// ---- pickers ----
type Script = { keys: string[]; widths: number[]; rows: number };
async function runRewind(name: string, tree: string, script: Script) {
	const list = checkpoints.buildCheckpoints(trees[tree].roots, trees[tree].leaf);
	let done: unknown = "open";
	const picker = new RewindPicker({ theme, checkpoints: list, maxRows: () => script.rows, done: (r: unknown) => { done = r ?? null; }, requestRender: () => {} });
	const frames: unknown[] = [];
	const snap = (key: string | null) => frames.push({ key, view: picker.view, query: picker.query, selected: picker.selected()?.id ?? null, done, renders: script.widths.map((w) => picker.render(w)) });
	snap(null);
	for (const key of script.keys) {
		picker.handleInput(KEYS[key]);
		snap(key);
	}
	return { name, tree, rows: script.rows, widths: script.widths, frames };
}
const rewinds = [
	await runRewind("browse", "sample", { keys: ["down", "down", "up", "end", "home", "pageDown", "enter", "down", "down", "down", "down", "up", "left", "right", "escape", "escape"], widths: [10, 40, 72], rows: 30 }),
	await runRewind("filter", "sample", { keys: ["t", "h", "i", "r", "d", "backspace", "escape", "a", "space", "i", "d", "enter", "two", "escape", "kittyX", "e_acute", "emoji", "paste", "escape", "escape"], widths: [50], rows: 20 }),
	await runRewind("pick by number", "midLeaf", { keys: ["enter", "four"], widths: [60], rows: 24 }),
	await runRewind("pick enter", "abandonedLeaf", { keys: ["down", "enter", "down", "enter"], widths: [60], rows: 24 }),
	await runRewind("long list", "long", { keys: ["pageDown", "pageDown", "down", "end", "pageUp", "ctrlC", "down"], widths: [30, 80], rows: 14 }),
	await runRewind("empty", "empty", { keys: ["enter", "a", "escape"], widths: [40], rows: 20 }),
	await runRewind("odd", "odd", { keys: ["enter", "nine", "one"], widths: [3, 4, 5, 24, 60], rows: 5 }),
];
async function runResume(name: string, script: Script & { fail?: string; previewFail?: boolean; cwd?: string; current?: string }) {
	let done: unknown = "open";
	const loads: string[] = [];
	const picker = new ResumePicker({
		theme, cwd: script.cwd ?? "/work/app", currentPath: script.current, homeDir: "/work",
		loadSessions: async (scope: string) => {
			loads.push(scope);
			if (script.fail === scope) throw new Error("disk on fire");
			return scope === "folder" ? sessionList.filter((s) => s.cwd === "/work/app") : sessionList;
		},
		loadPreview: async (path: string) => {
			if (script.previewFail) throw new Error("x");
			return sessions.readLastExchange(path);
		},
		maxRows: () => script.rows, done: (p: unknown) => { done = p ?? null; }, requestRender: () => {},
	});
	const frames: unknown[] = [];
	const snap = async (key: string | null) => {
		const early = script.widths.map((w) => picker.render(w));
		await flush();
		frames.push({ key, scope: picker.scope, query: picker.query, selected: picker.selected()?.path ?? null, done, early, renders: script.widths.map((w) => picker.render(w)) });
	};
	await snap(null);
	for (const key of script.keys) {
		picker.handleInput(KEYS[key]);
		await snap(key);
	}
	return { name, rows: script.rows, widths: script.widths, cwd: script.cwd ?? "/work/app", current: script.current ?? null, fail: script.fail ?? null, previewFail: Boolean(script.previewFail), loads, frames };
}
const resumes = [
	await runResume("browse", { keys: ["down", "down", "up", "tab", "down", "down", "down", "pageDown", "pageUp", "shiftTab", "enter"], widths: [20, 50, 90], rows: 30, current: join(root, "sessions", "app-a") }),
	await runResume("search", { keys: ["tab", "a", "space", "a", "backspace", "backspace", "backspace", "escape", "kittyX", "escape", "escape"], widths: [60], rows: 12 }),
	await runResume("small window", { keys: ["tab", "down", "down", "down", "down", "down", "ctrlC"], widths: [40], rows: 10 }),
	await runResume("load error", { keys: ["tab", "tab"], widths: [50], rows: 20, fail: "all" }),
	await runResume("preview error", { keys: ["down"], widths: [50], rows: 20, previewFail: true }),
	await runResume("empty folder", { keys: ["enter", "tab"], widths: [50], rows: 20, cwd: "/elsewhere/none" }),
	await runResume("narrow", { keys: ["down"], widths: [1, 4, 5, 9], rows: 20, cwd: "/" }),
];

// ---- settings and launch ----
const escapeSettings: unknown[] = [];
for (const [name, global, project] of [
	["defaults", undefined, undefined], ["global none", { doubleEscapeAction: "none" }, undefined], ["project fork", { doubleEscapeAction: "none" }, { doubleEscapeAction: "fork" }],
	["invalid", { doubleEscapeAction: "bogus" }, { doubleEscapeAction: 3 }], ["broken", "{ nope", "[1]"],
] as Array<[string, unknown, unknown]>) {
	const dir = join(root, "esc", name.replace(/ /g, "-"));
	mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
	rmSync(join(agentDir, "settings.json"), { force: true });
	if (global !== undefined) writeFileSync(join(agentDir, "settings.json"), typeof global === "string" ? global : JSON.stringify(global));
	if (project !== undefined) writeFileSync(join(dir, CONFIG_DIR_NAME, "settings.json"), typeof project === "string" ? project : JSON.stringify(project));
	for (const trusted of [true, false]) {
		escapeSettings.push({ name, global: global === undefined ? null : typeof global === "string" ? global : JSON.stringify(global), project: project === undefined ? null : typeof project === "string" ? project : JSON.stringify(project), cwd: dir, trusted, out: nav.readDoubleEscapeAction(dir, trusted) });
	}
}
rmSync(join(agentDir, "settings.json"), { force: true });
const launches = [[], ["--sessions"], ["-c"], ["--continue", "--sessions"], ["-r"], ["--session", "x.jsonl"], ["--session-id", "abc"], ["--fork", "f"], ["--no-session"], ["-p", "hi"], ["--model", "m", "--sessions"]]
	.map((args) => ({ args, out: nav.launchSelectsSession(["node", "pi", ...args]) }));
const pickerRows = [0, 5, 12, 13, 24, 35, 50].map((rows) => ({ rows, out: Math.max(10, Math.floor(rows * 0.8)) }));
const applied: unknown[] = [];
for (const action of ["edit", "after", "summary", "fork"]) {
	const calls: unknown[] = [];
	await nav.applyRewind({
		navigateTree: async (id: string, opts: unknown) => calls.push(["navigateTree", id, opts]),
		fork: async (id: string, opts: unknown) => calls.push(["fork", id, opts]),
		ui: { notify: (m: string, l: string) => calls.push(["notify", m, l]) },
	} as never, { checkpoint: { id: "u2", endId: "a2" }, action });
	applied.push({ action, calls });
}

// ---- registerSessionNav ----
async function runRegistrar(name: string, options: { mode?: string; flag?: boolean; argv?: string[]; reason?: string }) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let log: unknown[] = [];
	const state = { idle: true, pending: false };
	const ctx = {
		mode: options.mode ?? "tui", hasUI: true, cwd: join(root, "esc", "defaults"),
		isIdle: () => state.idle, hasPendingMessages: () => state.pending, isProjectTrusted: () => false,
		sessionManager: { getTree: () => [], getLeafId: () => null, getCwd: () => "/work/app", getSessionDir: () => join(agentDir, "sessions", "x"), getSessionFile: () => "current.jsonl" },
		ui: { notify: (m: string, l: string) => log.push(["notify", m, l]), custom: async () => (log.push(["custom"]), undefined) },
	};
	const pi = {
		registerFlag: (n: string, spec: unknown) => log.push(["flag", n, spec]),
		getFlag: () => options.flag ?? false,
		on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(n, c),
		sendUserMessage: (t: string, opts: unknown) => log.push(["send", t, opts]),
	};
	nav.registerSessionNav(pi as never, ["node", "pi", ...(options.argv ?? [])]);
	type Step = { op: string; at?: number; idle?: boolean; pending?: boolean; arg?: string };
	const steps: Step[] = [
		{ op: "session_start" },
		{ op: "escape", at: 0 }, { op: "escape", at: 300 }, { op: "escape", at: 400 }, { op: "escape", at: 1000 }, { op: "escape", at: 1600 },
		{ op: "escape", at: 1700, idle: false }, { op: "escape", at: 1800, idle: true }, { op: "escape", at: 1900, pending: true }, { op: "escape", at: 2000, pending: false }, { op: "escape", at: 2499 },
		{ op: "submit", arg: " /resume " }, { op: "submit", arg: "/resume now" }, { op: "action", arg: "app.session.resume" }, { op: "action", arg: "app.other" },
		{ op: "command", arg: "rewind", idle: false }, { op: "command", arg: "rewind", idle: true }, { op: "command", arg: "sessions" },
		{ op: "session_shutdown" }, { op: "escape", at: 3000 },
	];
	const records: unknown[] = [];
	for (const step of steps) {
		log = [];
		if (step.idle !== undefined) state.idle = step.idle;
		if (step.pending !== undefined) state.pending = step.pending;
		if (step.at !== undefined) clock = NOW + step.at;
		let out: unknown = null;
		const current = intercepts.getEditorIntercepts();
		switch (step.op) {
			case "session_start":
				for (const fn of handlers.get("session_start") ?? []) await fn({ reason: options.reason ?? "startup" }, ctx);
				await new Promise((resolve) => setTimeout(resolve, 5));
				break;
			case "session_shutdown":
				for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx);
				break;
			case "escape": out = current.escape?.() ?? null; break;
			case "submit": out = current.submit?.(step.arg!) ?? null; break;
			case "action": out = current.action?.(step.arg!) ?? null; break;
			case "command": await commands.get(step.arg!)!.handler("", ctx); break;
		}
		records.push({ step, out, log });
	}
	clock = NOW;
	intercepts.setEditorIntercepts(undefined);
	return { name, options, records };
}
const registrars = [
	await runRegistrar("tui startup with flag", { flag: true }),
	await runRegistrar("flag with --continue", { flag: true, argv: ["-c"] }),
	await runRegistrar("rpc", { mode: "rpc", flag: true }),
	await runRegistrar("reload", { flag: true, reason: "reload" }),
];

rmSync(root, { recursive: true, force: true });
const output = `${JSON.stringify(placeholders({
	roleCodes: ROLE_CODES, now: NOW, configDirName: CONFIG_DIR_NAME, agentDir: getAgentDir(), keyTable,
	titles, ages, millis, queries, checkpointCases, sessionList, groups, titlesS, filters, grouped, files, tails,
	frames, splits, wraps, windows, rewinds, resumes, escapeSettings, launches, pickerRows, applied, registrars,
}), null, 1)}\n`;
const goldenPath = join(here, "golden.json");
const count = (list: Array<{ frames: Array<{ renders: unknown[] }> }>) => list.reduce((n, r) => n + r.frames.reduce((m, f) => m + f.renders.length, 0), 0);
const summary = `${titles.length + ages.length + millis.length + queries.length} text cases, ${checkpointCases.length} checkpoint trees, ${groups.length + titlesS.length + filters.length} session cases, ${tails.length} tail reads, ${frames.length + splits.length + wraps.length + windows.length} layout cases, ${rewinds.length} rewind scripts (${count(rewinds)} renders), ${resumes.length} resume scripts (${count(resumes)} renders), ${escapeSettings.length} settings loads, ${launches.length} launch argv, ${registrars.length} registrar runs`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("session-nav golden.json is stale: run npx tsx go/internal/sessionnav/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`session-nav golden.json is current (${summary})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`session-nav golden.json: ${summary}`);
}
