/**
 * btw/index.ts — registrar wiring tests.
 *
 * Drives the real registrar through a mocked Pi/ctx harness (the
 * you-should-know wiring-test pattern): command surfacing (parent vs
 * headless child), the end-to-end ask flow (prompt = digest + snapshot +
 * question), the multi-surface lifecycle (entry box, toast, pending →
 * answered card with auto-hide, frame pill vs footer status), last-wins
 * replacement, failure toasts, shutdown cleanup, and RPC degradation. No
 * network: the model registry's complete() is the only injected async seam;
 * per-test gates control when calls settle.
 */

import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";

import { contributedFrameMetadata, FRAME_CAPABILITY_EVENT } from "../frame/protocol.ts";
import { BTW_ENTRY_TYPE, BTW_STATUS_KEY, BTW_WIDGET_KEY, type BtwEntryData } from "./display.ts";
import { registerBtw } from "./index.ts";

type ExtensionEvent = unknown;

interface HarnessOptions {
	/** Session model; null models a model-less session. */
	model?: { provider: string; id: string } | null;
	/** The complete() reply. */
	reply?: {
		text?: string;
		stopReason?: string;
		errorMessage?: string;
		usage?: { input?: number; output?: number; cost?: { total?: number } };
	};
	/** ctx.mode (default "tui"). */
	mode?: "tui" | "rpc";
	/** ctx.hasUI (default true). */
	hasUI?: boolean;
	/** True → ctx.signal is a live run signal (mid-flow). */
	midFlow?: boolean;
	/** Harness pi answers the frame capability probe. */
	frameSupported?: boolean;
	/** Answer-card lifetime injected into registerBtw (default 8ms). */
	answerCardMs?: number;
	/** True → register under AIO_SUBAGENT_CHILD=1. */
	child?: boolean;
}

const DEFAULT_REPLY_TEXT = "package-lock.json is the chunkiest file in this fixture workspace.";

interface WidgetCall {
	key: string;
	content: unknown;
	options: { placement?: string } | undefined;
}

