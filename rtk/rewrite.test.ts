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

beforeEach(() => resetRtkState());
afterEach(() => resetRtkState());

test("RTK routing is always enabled", () => {
	assert.equal(isRtkEnabled(), true);
	setRtkEnabled(false);
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

test("rewriteAgentBashCommand enforces routing and strips bypass prefixes", async () => {
	const commands: string[] = [];
	const pi = {
		async exec(_binary: string, args: string[]) {
			commands.push(args[1] ?? "");
			return { stdout: "rewritten", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;

	setRtkEnabled(false);
	process.env.RTK_DISABLED = "1";
	assert.equal(await rewriteAgentBashCommand(pi, "git status"), "rewritten");
	assert.equal(process.env.RTK_DISABLED, undefined);
	assert.equal(await rewriteAgentBashCommand(pi, "rtk git status"), undefined);
	assert.equal(
		await rewriteAgentBashCommand(pi, "RTK_DISABLED=1 git status"),
		"rewritten",
	);
	assert.equal(
		await rewriteAgentBashCommand(
			pi,
			"FOO=1 RTK_DISABLED=1 git status && env RTK_DISABLED=1 ls",
		),
		"rewritten",
	);
	assert.deepEqual(commands, [
		"git status",
		"git status",
		"FOO=1 git status && ls",
	]);
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

test("buildRtkUserBashResult cannot be disabled or bypassed", () => {
	const seen: string[] = [];
	setRtkRewriteFn((command) => {
		seen.push(command);
		return `rtk:${command}`;
	});
	setRtkEnabled(false);
	assert.ok(buildRtkUserBashResult("git status", fakeOperations({})));
	assert.ok(
		buildRtkUserBashResult("RTK_DISABLED=1 git status", fakeOperations({})),
	);
	assert.deepEqual(seen, ["git status", "git status"]);
});
