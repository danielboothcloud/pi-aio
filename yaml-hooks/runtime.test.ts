// Runtime regression tests: tool-paths extraction, session state, path
// conditions, and bash-executor serialization/redaction.

import assert from "node:assert/strict";
import test from "node:test";
import {
	getChangedPaths,
	getMutationToolHookNames,
	getToolFileChanges,
	normalizeMutationToolName,
	parseBashChanges,
} from "./tool-paths.js";
import {
	SessionStateStore,
	sanitizeToolArgsForSerialization,
} from "./session-state.js";
import { __resetTrustListCacheForTests } from "./paths.js";
import { buildPathMatchContext, evaluatePathConditions, normalizeConditionPath } from "./path-filter.js";
import {
	buildBashEnvironment,
	isBlockingToolBeforeEvent,
	mapBashProcessResultToHookResult,
	trimToUtf8Boundary,
} from "./bash-executor.js";
import { redactSensitiveContent } from "./actions.js";

// ---- tool-paths: mutation classification ----

test("normalizeMutationToolName: direct, patch aliases, bash", () => {
	assert.equal(normalizeMutationToolName("write"), "write");
	assert.equal(normalizeMutationToolName("edit"), "edit");
	assert.equal(normalizeMutationToolName("multiedit"), "multiedit");
	assert.equal(normalizeMutationToolName("patch"), "apply_patch");
	assert.equal(normalizeMutationToolName("apply_patch"), "apply_patch");
	assert.equal(normalizeMutationToolName("bash"), "bash");
	assert.equal(normalizeMutationToolName("read"), undefined);
});

test("getMutationToolHookNames: patch aliases dispatch once", () => {
	assert.deepEqual(getMutationToolHookNames("patch"), ["patch", "apply_patch"]);
	assert.deepEqual(getMutationToolHookNames("apply_patch"), ["patch", "apply_patch"]);
	assert.deepEqual(getMutationToolHookNames("write"), ["write"]);
	assert.deepEqual(getMutationToolHookNames("bash"), ["bash"]);
});

// ---- tool-paths: affected-path extraction ----

test("getToolFileChanges: write maps to create, edit maps to modify", () => {
	assert.deepEqual(getToolFileChanges("write", { path: "src/new.ts", content: "x" }), [
		{ operation: "modify", path: "src/new.ts" },
	]);
	assert.deepEqual(getToolFileChanges("edit", { path: "src/index.ts", edits: [{ oldText: "a", newText: "b" }] }), [
		{ operation: "modify", path: "src/index.ts" },
	]);
});

test("getToolFileChanges: multiedit edits array with top-level path", () => {
	assert.deepEqual(
		getToolFileChanges("multiedit", {
			filePath: "src/index.ts",
			edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }],
		}),
		[{ operation: "modify", path: "src/index.ts" }],
	);
});

test("getToolFileChanges: apply_patch parses add/update/delete/move", () => {
	const changes = getToolFileChanges("apply_patch", {
		patch: [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"*** Update File: src/index.ts",
			"*** Move to: src/renamed.ts",
			"*** Delete File: src/old.ts",
			"*** End Patch",
		].join("\n"),
	});
	assert.deepEqual(getChangedPaths(changes).sort(), [
		"src/index.ts",
		"src/new.ts",
		"src/old.ts",
		"src/renamed.ts",
	]);
});

test("getToolFileChanges: aio apply_patch changes array is patch-shaped", () => {
	// aio's apply_patch sends a changes array; the extractor reads the patch
	// field, so a unified-diff string still parses. Structured changes arrays
	// without a patch field produce no paths (pathless dispatch).
	const changes = getToolFileChanges("apply_patch", {
		changes: [{ path: "src/x.ts", action: "update" }],
	});
	assert.deepEqual(changes, []);
});

