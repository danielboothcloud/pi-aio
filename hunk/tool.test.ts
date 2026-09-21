// Regression tests for the hunk tool action dispatch: argument flows through
// a fake exec, validation errors, comment-apply stdin redirection, and
// no-session classification.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HUNK_ACTIONS, applyCommentBatch, runHunkAction, type HunkToolParams } from "./tool.js";
import { hunkCliError, type HunkExec } from "./cli.js";

interface FakeCall {
	readonly command: string;
	readonly args: string[];
	readonly stdout: string;
	readonly code: number;
	readonly stderr?: string;
}

function fakeExec(calls: FakeCall[]): HunkExec {
	return async (command, args) => {
		const next = calls.shift();
		if (!next) {
			throw hunkCliError("failed", `unexpected exec: ${command} ${args.join(" ")}`);
		}
		if (next.command !== command) {
			throw hunkCliError("failed", `expected command ${next.command}, got ${command}`);
		}
		return { code: next.code, stdout: next.stdout, stderr: next.stderr ?? "" };
	};
}

function params(action: HunkToolParams["action"], extra: Partial<HunkToolParams> = {}): HunkToolParams {
	return { action, ...extra } as HunkToolParams;
}

const CWD = "/tmp/aio-hunk-tool-test";

test("HUNK_ACTIONS covers the upstream session surface", () => {
	assert.deepEqual([...HUNK_ACTIONS].sort(), [
		"comment_add",
		"comment_apply",
		"comment_clear",
		"comment_list",
		"comment_rm",
		"context",
		"get",
		"highlight_add",
		"highlight_clear",
		"list",
		"navigate",
		"reload",
		"review",
	]);
});

test("list and review append --json and pass payloads through", async () => {
	const outcome = await runHunkAction(
		fakeExec([
			{ command: "hunk", args: ["session", "list", "--json"], stdout: `{"sessions":[{"id":"s1"}]}`, code: 0 },
		]),
		params("list"),
		{},
		CWD,
		undefined,
	);
	assert.match(outcome.text, /Active Hunk sessions/);
	assert.deepEqual(outcome.payload, { sessions: [{ id: "s1" }] });

	const review = await runHunkAction(
		fakeExec([
			{
				command: "hunk",
				args: ["session", "review", "--repo", ".", "--include-patch", "--json"],
				stdout: `{"files":[]}`,
				code: 0,
			},
		]),
		params("review", { includePatch: true }),
		{},
		CWD,
		undefined,
	);
	assert.deepEqual(review.payload, { files: [] });
});

test("navigate, reload, and highlight flow structured args through", async () => {
	const ex = fakeExec([
		{
			command: "hunk",
			args: ["session", "navigate", "--repo", ".", "--file", "src/App.tsx", "--new-line", "372", "--json"],
			stdout: `{"ok":true}`,
			code: 0,
		},
		{
			command: "hunk",
			args: ["session", "reload", "--repo", ".", "--", "show", "HEAD~1", "--", "README.md", "--json"],
			stdout: `{"reloaded":true}`,
			code: 0,
		},
		{
			command: "hunk",
			args: [
				"session",
				"highlight",
				"add",
				"--repo",
				".",
				"--file",
				"src/App.tsx",
				"--new-line",
				"42",
				"--start",
				"6",
				"--end",
				"19",
				"--tone",
				"current",
				"--json",
			],
			stdout: `{"marked":true}`,
			code: 0,
		},
	]);

	await runHunkAction(ex, params("navigate", { filePath: "src/App.tsx", newLine: 372 }), {}, CWD, undefined);
	await runHunkAction(
		ex,
		params("reload", { reloadCommand: "show", reloadTarget: "HEAD~1", pathspec: ["README.md"] }),
		{},
		CWD,
		undefined,
	);
	await runHunkAction(
		ex,
		params("highlight_add", { filePath: "src/App.tsx", newLine: 42, start: 6, end: 19, tone: "current" }),
		{},
		CWD,
		undefined,
	);
});

test("comment_add builds the annotation command", async () => {
	const outcome = await runHunkAction(
		fakeExec([
			{
				command: "hunk",
				args: [
					"session",
					"comment",
					"add",
					"--repo",
					".",
					"--file",
					"README.md",
					"--new-line",
					"103",
					"--summary",
					"Tighten this wording",
					"--rationale",
					"clarity",
					"--json",
				],
				stdout: `{"commentId":"comment-1"}`,
				code: 0,
			},
		]),
		params("comment_add", {
			filePath: "README.md",
			newLine: 103,
			summary: "Tighten this wording",
			rationale: "clarity",
		}),
		{},
		CWD,
		undefined,
	);
	assert.deepEqual(outcome.payload, { commentId: "comment-1" });
});

