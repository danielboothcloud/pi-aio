import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "./index.ts";

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
