import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { GOAL_ACTIVITY_EVENT, NOTIFICATION_EVENT } from "../notifications/protocol.ts";
import { GOAL_MESSAGE_TYPE, GOAL_STATE_ENTRY, GOAL_STATUS_KEY, type Goal, MAX_CONTINUATIONS, MAX_REJECTIONS, newGoal } from "./core.ts";
import { GOAL_TOOL_NAMES, registerGoals } from "./index.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;

function harness(options: { review?: string | Error; confirm?: boolean; idle?: boolean; entries?: unknown[] } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "aio-goals-"));
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const renderers = new Map<string, any>();
	const events = new EventEmitter();
	const entries: any[] = [...(options.entries ?? [])];
	const sent: Array<{ message: any; options: any }> = [];
	const notices: Array<{ text: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const signals: any[] = [];
	const activity: any[] = [];
	let aborted = 0;
	let reviewPrompt = "";
	const state = { review: options.review ?? "APPROVED\nAll done.", confirm: options.confirm ?? true, idle: options.idle ?? true };
	events.on(NOTIFICATION_EVENT, (data) => signals.push(data));
	events.on(GOAL_ACTIVITY_EVENT, (data) => activity.push(data));
	const pi = {
		events,
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any, sendOptions: any) => sent.push({ message, options: sendOptions }),
		exec: async (_command: string, args: string[]) => ({ stdout: args[0] === "status" ? " M goals/index.ts\n" : " 1 file changed\n", stderr: "", code: 0 }),
	} as unknown as ExtensionAPI;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => "goal-session", getEntries: () => entries, getBranch: () => entries },
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		abort: () => { aborted++; },
		modelRegistry: {
			complete: async (_model: unknown, context: any) => {
				reviewPrompt = context.messages[0].content;
				if (state.review instanceof Error) throw state.review;
				return { stopReason: "stop", content: [{ type: "text", text: state.review }] };
			},
		},
		ui: {
			theme,
			notify: (text: string, level: string) => notices.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			confirm: async () => state.confirm,
		},
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = (await handler({ type: name, ...event }, ctx)) ?? result;
		return result;
	};
	const goalState = (): Goal | null => {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].customType === GOAL_STATE_ENTRY) return entries[i].data.goal;
		}
		return null;
	};
	const tool = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
		tools.get(name).execute("call", params, signal, undefined, ctx);
	const goal = (args: string) => commands.get("goal").handler(args, ctx);
	const settle = (outcome = "completed") => fire("agent_before_settle", { outcome, entries: [], continue: false });
	return {
		pi, ctx, cwd, handlers, commands, tools, renderers, entries, sent, notices, statuses, signals, activity, state,
		fire, goalState, tool, goal, settle,
		aborted: () => aborted,
		reviewPrompt: () => reviewPrompt,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

async function startGoal(h: ReturnType<typeof harness>) {
	registerGoals(h.pi);
	await h.fire("session_start", { reason: "startup" });
	await h.goal("add a dark mode toggle");
	return h.tool("goal_propose", { objective: "Add a dark mode toggle", doneWhen: "Toggle switches theme; npm test passes" });
}

test("subagent children register no goal surface", () => {
	const previous = process.env.AIO_SUBAGENT_CHILD;
	process.env.AIO_SUBAGENT_CHILD = "1";
	const h = harness();
	try {
		registerGoals(h.pi);
		assert.equal(h.tools.size, 0);
		assert.equal(h.commands.size, 0);
		assert.equal(h.handlers.size, 0);
	} finally {
		if (previous === undefined) delete process.env.AIO_SUBAGENT_CHILD;
		else process.env.AIO_SUBAGENT_CHILD = previous;
		h.cleanup();
	}
});

test("/goal sends a visible draft, and a confirmed goal_propose activates the goal", async () => {
	const h = harness();
	try {
		registerGoals(h.pi);
		assert.deepEqual([...h.tools.keys()].sort(), [...GOAL_TOOL_NAMES].sort());
		await h.fire("session_start", { reason: "startup" });
		await assert.rejects(h.tool("goal_propose", { objective: "x", doneWhen: "y" }), /No goal draft/);
		await h.goal("add a dark mode toggle");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].message.customType, GOAL_MESSAGE_TYPE);
		assert.equal(h.sent[0].message.display, true);
		assert.match(h.sent[0].message.content, /add a dark mode toggle/);
		assert.match(h.sent[0].message.content, /ask_user_question/);
		assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
		assert.equal(h.statuses.get(GOAL_STATUS_KEY), "◎ goal · draft");

		const result = await h.tool("goal_propose", { objective: "Add a dark mode toggle", doneWhen: "npm test passes" });
		assert.match(result.content[0].text, /Start the work now/);
		assert.equal(h.goalState()?.status, "active");
		assert.equal(h.goalState()?.objective, "Add a dark mode toggle");
		assert.equal(h.statuses.get(GOAL_STATUS_KEY), `◎ goal · 0/${MAX_CONTINUATIONS}`);
		assert.equal(h.activity.at(-1).active, true);
	} finally {
		h.cleanup();
	}
});

