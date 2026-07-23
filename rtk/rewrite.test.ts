import assert from "node:assert/strict";
import type {
	BashOperations,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "node:test";
import {
	buildRtkUserBashResult,
	isRtkEnabled,
	resetRtkState,
	rewriteAgentBashCommand,
	setRtkEnabled,
	setRtkRewriteFn,
} from "./rewrite.ts";

const originalRtkDisabled = process.env.RTK_DISABLED;

beforeEach(() => {
	resetRtkState();
	delete process.env.RTK_DISABLED;
});
afterEach(() => {
	resetRtkState();
	if (originalRtkDisabled === undefined) delete process.env.RTK_DISABLED;
	else process.env.RTK_DISABLED = originalRtkDisabled;
});

test("session toggle defaults to enabled", () => {
	assert.equal(isRtkEnabled(), true);
});

test("setRtkEnabled flips the toggle", () => {
	setRtkEnabled(false);
	assert.equal(isRtkEnabled(), false);
	setRtkEnabled(true);
	assert.equal(isRtkEnabled(), true);
});

function fakePi(
	result: {
		stdout?: string;
		stderr?: string;
		code?: number;
		killed?: boolean;
	},
	capture: { command?: string; args?: string[]; timeout?: number } = {},
): ExtensionAPI {
	return {
		async exec(
			command: string,
			args: string[],
			options?: { timeout?: number },
		) {
			capture.command = command;
			capture.args = args;
			capture.timeout = options?.timeout;
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.code ?? 0,
				killed: result.killed ?? false,
			};
		},
	} as unknown as ExtensionAPI;
}

test("rewriteAgentBashCommand delegates asynchronously through pi.exec", async () => {
	const captured: { command?: string; args?: string[]; timeout?: number } = {};
	const rewritten = await rewriteAgentBashCommand(
		fakePi({ stdout: "rtk git status\n" }, captured),
		"git status",
	);

	assert.equal(rewritten, "rtk git status");
	assert.equal(captured.command, "rtk");
	assert.deepEqual(captured.args, ["rewrite", "git status"]);
	assert.equal(captured.timeout, 2_000);
});

test("rewriteAgentBashCommand accepts advisory exit code 3", async () => {
	const rewritten = await rewriteAgentBashCommand(
		fakePi({ stdout: "rtk grep foo .\n", code: 3 }),
		"grep foo .",
	);
	assert.equal(rewritten, "rtk grep foo .");
});

test("rewriteAgentBashCommand falls through on no-equivalent or killed execution", async () => {
	assert.equal(
		await rewriteAgentBashCommand(
			fakePi({ stdout: "ignored", code: 1 }),
			"custom-command",
		),
		undefined,
	);
	assert.equal(
		await rewriteAgentBashCommand(
			fakePi({ stdout: "ignored", killed: true }),
			"git status",
		),
		undefined,
	);
});

test("rewriteAgentBashCommand skips disabled, bypassed, and already rewritten commands", async () => {
	let calls = 0;
	const pi = {
		async exec() {
			calls++;
			return { stdout: "rewritten", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;

	setRtkEnabled(false);
	assert.equal(await rewriteAgentBashCommand(pi, "git status"), undefined);
	setRtkEnabled(true);
	assert.equal(await rewriteAgentBashCommand(pi, "rtk git status"), undefined);
	assert.equal(
		await rewriteAgentBashCommand(pi, "RTK_DISABLED=1 git status"),
		undefined,
	);
	process.env.RTK_DISABLED = "1";
	assert.equal(await rewriteAgentBashCommand(pi, "git status"), undefined);
	assert.equal(calls, 0);
});

test("rewriteAgentBashCommand supports the injected rewrite seam", async () => {
	setRtkRewriteFn((command) => `rtk-test:${command}`);
	const rewritten = await rewriteAgentBashCommand(
		fakePi({ stdout: "should not run" }),
		"ls",
	);
	assert.equal(rewritten, "rtk-test:ls");
});

function fakeOperations(capture: { cmd?: string }): BashOperations {
	return {
		exec: async (command) => {
			capture.cmd = command;
			return { exitCode: 0 };
		},
	};
}

test("buildRtkUserBashResult returns operations that execute the rewritten command", async () => {
	setRtkRewriteFn(() => "rtk-rewritten");
	const captured: { cmd?: string } = {};
	const result = buildRtkUserBashResult("git status", fakeOperations(captured));

	assert.ok(result?.operations?.exec, "expected operations.exec to be defined");
	const res = await result!.operations!.exec("ignored-original", "/repo", {
		onData: () => {},
	});
	assert.equal(res.exitCode, 0);
	assert.equal(
		captured.cmd,
		"rtk-rewritten",
		"exec should receive the rewritten command",
	);
});

test("buildRtkUserBashResult falls through without an equivalent", () => {
	setRtkRewriteFn(() => undefined);
	const result = buildRtkUserBashResult("git status", fakeOperations({}));
	assert.equal(result, undefined);
});

test("buildRtkUserBashResult falls through when disabled or bypassed", () => {
	setRtkRewriteFn(() => "rtk-rewritten");
	setRtkEnabled(false);
	assert.equal(
		buildRtkUserBashResult("git status", fakeOperations({})),
		undefined,
	);
	setRtkEnabled(true);
	assert.equal(
		buildRtkUserBashResult("RTK_DISABLED=1 git status", fakeOperations({})),
		undefined,
	);
});
