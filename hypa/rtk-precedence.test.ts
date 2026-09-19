/**
 * aio-hypa rtk precedence — regression tests for the aio composition rule:
 * hypa's bash rewrite never double-wraps commands rtk claimed (`rtk ...`).
 * The upstream ported suites cover upstream behavior; this file covers the
 * local integration change only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import registerHypa, { isRtkClaimedCommand } from "./index.js";

// ---------------------------------------------------------------------------
// isRtkClaimedCommand
// ---------------------------------------------------------------------------

test("isRtkClaimedCommand matches rtk-prefixed commands", () => {
	assert.equal(isRtkClaimedCommand("rtk ls"), true);
	assert.equal(isRtkClaimedCommand("rtk"), true);
	assert.equal(isRtkClaimedCommand("   rtk ls -la"), true);
});

test("isRtkClaimedCommand leaves non-rtk commands alone", () => {
	assert.equal(isRtkClaimedCommand("rtkx ls"), false);
	assert.equal(isRtkClaimedCommand("ls"), false);
	assert.equal(isRtkClaimedCommand("echo rtk"), false);
	assert.equal(isRtkClaimedCommand(""), false);
});

// ---------------------------------------------------------------------------
// tool_call dispatch through a fake ExtensionAPI
// ---------------------------------------------------------------------------

interface FakeExecCall {
	command: string;
	args: string[];
}

interface FakeEvent {
	toolName: string;
	input: { command: string; timeout?: unknown };
}

function createFakePi(options: { stdout?: string; killed?: boolean } = {}) {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const registeredTools: string[] = [];
	const execCalls: FakeExecCall[] = [];
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(definition: Record<string, unknown>) {
			if (typeof definition.name === "string") registeredTools.push(definition.name);
		},
		registerCommand() {},
		getActiveTools(): string[] {
			return [];
		},
		setActiveTools(_names: string[]) {},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			return { stdout: options.stdout ?? "", stderr: "", code: 0, killed: options.killed ?? false };
		},
	};
	return {
		pi: pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
		handlers,
		registeredTools,
		execCalls,
	};
}

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
	const keys = Object.keys(env);
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	const restore = () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		const result = fn();
		if (result instanceof Promise) return result.finally(restore);
		restore();
		return result;
	} catch (err) {
		restore();
		throw err;
	}
}

const ADDITIVE_TEST_ENV = {
	HYPA_PI_MODE: "additive",
	HYPA_PI_CONFIG: "none",
	HYPA_PI_ENABLE_MCP_PROXY: "0",
	HYPA_BIN: "/tmp/hypa-test-bin",
} as const;

function toolCallHandlers(fake: ReturnType<typeof createFakePi>) {
	const list = fake.handlers.get("tool_call") ?? [];
	assert.equal(list.length >= 1, true, "expected a tool_call handler");
	return list;
}

async function dispatchToolCall(fake: ReturnType<typeof createFakePi>, event: FakeEvent) {
	// Handlers are async (the rewrite path awaits pi.exec); await each so
	// mutations land before assertions run.
	for (const handler of toolCallHandlers(fake)) {
		await handler(event, { signal: new AbortController().signal, hasUI: false });
	}
}

test("rtk-claimed commands are skipped without spawning hypa rewrite", async () => {
	await withEnv(ADDITIVE_TEST_ENV, async () => {
		const fake = createFakePi();
		registerHypa(fake.pi);

		// rtk registered its handler first and already rewrote `ls -la` to
		// `rtk ls -la`; hypa's handler must leave it alone.
		const event: FakeEvent = { toolName: "bash", input: { command: "rtk ls -la" } };
		await dispatchToolCall(fake, event);

		assert.deepEqual(fake.execCalls, [], "hypa rewrite must not spawn for rtk-claimed commands");
		assert.equal(event.input.command, "rtk ls -la");
	});
});

test("user-invoked bare rtk commands are also skipped", async () => {
	await withEnv(ADDITIVE_TEST_ENV, async () => {
		const fake = createFakePi();
		registerHypa(fake.pi);

		const event: FakeEvent = { toolName: "bash", input: { command: "rtk" } };
		await dispatchToolCall(fake, event);

		assert.deepEqual(fake.execCalls, []);
		assert.equal(event.input.command, "rtk");
	});
});

test("commands rtk declined are still rewritten and qualified by hypa", async () => {
	await withEnv(ADDITIVE_TEST_ENV, async () => {
		const fake = createFakePi({
			stdout: JSON.stringify({
				input: "curl -s example.com",
				outcome: "GenericWrapper",
				command: 'hypa -c "curl -s example.com"',
			}),
		});
		registerHypa(fake.pi);

		const event: FakeEvent = { toolName: "bash", input: { command: "curl -s example.com" } };
		await dispatchToolCall(fake, event);

		assert.deepEqual(fake.execCalls, [
			{ command: "/tmp/hypa-test-bin", args: ["rewrite", "--json", "curl -s example.com"] },
		]);
		// injectExecutionTimeout (no timeout) then qualify with the resolved binary.
		assert.equal(event.input.command, '/tmp/hypa-test-bin -c "curl -s example.com"');
	});
});

test("non-bash tool calls never reach the hypa rewrite", async () => {
	await withEnv(ADDITIVE_TEST_ENV, async () => {
		const fake = createFakePi();
		registerHypa(fake.pi);

		const event = { toolName: "read", input: { path: "notes.txt" } };
		for (const handler of toolCallHandlers(fake)) {
			await handler(event, { signal: new AbortController().signal, hasUI: false });
		}

		assert.deepEqual(fake.execCalls, []);
	});
});

test("hypa tools stay registered so the additive tools coexist with builtins", () => {
	withEnv(ADDITIVE_TEST_ENV, () => {
		const fake = createFakePi();
		registerHypa(fake.pi);

		for (const name of ["hypa_shell", "hypa_read", "hypa_grep", "hypa_find", "hypa_ls"]) {
			assert.equal(fake.registeredTools.includes(name), true, `expected ${name}`);
		}
	});
});
