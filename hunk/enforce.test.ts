// Enforce regression tests: persisted state, mutation→comment mapping,
// anchors from tool_result events, debounce aggregation, and budgets.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_ENFORCE_STATE,
	HUNK_ENFORCE_FILE_NAME,
	readHunkEnforceState,
	writeHunkEnforceState,
} from "./enforce.js";
import {
	buildMutationComments,
	buildMutationHighlights,
	hasLiveSession,
} from "./annotator.js";
import {
	EnforceRuntime,
	bashMutationsFromToolResult,
	mutationsFromToolResult,
} from "./enforce-runtime.js";
import type { MutationRecord } from "./annotator.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

// ---- persisted state ----

test("HUNK_ENFORCE_FILE_NAME follows the aio agent-file pattern", () => {
	assert.equal(HUNK_ENFORCE_FILE_NAME, "aio-hunk-enforce.json");
});

test("readHunkEnforceState: missing and broken files yield defaults", () => {
	assert.deepEqual(readHunkEnforceState("/nonexistent/aio-hunk-enforce.json"), DEFAULT_ENFORCE_STATE);
	assert.equal(DEFAULT_ENFORCE_STATE.enforce, false, "enforce is OFF by default");
});

test("readHunkEnforceState: invalid values fall back, valid persist", () => {
	const dir = mkdtempSync(join(tmpdir(), "aio-hunk-enforce-"));
	const file = join(dir, HUNK_ENFORCE_FILE_NAME);
	test.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(file, '{"enforce": true, "maxCommentsPerBatch": 99, "maxBashAnnotations": "bad"}');
	const state = readHunkEnforceState(file);
	assert.equal(state.enforce, true);
	assert.equal(state.maxCommentsPerBatch, 99, "in-range values persist");
	assert.equal(state.maxBashAnnotations, DEFAULT_ENFORCE_STATE.maxBashAnnotations, "invalid falls back");

	writeFileSync(file, "not json");
	assert.deepEqual(readHunkEnforceState(file), DEFAULT_ENFORCE_STATE);

	writeFileSync(file, '{"enforce": true}');
	writeHunkEnforceState({ enforce: false, maxCommentsPerBatch: 3, maxBashAnnotations: 4 }, file);
	assert.deepEqual(readHunkEnforceState(file), { enforce: false, maxCommentsPerBatch: 3, maxBashAnnotations: 4 });
});

// ---- mutation → comment mapping ----

test("buildMutationComments: groups per file with operation counts", () => {
	const mutations: MutationRecord[] = [
		{ path: "src/a.ts", operation: "modify", anchorLine: 12 },
		{ path: "src/a.ts", operation: "modify", anchorLine: 40 },
		{ path: "src/new.ts", operation: "create", anchorLine: 1 },
	];
	const comments = buildMutationComments(mutations, { maxCommentsPerBatch: 6 });
	assert.equal(comments.length, 2);
	const a = comments.find((comment) => comment.filePath === "src/a.ts");
	assert.match(a?.summary ?? "", /modify ×2/);
	assert.equal(a?.newLine, 12, "first anchored record wins");
	const n = comments.find((comment) => comment.filePath === "src/new.ts");
	assert.match(n?.summary ?? "", /create/);
	assert.equal(n?.author, "aio");
});

test("buildMutationComments: bash mutations stay unanchored", () => {
	const mutations: MutationRecord[] = [
		{ path: "src/old.ts", operation: "delete", fromBash: true },
	];
	const comments = buildMutationComments(mutations, { maxCommentsPerBatch: 6 });
	assert.equal(comments.length, 1);
	assert.equal(comments[0]?.newLine, undefined, "parsed shell lines are guesses; file-level only");
});

test("buildMutationComments: bounded by maxCommentsPerBatch", () => {
	const mutations: MutationRecord[] = Array.from({ length: 10 }, (_, i) => ({
		path: `src/f${i}.ts`,
		operation: "modify" as const,
	}));
	const comments = buildMutationComments(mutations, { maxCommentsPerBatch: 3 });
	assert.equal(comments.length, 3);
});

test("buildMutationHighlights: anchored create/modify only, bounded", () => {
	const mutations: MutationRecord[] = [
		{ path: "src/a.ts", operation: "modify", anchorLine: 12 },
		{ path: "src/old.ts", operation: "delete" },
		{ path: "src/cmd.ts", operation: "delete", fromBash: true },
		{ path: "src/b.ts", operation: "create", anchorLine: 1 },
	];
	const highlights = buildMutationHighlights(mutations, { maxCommentsPerBatch: 1 });
	assert.equal(highlights.length, 1, "budget bounds highlights too");
	assert.equal(highlights[0]?.filePath, "src/a.ts");

	const unbounded = buildMutationHighlights(mutations, { maxCommentsPerBatch: 6 });
	assert.equal(unbounded.length, 2, "delete and bash-derived never highlighted");
});

// ---- tool_result mapping ----

function toolResultEvent(toolName: string, input: Record<string, unknown>, extra: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName,
		input,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details: undefined,
		...extra,
	} as ToolResultEvent;
}

test("mutationsFromToolResult: write anchors at line 1", () => {
	const mutations = mutationsFromToolResult(toolResultEvent("write", { path: "src/new.ts", content: "x" }));
	assert.deepEqual(mutations, [{ path: "src/new.ts", operation: "modify", anchorLine: 1 }]);
});

