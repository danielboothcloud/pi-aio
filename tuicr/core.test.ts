// Regression tests for the tuicr core: comment collection through fake
// captures, base-branch resolution, and the editor-prefill formatting.
// All exec goes through injected Capture seams — never a live tuicr/git.

import assert from "node:assert/strict";
import test from "node:test";
import { allComments, baseBranch, format, type Capture } from "./core.js";

/** Fake capture keyed by "command arg arg"; unexpected keys throw. */
function fakeCapture(script: Record<string, string | null>): Capture {
	return (command, args) => {
		const key = [command, ...args].join(" ");
		if (!(key in script)) throw new Error(`unexpected exec: ${key}`);
		const value = script[key];
		return value === null ? null : value;
	};
}

const CWD = "/tmp/aio-tuicr-core-test";

test("allComments joins sessions that have comments and skips empty ones", () => {
	const capture = fakeCapture({
		"tuicr review list --all": JSON.stringify([
			{ path: "/repo/.git/tuicr/s1", comment_count: 2 },
			{ path: "/repo/.git/tuicr/s2", comment_count: 0 },
		]),
		"tuicr review comments --session /repo/.git/tuicr/s1": JSON.stringify([
			{ id: "c1", location: "src/a.ts:10", content: "first" },
			{ id: "c2", path: "src/b.ts", comment_type: "bug", content: "second" },
		]),
	});
	assert.deepEqual(allComments(CWD, capture), [
		{ id: "c1", location: "src/a.ts:10", content: "first" },
		{ id: "c2", path: "src/b.ts", comment_type: "bug", content: "second" },
	]);
});

test("allComments returns [] when tuicr is missing or exits non-zero", () => {
	assert.deepEqual(allComments(CWD, fakeCapture({ "tuicr review list --all": null })), []);
});

test("allComments throws a descriptive error on malformed tuicr output", () => {
	assert.throws(
		() => allComments(CWD, fakeCapture({ "tuicr review list --all": "not json" })),
		/tuicr review list --all printed malformed JSON/,
	);
	assert.throws(
		() =>
			allComments(
				CWD,
				fakeCapture({ "tuicr review list --all": JSON.stringify({ nope: true }) }),
			),
		/did not print a JSON array/,
	);
});

test("baseBranch prefers origin/HEAD's target and verifies candidates", () => {
	const capture = fakeCapture({
		"git symbolic-ref --short refs/remotes/origin/HEAD": "origin/develop",
		"git rev-parse --abbrev-ref HEAD": "feature/x",
		"git rev-parse --verify --quiet origin/develop": "abc123",
	});
	assert.equal(baseBranch(CWD, capture), "origin/develop");
});

test("baseBranch falls back through main/master when origin/HEAD fails", () => {
	const capture = fakeCapture({
		"git symbolic-ref --short refs/remotes/origin/HEAD": null,
		"git rev-parse --abbrev-ref HEAD": "feature/x",
		"git rev-parse --verify --quiet origin/main": null,
		"git rev-parse --verify --quiet origin/master": "abc123",
	});
	assert.equal(baseBranch(CWD, capture), "origin/master");
});

test("baseBranch skips the current branch without verifying it", () => {
	const capture = fakeCapture({
		"git symbolic-ref --short refs/remotes/origin/HEAD": "main",
		"git rev-parse --abbrev-ref HEAD": "main",
		"git rev-parse --verify --quiet origin/main": "abc123",
	});
	// "main" is the current branch — skipped before any verify; origin/main
	// verifies and wins.
	assert.equal(baseBranch(CWD, capture), "origin/main");
});

test("baseBranch returns null when nothing verifies (no base entries)", () => {
	const capture = fakeCapture({
		"git symbolic-ref --short refs/remotes/origin/HEAD": null,
		"git rev-parse --abbrev-ref HEAD": "main",
		"git rev-parse --verify --quiet origin/main": null,
		"git rev-parse --verify --quiet origin/master": null,
		"git rev-parse --verify --quiet master": null,
	});
	assert.equal(baseBranch(CWD, capture), null);
});

test("format renders numbered anchor/type/body lines under the header", () => {
	const text = format([
		{ id: "1", location: "src/auth.ts:42", comment_type: "bug", content: "  throws\n\nwhen the token is missing  " },
		{ id: "2", path: "src/auth.ts:88", content: "rename this" },
		{ id: "3", content: "general note" },
		{ id: "4", location: "src/c.ts:1", comment_type: "none", content: "no tag" },
	]);
	assert.equal(
		text,
		[
			"I reviewed your changes. Please address these comments:",
			"",
			"1. `src/auth.ts:42` [BUG] - throws when the token is missing",
			"2. `src/auth.ts:88` - rename this",
			"3. - general note",
			"4. `src/c.ts:1` - no tag",
		].join("\n"),
	);
});

test("format produces a trailing-empty-line header for zero comments", () => {
	assert.equal(format([]), "I reviewed your changes. Please address these comments:\n");
});
