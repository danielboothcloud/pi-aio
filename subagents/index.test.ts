import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSubagentWidgetLines, registerSubagents } from "./index.ts";
import type { SubagentRun } from "./types.ts";

function createHarness() {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
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
		sendMessage() {},
	} as unknown as ExtensionAPI;
	return { handlers, pi, tools };
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
	for (const line of lines) assert.ok(visibleWidth(line) <= 28);
});

test("registers the reduced subagent tool and lifecycle hooks", () => {
	const harness = createHarness();
	registerSubagents(harness.pi);
	assert.equal(harness.tools.has("subagent"), true);
	assert.equal(harness.handlers.has("session_start"), true);
	assert.equal(harness.handlers.has("session_shutdown"), true);
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