test("mutationsFromToolResult: edit anchor from firstChangedLine details", () => {
	const event = toolResultEvent("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }, {
		details: { diff: "...", patch: "...", firstChangedLine: 37 },
	});
	const mutations = mutationsFromToolResult(event);
	assert.deepEqual(mutations, [{ path: "src/a.ts", operation: "modify", anchorLine: 37 }]);
});

test("mutationsFromToolResult: apply_patch stays file-anchored", () => {
	const mutations = mutationsFromToolResult(
		toolResultEvent("apply_patch", { changes: [{ path: "src/x.ts", action: "update" }] }),
	);
	assert.equal(mutations.length, 1);
	assert.equal(mutations[0]?.path, "src/x.ts");
	assert.equal(mutations[0]?.anchorLine, undefined, "aio apply_patch reports counts, not lines");
});

test("mutationsFromToolResult: error results never annotate", () => {
	assert.deepEqual(mutationsFromToolResult(toolResultEvent("write", { path: "src/new.ts", content: "x" }, { isError: true })), []);
});

test("mutationsFromToolResult: non-mutation tools produce nothing", () => {
	assert.deepEqual(mutationsFromToolResult(toolResultEvent("read", { path: "src/a.ts" })), []);
	assert.deepEqual(mutationsFromToolResult(toolResultEvent("grep", { pattern: "x" })), []);
});

test("bashMutationsFromToolResult: rm/touch map unanchored; plain bash stays silent", () => {
	const rm = bashMutationsFromToolResult(toolResultEvent("bash", { command: "rm src/old.ts && npm test" }));
	assert.deepEqual(rm, [{ path: "src/old.ts", operation: "delete", fromBash: true }]);

	const touch = bashMutationsFromToolResult(toolResultEvent("bash", { command: "touch src/x.ts" }));
	assert.equal(touch.length, 1);
	assert.equal(touch[0]?.fromBash, true);

	assert.deepEqual(bashMutationsFromToolResult(toolResultEvent("bash", { command: "npm test" })), []);
});

// ---- debounced runtime ----

function fakeEx(calls: Array<{ code: number; stdout: string }>): { ex: import("./cli.js").HunkExec; payloads: string[] } {
	const queue = [...calls];
	const payloads: string[] = [];
	const ex: import("./cli.js").HunkExec = async (_command, args) => {
		// The live-review probe (session list) always reports an available
		// matching session; scripted results apply to the annotate calls.
		if (args.includes("list")) {
			return { code: 0, stdout: JSON.stringify({ sessions: [{ repoRoot: "/tmp" }] }), stderr: "" };
		}
		payloads.push(args.join(" "));
		const next = queue.shift();
		return { code: next?.code ?? 0, stdout: next?.stdout ?? "", stderr: "" };
	};
	return { ex, payloads };
}

test("EnforceRuntime: flush leaves one batch and reports count", async () => {
	const { ex } = fakeEx([{ code: 0, stdout: '{"applied":2}' }]);
	// Large window: the timer never fires during the test, so the manual
	// flush is the only one racing for the batch.
	const runtime = new EnforceRuntime(ex, { maxCommentsPerBatch: 6, maxBashAnnotations: 10, windowMs: 60_000 });
	await runtime.queue(
		[
			{ path: "src/a.ts", operation: "modify", anchorLine: 12 },
			{ path: "src/b.ts", operation: "create", anchorLine: 1 },
		],
		{ repo: "." },
		"/tmp",
		undefined,
	);
	assert.equal(runtime.pendingCount, 2);
	const outcome = await runtime.flush({ repo: "." }, "/tmp", undefined);
	assert.equal(outcome.left, 2);
	assert.match(outcome.text, /2 inline annotation/);
	assert.equal(runtime.pendingCount, 0);
});

test("EnforceRuntime: bash budget bounds bash-derived records", async () => {
	const { ex } = fakeEx([]);
	const runtime = new EnforceRuntime(ex, { maxCommentsPerBatch: 6, maxBashAnnotations: 2, windowMs: 60_000 });
	const bashRecord: MutationRecord = { path: "src/x.ts", operation: "delete", fromBash: true };
	await runtime.queue([bashRecord, bashRecord, bashRecord], { repo: "." }, "/tmp", undefined);
	// The third bash record exceeded the budget and never queued.
	assert.equal(runtime.pendingCount, 2);
	assert.equal(runtime.bashBudgetSpent, true);
});

test("EnforceRuntime: clear drops pending and resets the probe cache", async () => {
	const { ex } = fakeEx([]);
	const runtime = new EnforceRuntime(ex, { maxCommentsPerBatch: 6, maxBashAnnotations: 10, windowMs: 60_000 });
	await runtime.queue([{ path: "src/a.ts", operation: "modify", anchorLine: 1 }], { repo: "." }, "/tmp", undefined);
	runtime.clear();
	assert.equal(runtime.pendingCount, 0);
});

test("hasLiveSession: true when a session matches this repo", async () => {
	const matching = async () => ({
		code: 0,
		stdout: JSON.stringify({ sessions: [{ repoRoot: "/repo", cwd: "/repo" }] }),
		stderr: "",
	});
	assert.equal(await hasLiveSession(matching, "/repo"), true);
	assert.equal(await hasLiveSession(matching, "/repo/sub"), true, "subdirectories match the repo root");
	assert.equal(await hasLiveSession(matching, "/other"), false);

	const none = async () => ({ code: 0, stdout: '{"sessions":[]}', stderr: "" });
	assert.equal(await hasLiveSession(none, "/repo"), false);

	const broken = async () => ({ code: 1, stdout: "", stderr: "No active Hunk sessions" });
	assert.equal(await hasLiveSession(broken, "/repo"), false);
});
