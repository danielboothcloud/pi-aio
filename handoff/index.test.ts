/**
 * handoff/index.ts — registrar wiring through a mocked Pi/ctx harness. No
 * network: `complete` is injected. RPC mode skips the TUI loader.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	HANDOFF_ENTRY_TYPE,
	HANDOFF_PROPOSAL_ENTRY_TYPE,
	PROPOSAL_ACTIONS,
	type HandoffEntryData,
	type HandoffProposalData,
} from "./core.ts";
import {
	registerHandoff,
	renderHandoffRows,
	renderProposalRows,
	type HandoffCompleteFn,
	type HandoffResponse,
} from "./index.ts";
import type { HandoffRecipeResolution } from "./recipe.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const MODEL = { provider: "anthropic", id: "claude-opus", contextWindow: 200_000 };
const OTHER = { provider: "openai", id: "gpt-x", contextWindow: 100_000 };

interface HarnessOptions {
	child?: boolean;
	/** One response per model call, in order; the last one repeats. */
	responses?: Array<HandoffResponse | Error>;
	/** Editor answers in order; when exhausted the editor returns its text. */
	editorResults?: Array<string | undefined>;
	/** Proposal menu answers in order; when exhausted it picks "start". */
	selects?: Array<string | undefined>;
	inputResult?: string;
	idle?: boolean;
	sessionFile?: string;
	branch?: unknown[];
	cancelNew?: boolean;
	recipe?: HandoffRecipeResolution;
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
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const newSessionCalls: Array<Record<string, unknown>> = [];
	const created: Array<{ customType: string; data: unknown }> = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const replacement = { editorText: "", notes: [] as Array<{ message: string; type?: string }> };
	const setModels: unknown[] = [];
	const thinking: string[] = [];
	const responses = [...(options.responses ?? [])];
	const editorResults = [...(options.editorResults ?? [])];
	const selects = [...(options.selects ?? [])];

	const complete: HandoffCompleteFn = async (_ctx, request) => {
		calls.push(request);
		const response = responses.length > 1 ? responses.shift() : responses[0];
		if (response instanceof Error) throw response;
		return response ?? { content: [{ type: "text", text: "## Context\nWe built X.\n\n## Task\nDo Y." }], stopReason: "stop" };
	};

	const branch = options.branch ?? [
		{ type: "custom", customType: "recipe-state", data: { name: "work" } },
		{ type: "message", id: "1", message: { role: "user", content: "build X", timestamp: 1 } },
		{ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "built X" }], timestamp: 2 } },
		{ type: "custom", customType: "styles", data: { style: "concise" } },
		{ type: "custom", customType: "advisor-state", data: { enabled: true } },
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
			select: async (title: string, choices: string[]) => {
				selectCalls.push({ title, options: choices });
				return selects.length > 0 ? selects.shift() : "Start the new session";
			},
			editor: async (title: string, text: string) => {
				editorCalls.push({ title, text });
				return editorResults.length > 0 ? editorResults.shift() : text;
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
					notify: (message: string, type?: string) => replacement.notes.push({ message, type }),
				},
				sessionManager: { getSessionFile: () => "/sessions/new.jsonl" },
			});
			return { cancelled: false };
		},
	};

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
		registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		setModel: async (model: unknown) => {
			setModels.push(model);
			return true;
		},
		setThinkingLevel: (level: string) => thinking.push(level),
	};

	try {
		// SAFETY: the harness implements the Pi surface the registrar touches.
		registerHandoff(pi as never, { complete, resolveRecipe: async () => options.recipe ?? {} });
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
	const proposals = () =>
		appended.filter((e) => e.customType === HANDOFF_PROPOSAL_ENTRY_TYPE).map((e) => e.data as HandoffProposalData);
	return {
		ctx, run, emit, commands, renderers, notifications, calls, editorCalls, selectCalls, newSessionCalls,
		created, appended, proposals, replacement, setModels, thinking,
	};
}