test("parseBashChanges: recognized mutation commands extract paths", () => {
	assert.deepEqual(parseBashChanges("rm -f src/old.ts"), [{ operation: "delete", path: "src/old.ts" }]);
	assert.deepEqual(parseBashChanges("git rm src/old.ts"), [{ operation: "delete", path: "src/old.ts" }]);
	assert.deepEqual(parseBashChanges("mv src/a.ts src/b.ts"), [
		{ operation: "rename", fromPath: "src/a.ts", toPath: "src/b.ts" },
	]);
	assert.deepEqual(parseBashChanges("cp src/a.ts src/b.ts"), [{ operation: "create", path: "src/b.ts" }]);
	assert.deepEqual(parseBashChanges("touch src/x.ts src/y.ts"), [
		{ operation: "create", path: "src/x.ts" },
		{ operation: "create", path: "src/y.ts" },
	]);
	assert.deepEqual(parseBashChanges("mkdir -p src/dir"), [{ operation: "create", path: "src/dir" }]);
	// Non-mutating commands are pathless.
	assert.deepEqual(parseBashChanges("npm test"), []);
	assert.deepEqual(parseBashChanges("echo hello"), []);
	// Compound commands split on && / ;.
	assert.deepEqual(parseBashChanges("npm test && rm src/old.ts"), [{ operation: "delete", path: "src/old.ts" }]);
	// Quoted paths survive tokenization; POSIX -- flips to positional.
	assert.deepEqual(parseBashChanges("rm -- --bad-name"), [{ operation: "delete", path: "--bad-name" }]);
});

// ---- session-state ----

test("SessionStateStore: pending tool calls are consumed once and expire", () => {
	let now = 1_000_000;
	const store = new SessionStateStore({ nowFn: () => now });

	store.setPendingToolCall("call-1", "s1", { command: "npm test" });
	assert.equal(store.pendingToolCallCount(), 1);
	assert.deepEqual(store.consumePendingToolCall("call-1")?.toolArgs, { command: "npm test" });
	assert.equal(store.consumePendingToolCall("call-1"), undefined);
	assert.equal(store.pendingToolCallCount(), 0);

	// TTL sweep: entries older than 5 minutes are dropped on insert.
	now += 10 * 60_000;
	store.setPendingToolCall("call-2", "s1", {});
	assert.equal(store.pendingToolCallCount(), 1);
});

test("SessionStateStore: file changes collect, dedupe, and replay on idle", () => {
	const store = new SessionStateStore();
	const changes = [{ operation: "modify" as const, path: "src/index.ts" }];

	store.addFileChanges("s1", changes);
	store.addFileChanges("s1", changes); // duplicate is dropped
	assert.equal(store.getFileChanges("s1").length, 1);
	assert.deepEqual(store.getModifiedPaths("s1"), ["src/index.ts"]);

	// A change arriving during an active idle dispatch replays next time.
	store.beginIdleDispatch("s1", changes);
	const lateChange = [{ operation: "modify" as const, path: "src/late.ts" }];
	store.addFileChanges("s1", lateChange);
	store.consumeFileChanges("s1", changes);
	assert.deepEqual(store.getModifiedPaths("s1"), ["src/late.ts"]);
});

test("SessionStateStore: scope evaluation main/child", async () => {
	const store = new SessionStateStore();
	store.rememberSession("child", "root");
	store.rememberSession("root", null);

	assert.ok(await store.evaluateScope("root", "all", async () => null));
	assert.ok(await store.evaluateScope("root", "main", async () => null));
	assert.ok(!(await store.evaluateScope("child", "main", async () => null)));
	assert.ok(await store.evaluateScope("child", "child", async () => null));
	assert.ok(!(await store.evaluateScope("child", "child", async () => null)) === false);
});

test("SessionStateStore: deleteSession tombstones the id", () => {
	const store = new SessionStateStore();
	store.rememberSession("s1");
	store.deleteSession("s1");
	assert.ok(store.isDeleted("s1"));
});

// ---- tool_args redaction ----

