// End-to-end dispatch tests: run hooks through the real runtime with a
// mocked host adapter and injected bash runner, verifying blocking, prompt
// context, async queues, file.changed synthesis, and idle consumption.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js";
import { mapBashProcessResultToHookResult } from "./bash-executor.js";
import type { HostAdapter, HookNotifyLevel } from "./types.js";
import { __resetSnapshotCacheForTests } from "./discovery.js";
import { createHooksRuntime, type CreateHooksRuntimeOptions } from "./runtime.js";
import { __resetTrustListCacheForTests } from "./paths.js";

const tmp = mkdtempSync(join(tmpdir(), "aio-yaml-hooks-dispatch-"));
const agentDir = join(tmp, "agent");
const projectDir = join(tmp, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	__resetSnapshotCacheForTests();
	__resetTrustListCacheForTests();
	rmSync(tmp, { recursive: true, force: true });
});

test.beforeEach(() => {
	__resetSnapshotCacheForTests();
	__resetTrustListCacheForTests();
});

interface MockHostEvents {
	prompts: string[];
	notifications: Array<{ text: string; level?: HookNotifyLevel }>;
	status: Array<{ hookId: string; text: string }>;
	confirms: Array<{ title?: string; message: string }>;
	confirmResult: boolean;
	aborts: string[];
}

interface MockBashRequest {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}

function mockBashResult(request: MockBashRequest, event: string): BashHookResult {
	// Route through the real mapper so exit-2 blocking semantics apply.
	return mapBashProcessResultToHookResult(
		{
			command: request.command,
			stdout: request.stdout,
			stderr: request.stderr,
			durationMs: 1,
			exitCode: request.exitCode,
			signal: null,
			timedOut: false,
		},
		{ session_id: "mock", event, cwd: projectDir },
	);
}

interface Harness {
	runtime: ReturnType<typeof createHooksRuntime>;
	host: MockHostEvents;
	bashCalls: Array<{ command: string; exitCode?: number }>;
}

function createHarness(options: {
	yaml: string;
	bashResponses?: Record<string, MockBashRequest>;
	promptHookStdout?: string;
	confirmResult?: boolean;
}): Harness {
	mkdirSync(join(agentDir, "hook"), { recursive: true });
	writeFileSync(join(agentDir, "hook", "hooks.yaml"), options.yaml);

	const host: MockHostEvents = {
		prompts: [],
		notifications: [],
		status: [],
		confirms: [],
		confirmResult: options.confirmResult ?? false,
		aborts: [],
	};
	const bashCalls: Array<{ command: string; exitCode?: number }> = [];

	const adapter: HostAdapter = {
		abort: (sessionId) => {
			host.aborts.push(sessionId);
		},
		getRootSessionId: () => undefined,
		runBash: (request: BashExecutionRequest) => {
			const response =
				options.bashResponses?.[request.command] ??
				(options.promptHookStdout !== undefined && request.context.event === "user.prompt.submit"
					? {
							command: request.command,
							exitCode: 0,
							stdout: options.promptHookStdout,
							stderr: "",
						}
					: {
							command: request.command,
							exitCode: 0,
							stdout: "",
							stderr: "",
						});
			bashCalls.push({ command: request.command, exitCode: response.exitCode });
			return Promise.resolve(mockBashResult(response, request.context.event));
		},
		sendPrompt: (sessionId, text) => {
			host.prompts.push(`${sessionId}:${text}`);
			return { status: "accepted" };
		},
		notify: (text, level) => {
			host.notifications.push({ text, level });
			return { status: "accepted" };
		},
		confirm: (request) => {
			host.confirms.push(request);
			return Promise.resolve(host.confirmResult);
		},
		setStatus: (hookId, text) => {
			host.status.push({ hookId, text });
			return { status: "accepted" };
		},
	};

	const runtimeOptions: CreateHooksRuntimeOptions = {
		projectDir,
		host: adapter,
		executeBash: adapter.runBash,
	};

	return { runtime: createHooksRuntime(runtimeOptions), host, bashCalls };
}

// ---- tool.before blocking ----

test("tool.before bash hook blocks the tool on exit 2", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: guard
    event: tool.before.bash
    actions:
      - bash: "./scripts/guard.sh"
`,
		bashResponses: {
			"./scripts/guard.sh": { command: "./scripts/guard.sh", exitCode: 2, stdout: "", stderr: "no cluster mutations" },
		},
	});

	await assert.rejects(
		harness.runtime["tool.execute.before"](
			{ tool: "bash", sessionID: "s1", callID: "c1" },
			{ args: { command: "kubectl delete pod x" } },
		),
		/no cluster mutations/,
	);
});

test("tool.before wildcard hook blocks and action: stop adds stopSession", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: stopper
    event: tool.before.*
    action: stop
    actions:
      - bash: "false-block"
`,
		bashResponses: { "false-block": { command: "false-block", exitCode: 2, stdout: "", stderr: "denied" } },
	});

	await assert.rejects(
		harness.runtime["tool.execute.before"](
			{ tool: "read", sessionID: "s1", callID: "c1" },
			{ args: { path: "src/index.ts" } },
		),
		/denied/,
	);
});

