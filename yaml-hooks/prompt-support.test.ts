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
