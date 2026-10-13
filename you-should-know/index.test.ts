/**
 * you-should-know/index.ts — registrar wiring tests.
 *
 * Drives the real registrar through a mocked Pi/ctx harness (the styles/index
 * pattern): event fires, batch scheduling, silence contract, child sidecar
 * shape and surfacing, settings propagation (parent off ⇒ child off), the
 * /ysk command surface, completions, and the failure latch. No network; the
 * model registry's complete() is the only injected async seam. All state is
 * per-harness (settings + fixtures under a temp dir; env restored at the end).
 */

import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";

import { appendChildAuditRecord, sidecarPathFor } from "./auditor.ts";
import { YSK_ENTRY_TYPE, type YskEntryData } from "./display.ts";
import { registerYouShouldKnow } from "./index.ts";

type ExtensionEvent = unknown;

interface HarnessOptions {
	/** Written to the settings file before registration. */
	settings?: Record<string, unknown>;
	/** Session model; null models a model-less session. */
	model?: { provider: string; id: string } | null;
	/** The complete() reply (defaults to a clean empty-findings JSON). */
	reply?: {
		text?: string;
		stopReason?: string;
		errorMessage?: string;
		usage?: { input?: number; output?: number; cost?: { total?: number } };
	};
	failComplete?: Error;
	/** Subagent-child environment for the registrar process. */
	child?: { runId?: string; agent?: string; sessionFile: string } | null;
}

interface CompleteCall {
	context: { systemPrompt: string; messages: Array<{ content: string }> };
}

const CRITICAL_REPLY = JSON.stringify({
	findings: [
		{ severity: "critical", title: "Unawaited promise discarded", detail: "Errors pass silently at init.", file: "src/app.ts" },
	],
});

const REPLY_USAGE = { input: 4100, output: 420, cost: { total: 0.003 } };