function waitFor(what: string, pred: () => boolean, timeoutMs = 2500): Promise<void> {
	return (async () => {
		for (let i = 0; i < timeoutMs / 5; i++) {
			if (pred()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.fail(`timeout waiting for ${what}`);
	})();
}

/** Render helper for captured widget factories (passthrough theme). */
const widgetTheme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

function renderWidget(call: WidgetCall, width = 80): string[] {
	if (typeof call.content !== "function") return [];
	const component = (call.content as (tui: unknown, theme: unknown) => { render(w: number): string[] })(
		{},
		widgetTheme,
	);
	return component.render(width);
}

function makeHarness(options: HarnessOptions = {}) {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "btw-wiring-"));
	fsSync.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));

	const previousEnv: Record<string, string | undefined> = {
		AIO_SUBAGENT_CHILD: process.env.AIO_SUBAGENT_CHILD,
	};
	if (options.child) process.env.AIO_SUBAGENT_CHILD = "1";

	const sessionModel = options.model === null ? null : (options.model ?? { provider: "openai", id: "gpt-test" });
	const replyText = options.reply?.text ?? DEFAULT_REPLY_TEXT;
	const answerCardMs = options.answerCardMs ?? 8;

	const handlers = new Map<string, Array<(event: ExtensionEvent, ctx: unknown) => unknown>>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const renderers: Array<{ type: string; renderer: unknown }> = [];
	const entries: Array<{ customType: string; data: BtwEntryData }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const widgets: WidgetCall[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const completeCalls: Array<{
		context: { systemPrompt: string; messages: Array<{ content: string }> };
		signal?: AbortSignal;
	}> = [];
	/** FIFO: complete calls consume a gate each before settling (tests push). */
	const gates: Array<Promise<void>> = [];

	const ctx = {
		cwd: dir,
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		signal: options.midFlow ? new AbortController().signal : undefined,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			setWidget: (key: string, content: unknown, widgetOptions?: { placement?: string }) =>
				widgets.push({ key, content, options: widgetOptions }),
		},
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "keep the router safe" } },
				{
					type: "message",
					message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "200 lines" }] },
				},
			],
		},
		modelRegistry: {
			complete: async (
				_model: unknown,
				context: { systemPrompt: string; messages: Array<{ content: string }> },
				callOptions?: { signal?: AbortSignal },
			) => {
				completeCalls.push({ context, signal: callOptions?.signal });
				const gate = gates.shift();
				if (gate) await gate;
				return {
					content: [{ type: "text", text: replyText }],
					stopReason: options.reply?.stopReason ?? "stop",
					errorMessage: options.reply?.errorMessage,
					usage: options.reply?.usage,
				};
			},
		},
		get model() {
			return sessionModel;
		},
	};

	// SAFETY: the mock exposes exactly the registrar's consumed surface; the
	// full ExtensionAPI contract is intentionally not modeled here.
	const pi = {
		on: (event: string, handler: (event: ExtensionEvent, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: {
			emit: (event: string, payload: Record<string, unknown>) => {
				if (event === FRAME_CAPABILITY_EVENT && options.frameSupported) {
					payload.supported = true;
				}
			},
		},
		registerEntryRenderer: (type: string, renderer: unknown) => renderers.push({ type, renderer }),
		appendEntry: (customType: string, data: BtwEntryData) => entries.push({ customType, data }),
		registerCommand: (name: string, command: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, command);
		},
	} as unknown as Parameters<typeof registerBtw>[0];

	registerBtw(pi, { answerCardMs });

	const fire = (event: string, eventPayload: ExtensionEvent) => {
		for (const handler of handlers.get(event) ?? []) handler(eventPayload, ctx);
	};
	const ask = (question: string) => {
		const command = commands.get("btw");
		assert.ok(command, "the btw command registered");
		return command.handler(question, ctx);
	};
	const restore = () => {
		fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fsSync.rmSync(dir, { recursive: true, force: true });
	};

	return {
		ask,
		fire,
		restore,
		commands,
		entries,
		notifications,
		widgets,
		statuses,
		completeCalls,
		renderers,
		gates,
		ctx,
	};
}

function gate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// =====================================================================
// Command surfacing
// =====================================================================

test("registers the btw command and the entry renderer in a parent session", () => {
	const h = makeHarness();
	try {
		assert.ok(h.commands.has("btw"), "command registered");
		assert.ok(h.commands.get("btw")?.description?.includes("mid-flow"), "description mentions mid-flow");
		assert.ok(
			h.renderers.some((renderer) => renderer.type === BTW_ENTRY_TYPE),
			"entry renderer registered",
		);
	} finally {
		h.restore();
	}
});

test("headless subagent children register no command but keep the renderer", () => {
	const h = makeHarness({ child: true });
	try {
		assert.equal(h.commands.size, 0, "no command in children");
		assert.ok(h.renderers.some((renderer) => renderer.type === BTW_ENTRY_TYPE), "renderer still registered");
	} finally {
		h.restore();
	}
});

test("a bare /btw reports usage and never calls the model", async () => {
	const h = makeHarness();
	try {
		await h.ask("");
		assert.ok(h.notifications.some((n) => n.message.includes("Usage: /btw <question>")), "usage shown");
		assert.ok(h.notifications.some((n) => n.message.includes("no question in flight")), "in-flight state shown");
		assert.equal(h.completeCalls.length, 0);
	} finally {
		h.restore();
	}
});

test("a model-less session warns and never calls the model", async () => {
	const h = makeHarness({ model: null });
	try {
		await h.ask("what gives?");
		assert.ok(h.notifications.some((n) => n.type === "warning" && n.message.includes("no model is active")));
		assert.equal(h.completeCalls.length, 0);
		assert.equal(h.entries.length, 0);
	} finally {
		h.restore();
	}
});