test("happy path: propose a card, confirm, new session with carried state", async () => {
	const h = harness();
	await h.run("now do Y for teams");

	assert.equal(h.calls.length, 1);
	assert.match(h.calls[0]!.systemPrompt, /context transfer assistant/);
	assert.match(h.calls[0]!.text, /## Conversation History\n\n[\s\S]*build X[\s\S]*built X/);
	assert.match(h.calls[0]!.text, /## User's Goal for New Thread\n\nnow do Y for teams$/);

	// The proposal is a transcript card plus a plan-style menu; no editor opens.
	assert.equal(h.editorCalls.length, 0);
	const [card] = h.proposals();
	assert.ok(card);
	assert.equal(card.revision, 1);
	assert.match(card.prompt, /^## Context\nWe built X\.[\s\S]*## Previous conversation\nFull pi transcript \(JSONL\): \[`\/sessions\/old\.jsonl`\]/);
	assert.deepEqual(h.selectCalls[0]!.options, Object.values(PROPOSAL_ACTIONS));

	assert.equal(h.newSessionCalls[0]!.parentSession, "/sessions/old.jsonl");
	assert.deepEqual(h.created.map((e) => e.customType), ["recipe-state", "styles", "advisor-state", HANDOFF_ENTRY_TYPE]);
	const data = h.created.at(-1)!.data as HandoffEntryData;
	assert.deepEqual(
		{ goal: data.goal, model: data.model, thinkingLevel: data.thinkingLevel, carried: data.carried, parent: data.parentSession, recipe: data.recipe },
		{ goal: "now do Y for teams", model: "anthropic/claude-opus", thinkingLevel: "high", carried: ["recipe-state", "styles", "advisor-state"], parent: "/sessions/old.jsonl", recipe: undefined },
	);
	assert.equal(h.replacement.editorText, card.prompt);
	assert.match(h.replacement.notes[0]!.message, /Handoff ready/);
});

test("edit and refine add revised cards; only start creates the session", async () => {
	const h = harness({
		selects: [PROPOSAL_ACTIONS.edit, PROPOSAL_ACTIONS.edit, PROPOSAL_ACTIONS.refine, PROPOSAL_ACTIONS.start],
		// First edit changes the prompt, second keeps it, then the refine feedback.
		editorResults: ["edited prompt", "edited prompt", "  mention the tests  "],
		responses: [
			{ content: [{ type: "text", text: "draft one" }], stopReason: "stop" },
			{ content: [{ type: "text", text: "draft two" }], stopReason: "stop" },
		],
	});
	await h.run("goal");

	assert.equal(h.newSessionCalls.length, 1);
	assert.deepEqual(h.proposals().map((p) => p.revision), [1, 2, 3]);
	assert.equal(h.proposals()[1]!.prompt, "edited prompt");
	assert.equal(h.editorCalls[0]!.text, h.proposals()[0]!.prompt);
	assert.match(h.calls[1]!.text, /## Current Draft\n\nedited prompt\n\n## Requested Changes\n\nmention the tests/);
	assert.match(h.proposals()[2]!.prompt, /^draft two\n\n## Previous conversation/);
	assert.equal(h.replacement.editorText, h.proposals()[2]!.prompt);
});

test("refine failures keep the previous draft", async () => {
	const h = harness({
		selects: [PROPOSAL_ACTIONS.refine, PROPOSAL_ACTIONS.refine, PROPOSAL_ACTIONS.start],
		editorResults: ["", "shorter"],
		responses: [
			{ content: [{ type: "text", text: "draft one" }], stopReason: "stop" },
			{ content: [], stopReason: "error", errorMessage: "overloaded" },
		],
	});
	await h.run("goal");
	// Empty feedback skips the call; the failed refine keeps draft one.
	assert.equal(h.calls.length, 2);
	assert.match(h.notifications.at(-1)!.message, /could not refine the prompt: overloaded/);
	assert.equal(h.proposals().length, 1);
	assert.match(h.replacement.editorText, /^draft one/);
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
	const error = harness({ responses: [{ content: [], stopReason: "error", errorMessage: "overloaded" }] });
	await error.run("x");
	assert.match(error.notifications.at(-1)!.message, /could not generate the prompt: overloaded/);

	const thrown = harness({ responses: [new Error("network down")] });
	await thrown.run("x");
	assert.match(thrown.notifications.at(-1)!.message, /network down/);

	const blank = harness({ responses: [{ content: [{ type: "text", text: "  " }], stopReason: "stop" }] });
	await blank.run("x");
	assert.match(blank.notifications.at(-1)!.message, /empty prompt/);

	const cancel = harness({ selects: [PROPOSAL_ACTIONS.cancel] });
	await cancel.run("x");
	assert.match(cancel.notifications.at(-1)!.message, /Handoff cancelled/);

	const escape = harness({ selects: [undefined] });
	await escape.run("x");
	assert.match(escape.notifications.at(-1)!.message, /Handoff cancelled/);

	for (const h of [error, thrown, blank, cancel, escape]) assert.equal(h.newSessionCalls.length, 0);
	assert.equal(cancel.proposals().length, 1);

	const newCancel = harness({ cancelNew: true });
	await newCancel.run("x");
	assert.match(newCancel.notifications.at(-1)!.message, /new session was not created/);
});

test("a trusted .pi-recipe default is pinned and replaces the keys it sets", async () => {
	const h = harness({
		recipe: { recipe: { name: "proj", file: "/repo/.pi-recipe", owns: ["model", "thinking", "style"] } },
	});
	await h.run("goal");

	// The old recipe and style are replaced; the advisor override is kept.
	assert.deepEqual(h.created.map((e) => e.customType), ["advisor-state", "recipe-state", HANDOFF_ENTRY_TYPE]);
	assert.deepEqual(h.created[1]!.data, { name: "proj" });
	const data = h.created.at(-1)!.data as HandoffEntryData;
	assert.deepEqual(data.recipe, { name: "proj", file: "/repo/.pi-recipe", owns: ["model", "thinking", "style"] });
	assert.deepEqual(h.proposals()[0]!.recipe, data.recipe);
	assert.equal(h.replacement.notes.some((n) => n.type === "warning"), false);

	// The new session keeps the recipe's model and thinking level.
	const newCtx = { ...h.ctx, model: MODEL, sessionManager: { getBranch: () => [{ type: "custom", customType: HANDOFF_ENTRY_TYPE, data: { ...data, model: "openai/gpt-x" } }] } };
	await h.emit("session_start", { reason: "new" }, newCtx);
	assert.deepEqual(h.setModels, []);
	assert.deepEqual(h.thinking, []);
});

test("a recipe that needs a restart warns with the new session file", async () => {
	const h = harness({
		recipe: { recipe: { name: "proj", file: "/repo/.pi-recipe", owns: [], restartNote: "its extension set and model scope need a restart" } },
	});
	await h.run("goal");
	const warning = h.replacement.notes.find((n) => n.type === "warning");
	assert.match(warning!.message, /Recipe "proj": its extension set .* pi --session "\/sessions\/new\.jsonl"/);
});

test("an untrusted .pi-recipe note shows on the card; old state carries over", async () => {
	const h = harness({ recipe: { note: ".pi-recipe is not trusted; the new session keeps the current recipe" } });
	await h.run("goal");
	assert.match(h.proposals()[0]!.recipeNote!, /not trusted/);
	assert.deepEqual(h.created.map((e) => e.customType), ["recipe-state", "styles", "advisor-state", HANDOFF_ENTRY_TYPE]);
});

test("ephemeral session: no transcript link and no parent", async () => {
	const h = harness({ sessionFile: undefined });
	await h.run("x");
	assert.doesNotMatch(h.proposals()[0]!.prompt, /Previous conversation/);
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
	assert.equal(h.renderers.has(HANDOFF_PROPOSAL_ENTRY_TYPE), true);
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

test("the proposal card fits every width and shows the new-session facts", () => {
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const data: HandoffProposalData = {
		version: 1,
		goal: "implement this for teams as well ".repeat(5),
		prompt: "## Context\nA very long line of context that wraps across many terminal columns for sure.\n\n## Task\nDo Y.",
		revision: 2,
		model: "anthropic/claude-opus",
		carried: ["advisor-state"],
		recipe: { name: "proj", file: "/repo/.pi-recipe", owns: ["model"], restartNote: "its extension set and model scope need a restart" },
		recipeNote: undefined,
	};
	for (const width of [0, 1, 10, 40, 120]) {
		const rows = renderProposalRows(data, theme, width);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
	}
	const text = renderProposalRows(data, theme, 200).join("\n");
	assert.match(text, /HANDOFF PROPOSAL · revision 2/);
	assert.match(text, /New session: recipe proj \(\.pi-recipe\) · keeps advisor-state/);
	assert.doesNotMatch(text, /model anthropic/);
	assert.match(text, /Recipe proj: its extension set/);
});
