import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPrettyTools from "./index.ts";
import { renderGrepResults, renderTree } from "./render.ts";
import type { ComponentLike, PiPrettyDeps, SdkToolDef, ThemeLike } from "./types.ts";

class FakeText implements ComponentLike {
	value = "";

	constructor(text = "") {
		this.value = text;
	}

	setText(value: string): void {
		this.value = value;
	}

	render(): string[] {
		return this.value.split("\n");
	}
}

const theme: ThemeLike = {
	fg: (_key, text) => text,
	bold: (text) => text,
};

function sdkTool(name: string): SdkToolDef {
	return {
		name,
		description: `${name} test tool`,
		parameters: {},
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

function createHarness() {
	const tools = new Map<string, Record<string, unknown>>();
	const commands = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const shortcuts = new Map<string, Record<string, unknown>>();
	const pi = {
		registerTool(tool: Record<string, unknown>) {
			tools.set(String(tool.name), tool);
		},
		registerCommand(name: string, command: Record<string, unknown>) {
			commands.set(name, command);
		},
		registerShortcut(name: string, shortcut: Record<string, unknown>) {
			shortcuts.set(name, shortcut);
		},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
	} as unknown as ExtensionAPI;
	const deps: PiPrettyDeps = {
		TextComponent: FakeText,
		sdk: {
			getAgentDir: () => "/tmp/aio-pretty-test",
			createReadToolDefinition: () => sdkTool("read"),
			createBashToolDefinition: () => sdkTool("bash"),
			createLsToolDefinition: () => sdkTool("ls"),
			createFindToolDefinition: () => sdkTool("find"),
			createGrepToolDefinition: () => sdkTool("grep"),
		},
	};
	return { commands, deps, handlers, pi, shortcuts, tools };
}

const originalDisabledTools = process.env.PRETTY_DISABLE_TOOLS;

afterEach(() => {
	if (originalDisabledTools === undefined) delete process.env.PRETTY_DISABLE_TOOLS;
	else process.env.PRETTY_DISABLE_TOOLS = originalDisabledTools;
});

test("registers all five pretty built-in tools and FFF maintenance commands", async () => {
	delete process.env.PRETTY_DISABLE_TOOLS;
	const harness = createHarness();
	await registerPrettyTools(harness.pi, harness.deps);

	assert.deepEqual([...harness.tools.keys()], ["read", "bash", "ls", "find", "grep"]);
	assert.deepEqual([...harness.commands.keys()], ["fff-health", "fff-rescan"]);
	assert.deepEqual([...harness.shortcuts.keys()], ["ctrl+shift+o"]);
	assert.equal(harness.handlers.has("session_start"), true);
});

test("PRETTY_DISABLE_TOOLS leaves selected built-ins untouched", async () => {
	process.env.PRETTY_DISABLE_TOOLS = "ls,grep";
	const harness = createHarness();
	await registerPrettyTools(harness.pi, harness.deps);

	assert.deepEqual([...harness.tools.keys()], ["read", "bash", "find"]);
});

test("bash renderer includes a colored exit summary", async () => {
	const harness = createHarness();
	await registerPrettyTools(harness.pi, harness.deps);
	const bash = harness.tools.get("bash") as {
		renderResult: (
			result: Record<string, unknown>,
			options: Record<string, unknown>,
			theme: ThemeLike,
			context: Record<string, unknown>,
		) => FakeText;
	};
	const rendered = bash.renderResult(
		{
			content: [{ type: "text", text: "hello" }],
			details: { _type: "bashResult", text: "hello", exitCode: 0, command: "echo hello" },
		},
		{},
		theme,
		{ expanded: false, isError: false, state: {} },
	);

	assert.match(rendered.value, /exit 0/);
	assert.match(rendered.value, /1 lines/);
});

test("grep rendering groups files, shows line numbers, and highlights matches", () => {
	const rendered = renderGrepResults("src/a.ts:12:const hello = true\nsrc/a.ts:18:hello()", "hello");

	assert.match(rendered, /src\/a\.ts/);
	assert.match(rendered, /12/);
	assert.match(rendered, /\u001b\[38;2;220;180;80m/);
});

test("ls rendering uses tree connectors and Nerd Font file icons", () => {
	const rendered = renderTree("src/\nindex.ts", ".");

	assert.match(rendered, /├──/);
	assert.match(rendered, /└──/);
	assert.match(rendered, /index\.ts/);
	assert.match(rendered, /\ue628/);
});
