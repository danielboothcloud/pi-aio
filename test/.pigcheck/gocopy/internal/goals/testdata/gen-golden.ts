// Regenerate golden.json from the TypeScript goals feature (the reference):
//   npx tsx go/internal/goals/testdata/gen-golden.ts [--check]
// It runs the pure core and review functions on fixed inputs, and drives the
// real registerGoals through a scripted harness: each scenario is a list of
// steps (commands, tool calls, settle boundaries, session events) and records
// every host effect in order. Goal ids and timestamps are written as
// placeholders; the Go test normalizes its own output the same way.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
delete process.env.AIO_SUBAGENT_CHILD;

const core = await import(join(repo, "goals", "core.ts"));
const review = await import(join(repo, "goals", "review.ts"));
const { registerGoals } = await import(join(repo, "goals", "index.ts"));

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Replace goal ids and ISO timestamps in every string, as JSON (undefined drops). */
function normalize(value: unknown): Json {
	if (typeof value === "string") {
		return value.replace(/\bg-[0-9a-z]{6,}\b/g, "g-@@ID@@").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "@@TIME@@");
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		const out: { [key: string]: Json } = {};
		for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = normalize(item);
		return out;
	}
	return null;
}

// ---- fixtures ----
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message",
	message: { role, content, ...extra },
});
const BRANCH = [
	{ type: "model_change", provider: "x", modelId: "y" },
	msg("user", "Add a dark mode toggle"),
	msg("assistant", [
		{ type: "thinking", thinking: "hidden" },
		{ type: "text", text: "I will add it." },
		{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/theme.ts", oldText: "a", newText: "b" } },
	]),
	msg("toolResult", [{ type: "text", text: "Edited src/theme.ts" }], { toolName: "edit", isError: false }),
	msg("assistant", [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "npm test" } }]),
	msg("toolResult", [{ type: "text", text: "1 failing" }], { toolName: "bash", isError: true }),
	{ type: "custom", customType: "aio-goal", data: { goal: null } },
	msg("assistant", [{ type: "text", text: "Tests pass now — ünïcödé ✓ 🎉" }]),
];

type Reply = string | { throw: string } | { stopReason: string; errorMessage?: string; text?: string };
type ExecReply = { stdout: string; code: number } | { throw: string };

const GIT_OK: ExecReply[] = [
	{ stdout: " M src/theme.ts\n?? src/new.ts\n", code: 0 },
	{ stdout: " src/theme.ts | 4 ++--\n 1 file changed\n", code: 0 },
];

interface Options {
	hasUI?: boolean;
	idle?: boolean;
	model?: boolean;
	confirms?: boolean[];
	replies?: Reply[];
	exec?: ExecReply[];
	sendThrows?: string;
	entries?: unknown[];
	branch?: unknown[];
}

type Step =
	| { op: "start"; entries?: unknown[] }
	| { op: "goal"; args: string }
	| { op: "tool"; name: string; params: Record<string, unknown>; abortDuringReview?: boolean; duringReview?: Step }
	| { op: "settle"; outcome: string; entries?: unknown[] }
	| { op: "settled"; aborted: boolean }
	| { op: "idle"; value: boolean }
	| { op: "sendThrows"; value?: string }
	| { op: "shutdown" };

interface ScenarioRecord {
	name: string;
	options: Json;
	records: Json[];
}