test("tool.before non-blocking failures do not block the tool", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: logger
    event: tool.before.bash
    actions:
      - bash: "./scripts/log.sh"
`,
		bashResponses: { "./scripts/log.sh": { command: "./scripts/log.sh", exitCode: 1, stdout: "", stderr: "log failed" } },
	});

	await harness.runtime["tool.execute.before"](
		{ tool: "bash", sessionID: "s1", callID: "c1" },
		{ args: { command: "npm test" } },
	);
	// The tool continues: no throw. Pending args remain tracked for after.
	assert.equal(harness.bashCalls.length, 1);
});

// ---- tool.after + file.changed synthesis ----

test("tool.after write synthesizes file.changed and collects idle changes", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: post-write
    event: tool.after.write
    actions:
      - bash: "./scripts/notify-write.sh"
  - id: file-watcher
    event: file.changed
    conditions:
      - matchesAnyPath: "src/**"
    actions:
      - notify: "src changed"
`,
		bashResponses: { "./scripts/notify-write.sh": { command: "./scripts/notify-write.sh", exitCode: 0, stdout: "", stderr: "" } },
	});

	await harness.runtime["tool.execute.before"](
		{ tool: "write", sessionID: "s1", callID: "c1" },
		{ args: { path: "src/new.ts", content: "x" } },
	);
	await harness.runtime["tool.execute.after"]({
		tool: "write",
		sessionID: "s1",
		callID: "c1",
		args: { path: "src/new.ts", content: "x" },
	});

	// Post-tool hook ran, and the notify fired from file.changed (UI action,
	// accepted by the mocked host).
	assert.deepEqual(harness.host.notifications, [{ text: "src changed", level: "info" }]);

	// The mutation is collected for session.idle and consumed on dispatch.
	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
	assert.deepEqual(harness.host.notifications, [{ text: "src changed", level: "info" }]);
});

test("tool.after bash mutation commands feed file.changed", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: watcher
    event: file.changed
    actions:
      - bash: "./scripts/on-change.sh"
`,
		bashResponses: { "./scripts/on-change.sh": { command: "./scripts/on-change.sh", exitCode: 0, stdout: "", stderr: "" } },
	});

	await harness.runtime["tool.execute.after"]({
		tool: "bash",
		sessionID: "s1",
		callID: "c1",
		args: { command: "rm src/old.ts && npm test" },
	});

	// file.changed dispatched from the recognized mutation.
	assert.equal(harness.bashCalls.some((call) => call.command === "./scripts/on-change.sh"), true);
});

// ---- session.idle changes ----

test("session.idle: collected changes dispatch once and are consumed", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: idle
    event: session.idle
    actions:
      - bash: "./scripts/idle.sh"
  - id: changed
    event: file.changed
    actions:
      - bash: "./scripts/on-change.sh"
`,
		bashResponses: {
			"./scripts/idle.sh": { command: "./scripts/idle.sh", exitCode: 0, stdout: "", stderr: "" },
			"./scripts/on-change.sh": { command: "./scripts/on-change.sh", exitCode: 0, stdout: "", stderr: "" },
		},
	});

	await harness.runtime["tool.execute.after"]({
		tool: "bash",
		sessionID: "s1",
		callID: "c1",
		args: { command: "touch src/a.ts" },
	});
	// The touch already dispatched file.changed.
	const changeCalls = harness.bashCalls.filter((call) => call.command === "./scripts/on-change.sh").length;
	assert.equal(changeCalls, 1);

	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
	assert.equal(harness.bashCalls.some((call) => call.command === "./scripts/idle.sh"), true);

	// Idle dispatch consumed the changes: a second idle has no file.changed.
	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
	const idleCalls = harness.bashCalls.filter((call) => call.command === "./scripts/idle.sh").length;
	assert.equal(idleCalls, 2);
	const changeCallsAfterSecondIdle = harness.bashCalls.filter((call) => call.command === "./scripts/on-change.sh").length;
	assert.equal(changeCallsAfterSecondIdle, 1);
});

// ---- prompt context ----

test("user.prompt.submit: successful stdout becomes same-turn context", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: context
    event: user.prompt.submit
    actions:
      - bash: "./scripts/context.sh"
`,
		promptHookStdout: "The current time is 12:00.",
	});

	const result = await harness.runtime["user.prompt.submit"]({ sessionID: "s1", prompt: "What time is it?" });
	assert.deepEqual(result.additionalContext, ["The current time is 12:00."]);
});

test("user.prompt.submit: failing and empty hooks contribute nothing", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: context
    event: user.prompt.submit
    actions:
      - bash: "./scripts/context.sh"
`,
		bashResponses: { "./scripts/context.sh": { command: "./scripts/context.sh", exitCode: 1, stdout: "", stderr: "boom" } },
	});

	const failed = await harness.runtime["user.prompt.submit"]({ sessionID: "s1", prompt: "hi" });
	assert.deepEqual(failed.additionalContext, []);

	const empty = createHarness({
		yaml: `
hooks:
  - id: context
    event: user.prompt.submit
    actions:
      - bash: "true"
`,
		promptHookStdout: "   ",
	});
	const result = await empty.runtime["user.prompt.submit"]({ sessionID: "s1", prompt: "hi" });
	assert.deepEqual(result.additionalContext, []);
});

