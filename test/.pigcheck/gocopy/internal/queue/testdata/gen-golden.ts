// Regenerate golden.json from the TypeScript queue feature (the reference):
//   npx tsx go/internal/queue/testdata/gen-golden.ts [--check]
// It drives the real mirror.ts and controller.ts (scripted host state and
// recorded dependency calls), lines.ts (the widget at several widths with
// the ANSI test theme), registerQueue through a scripted host (panel rows,
// widget updates in plain and framed editors, /queue, restore merges), and
// QueueEditor (a real pi-tui CustomEditor) with key sequences that reach
// the editor intercepts, the empty-submit hook, and the user-bash spacing.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const { QueueMirror } = await import(join(repo, "queue", "mirror.ts"));
const { QueueController } = await import(join(repo, "queue", "controller.ts"));
const lines = await import(join(repo, "queue", "lines.ts"));
const { registerQueue, restoreTextsToEditor } = await import(join(repo, "queue", "index.ts"));
const { QueueEditor } = await import(join(repo, "queue", "queue-editor.ts"));
const protocol = await import(join(repo, "frame", "protocol.ts"));
const intercepts = await import(join(repo, "ui", "editor-intercepts.ts"));
const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
const tui = await import("@earendil-works/pi-tui");

const ROLE_CODES = (JSON.parse(readFileSync(join(repo, "go", "internal", "chrome", "testdata", "golden.json"), "utf8")) as { roleCodes: Record<string, number> }).roleCodes;
const ansi = {
	fg: (role: string, text: string) => `\x1b[${ROLE_CODES[role] ?? 37}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${(ROLE_CODES[role] ?? 37) + 10}m${text}\x1b[49m`,
};

// ---- mirror ----
type MirrorOp = [string, ...unknown[]];
const mirrorScript: MirrorOp[] = [
	["add", "a", "steer"], ["add", "b", "followUp"], ["add", "a", "followUp"], ["add", "c", "steer"],
	["entries"], ["next"], ["removeDelivered", "a"], ["removeDelivered", "a"], ["removeDelivered", "zz"],
	["remove", { text: "b", mode: "steer" }], ["remove", { text: "b", mode: "followUp" }], ["removeNext"], ["removeNext"],
	["isEmpty"], ["add", "d", "followUp"], ["size"], ["clear"], ["next"], ["removeNext"],
];
const mirror = new QueueMirror();
const mirrorSteps = mirrorScript.map(([op, ...args]) => {
	let out: unknown;
	switch (op) {
		case "size": out = mirror.size; break;
		case "isEmpty": out = mirror.isEmpty; break;
		default: out = (mirror as unknown as Record<string, (...a: unknown[]) => unknown>)[op](...args);
	}
	return { op, args, out: out ?? null, entries: mirror.entries() };
});

