import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SubagentInspector } from "./inspector.ts";
import { clearRuns, listRuns } from "./registry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSubagentWidgetLines, registerSubagents } from "./index.ts";
import type { SubagentRun } from "./types.ts";

function createHarness() {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, Record<string, unknown>>();
	const shortcuts = new Map<string, Record<string, unknown>>();
	const messages: Array<{ message: Record<string, unknown>; options: unknown }> = [];
	const pi = {
		registerCommand(name: string, options: Record<string, unknown>) {
			commands.set(name, options);
		},
		registerShortcut(key: string, options: Record<string, unknown>) {
			shortcuts.set(key, options);
		},
		registerTool(tool: Record<string, unknown>) {
			tools.set(String(tool.name), tool);
		},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const values = handlers.get(name) ?? [];
			values.push(handler);
			handlers.set(name, values);
		},
		getThinkingLevel() {
			return "high";
		},
		sendMessage(message: Record<string, unknown>, options: unknown) {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	return { commands, handlers, pi, shortcuts, tools, messages };
}

test("subagent widget is branded, bounded, and width-safe", () => {
	const runs: SubagentRun[] = Array.from({ length: 6 }, (_, index) => ({
		id: `run-${index}-abcdefgh`,
		state: "running",
		mode: "parallel",
		context: "fresh",
		cwd: process.cwd(),
		startedAt: Date.now(),
		children: [
			{ index: 0, agent: "reviewer", task: "Review", state: "completed" },
			{ index: 1, agent: "validator", task: "Validate", state: "running" },
		],
		results: [],
		stopRequested: false,
	}));
	const theme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
	const lines = buildSubagentWidgetLines(runs, 28, theme, 3);
	assert.match(lines[0] ?? "", /SUBAGENTS · 6 active runs/);
	assert.match(lines.at(-1) ?? "", /\+3 more runs/);
	assert.match(buildSubagentWidgetLines(runs, 100, theme)[0] ?? "", /ctrl\+s inspect/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 28);
});

test("registers the reduced subagent tool and lifecycle hooks", () => {
	const harness = createHarness();
	registerSubagents(harness.pi);
	assert.equal(harness.tools.has("subagent"), true);
	assert.equal(harness.handlers.has("session_start"), true);
	assert.equal(harness.handlers.has("session_shutdown"), true);
	assert.equal(harness.commands.has("subagents"), true);
	assert.equal(harness.shortcuts.has("ctrl+s"), true);
	assert.equal(harness.shortcuts.has("alt+s"), false);
});

test("inspector refuses non-TUI modes and empty sessions without opening", async () => {
	const harness = createHarness();
	registerSubagents(harness.pi);
	const command = harness.commands.get("subagents") as {
		handler: (args: string, ctx: unknown) => Promise<void>;
	};
	const notes: string[] = [];
	let opened = false;
	const ui = {
		notify: (message: string) => notes.push(message),
		custom: async () => {
			opened = true;
		},
	};
	await command.handler("", { mode: "rpc", ui });
	await command.handler("", { mode: "tui", ui });
	assert.equal(opened, false);
	assert.match(notes[0] ?? "", /only available in the interactive TUI/);
	assert.match(notes[1] ?? "", /No subagent runs/);
});

test("list action exposes the neutral builtin agents", async () => {
	const harness = createHarness();
	registerSubagents(harness.pi);
	const tool = harness.tools.get("subagent") as {
		execute: (
			...args: unknown[]
		) => Promise<{ content: Array<{ text: string }> }>;
	};
	const result = await tool.execute(
		"tool-1",
		{ action: "list" },
		undefined,
		undefined,
		{
			cwd: process.cwd(),
			isProjectTrusted: () => true,
			ui: { setWidget() {} },
			sessionManager: { getSessionFile: () => undefined },
		},
	);
	assert.match(result.content[0].text, /reviewer/);
	assert.match(result.content[0].text, /worker/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "timed out waiting for child completion");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

for (const shutdown of [false, true]) {
	test(`overlay recovery ${shutdown ? "does not leak completion after session replacement" : "continues after closing and delivers one parent follow-up"}`, async (t) => {
		clearRuns();
		const base = join(process.cwd(), ".pi-subagents");
		mkdirSync(base, { recursive: true });
		const runsBaseDir = mkdtempSync(join(base, "index-test-"));
		const harness = createHarness();
		registerSubagents(harness.pi, { runner: {
			piBinary: process.execPath,
			piArgsPrefix: [join(process.cwd(), "subagents/test-fixture-child.mjs")],
			runsBaseDir, maxAttempts: 1,
		} });
		let component: SubagentInspector | undefined;
		const notes: string[] = [];
		const ctx = {
			mode: "tui", hasUI: true, cwd: process.cwd(),
			model: { provider: "anthropic", id: "original-model" },
			isProjectTrusted: () => true,
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				setWidget() {}, notify: (text: string) => notes.push(text),
				custom: (factory: (...args: any[]) => SubagentInspector) => new Promise<void>((resolve) => {
					component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_role: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
				}),
			},
		};
		t.after(() => {
			component?.close();
			for (const handler of harness.handlers.get("session_shutdown") ?? []) handler({}, ctx);
			clearRuns();
			rmSync(runsBaseDir, { recursive: true, force: true });
		});
		const tool = harness.tools.get("subagent") as { execute: (...args: unknown[]) => Promise<{ details: { run: Record<string, unknown> } }> };
		const result = await tool.execute("first", { agent: "reviewer", task: "quota-once review" }, undefined, undefined, ctx);
		assert.equal(result.details.run.state, "failed");
		const command = harness.commands.get("subagents") as { handler: (args: string, ctx: unknown) => Promise<void> };
		const overlay = command.handler("", ctx);
		assert.ok(component);
		assert.match(component.render(100).join("\n"), /MODEL · anthropic\/original-model/);
		component.handleInput("r");
		component.handleInput("r");
		const continuation = listRuns().find((run) => run.resumedFrom);
		assert.ok(continuation);
		assert.equal(listRuns().length, 2);
		assert.equal(component.selectedKey, `${continuation.id}:0`);
		component.close();
		await overlay;
		if (shutdown) {
			for (const handler of harness.handlers.get("session_shutdown") ?? []) handler({}, ctx);
			for (const handler of harness.handlers.get("session_start") ?? []) handler({}, ctx);
		}
		await waitFor(() => continuation.results.length === 1);
		// Completion notifications are scheduled immediately after run finalization.
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(harness.messages.length, shutdown ? 0 : 1);
		assert.deepEqual(notes, []);
		if (!shutdown) {
			const delivered = harness.messages[0];
			assert.equal(delivered.message.customType, "aio-subagent-complete");
			assert.match(String(delivered.message.content), /Resumed child #1/);
			assert.deepEqual(delivered.options, { deliverAs: "followUp", triggerTurn: true });
			assert.doesNotMatch(JSON.stringify(delivered.message.details), /transcript|systemPrompt|childLaunches/);
		}
	});
}
