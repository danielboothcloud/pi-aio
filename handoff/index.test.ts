/**
 * handoff/index.ts — registrar wiring through a mocked Pi/ctx harness. No
 * network: `complete` is injected. RPC mode skips the TUI loader.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { HANDOFF_ENTRY_TYPE, type HandoffEntryData } from "./core.ts";
import { registerHandoff, renderHandoffRows, type HandoffCompleteFn, type HandoffResponse } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const MODEL = { provider: "anthropic", id: "claude-opus", contextWindow: 200_000 };
const OTHER = { provider: "openai", id: "gpt-x", contextWindow: 100_000 };

interface HarnessOptions {
	child?: boolean;
	response?: HandoffResponse | Error;
	editorResult?: string | undefined;
	inputResult?: string;
	idle?: boolean;
	sessionFile?: string;
	branch?: unknown[];
	cancelNew?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const previous = process.env.AIO_SUBAGENT_CHILD;
	if (options.child) process.env.AIO_SUBAGENT_CHILD = "1";
	else delete process.env.AIO_SUBAGENT_CHILD;

	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const renderers = new Map<string, unknown>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const calls: Array<{ systemPrompt: string; text: string }> = [];
	const editorCalls: Array<{ title: string; text: string }> = [];
	const newSessionCalls: Array<Record<string, unknown>> = [];
	const created: Array<{ customType: string; data: unknown }> = [];
	const replacement = { editorText: "", notes: [] as string[] };
	const setModels: unknown[] = [];
	const thinking: string[] = [];

	const complete: HandoffCompleteFn = async (_ctx, request) => {
		calls.push(request);
		if (options.response instanceof Error) throw options.response;
		return options.response ?? { content: [{ type: "text", text: "## Context\nWe built X.\n\n## Task\nDo Y." }], stopReason: "stop" };
	};

	const branch = options.branch ?? [
		{ type: "custom", customType: "recipe-state", data: { name: "work" } },
		{ type: "message", id: "1", message: { role: "user", content: "build X", timestamp: 1 } },
		{ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "built X" }], timestamp: 2 } },
		{ type: "custom", customType: "styles", data: { style: "concise" } },
	];

	const ctx = {
		cwd: "/repo",
		hasUI: true,
		mode: "rpc",
		model: MODEL,
		thinkingLevel: "high",
		scopedModels: [],
		isIdle: () => options.idle ?? true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			input: async () => options.inputResult,
			editor: async (title: string, text: string) => {
				editorCalls.push({ title, text });
				return "editorResult" in options ? options.editorResult : text;
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/sessions/old.jsonl"),
		},
		modelRegistry: {
			find: (provider: string, id: string) => [MODEL, OTHER].find((m) => m.provider === provider && m.id === id),
			getModelsOfType: () => [MODEL, OTHER],
		},
		newSession: async (opts: {
			setup?: (sm: unknown) => Promise<void>;
			withSession?: (next: unknown) => Promise<void>;
			parentSession?: string;
		}) => {
			newSessionCalls.push(opts);
			if (options.cancelNew) return { cancelled: true };
			await opts.setup?.({ appendCustomEntry: (customType: string, data: unknown) => created.push({ customType, data }) });
			await opts.withSession?.({
				ui: {
					setEditorText: (text: string) => {
						replacement.editorText = text;
					},
					notify: (message: string) => replacement.notes.push(message),
				},
			});
			return { cancelled: false };
		},
	};

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
		registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		setModel: async (model: unknown) => {
			setModels.push(model);
			return true;
		},
		setThinkingLevel: (level: string) => thinking.push(level),
	};

	try {
		// SAFETY: the harness implements the Pi surface the registrar touches.
		registerHandoff(pi as never, { complete });
	} finally {
		if (previous === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = previous;
	}

	const run = async (args: string) => {
		const def = commands.get("handoff");
		assert.ok(def, "handoff command registered");
		await def.handler(args, ctx);
	};
	const emit = async (event: string, payload: unknown, eventCtx: unknown = ctx) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, eventCtx);
	};
	return { ctx, run, emit, commands, renderers, notifications, calls, editorCalls, newSessionCalls, created, replacement, setModels, thinking };
}

test("happy path: generate, edit with transcript link, new session with carried state", async () => {
	const h = harness();
	await h.run("now do Y for teams");

	assert.equal(h.calls.length, 1);
	assert.match(h.calls[0]!.systemPrompt, /context transfer assistant/);
	assert.match(h.calls[0]!.text, /## Conversation History\n\n[\s\S]*build X[\s\S]*built X/);
	assert.match(h.calls[0]!.text, /## User's Goal for New Thread\n\nnow do Y for teams$/);

	assert.match(h.editorCalls[0]!.text, /^## Context\nWe built X\.[\s\S]*## Previous conversation\nFull pi transcript \(JSONL\): \[`\/sessions\/old\.jsonl`\]/);
	assert.equal(h.newSessionCalls[0]!.parentSession, "/sessions/old.jsonl");
	assert.deepEqual(h.created.map((e) => e.customType), ["recipe-state", "styles", HANDOFF_ENTRY_TYPE]);
	const data = h.created.at(-1)!.data as HandoffEntryData;
	assert.deepEqual(
		{ goal: data.goal, model: data.model, thinkingLevel: data.thinkingLevel, carried: data.carried, parent: data.parentSession },
		{ goal: "now do Y for teams", model: "anthropic/claude-opus", thinkingLevel: "high", carried: ["recipe-state", "styles"], parent: "/sessions/old.jsonl" },
	);
	assert.equal(h.replacement.editorText, h.editorCalls[0]!.text);
	assert.match(h.replacement.notes[0]!, /Handoff ready/);
});

test("guards: no UI, no model, busy agent, no goal, empty conversation", async () => {
	const busy = harness({ idle: false });
	await busy.run("x");
	assert.match(busy.notifications.at(-1)!.message, /wait for the agent to finish/);
	assert.equal(busy.calls.length, 0);

	const noGoal = harness({ inputResult: "  " });
	await noGoal.run("");
	assert.match(noGoal.notifications.at(-1)!.message, /Usage: \/handoff/);

	const asked = harness({ inputResult: "from the prompt" });
	await asked.run("");
	assert.match(asked.calls[0]!.text, /from the prompt$/);

	const empty = harness({ branch: [{ type: "custom", customType: "styles", data: {} }] });
	await empty.run("x");
	assert.match(empty.notifications.at(-1)!.message, /no conversation/);

	const noUi = harness();
	noUi.ctx.hasUI = false;
	await noUi.run("x");
	assert.match(noUi.notifications.at(-1)!.message, /interactive session/);

	const noModel = harness();
	(noModel.ctx as { model: unknown }).model = undefined;
	await noModel.run("x");
	assert.match(noModel.notifications.at(-1)!.message, /no model is active/);
});

test("failures and cancellations never open a new session", async () => {
	const error = harness({ response: { content: [], stopReason: "error", errorMessage: "overloaded" } });
	await error.run("x");
	assert.match(error.notifications.at(-1)!.message, /could not generate the prompt: overloaded/);

	const thrown = harness({ response: new Error("network down") });
	await thrown.run("x");
	assert.match(thrown.notifications.at(-1)!.message, /network down/);

	const blank = harness({ response: { content: [{ type: "text", text: "  " }], stopReason: "stop" } });
	await blank.run("x");
	assert.match(blank.notifications.at(-1)!.message, /empty prompt/);

	const editCancel = harness({ editorResult: undefined });
	await editCancel.run("x");
	assert.match(editCancel.notifications.at(-1)!.message, /Handoff cancelled/);

	for (const h of [error, thrown, blank, editCancel]) assert.equal(h.newSessionCalls.length, 0);

	const newCancel = harness({ cancelNew: true });
	await newCancel.run("x");
	assert.match(newCancel.notifications.at(-1)!.message, /new session was not created/);
});

test("ephemeral session: no transcript link and no parent", async () => {
	const h = harness({ sessionFile: undefined });
	await h.run("x");
	assert.doesNotMatch(h.editorCalls[0]!.text, /Previous conversation/);
	assert.equal((h.created.at(-1)!.data as HandoffEntryData).parentSession, undefined);
});

test("new handoff session restores the previous model and thinking level once", async () => {
	const h = harness();
	const entry = (data: Partial<HandoffEntryData>) => ({
		type: "custom",
		customType: HANDOFF_ENTRY_TYPE,
		data: { version: 1, goal: "g", carried: [], createdAt: "now", ...data },
	});
	const newCtx = (branch: unknown[], model = MODEL) => ({ ...h.ctx, model, sessionManager: { getBranch: () => branch } });

	await h.emit("session_start", { reason: "new" }, newCtx([entry({ model: "openai/gpt-x", thinkingLevel: "low" })]));
	assert.deepEqual(h.setModels, [OTHER]);
	assert.deepEqual(h.thinking, ["low"]);

	// Same model: no switch. Resume, or a branch that already has messages: nothing.
	await h.emit("session_start", { reason: "new" }, newCtx([entry({ model: "anthropic/claude-opus" })]));
	await h.emit("session_start", { reason: "resume" }, newCtx([entry({ model: "openai/gpt-x" })]));
	await h.emit(
		"session_start",
		{ reason: "new" },
		newCtx([entry({ model: "openai/gpt-x" }), { type: "message", message: { role: "user" } }]),
	);
	assert.equal(h.setModels.length, 1);
	assert.equal(h.thinking.length, 1);
});

test("subagent child: renderer only, no command or restore", () => {
	const h = harness({ child: true });
	assert.equal(h.commands.has("handoff"), false);
	assert.equal(h.renderers.has(HANDOFF_ENTRY_TYPE), true);
});

test("the HANDOFF note fits every width", () => {
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const data: HandoffEntryData = {
		version: 1,
		goal: "implement this for teams as well ".repeat(5),
		parentSession: "/very/long/path/to/sessions/2026-08-07/session.jsonl",
		model: "anthropic/claude-opus",
		carried: ["recipe-state", "styles"],
		createdAt: "now",
	};
	for (const width of [0, 1, 10, 40, 120]) {
		const rows = renderHandoffRows(data, theme, width);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
	}
	assert.match(renderHandoffRows(data, theme, 200).at(-1)!, /from \/very\/long.*anthropic\/claude-opus · kept recipe-state, styles/);
});