// ---- controller ----
type Step = { op: string; arg?: unknown; mode?: string; idle?: boolean; pending?: boolean };
function runController(name: string, steps: Step[]) {
	const state = { idle: true, pending: false };
	let calls: unknown[] = [];
	const controller = new QueueController({
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		abort: () => calls.push(["abort"]),
		clearEditor: () => calls.push(["clearEditor"]),
		restoreTextsToEditor: (texts: string[]) => calls.push(["restore", texts]),
		sendUserMessage: (text: string, mode: string) => calls.push(["send", text, mode]),
		notify: (message: string, type: string) => calls.push(["notify", message, type]),
		updateWidget: () => calls.push(["updateWidget"]),
	});
	return {
		name,
		steps: steps.map((step) => {
			if (step.idle !== undefined) state.idle = step.idle;
			if (step.pending !== undefined) state.pending = step.pending;
			calls = [];
			let out: unknown = null;
			switch (step.op) {
				case "queued": controller.handleQueuedInput(step.arg as string, step.mode as string); break;
				case "delivered": controller.handleUserMessageText(step.arg as string); break;
				case "resync": controller.resync(); break;
				case "emptySubmit": out = controller.onEmptySubmit(); break;
				case "agentStart": controller.onAgentStart(); break;
				case "agentSettled": controller.onAgentSettled(); break;
			}
			return { step, out, calls, entries: controller.mirror.entries(), busy: controller.flowBusy };
		}),
	};
}
const controllers = [
	runController("interrupt and deliver", [
		{ op: "queued", arg: "first", mode: "steer", idle: false, pending: true },
		{ op: "queued", arg: "second", mode: "followUp" },
		{ op: "queued", arg: "third", mode: "steer" },
		{ op: "emptySubmit" },
		{ op: "emptySubmit" },
		{ op: "agentSettled", idle: true, pending: false },
		{ op: "delivered", arg: "first" },
		{ op: "agentStart", idle: false },
		{ op: "queued", arg: "third", mode: "steer", pending: true },
		{ op: "queued", arg: "second", mode: "followUp" },
		{ op: "delivered", arg: "third" },
		{ op: "agentSettled", idle: true },
		{ op: "resync", pending: false },
	]),
	runController("deferred send fails", [
		{ op: "queued", arg: "x", mode: "followUp", idle: false, pending: true },
		{ op: "queued", arg: "y", mode: "followUp" },
		{ op: "emptySubmit" },
		{ op: "agentSettled", idle: false },
		{ op: "emptySubmit", idle: true, pending: false },
		{ op: "emptySubmit" },
	]),
	runController("orphans on settle", [
		{ op: "queued", arg: "only", mode: "steer", idle: false, pending: true },
		{ op: "emptySubmit" },
		{ op: "delivered", arg: "other" },
		{ op: "agentSettled", idle: true, pending: false },
	]),
	runController("mirror miss", [
		{ op: "emptySubmit", idle: false, pending: true },
		{ op: "emptySubmit", pending: false },
		{ op: "queued", arg: "q", mode: "steer" },
		{ op: "resync", pending: false },
		{ op: "emptySubmit", idle: true },
	]),
];

// ---- widget lines ----
const entrySets: Record<string, Array<{ text: string; mode: string }>> = {
	none: [],
	one: [{ text: "fix the tests", mode: "steer" }],
	mixed: [
		{ text: "first line\nsecond line", mode: "steer" },
		{ text: "follow up with a much longer message that will not fit in narrow widths", mode: "followUp" },
		{ text: "漢字 message 🙂", mode: "followUp" },
		{ text: "", mode: "steer" },
		{ text: "five", mode: "followUp" },
		{ text: "six", mode: "followUp" },
		{ text: "seven", mode: "steer" },
	],
};
const widgetLines = Object.entries(entrySets).flatMap(([name, entries]) =>
	[0, 1, 8, 20, 40, 80].flatMap((width) => [undefined, 2].map((maxRows) => ({ name, width, maxRows: maxRows ?? null, out: lines.buildQueueLines({ entries, width, theme: ansi, maxRows }) }))));
const previews = ["", "one", "a\nb", "\nlead", "x\r\ny"].map((text) => ({ text, out: lines.firstLinePreview(text) }));