// =====================================================================
// End-to-end ask (single turn)
// =====================================================================

test("an idle ask answers through one isolated call and surfaces everything", async () => {
	const h = makeHarness({
		reply: { usage: { input: 1000, output: 250, cost: { total: 0.001 } } },
	});
	try {
		await h.ask("what is chunkiest in this repo???");

		// The prompt: persona system prompt, digest, snapshot, question.
		await waitFor("complete call", () => h.completeCalls.length === 1);
		const call = h.completeCalls[0];
		assert.ok(call.context.systemPrompt.includes("By The Way"), "persona system prompt");
		assert.ok(call.context.messages[0].content.includes("QUESTION"), "question section");
		assert.ok(call.context.messages[0].content.includes("what is chunkiest in this repo???"), "the question itself");
		assert.ok(call.context.messages[0].content.includes("keep the router safe"), "flow digest included");
		assert.ok(call.context.messages[0].content.includes("package.json"), "workspace snapshot included");

		// The entry: full data, never in LLM context (custom entry).
		await waitFor("entry", () => h.entries.length === 1);
		const entry = h.entries[0];
		assert.equal(entry.customType, BTW_ENTRY_TYPE);
		assert.equal(entry.data.question, "what is chunkiest in this repo???");
		assert.equal(entry.data.answer, "package-lock.json is the chunkiest file in this fixture workspace.");
		assert.equal(entry.data.model, "openai/gpt-test");
		assert.equal(entry.data.answeredMidFlow, false, "idle ask → not mid-flow");
		assert.deepEqual(entry.data.usage, { inputTokens: 1000, outputTokens: 250, costTotal: 0.001 });
		assert.ok(entry.data.latencyMs >= 0);
		assert.ok(typeof entry.data.timestamp === "number");

		// The toast ping.
		assert.ok(
			h.notifications.some((n) => n.type === "info" && n.message.startsWith("btw — ")),
			"one-line arrival toast",
		);

		// Widget lifecycle: pending card → answered card → auto-hide clear.
		assert.equal(h.widgets[0].key, BTW_WIDGET_KEY);
		assert.equal(h.widgets[0].options?.placement, "aboveEditor");
		const pendingRows = renderWidget(h.widgets[0]);
		assert.ok(pendingRows.some((row) => row.includes("↯ asking gpt-test")), "pending card rendered asking line");
		await waitFor("answered card", () => h.widgets.some((widget, index) => index > 0 && typeof widget.content === "function"));
		const answeredFactory = [...h.widgets].reverse().find((widget) => typeof widget.content === "function")!;
		assert.ok(answeredFactory !== h.widgets[0], "a second, answered factory was installed");
		const answeredRows = renderWidget(answeredFactory);
		assert.ok(answeredRows.some((row) => row.includes("chunkiest")), "answered card carries the answer");
		assert.ok(answeredRows.some((row) => row.includes("auto-hides in")), "countdown row");
		await waitFor("auto-hide", () => h.widgets.some((widget) => widget.content === undefined));

		// Footer status fallback (no frame in this harness): pill set, then cleared.
		assert.ok(h.statuses.some((status) => status.key === BTW_STATUS_KEY && status.text?.startsWith("↯ btw asking")));
		assert.ok(h.statuses.some((status) => status.key === BTW_STATUS_KEY && status.text === undefined));
	} finally {
		h.restore();
	}
});

test("a mid-flow ask records answeredMidFlow on the entry", async () => {
	const h = makeHarness({ midFlow: true });
	try {
		await h.ask("why is this input misaligned?");
		await waitFor("entry", () => h.entries.length === 1);
		assert.equal(h.entries[0].data.answeredMidFlow, true);
	} finally {
		h.restore();
	}
});