test("a declined goal_propose keeps the draft open and starts nothing", async () => {
	const h = harness({ confirm: false });
	try {
		const result = await startGoal(h);
		assert.match(result.content[0].text, /did not start/);
		assert.equal(h.goalState(), null);
		h.state.confirm = true;
		await h.tool("goal_propose", { objective: "Add a dark mode toggle", doneWhen: "tests pass" });
		assert.equal(h.goalState()?.status, "active");
	} finally {
		h.cleanup();
	}
});

test("agent_before_settle continues an active goal until the continuation cap", async () => {
	const h = harness();
	try {
		await startGoal(h);
		const result = await h.settle();
		assert.equal(result.continue, true);
		const [stateDraft, message] = result.entries;
		assert.equal(stateDraft.customType, GOAL_STATE_ENTRY);
		assert.equal(stateDraft.data.goal.continuations, 1);
		assert.equal(message.type, "custom_message");
		assert.equal(message.display, false);
		assert.match(message.content, /Continue working on the active goal/);

		for (let i = 1; i < MAX_CONTINUATIONS; i++) assert.equal((await h.settle()).continue, true);
		const capped = await h.settle();
		assert.equal(capped.continue, undefined);
		assert.equal(capped.entries.at(-1).data.goal.status, "paused");
		assert.match(capped.entries.at(-1).data.goal.pauseReason, /automatic continuations/);
		assert.equal(h.signals.at(-1).title, "Goal needs attention");
		assert.equal(await h.settle(), undefined);
	} finally {
		h.cleanup();
	}
});

test("model errors and Esc pause the loop; idle goals are left alone", async () => {
	const h = harness();
	try {
		registerGoals(h.pi);
		await h.fire("session_start", { reason: "startup" });
		assert.equal(await h.settle(), undefined);

		await h.goal("first");
		await h.tool("goal_propose", { objective: "First", doneWhen: "done" });
		const errored = await h.settle("error");
		assert.equal(errored.continue, undefined);
		assert.equal(errored.entries[0].data.goal.status, "paused");

		await h.goal("resume");
		await h.fire("agent_settled", { aborted: true });
		assert.equal(h.goalState()?.status, "paused");
		assert.equal(h.goalState()?.pauseReason, "stopped with Esc");
		assert.equal(await h.settle(), undefined);
	} finally {
		h.cleanup();
	}
});

test("goal_done finishes the goal only when the review approves", async () => {
	const h = harness({ review: "REJECTED\nThe tests were not run." });
	try {
		await startGoal(h);
		let result = await h.tool("goal_done", { summary: "Added the toggle." });
		assert.match(result.content[0].text, /Review rejected: The tests were not run/);
		assert.equal(h.goalState()?.status, "active");
		assert.equal(h.goalState()?.rejections, 1);
		assert.match(h.reviewPrompt(), /Add a dark mode toggle/);
		assert.match(h.reviewPrompt(), /Added the toggle/);
		assert.match(h.reviewPrompt(), /M goals\/index\.ts/);
		assert.match((await h.settle()).entries[1].content, /tests were not run/);

		h.state.review = "APPROVED\nToggle and tests verified.";
		result = await h.tool("goal_done", { summary: "Added the toggle and ran npm test." });
		assert.match(result.content[0].text, /goal is complete/);
		assert.equal(h.goalState()?.status, "done");
		assert.equal(h.goalState()?.summary, "Added the toggle and ran npm test.");
		assert.equal(h.signals.at(-1).title, "Goal complete");
		assert.equal(await h.settle(), undefined);
		assert.equal(h.statuses.get(GOAL_STATUS_KEY), undefined);
		await assert.rejects(h.tool("goal_done", { summary: "again" }), /No active goal/);
	} finally {
		h.cleanup();
	}
});