// ---- registerQueue ----
async function runRegistrar(name: string, options: { framed?: boolean; mode?: string }) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let log: unknown[] = [];
	let factory: unknown;
	let editorText = "";
	const ctx = {
		mode: options.mode ?? "tui", hasUI: true,
		isIdle: () => false, hasPendingMessages: () => true, abort: () => log.push(["abort"]),
		ui: {
			theme: ansi,
			getEditorComponent: () => factory,
			setEditorComponent: (f: unknown) => {
				factory = f;
				if (options.framed && f) (f as Record<symbol, boolean>)[Symbol.for("aio.frame-editor-factory")] = true;
				log.push(["setEditorComponent"]);
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; log.push(["setEditorText", text]); },
			setWidget: (key: string, content: unknown, opts: unknown) => {
				const rows = typeof content === "function" ? (content as (t: unknown, th: unknown) => { render(w: number): string[] })(undefined, ansi).render(60) : null;
				log.push(["setWidget", key, rows, opts ?? null]);
			},
			notify: (message: string, level: string) => log.push(["notify", message, level]),
		},
	};
	const pi = {
		on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(n, c),
		sendUserMessage: (text: string, opts: unknown) => log.push(["send", text, opts]),
	};
	registerQueue(pi as never);
	const fire = async (event: string, payload: unknown = {}) => {
		for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
	};
	const steps: Array<[string, unknown?]> = [
		["session_start"],
		["input", { text: "queued one", streamingBehavior: "steer" }],
		["input", { text: "queued two\nmore", streamingBehavior: "followUp" }],
		["input", { text: "not queued" }],
		["command", "status"],
		["command", "off"],
		["command", ""],
		["command", "on"],
		["command", "bogus"],
		["message_start", { message: { role: "user", content: [{ type: "text", text: "queued " }, { type: "image" }, { type: "text", text: "one" }] } }],
		["message_start", { message: { role: "assistant", content: "x" } }],
		["agent_end"],
		["session_shutdown"],
	];
	const records: unknown[] = [];
	for (const [op, arg] of steps) {
		log = [];
		if (op === "command") await commands.get("queue")!.handler(arg as string, ctx);
		else await fire(op, arg ?? {});
		records.push({ op, arg: arg ?? null, log, panel: protocol.getQueuePanelLines() });
	}
	return { name, options, records };
}
const registrars = [await runRegistrar("plain", {}), await runRegistrar("framed", { framed: true }), await runRegistrar("rpc", { mode: "rpc" })];
const restores = [
	{ current: "", texts: ["a", "b"] }, { current: "draft", texts: ["a"] }, { current: "has a inside", texts: ["a", "b"] },
	{ current: "  ", texts: [] }, { current: "x", texts: ["x"] }, { current: "", texts: ["", " "] },
].map((c) => {
	let out: string | null = null;
	restoreTextsToEditor({ hasUI: true, ui: { getEditorText: () => c.current, setEditorText: (t: string) => { out = t; } } } as never, c.texts);
	return { ...c, out };
});