async function runScenario(name: string, options: Options, steps: Step[]): Promise<ScenarioRecord> {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: unknown[] = [...(options.entries ?? [])];
	const state = {
		idle: options.idle ?? true,
		sendThrows: options.sendThrows,
		confirms: [...(options.confirms ?? [])],
		replies: [...(options.replies ?? [])],
		exec: [...(options.exec ?? [])],
	};
	let log: unknown[] = [];
	let during: (() => Promise<void>) | undefined;
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
			log.push({ op: "append", customType, data });
		},
		sendMessage: (message: any, sendOptions: any) => {
			log.push({ op: "send", message, options: sendOptions });
			if (state.sendThrows) throw new Error(state.sendThrows);
		},
		exec: async (command: string, args: string[], execOptions: { cwd: string; timeout: number }) => {
			log.push({ op: "exec", command, args, timeout: execOptions.timeout });
			const reply = state.exec.shift() ?? { stdout: "", code: 0 };
			if ("throw" in reply) throw new Error(reply.throw);
			return { ...reply, stderr: "" };
		},
	};
	const ctx = {
		cwd: "/work",
		mode: "tui",
		hasUI: options.hasUI ?? true,
		model: options.model === false ? undefined : { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => "s", getEntries: () => entries, getBranch: () => options.branch ?? BRANCH },
		isIdle: () => state.idle,
		abort: () => log.push({ op: "abort" }),
		modelRegistry: {
			complete: async (_model: unknown, context: any, _options: unknown) => {
				log.push({ op: "complete", systemPrompt: context.systemPrompt, prompt: context.messages[0].content });
				if (during) {
					const action = during;
					during = undefined;
					await action();
				}
				const reply = state.replies.shift() ?? "APPROVED";
				if (typeof reply === "string") return { stopReason: "stop", content: [{ type: "text", text: reply }] };
				if ("throw" in reply) throw new Error(reply.throw);
				return { stopReason: reply.stopReason, errorMessage: reply.errorMessage, content: reply.text ? [{ type: "text", text: reply.text }] : [] };
			},
		},
		ui: {
			theme: { fg: (tone: string, text: string) => `[${tone}]${text}`, bold: (text: string) => text },
			notify: (text: string, level: string) => log.push({ op: "notify", text, level }),
			setStatus: (key: string, text: string | undefined) => log.push({ op: "status", key, text: text ?? null }),
			confirm: async (title: string, body: string) => {
				log.push({ op: "confirm", title, body });
				return state.confirms.shift() ?? true;
			},
		},
	};
	registerGoals(pi as never);
	const fire = async (event: string, payload: Record<string, unknown>) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result;
		return result;
	};
	async function exec(step: Step): Promise<unknown> {
		switch (step.op) {
			case "start":
				if (step.entries) entries.splice(0, entries.length, ...step.entries);
				return fire("session_start", { reason: "startup" });
			case "goal":
				await commands.get("goal").handler(step.args, ctx);
				return null;
			case "tool": {
				const controller = new AbortController();
				if (step.abortDuringReview) during = async () => controller.abort();
				if (step.duringReview) {
					const inner = step.duringReview;
					during = async () => {
						const saved = log;
						log = [];
						const result = await exec(inner);
						const innerLog = log;
						log = saved;
						log.push({ op: "during", step: inner, result: result ?? null, log: innerLog });
					};
				}
				try {
					const out = await tools.get(step.name).execute(
						"call",
						step.params,
						controller.signal,
						(update: { content: Array<{ text: string }> }) => log.push({ op: "update", text: update.content[0].text }),
						ctx,
					);
					return { text: out.content[0].text };
				} catch (error) {
					return { error: (error as Error).message };
				} finally {
					during = undefined;
				}
			}
			case "settle":
				return fire("agent_before_settle", { outcome: step.outcome, entries: step.entries ?? [], continue: false });
			case "settled":
				return fire("agent_settled", { aborted: step.aborted });
			case "idle":
				state.idle = step.value;
				return null;
			case "sendThrows":
				state.sendThrows = step.value;
				return null;
			case "shutdown":
				return fire("session_shutdown", {});
		}
	}
	const records: unknown[] = [];
	for (const step of steps) {
		log = [];
		const result = await exec(step);
		records.push({ step, result: result ?? null, log });
	}
	const scenario: ScenarioRecord = { name, options: normalize({ ...options, branch: options.branch ?? null }), records: records.map(normalize) };
	return scenario;
}

const active = (overrides: Record<string, unknown> = {}) => ({
	id: "g-abc123",
	objective: "Ship the parser",
	doneWhen: "npm test passes",
	status: "active",
	continuations: 3,
	rejections: 1,
	lastReview: "missing tests",
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-01T00:00:00.000Z",
	...overrides,
});
const goalEntry = (goal: unknown) => ({ type: "custom", customType: "aio-goal", data: { goal } });
const propose = { op: "tool", name: "goal_propose", params: { objective: "  Add a dark mode toggle ", doneWhen: " Toggle works; npm test passes " } } as const;
const done = (summary = "Added the toggle; npm test passes.") => ({ op: "tool", name: "goal_done", params: { summary } }) as const;
const settles = (count: number, outcome = "completed"): Step[] => Array.from({ length: count }, () => ({ op: "settle", outcome }));