test("repeated review rejections and review failures pause the goal", async () => {
	const h = harness({ review: "REJECTED\nMissing work." });
	try {
		await startGoal(h);
		for (let i = 1; i < MAX_REJECTIONS; i++) await h.tool("goal_done", { summary: "done" });
		const result = await h.tool("goal_done", { summary: "done" });
		assert.match(result.content[0].text, /paused after/);
		assert.equal(h.goalState()?.status, "paused");

		await h.goal("resume");
		assert.equal(h.goalState()?.rejections, 0);
		h.state.review = new Error("provider offline");
		const failed = await h.tool("goal_done", { summary: "done" });
		assert.match(failed.content[0].text, /could not run: provider offline/);
		assert.match(h.goalState()?.pauseReason ?? "", /review failed/);
	} finally {
		h.cleanup();
	}
});

test("goal_blocked pauses and asks for attention", async () => {
	const h = harness();
	try {
		await startGoal(h);
		const result = await h.tool("goal_blocked", { reason: "Need the API key" });
		assert.match(result.content[0].text, /paused/);
		assert.equal(h.goalState()?.status, "paused");
		assert.equal(h.goalState()?.pauseReason, "Need the API key");
		assert.equal(h.signals.at(-1).title, "Goal needs attention");
		assert.equal(h.activity.at(-1).quietSettle, true);
		await assert.rejects(h.tool("goal_blocked", { reason: "again" }), /No active goal/);
	} finally {
		h.cleanup();
	}
});

test("/goal pause, resume, status, and cancel", async () => {
	const h = harness({ idle: false });
	try {
		await startGoal(h);
		await h.goal("pause");
		assert.equal(h.goalState()?.status, "paused");
		assert.equal(h.aborted(), 1);
		assert.equal(h.signals.length, 0);

		h.state.idle = true;
		const sentBefore = h.sent.length;
		await h.goal("resume");
		assert.equal(h.goalState()?.status, "active");
		assert.equal(h.sent.length, sentBefore + 1);
		assert.equal(h.sent.at(-1)?.message.display, false);
		assert.match(h.sent.at(-1)?.message.content, /continuation 1\//);

		await h.goal("");
		assert.match(h.notices.at(-1)?.text ?? "", /Goal: Add a dark mode toggle/);
		await h.goal("clear");
		assert.equal(h.goalState(), null);
		assert.equal(h.notices.at(-1)?.text, "Goal cleared.");
	} finally {
		h.cleanup();
	}
});

test("starting a new goal asks before it replaces an unfinished one", async () => {
	const h = harness();
	try {
		await startGoal(h);
		h.state.confirm = false;
		await h.goal("something else");
		assert.equal(h.goalState()?.status, "active");
		h.state.confirm = true;
		await h.goal("something else");
		assert.equal(h.goalState(), null);
		assert.match(h.sent.at(-1)?.message.content, /something else/);
	} finally {
		h.cleanup();
	}
});

test("goals are session bound: reopen holds an active goal and project files are ignored", async () => {
	const active = newGoal("Saved goal", "done");
	const h = harness({ entries: [{ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: active } }] });
	try {
		mkdirSync(join(h.cwd, ".pi-glla"));
		writeFileSync(
			join(h.cwd, ".pi-glla", "active.jsonl"),
			`${JSON.stringify({ type: "state", value: { goal: { ...active, objective: "Directory goal" } } })}\n`,
		);
		registerGoals(h.pi);
		await h.fire("session_start", { reason: "resume" });
		assert.equal(h.goalState()?.objective, "Saved goal");
		assert.equal(h.goalState()?.status, "paused");
		assert.equal(h.goalState()?.pauseReason, "session reopened");
		assert.equal(h.sent.length, 0);
		assert.equal(await h.settle(), undefined);

		const fresh = harness();
		try {
			registerGoals(fresh.pi);
			await fresh.fire("session_start", { reason: "startup" });
			await fresh.goal("status");
			assert.match(fresh.notices.at(-1)?.text ?? "", /No goal/);
		} finally {
			fresh.cleanup();
		}
	} finally {
		h.cleanup();
	}
});

test("the draft card fits narrow widths", async () => {
	const h = harness();
	try {
		registerGoals(h.pi);
		const renderer = h.renderers.get(GOAL_MESSAGE_TYPE);
		const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
		const component = renderer({ details: { kind: "draft", text: "a long goal description ".repeat(8) } }, {}, theme);
		for (const width of [8, 20, 60]) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
		assert.equal(renderer({ details: { kind: "continue", text: "" } }, {}, theme), undefined);
	} finally {
		h.cleanup();
	}
});