// ---- QueueEditor ----
const editorTheme = {
	borderColor: (text: string) => text,
	selectList: { selectedPrefix: (t: string) => t, selectedText: (t: string) => t, description: (t: string) => t, scrollInfo: (t: string) => t, noMatch: (t: string) => t },
};
const APP: Record<string, string> = { "app.interrupt": "\x1b", "app.session.resume": "\x12" };
const keybindings = () => {
	const base = tui.getKeybindings();
	return new Proxy(base, {
		get(target, key, receiver) {
			if (key === "matches") return (data: string, id: string) => (id in APP ? data === APP[id] : target.matches(data, id as never));
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as never;
};
const KEYS: Record<string, string> = { esc: "\x1b", enter: "\r", ctrlR: "\x12", bs: "\x7f", bang: "!", l: "l", s: "s", x: "x", space: " ", backslash: "\\", left: "\x1b[D" };
const bindingIds = ["tui.input.submit", "app.interrupt", "app.session.resume"];
const keyTable = Object.entries(KEYS).map(([name, data]) => ({ name, data, bindings: bindingIds.filter((id) => keybindings().matches(data, id)) }));

type EditorStep = { key?: string; setText?: string; claim?: Record<string, unknown>; emptySubmit?: boolean };
let baseLog: Array<{ data: string; after: string }> = [];
const originalHandle = CustomEditor.prototype.handleInput;
CustomEditor.prototype.handleInput = function (this: { getText(): string }, data: string) {
	originalHandle.call(this, data);
	baseLog.push({ data, after: this.getText() });
};
function runEditor(name: string, withIntercepts: boolean, steps: EditorStep[]) {
	let events: unknown[] = [];
	let statuses: unknown[] = [];
	const claims = { escape: true, action: true, submit: ["/resume"] as string[], emptySubmit: false };
	const ctx = {
		mode: "tui", hasUI: true,
		ui: {
			theme: ansi,
			setWidget: () => {},
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value ?? null]),
		},
	};
	const editor = new QueueEditor({ terminal: { rows: 24 }, requestRender() {} } as never, editorTheme as never, keybindings(), ctx as never, {
		onEmptySubmit: () => (events.push(["emptySubmit"]), claims.emptySubmit),
	});
	editor.focused = true;
	editor.onEscape = () => events.push(["piEscape"]);
	editor.onSubmit = (text: string) => events.push(["piSubmit", text]);
	if (withIntercepts) {
		intercepts.setEditorIntercepts({
			escape: () => (events.push(["escape"]), claims.escape),
			submit: (text: string) => (events.push(["submit", text]), claims.submit.includes(text)),
			action: (action: string) => (events.push(["action", action]), claims.action),
		});
	} else intercepts.setEditorIntercepts(undefined);
	const records = steps.map((step) => {
		events = [];
		statuses = [];
		baseLog = [];
		if (step.claim) Object.assign(claims, step.claim);
		const before = editor.getText();
		if (step.setText !== undefined) editor.setText(step.setText);
		if (step.key) editor.handleInput(KEYS[step.key]);
		return { step, before, base: baseLog, events, statuses, text: editor.getText() };
	});
	intercepts.setEditorIntercepts(undefined);
	return { name, withIntercepts, records };
}
const typing = (text: string) => [...text].map((ch) => ({ key: Object.entries(KEYS).find(([, d]) => d === ch)![0] }));
const editors = [
	runEditor("intercepts", true, [
		{ key: "esc" },
		{ key: "esc", claim: { escape: false } },
		{ key: "x" },
		{ key: "esc", claim: { escape: true } },
		{ key: "bs" },
		{ key: "enter", claim: { emptySubmit: true } },
		{ key: "enter", claim: { emptySubmit: false } },
		{ setText: "/resume", key: "enter" },
		{ setText: "  /resume  ", key: "enter" },
		{ setText: "hello", key: "enter" },
		{ setText: "line\\", key: "enter" },
		{ key: "ctrlR" },
		{ key: "ctrlR", claim: { action: false } },
		{ setText: "" },
		...typing("!ls"),
		{ key: "space" },
		{ setText: "!!x" },
		{ key: "x" },
		{ key: "enter", claim: { submit: [] } },
		{ setText: "  " , key: "enter", claim: { emptySubmit: true } },
	]),
	runEditor("no intercepts", false, [
		{ key: "esc" },
		{ setText: "/resume", key: "enter" },
		{ key: "ctrlR" },
		{ key: "enter" },
		...typing("!x"),
	]),
];
CustomEditor.prototype.handleInput = originalHandle;

// BashHintEditor rendering under the queue editor: the base rows recorded,
// then the native shell chrome (or the frame's quiet rows).
const originalRender = CustomEditor.prototype.render;
let baseRows: string[] = [];
CustomEditor.prototype.render = function (this: unknown, width: number) {
	baseRows = originalRender.call(this, width);
	return baseRows;
};
const bashRenders: unknown[] = [];
for (const text of ["!ls -la", "!!secret", "  !x", "hello", ""]) {
	for (const frameChrome of [false, true]) {
		for (const width of [1, 2, 5, 10, 16, 30, 60]) {
			const ctx = { mode: "tui", hasUI: true, ui: { theme: ansi, setWidget: () => {}, setStatus: () => {} } };
			const editor = new QueueEditor({ terminal: { rows: 24 }, requestRender() {} } as never, editorTheme as never, keybindings(), ctx as never, { onEmptySubmit: () => false });
			editor.setText(text);
			if (frameChrome) editor.setFrameChrome(true);
			const out = editor.render(width);
			const base = baseRows;
			const unframed = editor.renderUnframed(width);
			bashRenders.push({ text, frameChrome, width, base, out, unframed });
		}
	}
}
CustomEditor.prototype.render = originalRender;

const output = `${JSON.stringify({
	roleCodes: ROLE_CODES, mirrorSteps, controllers, entrySets, widgetLines, previews, registrars, restores, keyTable, editors, bashRenders,
}, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
const summary = `${mirrorSteps.length} mirror steps, ${controllers.length} controller scenarios (${controllers.reduce((n, c) => n + c.steps.length, 0)} steps), ${widgetLines.length} widget renders, ${registrars.length} registrar runs, ${restores.length} restores, ${editors.length} editor scripts (${editors.reduce((n, e) => n + e.records.length, 0)} steps), ${bashRenders.length} shell editor renders`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("queue golden.json is stale: run npx tsx go/internal/queue/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`queue golden.json is current (${summary})`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`queue golden.json: ${summary}`);
}