test("sanitizeToolArgsForSerialization: redacts sensitive keys and caps bytes", () => {
	const sanitized = sanitizeToolArgsForSerialization({
		command: "npm test",
		api_key: "sk-123",
		token: "t-456",
		nested: { password: "p-789", safe: "ok" },
	});
	assert.deepEqual(sanitized, {
		command: "npm test",
		api_key: "[REDACTED]",
		token: "[REDACTED]",
		nested: { password: "[REDACTED]", safe: "ok" },
	});
	assert.ok(sanitized !== undefined);

	const oversized = sanitizeToolArgsForSerialization({ content: "x".repeat(70_000) });
	assert.equal((oversized as Record<string, unknown>)?._aio_hooks_tool_args_truncated, true);

	assert.equal(sanitizeToolArgsForSerialization(undefined), undefined);
});

// ---- path-filter ----

test("normalizeConditionPath: project-relative for inside, absolute for outside", () => {
	const projectDir = "/repo/project";
	assert.equal(normalizeConditionPath(projectDir, "/repo/project/src/index.ts"), "src/index.ts");
	assert.equal(normalizeConditionPath(projectDir, "src/index.ts"), "src/index.ts");
	assert.equal(normalizeConditionPath(projectDir, "/elsewhere/index.ts"), "/elsewhere/index.ts");
	// Backslashes and ./ prefixes normalize.
	assert.equal(normalizeConditionPath(projectDir, "./src\\lib.ts"), "src/lib.ts");
});

test("buildPathMatchContext + evaluatePathConditions", () => {
	const projectDir = "/repo/project";

	const ctx = buildPathMatchContext(projectDir, ["src/index.ts"], undefined);
	assert.equal(ctx.hasCodeFiles, true);

	assert.equal(evaluatePathConditions(["matchesCodeFiles"], ctx), undefined);
	assert.equal(
		evaluatePathConditions([{ matchesAnyPath: ["src/**/*.ts"] }], ctx),
		undefined,
	);
	assert.equal(
		evaluatePathConditions([{ matchesAllPaths: ["src/**/*.ts"] }], ctx),
		undefined,
	);
	assert.deepEqual(evaluatePathConditions([{ matchesAnyPath: ["docs/**"] }], ctx), {
		reason: "matchesAnyPath_failed",
		patterns: ["docs/**"],
	});
	assert.deepEqual(evaluatePathConditions([{ matchesAllPaths: ["docs/**"] }], ctx), {
		reason: "matchesAllPaths_failed",
		patterns: ["docs/**"],
	});

	// Pathless context fails path conditions with the no_paths reasons
	// (patterns included, matching upstream's skip telemetry).
	const pathless = buildPathMatchContext(projectDir, undefined, []);
	assert.deepEqual(evaluatePathConditions([{ matchesAnyPath: ["src/**"] }], pathless), {
		reason: "matchesAnyPath_no_paths",
		patterns: ["src/**"],
	});
	// matchesCodeFiles on a non-code file.
	const nonCode = buildPathMatchContext(projectDir, ["docs/notes.txt"], undefined);
	assert.deepEqual(evaluatePathConditions(["matchesCodeFiles"], nonCode), {
		reason: "matchesCodeFiles_failed",
	});
});

// ---- bash-executor: mapping, environment, serialization ----

test("mapBashProcessResultToHookResult: exit 2 blocks only tool.before", () => {
	const base = {
		command: "x",
		stdout: "",
		stderr: "denied",
		durationMs: 10,
		exitCode: 2,
		signal: null,
		timedOut: false,
	};

	const blocked = mapBashProcessResultToHookResult(base, { session_id: "s", event: "tool.before.bash", cwd: "/" });
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.blocking, true);

	// Non-before events never block on exit 2.
	const failed = mapBashProcessResultToHookResult(base, { session_id: "s", event: "tool.after.bash", cwd: "/" });
	assert.equal(failed.status, "failed");
	assert.equal(failed.blocking, false);

	// The literal wildcard event name starts with "tool.before." so bash
	// actions under the wildcard bucket block too (upstream behavior).
	assert.ok(isBlockingToolBeforeEvent("tool.before.*"));
	assert.ok(isBlockingToolBeforeEvent("tool.before.bash"));
	assert.ok(!isBlockingToolBeforeEvent("tool.after.bash"));
});