test("a newer ask replaces the older run (last wins)", async () => {
	const h = makeHarness();
	try {
		const held = gate();
		h.gates.push(held.promise);
		await h.ask("first question");
		await waitFor("first call at the seam", () => h.completeCalls.length === 1);
		await h.ask("second question");
		await waitFor("second call", () => h.completeCalls.length === 2);
		assert.ok(h.completeCalls[0].signal?.aborted, "the replaced run was aborted");
		await waitFor("single entry", () => h.entries.length === 1);
		assert.equal(h.entries[0].data.question, "second question");
		held.release();
	} finally {
		h.restore();
	}
});

test("a failed side call toasts a warning and appends nothing", async () => {
	const h = makeHarness({ reply: { stopReason: "error", errorMessage: "provider down" } });
	try {
		await h.ask("what is this config file for?");
		await waitFor("warning toast", () =>
			h.notifications.some((n) => n.type === "warning" && n.message.includes("provider down")),
		);
		assert.equal(h.entries.length, 0, "no entry on failure");
		await waitFor("widget cleared", () => h.widgets.some((widget) => widget.content === undefined));
		assert.ok(h.statuses.some((status) => status.key === BTW_STATUS_KEY && status.text === undefined), "pill cleared");
	} finally {
		h.restore();
	}
});

test("an answered card shows exactly once when answerCardMs is zero", async () => {
	const h = makeHarness({ answerCardMs: 0 });
	try {
		await h.ask("fresh question");
		await waitFor("entry", () => h.entries.length === 1);
		assert.equal(h.widgets.length, 2, "pending install then immediate clear");
		assert.equal(typeof h.widgets[0].content, "function", "pending card installed");
		assert.equal(h.widgets[1].content, undefined, "no answered card, direct clear");
	} finally {
		h.restore();
	}
});

// =====================================================================
// Surfaces: framed vs unframed, RPC degradation
// =====================================================================

test("with the frame probe answered, the pill lands in the frame, not the footer", async () => {
	const h = makeHarness({ frameSupported: true });
	try {
		const held = gate();
		h.gates.push(held.promise);
		await h.ask("held question");
		const meta = contributedFrameMetadata().btw;
		assert.ok(meta, "frame contributor installed while in flight");
		assert.equal(meta?.icon, "↯");
		assert.ok(meta?.label.includes("btw asking"), "label");
		assert.equal(meta?.role, "accent");
		assert.ok(
			!h.statuses.some((status) => status.key === BTW_STATUS_KEY && typeof status.text === "string"),
			"footer pill never set while framed",
		);
		held.release();
		await waitFor("entry", () => h.entries.length === 1);
		assert.equal(contributedFrameMetadata().btw, undefined, "contributor cleared after answer");
	} finally {
		h.restore();
	}
});

test("rpc mode skips widgets but keeps the entry and toast", async () => {
	const h = makeHarness({ mode: "rpc" });
	try {
		await h.ask("any question");
		await waitFor("entry", () => h.entries.length === 1);
		assert.equal(h.widgets.length, 0, "no widget in rpc mode");
		assert.ok(h.notifications.some((n) => n.type === "info" && n.message.startsWith("btw — ")));
	} finally {
		h.restore();
	}
});

test("session shutdown aborts an in-flight question and clears every surface", async () => {
	const h = makeHarness();
	try {
		const held = gate();
		h.gates.push(held.promise);
		await h.ask("pending question");
		await waitFor("held call at the seam", () => h.completeCalls.length === 1);
		h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.ok(h.completeCalls[0].signal?.aborted, "shutdown aborted the run");
		assert.ok(h.widgets.some((widget) => widget.content === undefined), "widget cleared");
		assert.ok(h.statuses.some((status) => status.key === BTW_STATUS_KEY && status.text === undefined), "status cleared");
		assert.equal(contributedFrameMetadata().btw, undefined, "frame contributor cleared");
		held.release();
	} finally {
		h.restore();
	}
});