const scenarios = [
	await runScenario("happy path with UI", { exec: [...GIT_OK] }, [
		{ op: "start" },
		{ op: "goal", args: "" },
		{ op: "goal", args: "add a dark mode toggle" },
		{ op: "goal", args: "status" },
		propose,
		{ op: "settle", outcome: "completed", entries: [{ type: "custom", customType: "other", data: {} }] },
		{ op: "settle", outcome: "completed" },
		{ op: "goal", args: "STATUS" },
		done(),
		{ op: "settle", outcome: "completed" },
		{ op: "goal", args: "status" },
		{ op: "shutdown" },
	]),
	await runScenario("headless: auto-confirm, three rejections, resume", { hasUI: false, replies: ["REJECTED: tests fail", "**Rejected** — still failing\nmore detail", "rejected"] }, [
		{ op: "start" },
		{ op: "goal", args: "fix the build" },
		{ op: "tool", name: "goal_propose", params: { objective: "Fix the build", doneWhen: "" } },
		{ op: "settle", outcome: "completed" },
		done("first try"),
		{ op: "settle", outcome: "completed" },
		done("second try"),
		done("third try"),
		{ op: "settle", outcome: "completed" },
		{ op: "goal", args: "status" },
		{ op: "goal", args: "resume" },
		{ op: "settle", outcome: "completed" },
	]),
	await runScenario("tool guards", {}, [
		{ op: "start" },
		propose,
		done(),
		{ op: "tool", name: "goal_blocked", params: { reason: "x" } },
		{ op: "goal", args: "x" },
		{ op: "tool", name: "goal_propose", params: { objective: "   ", doneWhen: "y" } },
	]),
	await runScenario("declined proposal, then accepted", { confirms: [false, true] }, [
		{ op: "start" },
		{ op: "goal", args: "refactor auth" },
		{ op: "tool", name: "goal_propose", params: { objective: "Refactor auth", doneWhen: "tests" } },
		{ op: "goal", args: "status" },
		{ op: "tool", name: "goal_propose", params: { objective: "Refactor auth into a module", doneWhen: "tests" } },
	]),
	await runScenario("continuation cap", {}, [
		{ op: "start" },
		{ op: "goal", args: "long task" },
		propose,
		...settles(MAX()),
		{ op: "settle", outcome: "completed" },
		{ op: "settle", outcome: "completed" },
		{ op: "goal", args: "resume" },
	]),
	await runScenario("error and abort outcomes", {}, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		{ op: "settle", outcome: "error" },
		{ op: "goal", args: "resume" },
		{ op: "settle", outcome: "aborted" },
		{ op: "settled", aborted: true },
		{ op: "settled", aborted: true },
		{ op: "idle", value: false },
		{ op: "goal", args: "resume" },
		{ op: "settled", aborted: false },
		{ op: "goal", args: "resume" },
	]),
	await runScenario("blocked, pause, cancel", { idle: false }, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		{ op: "goal", args: "cancel" },
		{ op: "goal", args: "clear" },
		{ op: "goal", args: "task again" },
		propose,
		{ op: "tool", name: "goal_blocked", params: { reason: "  need\n the   API key  " } },
		{ op: "goal", args: "status" },
		{ op: "goal", args: "resume" },
		{ op: "goal", args: "pause" },
		{ op: "goal", args: "pause" },
		{ op: "goal", args: "resume" },
		{ op: "tool", name: "goal_blocked", params: { reason: "   " } },
		{ op: "goal", args: "resume" },
		{ op: "goal", args: "Cancel" },
		{ op: "goal", args: "cancel" },
	]),
	await runScenario("replace a goal with UI", { confirms: [false, true] }, [
		{ op: "start" },
		{ op: "goal", args: "first" },
		propose,
		{ op: "goal", args: "second goal please" },
		{ op: "goal", args: "second goal please" },
		{ op: "goal", args: "status" },
	]),
	await runScenario("replace a goal without UI", { hasUI: false }, [
		{ op: "start" },
		{ op: "goal", args: "first" },
		propose,
		{ op: "goal", args: "second" },
		{ op: "tool", name: "goal_propose", params: { objective: "Second", doneWhen: "done" } },
		done(""),
		{ op: "goal", args: "third" },
	]),
	await runScenario("review failures", {
		model: true,
		replies: [{ throw: "network down" }, "APPROVED"],
		exec: [{ stdout: "", code: 128 }],
	}, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		done(),
		{ op: "goal", args: "resume" },
		done(),
	]),
	await runScenario("review error stop reasons", {
		replies: [{ stopReason: "error", errorMessage: "rate limited" }, { stopReason: "error" }, "Looks fine to me", { stopReason: "aborted" }, "   \n\n"],
		exec: [{ throw: "spawn git ENOENT" }, ...GIT_OK, { stdout: "", code: 0 }, { stdout: "", code: 0 }],
	}, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		done(),
		{ op: "goal", args: "resume" },
		done(),
		{ op: "goal", args: "resume" },
		done(),
		{ op: "goal", args: "resume" },
		done(),
		{ op: "goal", args: "resume" },
		done(),
	]),
	await runScenario("no model", { model: false }, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		done(),
	]),
	await runScenario("abort during review", { replies: ["APPROVED"] }, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		{ ...done(), abortDuringReview: true },
		{ op: "goal", args: "status" },
	]),
	await runScenario("goal changed during review", { replies: ["APPROVED", "REJECTED: x"] }, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		{ ...done(), duringReview: { op: "goal", args: "cancel" } },
		{ op: "goal", args: "status" },
	]),
	await runScenario("rejection reason reaches the continuation", { replies: ["REJECTED\nThe README is not updated."], exec: [...GIT_OK] }, [
		{ op: "start" },
		{ op: "goal", args: "task" },
		propose,
		done(),
		{ op: "settle", outcome: "completed" },
	]),
	await runScenario("send failure on resume", { sendThrows: undefined }, [
		{ op: "start", entries: [goalEntry(active({ status: "paused", pauseReason: "x" }))] },
		{ op: "sendThrows", value: "session is closing" },
		{ op: "goal", args: "resume" },
		{ op: "goal", args: "status" },
	]),
	await runScenario("session start restores", {}, [
		{ op: "start", entries: [goalEntry(active())] },
		{ op: "goal", args: "status" },
		{ op: "start", entries: [goalEntry(active()), goalEntry(active({ status: "done", summary: "", lastReview: "ok" }))] },
		{ op: "goal", args: "status" },
		{ op: "start", entries: [goalEntry(active()), goalEntry(null)] },
		{ op: "goal", args: "status" },
		{ op: "start", entries: [goalEntry(active()), goalEntry({ id: "g-x", objective: "o" })] },
		{ op: "goal", args: "status" },
		{ op: "start", entries: [goalEntry(active({ status: "paused", pauseReason: "session reopened", summary: "s ".repeat(200) })), { type: "message", message: { role: "user", content: "hi" } }] },
		{ op: "goal", args: "status" },
		{ op: "goal", args: "resume" },
		{ op: "shutdown" },
	]),
	await runScenario("headless session start", { hasUI: false }, [
		{ op: "start", entries: [goalEntry(active())] },
		{ op: "goal", args: "resume" },
		{ op: "settle", outcome: "error" },
		{ op: "goal", args: "resume" },
		{ op: "settled", aborted: true },
		{ op: "shutdown" },
	]),
];
function MAX() {
	return core.MAX_CONTINUATIONS;
}

