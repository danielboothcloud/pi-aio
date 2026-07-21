import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setPermissionModeAccess } from "../permission-modes/mode-access.js";
import { registerUserBash } from "./index.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<any>;

function makeHarness(options: { selections?: string[] } = {}) {
	const handlers = new Map<string, EventHandler[]>();
	const selectPrompts: string[] = [];
	const selections = [...(options.selections ?? [])];

	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		ui: {
			select: async (prompt: string) => {
				selectPrompts.push(prompt);
				return selections.shift();
			},
		},
	} as unknown as ExtensionContext;

	registerUserBash(pi);

	return {
		ctx,
		handlers,
		selectPrompts,
		async runUserBash(command: string) {
			const [handler] = handlers.get("user_bash") ?? [];
			assert.ok(handler, "user_bash handler missing");
			return handler(
				{ type: "user_bash", command, excludeFromContext: false, cwd: "/tmp" },
				ctx,
			);
		},
	};
}

test("user_bash allows read-only commands in plan mode", async () => {
	setPermissionModeAccess({
		getMode: () => "plan",
		setMode: async () => {},
	});

	const harness = makeHarness();
	const result = await harness.runUserBash("ls -la");
	assert.equal(result, undefined);
});

test("user_bash blocks mutating commands in ask mode", async () => {
	setPermissionModeAccess({
		getMode: () => "ask",
		setMode: async () => {},
	});

	const harness = makeHarness();
	const result = await harness.runUserBash("npm install");
	assert.equal(result?.result?.exitCode, 1);
	assert.match(String(result?.result?.output), /Ask mode/);
	assert.deepEqual(harness.selectPrompts, []);
});

test("user_bash blocks mutating commands in plan mode", async () => {
	setPermissionModeAccess({
		getMode: () => "plan",
		setMode: async () => {},
	});

	const harness = makeHarness();
	const result = await harness.runUserBash("rm -rf build/");
	assert.equal(result?.result?.exitCode, 1);
	assert.match(String(result?.result?.output), /Plan mode/);
});

test("user_bash prompts in default mode and blocks on deny", async () => {
	setPermissionModeAccess({
		getMode: () => "default",
		setMode: async () => {},
	});

	const harness = makeHarness({ selections: ["Block"] });
	const result = await harness.runUserBash("npm install");
	assert.equal(result?.result?.exitCode, 1);
	assert.match(String(result?.result?.output), /blocked by user/);
	assert.match(harness.selectPrompts[0], /Allow !bash/);
});

test("user_bash auto-approves in auto mode", async () => {
	setPermissionModeAccess({
		getMode: () => "auto",
		setMode: async () => {},
	});

	const harness = makeHarness();
	const result = await harness.runUserBash("npm install");
	assert.equal(result, undefined);
});