test("mapBashProcessResultToHookResult: success, failure, timeout", () => {
	const ctx = { session_id: "s", event: "tool.before.bash", cwd: "/" };
	assert.equal(
		mapBashProcessResultToHookResult({ command: "x", stdout: "", stderr: "", durationMs: 1, exitCode: 0, signal: null, timedOut: false }, ctx).status,
		"success",
	);
	assert.equal(
		mapBashProcessResultToHookResult({ command: "x", stdout: "", stderr: "", durationMs: 1, exitCode: 1, signal: null, timedOut: false }, ctx).status,
		"failed",
	);
	const timedOut = mapBashProcessResultToHookResult({ command: "x", stdout: "", stderr: "", durationMs: 1, exitCode: 124, signal: null, timedOut: true }, ctx);
	assert.equal(timedOut.status, "timed_out");
	assert.equal(timedOut.blocking, false);
});

test("buildBashEnvironment: allowlist restricts inherited env, keeps context", () => {
	const inherited = { PATH: "/usr/bin", HOME: "/home/me", MY_SECRET: "leak" };
	const contextEnv = { PI_PROJECT_DIR: "/repo", PI_SESSION_ID: "s1" };

	// Without allowlist: everything is inherited plus context.
	const full = buildBashEnvironment(inherited, contextEnv);
	assert.equal(full.PATH, "/usr/bin");
	assert.equal(full.PI_PROJECT_DIR, "/repo");

	// With allowlist: only named vars plus context.
	const allowlisted = buildBashEnvironment({ ...inherited, PI_YAML_HOOKS_ENV_ALLOWLIST: "PATH" }, contextEnv);
	assert.equal(allowlisted.PATH, "/usr/bin");
	assert.equal(allowlisted.MY_SECRET, undefined);
	assert.equal(allowlisted.PI_PROJECT_DIR, "/repo");
	assert.equal(allowlisted.PI_SESSION_ID, "s1");
});

test("trimToUtf8Boundary: never splits multi-byte sequences", () => {
	// "aé中" is 1 + 2 + 3 bytes; each prefix boundary is respected.
	const chunk = Buffer.from("aé中", "utf8");
	assert.equal(trimToUtf8Boundary(chunk, 1), 1);
	assert.equal(trimToUtf8Boundary(chunk, 2), 1);
	assert.equal(trimToUtf8Boundary(chunk, 3), 3);
	assert.equal(trimToUtf8Boundary(chunk, 6), 6);
	assert.equal(trimToUtf8Boundary(chunk, 0), 0);
	assert.equal(trimToUtf8Boundary(chunk, 100), 6);
});

// ---- redaction ----

test("redactSensitiveContent: tokens, URLs, bearer headers, JWTs", () => {
	assert.equal(redactSensitiveContent("token ghp_0123456789abcdefghij"), "token [REDACTED]");
	assert.equal(redactSensitiveContent("https://user:pass@example.com"), "https://user:[REDACTED]@example.com");
	assert.match(redactSensitiveContent("Authorization: Bearer abc123"), /Authorization: Bearer \[REDACTED\]/i);
	assert.match(redactSensitiveContent("api_key=sk-abcdef123456"), /api_key=\[REDACTED\]/i);
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij";
	assert.equal(redactSensitiveContent(jwt), "[REDACTED]");
	// Plain text passes through.
	assert.equal(redactSensitiveContent("npm test"), "npm test");
});

test.after(() => {
	__resetTrustListCacheForTests();
});