// ---- pure functions ----
const argsCases = ["", "  ", "status", " STATUS ", "pause", "resume", "cancel", "clear", "Clear", "status now", "build x", "\u00a0resume\u2028"].map(
	(args) => ({ args, command: core.parseGoalArgs(args) }),
);
const completions = ["", "s", "C", " re", "x", "clear"].map((prefix) => ({
	prefix,
	items: core.GOAL_SUBCOMMANDS.filter((sub: { name: string }) => sub.name.startsWith(prefix.trim().toLowerCase())).map((sub: { name: string }) => sub.name),
}));
const reviewTexts = [
	"APPROVED\nAll criteria met.",
	"approved: tests pass",
	"**APPROVED** — every check ran",
	"## Approved.",
	"> REJECTED: missing docs\n\nAlso lint fails.",
	"`REJECTED`",
	"\n\n  rejected - no tests  \n",
	"Rejected without detail",
	"I think this is APPROVED",
	"",
	"   \n  ",
	"APPROVEDX more",
	"REJECTED.",
	"*_APPROVED_*: yes",
	"\u00a0APPROVED\u00a0reason",
	"APPROVED\r\nwindows line",
];
const reviews = reviewTexts.map((text) => ({ text, verdict: core.parseReview(text) }));
const oneLines = [
	["  a\n\tb   c  ", 80],
	["x".repeat(100), 80],
	["x".repeat(80), 80],
	["é".repeat(90), 70],
	["🎉".repeat(10), 9],
	["a\u00a0b\u2028c", 10],
	["", 5],
].map(([text, max]) => ({ text, max, out: core.oneLine(text as string, max as number) }));
const statusCases: unknown[] = [];
for (const goal of [null, active(), active({ status: "paused" }), active({ status: "done" })]) {
	for (const drafting of [false, true]) {
		for (const reviewing of [false, true]) {
			statusCases.push({ goal, drafting, reviewing, text: core.statusText(goal, { drafting, reviewing }) ?? null });
		}
	}
}
const describes = [
	active(),
	active({ status: "paused", pauseReason: "blocked" }),
	active({ status: "paused" }),
	active({ status: "done", summary: "did it\nall", lastReview: "fine ".repeat(60), doneWhen: "" }),
	active({ lastReview: undefined, rejections: 0 }),
].map((goal) => ({ goal, text: core.describeGoal(goal) }));
const prompts = {
	draft: core.draftPrompt("make it faster"),
	started: core.startedText(active()),
	continuation: [active(), active({ rejections: 0 }), active({ lastReview: undefined }), active({ doneWhen: "" })].map((goal) => ({ goal, text: core.continuationPrompt(goal) })),
	reviewSystem: core.REVIEW_SYSTEM_PROMPT,
	review: [
		{ goal: active(), summary: "s", transcript: "t", workspace: "w" },
		{ goal: active({ doneWhen: "" }), summary: "", transcript: "", workspace: "" },
	].map((input) => ({ input, text: core.reviewPrompt(input) })),
};
const latest = [
	[],
	[goalEntry(active())],
	[goalEntry(active()), { type: "message" }],
	[goalEntry(active()), goalEntry(null)],
	[goalEntry(active()), goalEntry({ ...active(), status: "weird" })],
	[goalEntry(active()), goalEntry({ ...active(), continuations: "3" })],
	[goalEntry(active()), { type: "custom", customType: "aio-goal" }],
	[{ type: "custom", customType: "other", data: { goal: active() } }],
	[goalEntry(active({ status: "done", summary: "" }))],
].map((entries) => ({ entries, goal: core.latestGoal(entries) }));

