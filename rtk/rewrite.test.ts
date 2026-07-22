import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	buildRtkUserBashResult,
	isRtkEnabled,
	resetRtkState,
	rtkSpawnHook,
	setRtkEnabled,
	setRtkRewriteFn,
} from "./rewrite.ts";

beforeEach(() => resetRtkState());
afterEach(() => resetRtkState());

test("session toggle defaults to enabled", () => {
	assert.equal(isRtkEnabled(), true);
});

test("setRtkEnabled flips the toggle", () => {
	setRtkEnabled(false);
	assert.equal(isRtkEnabled(), false);
	setRtkEnabled(true);
	assert.equal(isRtkEnabled(), true);
});

test("rtkSpawnHook rewrites the command when enabled and rewrite succeeds", () => {
	setRtkRewriteFn(() => "rtk-rewritten-command");
	const out = rtkSpawnHook({ command: "git status", cwd: "/repo", env: {} });
	assert.deepEqual(out, {
		command: "rtk-rewritten-command",
		cwd: "/repo",
		env: {},
	});
});

test("rtkSpawnHook preserves the command when rewrite has no equivalent", () => {
	setRtkRewriteFn(() => undefined);
	const out = rtkSpawnHook({ command: "git status", cwd: "/repo", env: {} });
	assert.deepEqual(out, { command: "git status", cwd: "/repo", env: {} });
});

test("rtkSpawnHook preserves the command when the session toggle is disabled", () => {
	setRtkEnabled(false);
	setRtkRewriteFn(() => "should-not-be-used");
	const out = rtkSpawnHook({ command: "git status", cwd: "/repo", env: {} });
	assert.deepEqual(out, { command: "git status", cwd: "/repo", env: {} });
});

test("rtkSpawnHook preserves cwd and env alongside the rewritten command", () => {
	const env = { FOO: "bar" };
	setRtkRewriteFn((cmd) => `echo rewritten:${cmd}`);
	const out = rtkSpawnHook({ command: "ls", cwd: "/cwd", env });
	assert.equal(out.command, "echo rewritten:ls");
	assert.equal(out.cwd, "/cwd");
	assert.equal(out.env, env);
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

test("buildRtkUserBashResult returns undefined when rewrite has no equivalent", () => {
	setRtkRewriteFn(() => undefined);
	const result = buildRtkUserBashResult("git status", fakeOperations({}));
	assert.equal(result, undefined);
});

test("buildRtkUserBashResult returns undefined when the session toggle is disabled", () => {
	setRtkEnabled(false);
	setRtkRewriteFn(() => "rtk-rewritten");
	const result = buildRtkUserBashResult("git status", fakeOperations({}));
	assert.equal(result, undefined);
});