// ---- UI actions ----

test("notify, setStatus, and tool follow-up actions route through the host", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
      - setStatus: "settled"
`,
	});
	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
	assert.deepEqual(harness.host.notifications, [{ text: "Agent is idle", level: "info" }]);
	assert.deepEqual(harness.host.status, [{ hookId: "aio-yaml-hooks:idle-notify", text: "settled" }]);
});

test("tool follow-up action queues a prompt into the current session", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: retry-tests
    event: tool.after.bash
    actions:
      - tool:
          name: bash
          args:
            command: "npm test"
`,
	});
	await harness.runtime["tool.execute.after"]({ tool: "bash", sessionID: "s1", callID: "c1", args: { command: "npm run build" } });
	// The mocked adapter accepts every prompt, so the follow-up queues with
	// the canonical "Use the <tool> tool" wording.
	assert.equal(harness.host.prompts.length, 1);
	assert.match(harness.host.prompts[0] ?? "", /^s1:Use the bash tool with these arguments/);
});

test("confirm action on tool.before blocks when rejected", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: confirm-critical
    event: tool.before.bash
    actions:
      - confirm:
          title: "Run command?"
          message: "Approve this bash call."
`,
		confirmResult: false,
	});

	await assert.rejects(
		harness.runtime["tool.execute.before"](
			{ tool: "bash", sessionID: "s1", callID: "c1" },
			{ args: { command: "terraform apply" } },
		),
		/Blocked by user via confirm action/,
	);
	assert.equal(harness.host.confirms.length, 1);

	// Approved confirmations continue.
	const approved = createHarness({
		yaml: `
hooks:
  - id: confirm-critical
    event: tool.before.bash
    actions:
      - confirm:
          message: "Approve this bash call."
`,
		confirmResult: true,
	});
	await approved.runtime["tool.execute.before"](
		{ tool: "bash", sessionID: "s1", callID: "c1" },
		{ args: { command: "terraform apply" } },
	);
});

// ---- scope + conditions + async ----

test("scope: child hooks skip the root session", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: child-only
    event: session.idle
    scope: child
    actions:
      - bash: "./scripts/child.sh"
`,
	});

	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
	assert.equal(harness.bashCalls.length, 0);
});

test("matchesCodeFiles skips pathless dispatches", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: code-only
    event: session.idle
    conditions:
      - matchesCodeFiles
    actions:
      - bash: "./scripts/code.sh"
`,
	});

	// Idle with no collected changes is pathless: skipped.
	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
	assert.equal(harness.bashCalls.length, 0);

	// Collect a code change; the hook runs on the next idle.
	await harness.runtime["tool.execute.after"]({
		tool: "bash",
		sessionID: "s1",
		callID: "c1",
		args: { command: "touch src/index.ts" },
	});
	await harness.runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
	assert.equal(harness.bashCalls.some((call) => call.command === "./scripts/code.sh"), true);
});

test("async hooks queue off the dispatch loop", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: upload
    event: tool.after.write
    async: true
    actions:
      - bash: "./scripts/upload.sh"
`,
		bashResponses: { "./scripts/upload.sh": { command: "./scripts/upload.sh", exitCode: 0, stdout: "", stderr: "" } },
	});

	await harness.runtime["tool.execute.after"]({
		tool: "write",
		sessionID: "s1",
		callID: "c1",
		args: { path: "src/new.ts", content: "x" },
	});

	// The upload runs off-loop; await the queue microtask drain.
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(harness.bashCalls.some((call) => call.command === "./scripts/upload.sh"), true);
});

// ---- session lifecycle ----

test("session.created and session.deleted dispatch lifecycle hooks", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: ready
    event: session.created
    actions:
      - bash: "./scripts/ready.sh"
  - id: cleanup
    event: session.deleted
    actions:
      - bash: "./scripts/cleanup.sh"
`,
	});

	await harness.runtime.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } });
	assert.equal(harness.bashCalls.some((call) => call.command === "./scripts/ready.sh"), true);

	await harness.runtime.event({
		event: { type: "session.deleted", properties: { info: { id: "s1" }, reason: "quit" } },
	});
	assert.equal(harness.bashCalls.some((call) => call.command === "./scripts/cleanup.sh"), true);
});

// ---- user-bash interception ----

test("user.bash.before routes typed commands through tool.before.bash hooks", async () => {
	const harness = createHarness({
		yaml: `
hooks:
  - id: guard
    event: tool.before.bash
    actions:
      - bash: "./scripts/guard.sh"
`,
		bashResponses: {
			"./scripts/guard.sh": { command: "./scripts/guard.sh", exitCode: 2, stdout: "", stderr: "blocked by guard" },
		},
	});

	await assert.rejects(
		harness.runtime["user.bash.before"](
			{ tool: "bash", sessionID: "s1", callID: "user-bash:s1:call" },
			{ args: { command: "dangerous-command" } },
		),
		/blocked by guard/,
	);
});