const workspaceCases: unknown[] = [];
for (const replies of [
	GIT_OK,
	[{ stdout: "", code: 0 }, { stdout: "", code: 0 }],
	[{ stdout: "fatal: not a git repository", code: 128 }],
	[{ stdout: " M a\n", code: 0 }, { stdout: "x\n", code: 1 }],
	[{ throw: "spawn git ENOENT" }],
	[{ stdout: " M a\n", code: 0 }, { throw: "boom" }],
	[{ stdout: Array.from({ length: 75 }, (_, i) => ` M f${i}`).join("\n") + "\n", code: 0 }, { stdout: Array.from({ length: 61 }, (_, i) => `l${i}`).join("\n"), code: 0 }],
] as ExecReply[][]) {
	const queue = [...replies];
	const calls: unknown[] = [];
	const text = await review.workspaceSummary(async (command: string, args: string[], options: { timeout: number }) => {
		calls.push({ command, args, timeout: options.timeout });
		const reply = queue.shift() ?? { stdout: "", code: 0 };
		if ("throw" in reply) throw new Error(reply.throw);
		return reply;
	}, "/work");
	workspaceCases.push({ replies, calls, text });
}

const output = `${JSON.stringify(
	{
		constants: { maxContinuations: core.MAX_CONTINUATIONS, maxRejections: core.MAX_REJECTIONS, transcriptChars: review.REVIEW_TRANSCRIPT_CHARS, transcriptMessages: review.REVIEW_TRANSCRIPT_MESSAGES },
		branch: BRANCH,
		args: argsCases,
		completions,
		reviews,
		oneLines,
		statusCases,
		describes,
		prompts,
		latest,
		workspace: workspaceCases,
		scenarios,
	},
	null,
	1,
)}\n`;
const goldenPath = join(here, "golden.json");
const steps = scenarios.reduce((sum, scenario) => sum + scenario.records.length, 0);
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("goals golden.json is stale: run npx tsx go/internal/goals/testdata/gen-golden.ts");
		process.exit(1);
	}
	console.log(`goals golden.json is current (${scenarios.length} scenarios, ${steps} steps)`);
} else {
	writeFileSync(goldenPath, output);
	console.log(`goals golden.json: ${scenarios.length} scenarios, ${steps} steps, ${reviews.length} reviews`);
}
