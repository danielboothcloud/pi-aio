// Regenerate golden.json from the TypeScript notifications (the reference):
//   npx tsx go/internal/notifications/testdata/gen-golden.ts [--check]
// SCENARIOS drive the real registerNotifications with a fake backend; the
// Go test replays the same steps against its engine.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const { registerNotifications } = await import(join(repo, "notifications", "index.ts"));
const backendModule = await import(join(repo, "notifications", "backend.ts"));
const settingsModule = await import(join(repo, "notifications", "settings.ts"));

const cleanInputs = ["plain", "  a\n\tb  ", "\x1b[31mred\x1b[0m", "\x1b]8;;http://x\x07link\x1b]8;;\x07", "semi;colon", "\x9b2Jcsi8",
	"\x00ctrl\x7f\x85", "日本語のテキスト", "x".repeat(200), "😀".repeat(90), "a\u2028b\u00a0c"];
const clean = cleanInputs.flatMap((text) => [160, 5, 100].map((max) => ({ text, max, result: backendModule.cleanText(text, max) })));

const normalizeInputs = [null, [], "x", {}, { enabled: false, focusSkip: false, preview: true, minSeconds: 30, sound: "Ping", categories: { goal: false, core: "x" } },
	{ minSeconds: -1, sound: "bad;sound" }, { minSeconds: 86401 }, { minSeconds: 1.5, sound: "a b-c_d" }, { sound: "x".repeat(65) }];
const normalized = normalizeInputs.map((value) => ({ value, result: settingsModule.normalizeSettings(value) }));

// Backend delivery paths with a fake runner.
const backendCases: unknown[] = [];
for (const [name, platform, env, fails] of [
	["mac-native", "darwin", { TERM_PROGRAM: "ghostty" }, []],
	["mac-no-notifier", "darwin", { TERM_PROGRAM: "iTerm.app" }, ["terminal-notifier"]],
	["mac-no-sound", "darwin", {}, ["terminal-notifier", "afplay"]],
	["linux", "linux", { TERM_PROGRAM: "WezTerm" }, []],
	["kitty-tmux", "linux", { KITTY_WINDOW_ID: "1", TMUX: "x" }, []],
	["ssh", "darwin", { SSH_TTY: "/dev/ttys1", __CFBundleIdentifier: "bad bundle!" }, []],
] as const) {
	const calls: unknown[] = [];
	const writes: string[] = [];
	const backend = backendModule.createNotificationBackend({
		platform, env: env as NodeJS.ProcessEnv,
		execute: async (bin: string, args: string[]) => { calls.push([bin, ...args]); if ((fails as readonly string[]).includes(bin)) throw new Error("no"); return bin === "osascript" ? "com.mitchellh.ghostty\n" : ""; },
		write: (text: string) => writes.push(text),
	});
	const nameBefore = backend.name();
	const focused = await backend.focused(new AbortController().signal);
	for (const sound of ["Glass", "off"]) {
		await backend.send({ title: "Pi · T;x", body: "body\x1b[1m!", subtitle: "sub", group: "g", sound }, new AbortController().signal, () => true);
	}
	backendCases.push({ name, platform, env, fails, nameBefore, nameAfter: backend.name(), focused, calls, writes });
}

type Step = Record<string, unknown> & { op: string };
const SCENARIOS: Record<string, Step[]> = {
	finished: [{ op: "start" }, { op: "agentStart", t: 0 }, { op: "messageEnd", stop: "stop", text: "Done; all good" }, { op: "settled", t: 1000 }],
	error: [{ op: "start" }, { op: "agentStart", t: 0 }, { op: "messageEnd", stop: "error", text: "boom" }, { op: "settled", t: 10 }],
	aborted: [{ op: "start" }, { op: "agentStart", t: 0 }, { op: "messageEnd", stop: "aborted", text: "x" }, { op: "settled", t: 10 },
		{ op: "agentStart", t: 20 }, { op: "settled", t: 30, aborted: true }],
	tooShort: [{ op: "start", settings: { minSeconds: 5 } }, { op: "agentStart", t: 0 }, { op: "settled", t: 4999 }, { op: "agentStart", t: 6000 }, { op: "settled", t: 11000 }],
	notTui: [{ op: "start", mode: "rpc" }, { op: "agentStart", t: 0 }, { op: "settled", t: 10 }],
	disabled: [{ op: "start", settings: { enabled: false } }, { op: "agentStart", t: 0 }, { op: "settled", t: 10 }, { op: "command", args: "test" }],
	coreOff: [{ op: "start", settings: { categories: { core: false } } }, { op: "agentStart", t: 0 }, { op: "settled", t: 10 },
		{ op: "signal", s: { category: "goal", id: "g1", title: "Goal", body: "done", replacesCompletion: true } }],
	focused: [{ op: "start", focused: true }, { op: "agentStart", t: 0 }, { op: "settled", t: 10 }, { op: "command", args: "test" }],
	preview: [{ op: "start", settings: { preview: true } }, { op: "agentStart", t: 0 }, { op: "messageEnd", stop: "stop", text: "the answer" }, { op: "settled", t: 10 }],
	prompts: [{ op: "start" }, { op: "agentStart", t: 0 },
		{ op: "prompt", p: { id: 1, kind: "select", title: "Approval needed", body: "waiting", preview: "rm x", active: true } },
		{ op: "prompt", p: { id: 1, kind: "select", title: "Approval needed", body: "waiting", active: true } },
		{ op: "prompt", p: { id: 1, active: false } },
		{ op: "prompt", p: { id: 2, kind: "select", title: "Other session", body: "x", active: true }, otherSession: true },
		{ op: "settled", t: 10 }],
	signals: [{ op: "start" }, { op: "agentStart", t: 0 },
		{ op: "signal", s: { category: "background", id: "a", title: "Subagent", body: "done" } },
		{ op: "signal", s: { category: "background", id: "a", title: "Subagent", body: "again" } },
		{ op: "signal", s: { category: "critical", id: "c", title: "Crit", body: "x", replacesCompletion: true } },
		{ op: "signal", s: { category: "goal", id: "z", title: "Other", body: "x" }, otherSession: true },
		{ op: "settled", t: 10 }, { op: "agentStart", t: 20 }, { op: "settled", t: 30 }],
	goal: [{ op: "start" }, { op: "goal", active: true }, { op: "agentStart", t: 0 }, { op: "settled", t: 10 },
		{ op: "goal", active: false, quietSettle: true }, { op: "agentStart", t: 20 }, { op: "goal", active: false, quietSettle: true }, { op: "settled", t: 30 },
		{ op: "agentStart", t: 40 }, { op: "settled", t: 50 }],
	shutdown: [{ op: "start" }, { op: "agentStart", t: 0 }, { op: "shutdown" }, { op: "settled", t: 10 }],
	commands: [{ op: "start" }, ...["", "status", "off", "status", "on", "focus off", "preview on", "min 2.5", "min 0x10", "min -1", "min 86401", "sound Ping", "sound bad;x",
		"events goal off", "events nope on", "events core maybe", "on extra", "test", "test 61", "test x", "test 1 2", "bogus", "status"]
		.map((args) => ({ op: "command", args }))],
};

