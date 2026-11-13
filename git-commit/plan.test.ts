import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChangedFile } from "./git.js";
import {
	buildPlanPrompt,
	cleanMessage,
	FALLBACK_MESSAGE,
	isConventional,
	mergeWithNext,
	moveFile,
	parsePlan,
	type CommitGroup,
} from "./plan.js";

const FILES: ChangedFile[] = [
	{ path: "a.ts", status: "M", added: 2, deleted: 1 },
	{ path: "b.ts", status: "A", added: 5, deleted: 0 },
	{ path: "new.ts", oldPath: "old.ts", status: "R", added: 0, deleted: 0 },
];

describe("isConventional", () => {
	it("requires type(scope): description", () => {
		assert.equal(isConventional("feat(git): add command"), true);
		assert.equal(isConventional("fix(ui)!: break things\n\nbody"), true);
		assert.equal(isConventional("feat: no scope"), false);
		assert.equal(isConventional("wip(git): unknown type"), false);
		assert.equal(isConventional("feat(git):missing space"), false);
		assert.equal(isConventional(""), false);
	});
});

describe("parsePlan", () => {
	it("accepts fenced JSON and keeps the groups", () => {
		const reply = "```json\n" + JSON.stringify({
			commits: [
				{ message: "feat(b): add b", files: ["b.ts"] },
				{ message: "refactor(a): tidy a\n\nwhy", files: ["a.ts", "old.ts -> new.ts"] },
			],
		}) + "\n```";
		assert.deepEqual(parsePlan(reply, FILES), [
			{ message: "feat(b): add b", files: ["b.ts"], include: true },
			{ message: "refactor(a): tidy a\n\nwhy", files: ["a.ts", "new.ts"], include: true },
		]);
	});

	it("drops unknown and duplicate paths and collects leftovers", () => {
		const reply = JSON.stringify({
			commits: [
				{ message: "feat(a): a", files: ["a.ts", "nope.ts", "a.ts"] },
				{ message: "feat(x): x", files: ["a.ts"] },
				{ files: ["b.ts"] },
			],
		});
		assert.deepEqual(parsePlan(reply, FILES), [
			{ message: "feat(a): a", files: ["a.ts"], include: true },
			{ message: FALLBACK_MESSAGE, files: ["b.ts"], include: true },
			{ message: "chore(misc): update remaining files", files: ["new.ts"], include: true },
		]);
	});

	it("returns undefined for unusable replies", () => {
		assert.equal(parsePlan("I cannot do that", FILES), undefined);
		assert.equal(parsePlan("{\"commits\": 3}", FILES), undefined);
	});
});

describe("group edits", () => {
	const groups: CommitGroup[] = [
		{ message: "feat(a): a", files: ["a.ts"], include: true },
		{ message: "feat(b): b", files: ["b.ts", "new.ts"], include: false },
	];

	it("merges with the next group", () => {
		assert.deepEqual(mergeWithNext(groups, 0), [
			{ message: "feat(a): a", files: ["a.ts", "b.ts", "new.ts"], include: true },
		]);
		assert.deepEqual(mergeWithNext(groups, 1), groups);
	});

	it("moves files between groups, creating and removing groups", () => {
		assert.deepEqual(moveFile(groups, 0, "a.ts", 1).map((g) => g.files), [["b.ts", "new.ts", "a.ts"]]);
		assert.deepEqual(moveFile(groups, 1, "new.ts", 1).map((g) => g.files), [["a.ts"], ["b.ts"], ["new.ts"]]);
		assert.deepEqual(moveFile(groups, 0, "a.ts", -1).map((g) => g.files), [["a.ts"], ["b.ts", "new.ts"]]);
		assert.equal(groups[0]!.files.length, 1, "input is not mutated");
	});
});

describe("prompt and cleanup", () => {
	it("lists every staged path and recent subjects", () => {
		const prompt = buildPlanPrompt({ branch: "main", files: FILES, diff: "DIFF", recentSubjects: ["feat(x): y"] });
		assert.match(prompt, /M a\.ts \(\+2 -1\)/);
		assert.match(prompt, /R old\.ts -> new\.ts/);
		assert.match(prompt, /- feat\(x\): y/);
		assert.match(prompt, /DIFF$/);
	});

	it("strips terminal sequences and control characters", () => {
		assert.equal(cleanMessage("\u001b[31mfeat(a): red\u001b[0m\r\n\r\nbody\u0007  "), "feat(a): red\n\nbody");
	});
});