async function waitFor(what: string, pred: () => boolean, timeoutMs = 2500): Promise<void> {
	for (let i = 0; i < timeoutMs / 5; i++) {
		if (pred()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timeout waiting for ${what}`);
}

function makeHarness(options: HarnessOptions = {}) {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ysk-wiring-"));
	fsSync.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "harness" }));
	fsSync.mkdirSync(path.join(dir, "src"));
	fsSync.writeFileSync(path.join(dir, "src", "app.ts"), "export const app = 1;\n");
	fsSync.writeFileSync(path.join(dir, "src", "other.ts"), "export const other = 2;\n");

	const settingsFile = path.join(dir, "settings.json");
	if (options.settings) fsSync.writeFileSync(settingsFile, JSON.stringify(options.settings));

	const previousEnv: Record<string, string | undefined> = {
		AIO_YSK_SETTINGS_FILE: process.env.AIO_YSK_SETTINGS_FILE,
		AIO_SUBAGENT_CHILD: process.env.AIO_SUBAGENT_CHILD,
		AIO_SUBAGENT_RUN_ID: process.env.AIO_SUBAGENT_RUN_ID,
		AIO_SUBAGENT_AGENT: process.env.AIO_SUBAGENT_AGENT,
		PI_SESSION_FILE: process.env.PI_SESSION_FILE,
	};
	process.env.AIO_YSK_SETTINGS_FILE = settingsFile;
	if (options.child) {
		fsSync.mkdirSync(path.dirname(options.child.sessionFile), { recursive: true });
		process.env.AIO_SUBAGENT_CHILD = "1";
		process.env.PI_SESSION_FILE = options.child.sessionFile;
		if (options.child.runId) process.env.AIO_SUBAGENT_RUN_ID = options.child.runId;
		if (options.child.agent) process.env.AIO_SUBAGENT_AGENT = options.child.agent;
	}

	const sessionModel = options.model ?? { provider: "openai", id: "gpt-test" };
	const alternateModel = { provider: "anthropic", id: "claude-test" };
	const replyText = options.reply?.text ?? JSON.stringify({ findings: [] });

	const handlers = new Map<string, Array<(event: ExtensionEvent, ctx: unknown) => unknown>>();
	const commands = new Map<string, { description?: string; getArgumentCompletions?: (p: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const entries: Array<{ customType: string; data: YskEntryData }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statusHistory: Array<{ key: string; text: string | undefined }> = [];
	const completeCalls: CompleteCall[] = [];

	const ctx = {
		cwd: dir,
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => {
				statusHistory.push({ key, text });
			},
		},
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "keep the router safe" } },
			],
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				sessionModel && provider === sessionModel.provider && id === sessionModel.id
					? sessionModel
					: provider === alternateModel.provider && id === alternateModel.id
						? alternateModel
						: undefined,
			getModelsOfType: () => [sessionModel, alternateModel].filter(Boolean),
			complete: async (_model: unknown, context: CompleteCall["context"]) => {
				completeCalls.push({ context });
				if (options.failComplete) throw options.failComplete;
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

	const pi = {
		on: (event: string, handler: (event: ExtensionEvent, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data: YskEntryData) => entries.push({ customType, data }),
		registerCommand: (name: string, command: (typeof commands extends Map<string, infer C> ? C : never)) => {
			commands.set(name, command);
		},
		getAllTools: () => [{ name: "write" }, { name: "edit" }, { name: "apply_patch" }, { name: "bash" }],
		// SAFETY: the mock exposes exactly the registrar's consumed surface;
		// the full ExtensionAPI contract is intentionally not modeled here.
	} as unknown as Parameters<typeof registerYouShouldKnow>[0];

	registerYouShouldKnow(pi);

	const fire = (event: string, evt: ExtensionEvent) => {
		for (const handler of handlers.get(event) ?? []) handler(evt, ctx);
	};

	const writeResult = (input: Record<string, unknown> & { path?: string }, extra: Partial<{ toolName: string; isError: boolean; parentToolCallId: string }> = {}) => ({
		type: "tool_result",
		toolCallId: `t${completeCalls.length}-${Math.random().toString(16).slice(2, 8)}`,
		toolName: extra.toolName ?? "write",
		input,
		content: [{ type: "text", text: "Successfully wrote" }],
		isError: extra.isError ?? false,
		parentToolCallId: extra.parentToolCallId,
		details: undefined,
	});

	const restore = () => {
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};

	return { dir, settingsFile, fire, writeResult, entries, commands, notifications, statusHistory, completeCalls, ctx, restore };
}

// =====================================================================
// Trigger + silence contract
// =====================================================================

test("off by default: no audits, no status pill, no entries", async () => {
	const h = makeHarness();
	try {
		h.fire("session_start", { type: "session_start", reason: "startup" });
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "x" }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(h.completeCalls.length, 0);
		assert.equal(h.entries.length, 0);
		assert.ok(h.statusHistory.every((entry) => entry.text === undefined), "disabled ⇒ pill cleared, never set");
	} finally {
		h.restore();
	}
});

test("enabled audits a successful write end to end", async () => {
	const h = makeHarness({
		settings: { enabled: true, batchWindowMs: 15 },
		reply: { text: CRITICAL_REPLY, usage: REPLY_USAGE },
	});
	try {
		h.fire("session_start", { type: "session_start", reason: "startup" });
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "export const app = 2;\n" }));

		await waitFor("audit entry", () => h.entries.length === 1);
		const entry = h.entries[0];
		assert.equal(entry.customType, YSK_ENTRY_TYPE);
		assert.equal(entry.data.origin, null);
		assert.deepEqual(entry.data.files, ["src/app.ts"]);
		assert.equal(entry.data.findings[0].severity, "critical");
		assert.equal(entry.data.model, "openai/gpt-test");
		assert.ok(entry.data.raised >= 1);

		// Pill: on at session start, flashes auditing during the batch, back on after.
		assert.ok(h.statusHistory.some((entry) => entry.text === "◉ YSK on · openai/gpt-test"));
		assert.ok(h.statusHistory.some((entry) => entry.text?.startsWith("◉ YSK auditing")));
		// Critical toast per the agreed surface.
		assert.ok(h.notifications.some((n) => n.type === "error" && n.message.includes("You Should Know (Pi Edition) — ✖ Unawaited promise discarded")));

		assert.ok(h.completeCalls[0].context.systemPrompt.includes("You Should Know"));
		assert.ok(h.completeCalls[0].context.messages[0].content.includes("src/app.ts"));
		assert.ok(h.completeCalls[0].context.messages[0].content.includes("keep the router safe"));
	} finally {
		h.restore();
	}
});

test("silence: a clean audit emits no entry and no toast", async () => {
	const h = makeHarness({ settings: { enabled: true, batchWindowMs: 15 } });
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "x" }));
		await waitFor("audit call", () => h.completeCalls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(h.entries.length, 0);
		assert.equal(h.notifications.length, 0);
	} finally {
		h.restore();
	}
});

test("below-threshold findings stay silent", async () => {
	const h = makeHarness({
		settings: { enabled: true, batchWindowMs: 15 },
		reply: {
			text: JSON.stringify({
				findings: [{ severity: "info", title: "Consider a test", detail: "nice to have", file: "src/app.ts" }],
			}),
		},
	});
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "x" }));
		await waitFor("audit call", () => h.completeCalls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(h.entries.length, 0);
	} finally {
		h.restore();
	}
});

test("error results, nested calls, and unconfigured tools never audit", async () => {
	const h = makeHarness({ settings: { enabled: true, batchWindowMs: 15 } });
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "x" }, { isError: true }));
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "x" }, { parentToolCallId: "parent/1" }));
		h.fire("tool_result", h.writeResult({ path: "src/app.ts" }, { toolName: "read" }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(h.completeCalls.length, 0);
	} finally {
		h.restore();
	}
});

test("excluded paths never audit", async () => {
	const h = makeHarness({ settings: { enabled: true, batchWindowMs: 15 } });
	try {
		h.fire("tool_result", h.writeResult({ path: "node_modules/pkg/index.js", content: "x" }));
		h.fire("tool_result", h.writeResult({ path: "package-lock.json", content: "{}" }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(h.completeCalls.length, 0);
	} finally {
		h.restore();
	}
});

test("bursts coalesce into one audit covering every changed file", async () => {
	const h = makeHarness({
		settings: { enabled: true, batchWindowMs: 30 },
		reply: { text: CRITICAL_REPLY },
	});
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "a" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		h.fire("tool_result", h.writeResult({ path: "src/other.ts", content: "b" }));
		await waitFor("audit call", () => h.completeCalls.length === 1);
		await waitFor("entry", () => h.entries.length === 1);
		const prompt = h.completeCalls[0].context.messages[0].content;
		assert.ok(prompt.includes("src/app.ts"), "first file in prompt");
		assert.ok(prompt.includes("src/other.ts"), "second file coalesced into the same audit");
		assert.deepEqual(h.entries[0].data.files, ["src/app.ts", "src/other.ts"]);
	} finally {
		h.restore();
	}
});

// =====================================================================
// Settings propagation (parent off ⇒ child off)
// =====================================================================

test("disabling via the settings file stops later audits", async () => {
	const h = makeHarness({
		settings: { enabled: true, batchWindowMs: 15 },
		reply: { text: CRITICAL_REPLY },
	});
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "a" }));
		await waitFor("first audit", () => h.completeCalls.length === 1);
		fsSync.writeFileSync(h.settingsFile, JSON.stringify({ enabled: false, batchWindowMs: 15 }));
		h.fire("tool_result", h.writeResult({ path: "src/other.ts", content: "b" }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(h.completeCalls.length, 1, "no audits after the disable flip");
	} finally {
		h.restore();
	}
});

// =====================================================================
// Subagent children: audit locally, mirror to sidecar, parent surfaces
// =====================================================================

test("subagent children audit immediately and mirror findings to the sidecar", async () => {
	const childSession = `${os.tmpdir()}/ysk-wiring-child-${Date.now()}/session.jsonl`;
	const h = makeHarness({
		settings: { enabled: true, batchWindowMs: 15 },
		reply: { text: CRITICAL_REPLY, usage: REPLY_USAGE },
		child: { runId: "run-9", agent: "scout", sessionFile: childSession },
	});
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "a" }));
		await waitFor("child entry", () => h.entries.length === 1);
		await waitFor("sidecar record", async () => fsSync.existsSync(sidecarPathFor(childSession)));

		const raw = fsSync.readFileSync(sidecarPathFor(childSession), "utf8");
		const record = JSON.parse(raw.trim().split("\n")[0]);
		assert.equal(record.agent, "scout");
		assert.equal(record.runId, "run-9");
		assert.equal(record.model, "openai/gpt-test");
		assert.deepEqual(record.files, ["src/app.ts"]);
		assert.equal(record.findings[0].severity, "critical");

		// Children never touch the status pill.
		assert.equal(h.statusHistory.length, 0);
	} finally {
		h.restore();
	}
});

test("parent surfaces (and deletes) child findings when the subagent result arrives", async () => {
	const h = makeHarness({ settings: { enabled: true, batchWindowMs: 15 } });
	try {
		const childSession = path.join(h.dir, "child-run-1", "session.jsonl");
		fsSync.mkdirSync(path.dirname(childSession), { recursive: true });
		await appendChildAuditRecord(
			{
				agent: "scout",
				runId: "run-1",
				auditAt: Date.now(),
				model: "anthropic/claude-test",
				files: ["src/app.ts"],
				findings: [
					{ severity: "critical", title: "Unawaited promise discarded", detail: "Errors pass silently at init.", file: "src/app.ts" },
				],
				usage: { inputTokens: 900, outputTokens: 100, costTotal: 0.001 },
				latencyMs: 800,
			},
			childSession,
		);

		h.fire("tool_result", {
			type: "tool_result",
			toolCallId: "sub-1",
			toolName: "subagent",
			input: { task: { agent: "scout", task: "recon" } },
			content: [{ type: "text", text: "Child finished." }],
			isError: false,
			details: { children: [{ agent: "scout", sessionFile: childSession }] },
		});

		await waitFor("surfaced entry", () => h.entries.length === 1);
		const entry = h.entries[0];
		assert.equal(entry.data.origin, "subagent 'scout'");
		assert.equal(entry.data.model, "anthropic/claude-test");
		assert.ok(entry.data.findings[0].severity === "critical");
		assert.ok(h.notifications.some((n) => n.type === "error" && n.message.includes("You Should Know (Pi Edition)")), "critical surfaced findings toast too");
		assert.ok(!fsSync.existsSync(sidecarPathFor(childSession)), "sidecar consumed and deleted");

		// Simpler repeats within the dedupe TTL stay quiet.
		await appendChildAuditRecord(
			{
				agent: "scout",
				runId: "run-1",
				auditAt: Date.now(),
				model: "anthropic/claude-test",
				files: ["src/app.ts"],
				findings: [
					{ severity: "critical", title: "Unawaited promise discarded", detail: "Errors pass silently at init.", file: "src/app.ts" },
				],
				latencyMs: 100,
			},
			childSession,
		);
		h.fire("tool_result", {
			type: "tool_result",
			toolCallId: "sub-2",
			toolName: "subagent",
			input: { task: { agent: "scout", task: "recon" } },
			content: [{ type: "text", text: "Child finished again." }],
			isError: false,
			details: { children: [{ agent: "scout", sessionFile: childSession }] },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(h.entries.length, 1, "duplicate child finding deduped");
	} finally {
		h.restore();
	}
});

test("child audits stop when the shared settings file says disabled", async () => {
	const childSession = `${os.tmpdir()}/ysk-wiring-child-off-${Date.now()}/session.jsonl`;
	const h = makeHarness({ settings: { enabled: false, batchWindowMs: 15 }, child: { sessionFile: childSession } });
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "a" }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(h.completeCalls.length, 0);
		assert.ok(!fsSync.existsSync(sidecarPathFor(childSession)));
	} finally {
		h.restore();
	}
});

// =====================================================================
// Failure latch
// =====================================================================

test("infra errors notify once, then stay silent", async () => {
	const h = makeHarness({
		settings: { enabled: true, batchWindowMs: 15 },
		reply: { stopReason: "error", errorMessage: "boomtown 500" },
	});
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "a" }));
		await waitFor("first failure", () => h.completeCalls.length === 1);
		h.fire("tool_result", h.writeResult({ path: "src/other.ts", content: "b" }));
		await waitFor("second failure", () => h.completeCalls.length === 2);
		const failures = h.notifications.filter((n) => n.message.includes("boomtown"));
		assert.equal(failures.length, 1, "failure notifies exactly once");
		assert.equal(h.entries.length, 0);
	} finally {
		h.restore();
	}
});

// =====================================================================
// /ysk command + completions
// =====================================================================

const commandHarness = () => {
	const h = makeHarness({});
	const ctx = h.ctx;
	const handler = (args: string, ctx: unknown) => h.commands.get("ysk")!.handler(args, ctx);
	const completions = (prefix: string) =>
		(h.commands.get("ysk")!.getArgumentCompletions?.(prefix) ?? null) as Array<{ value: string; description?: string }> | null;
	return { h, ctx, handler, completions };
};

test("/ysk enable/disable persist and manage the pill", async () => {
	const { h, ctx, handler } = commandHarness();
	try {
		await handler("enable", ctx);
		assert.equal(JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8")).enabled, true);
		assert.ok(h.statusHistory.some((s) => s.text === "◉ YSK on · openai/gpt-test"));

		await handler("disable", ctx);
		assert.equal(JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8")).enabled, false);
		assert.ok(h.statusHistory.some((s) => s.text === undefined));
	} finally {
		h.restore();
	}
});

test("/ysk model pins, validates, and resets", async () => {
	const { h, ctx, handler } = commandHarness();
	try {
		await handler("model anthropic/claude-test", ctx);
		assert.equal(JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8")).model, "anthropic/claude-test");

		await handler("model openai/nope-missing", ctx);
		assert.equal(JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8")).model, "anthropic/claude-test", "unresolved model not saved");
		assert.ok(h.notifications.some((n) => n.type === "error" && n.message.includes("nope-missing")));

		await handler("model off", ctx);
		assert.equal(JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8")).model, null);
	} finally {
		h.restore();
	}
});

test("/ysk severity and tools validate and persist", async () => {
	const { h, ctx, handler } = commandHarness();
	try {
		await handler("severity critical", ctx);
		let saved = JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8"));
		assert.equal(saved.minSeverity, "critical");

		await handler("severity ultra", ctx);
		assert.ok(h.notifications.some((n) => n.type === "error" && n.message.includes("severity must be one of")));

		await handler("tools write, apply_patch", ctx);
		saved = JSON.parse(fsSync.readFileSync(h.settingsFile, "utf8"));
		assert.deepEqual(saved.auditTools, ["write", "apply_patch"]);
	} finally {
		h.restore();
	}
});

test("/ysk audit runs one manual audit immediately", async () => {
	const h = makeHarness({ settings: { enabled: true, batchWindowMs: 60000 } });
	try {
		const handler = h.commands.get("ysk")!.handler;
		await handler("audit src/app.ts", h.ctx);
		await waitFor("manual audit call", () => h.completeCalls.length === 1);
		assert.ok(h.completeCalls[0].context.messages[0].content.includes("manual audit requested"));
	} finally {
		h.restore();
	}
});

test("completions cover subcommands, models, severities, and tools", async () => {
	const { h, completions } = commandHarness();
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "x" })); // primes lastCtx
		await new Promise((resolve) => setTimeout(resolve, 20));

		const subs = completions("") ?? [];
		assert.ok(subs.some((c) => c.value === "enable"));
		assert.ok(subs.some((c) => c.value === "model"));

		const models = completions("model ") ?? [];
		assert.ok(models.some((c) => c.value === "anthropic/claude-test"));

		const severities = completions("severity ") ?? [];
		assert.deepEqual(severities.map((c) => c.value), ["info", "warning", "critical"]);

		const tools = completions("tools ") ?? [];
		assert.ok(tools.some((c) => c.value === "apply_patch"));
	} finally {
		h.restore();
	}
});

test("shutdown drops pending audit work scheduled before it", async () => {
	const h = makeHarness({ settings: { enabled: true, batchWindowMs: 15 } });
	try {
		h.fire("tool_result", h.writeResult({ path: "src/app.ts", content: "a" }));
		h.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(h.completeCalls.length, 0, "pending work scheduled before shutdown never audits");
	} finally {
		h.restore();
	}
});