const results: Record<string, unknown> = {};
for (const [name, steps] of Object.entries(SCENARIOS)) {
	const sends: unknown[] = [];
	const notices: unknown[] = [];
	const saved: unknown[] = [];
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let now = 0;
	let focused = false;
	const pi = {
		events: { on: (channel: string, fn: (data: unknown) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]); return () => {}; },
			emit: (channel: string, data: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(data); } },
		on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		registerCommand: (_: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commandHandler = options.handler; },
		getSessionName: () => "My session",
	};
	let settings = settingsModule.defaultSettings();
	const backend = {
		name: () => "fake",
		focused: async () => focused,
		send: async (n: unknown, _signal: AbortSignal, valid: () => boolean) => { if (valid()) sends.push(n); },
	};
	const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
	const fire = async (event: string, data: unknown, ctx: unknown) => { for (const fn of handlers.get(event) ?? []) await fn(data, ctx); };
	let ctx: Record<string, unknown> = {};
	registerNotifications(pi as never, {
		backend, load: () => settings, save: (s: unknown) => { saved.push(s); }, now: () => now,
		wait: async () => {},
	});
	for (const step of steps) {
		switch (step.op) {
			case "start":
				settings = settingsModule.normalizeSettings({ ...settingsModule.defaultSettings(), ...(step.settings as object), categories: { ...settingsModule.defaultSettings().categories, ...((step.settings as { categories?: object })?.categories ?? {}) } });
				focused = step.focused === true;
				ctx = { mode: step.mode ?? "tui", hasUI: true, cwd: "/work/proj", sessionManager: { getSessionId: () => "s1" },
					ui: { notify: (m: string, level: string) => notices.push([m, level]) } };
				await fire("session_start", { reason: "startup" }, ctx);
				break;
			case "agentStart": now = step.t as number; await fire("agent_start", {}, ctx); break;
			case "messageEnd": await fire("message_end", { message: { role: "assistant", stopReason: step.stop, content: [{ type: "text", text: step.text }, { type: "thinking", thinking: "x" }] } }, ctx); break;
			case "settled": now = step.t as number; await fire("agent_settled", { aborted: step.aborted === true }, ctx); break;
			case "shutdown": await fire("session_shutdown", {}, ctx); break;
			case "prompt": pi.events.emit("aio:notification:agent-prompt", { sessionId: step.otherSession ? "s2" : "s1", ...(step.p as object) }); break;
			case "goal": pi.events.emit("aio:notification:goal-activity", { sessionId: "s1", active: step.active, quietSettle: step.quietSettle === true }); break;
			case "signal": pi.events.emit("aio:notification", { sessionId: step.otherSession ? "s2" : "s1", ...(step.s as object) }); break;
			case "command": await commandHandler!(step.args as string, ctx); break;
		}
		await flush();
	}
	results[name] = { sends, notices, saved };
}

const output = `${JSON.stringify({ clean, normalized, defaults: settingsModule.defaultSettings(), backendCases, scenarios: SCENARIOS, results }, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("notifications golden.json is stale: run npx tsx go/internal/notifications/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`notifications golden.json is current (${Object.keys(SCENARIOS).length} scenarios)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`notifications golden.json: ${clean.length} clean cases, ${backendCases.length} backends, ${Object.keys(SCENARIOS).length} scenarios`);
}