test("comment_apply redirects the batch JSON through sh -c", async () => {
	const seenSh: string[] = [];
	const ex: HunkExec = async (command, args) => {
		if (command === "sh") {
			seenSh.push(args[1] ?? "");
			// The redirect target is the temp file; read the payload from it.
			const redirect = /<\s("(?:[^"\\]|\\.)*")$/.exec(args[1] ?? "")?.[1] ?? '""';
			const file = JSON.parse(redirect) as string;
			const payload = readFileSync(file, "utf8");
			assert.deepEqual(JSON.parse(payload), {
				comments: [{ summary: "Tighten this wording", filePath: "README.md", newLine: 103 }],
			});
			return { code: 0, stdout: `{"applied":2}`, stderr: "" };
		}
		throw hunkCliError("failed", `unexpected exec: ${command} ${args.join(" ")}`);
	};

	const outcome = await applyCommentBatch(
		ex,
		{},
		[{ filePath: "README.md", newLine: 103, summary: "Tighten this wording" }],
		CWD,
		undefined,
	);
	assert.deepEqual(outcome, { applied: 2 });
	assert.equal(seenSh.length, 1);
	assert.match(seenSh[0] ?? "", /hunk session comment apply --repo \./);
	assert.match(seenSh[0] ?? "", /< "/);
});

test("comment_apply failure classification surfaces /hunk guidance", async () => {
	const ex: HunkExec = async () => ({ code: 1, stdout: "", stderr: "Error: No active Hunk sessions" });
	await assert.rejects(
		applyCommentBatch(ex, {}, [{ summary: "s", filePath: "f", newLine: 1 }], CWD, undefined),
		(error: Error & { kind?: string }) => {
			assert.equal(error.kind, "no_sessions");
			assert.match(error.message, /Ask the user to open a review/);
			return true;
		},
	);
});

test("validation errors for underspecified actions", async () => {
	const none = fakeExec([]);

	await assert.rejects(
		runHunkAction(none, params("comment_add", {}), {}, CWD, undefined),
		/comment_add requires summary/,
	);
	await assert.rejects(
		runHunkAction(none, params("comment_apply", {}), {}, CWD, undefined),
		/non-empty comments array/,
	);
	await assert.rejects(
		runHunkAction(none, params("reload", {}), {}, CWD, undefined),
		/reload requires reloadCommand/,
	);
	await assert.rejects(
		runHunkAction(none, params("comment_rm", {}), {}, CWD, undefined),
		/comment_rm requires commentId/,
	);
	await assert.rejects(
		runHunkAction(none, params("comment_clear", {}), {}, CWD, undefined),
		/requires clearFile or clearAll/,
	);
	await assert.rejects(
		runHunkAction(none, params("highlight_add", {}), {}, CWD, undefined),
		/requires filePath, start, and end/,
	);
});

test("comment_clear scopes file, user-inclusive, and all", async () => {
	const ex = fakeExec([
		{ command: "hunk", args: ["session", "comment", "clear", "--repo", ".", "--file", "README.md", "--yes", "--json"], stdout: `{"cleared":1}`, code: 0 },
		{ command: "hunk", args: ["session", "comment", "clear", "--repo", ".", "--file", "README.md", "--include-user", "--yes", "--json"], stdout: `{"cleared":2}`, code: 0 },
		{ command: "hunk", args: ["session", "comment", "clear", "--repo", ".", "--all", "--yes", "--json"], stdout: `{"cleared":3}`, code: 0 },
	]);

	await runHunkAction(ex, params("comment_clear", { clearFile: "README.md" }), {}, CWD, undefined);
	await runHunkAction(ex, params("comment_clear", { clearFile: "README.md", includeUser: true }), {}, CWD, undefined);
	await runHunkAction(ex, params("comment_clear", { clearAll: true }), {}, CWD, undefined);
});

test("session id targeting replaces --repo", async () => {
	await runHunkAction(
		fakeExec([
			{ command: "hunk", args: ["session", "get", "s1", "--json"], stdout: `{"id":"s1"}`, code: 0 },
		]),
		params("get", { sessionId: "s1" }),
		{ repo: "/ignored" },
		CWD,
		undefined,
	);
});

test("non-zero exits classify as failed with the stderr text", async () => {
	await assert.rejects(
		runHunkAction(
			fakeExec([{ command: "hunk", args: ["session", "list", "--json"], stdout: "", code: 2, stderr: "No diff file matches src/x.ts" }]),
			params("list"),
			{},
			CWD,
			undefined,
		),
		(error: Error & { kind?: string }) => {
			assert.equal(error.kind, "failed");
			assert.match(error.message, /No diff file matches/);
			return true;
		},
	);
});

test("unknown actions throw", async () => {
	await assert.rejects(
		runHunkAction(fakeExec([]), params("nope" as HunkToolParams["action"]), {}, CWD, undefined),
		/Unsupported hunk action/,
	);
});
