import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeRegistry } from "./registry.js";
import { registerPromptSupport } from "./prompt-support.ts";

test("custom extension continuations never dispatch user-prompt hooks", async () => {
	let handler: (event: any, ctx: ExtensionContext) => unknown = () => assert.fail("missing handler");
	const pi = { on: (_event: string, callback: typeof handler) => { handler = callback; } } as unknown as ExtensionAPI;
	const registry = new Proxy({}, { get: () => assert.fail("custom runs must not touch prompt hooks") }) as RuntimeRegistry;
	registerPromptSupport(pi, registry);
	const result = await handler({ messageType: "custom", message: { customType: "continuation" }, systemPrompt: "system" }, {} as ExtensionContext);
	assert.equal(result, undefined);
});

test("real user prompts still reach submission hooks", async () => {
	const previous = process.env.PI_YAML_HOOKS_PROMPT_AWARENESS;
	try {
		process.env.PI_YAML_HOOKS_PROMPT_AWARENESS = "0";
		let handler: (event: any, ctx: ExtensionContext) => unknown = () => assert.fail("missing handler");
		const pi = { on: (_event: string, callback: typeof handler) => { handler = callback; } } as unknown as ExtensionAPI;
		const prompts: unknown[] = [];
		const registry = {
			rememberContext: () => {},
			getRuntimeFor: () => ({ "user.prompt.submit": async (input: unknown) => { prompts.push(input); return { additionalContext: ["hook context"] }; } }),
		} as unknown as RuntimeRegistry;
		registerPromptSupport(pi, registry);
		const result = await handler({ messageType: "user", prompt: "hello", systemPrompt: "system" }, {
			cwd: process.cwd(), sessionManager: { getSessionId: () => "test-session" },
		} as unknown as ExtensionContext);
		assert.deepEqual(prompts, [{ sessionID: "test-session", prompt: "hello" }]);
		assert.match((result as { systemPrompt: string }).systemPrompt, /hook context/);
	} finally {
		if (previous === undefined) delete process.env.PI_YAML_HOOKS_PROMPT_AWARENESS;
		else process.env.PI_YAML_HOOKS_PROMPT_AWARENESS = previous;
	}
});

test("the awareness note is only sent when hooks are loaded or a hook file has errors", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { buildHookAwarenessSystemPrompt } = await import("./prompt-support.ts");
	const agentDir = mkdtempSync(join(tmpdir(), "aio-hooks-note-"));
	const project = join(agentDir, "project");
	mkdirSync(project);
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, awareness: process.env.PI_YAML_HOOKS_PROMPT_AWARENESS };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_YAML_HOOKS_PROMPT_AWARENESS;
	try {
		assert.equal(buildHookAwarenessSystemPrompt({ cwd: project, hasUI: true }), undefined);
		writeFileSync(join(agentDir, "hooks.yaml"), "this: [is not valid hooks\n");
		assert.match(buildHookAwarenessSystemPrompt({ cwd: project, hasUI: true }) ?? "", /validation issue/);
	} finally {
		if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved.dir;
		if (saved.awareness !== undefined) process.env.PI_YAML_HOOKS_PROMPT_AWARENESS = saved.awareness;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
