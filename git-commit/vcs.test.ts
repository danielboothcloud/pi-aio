import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { findVcs } from "./vcs.js";

describe("findVcs", () => {
	let dir: string;

	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "aio-vcs-")));
	});

	after(() => rmSync(dir, { recursive: true, force: true }));

	function folder(...parts: string[]): string {
		const path = join(dir, ...parts);
		mkdirSync(path, { recursive: true });
		return path;
	}

	it("finds a git repository from a subfolder", () => {
		folder("git", ".git");
		assert.deepEqual(findVcs(folder("git", "src", "deep")), { kind: "git", root: join(dir, "git") });
	});

	it("treats a .git file (worktree or submodule) as git", () => {
		folder("wt");
		writeFileSync(join(dir, "wt", ".git"), "gitdir: /elsewhere\n");
		assert.deepEqual(findVcs(join(dir, "wt")), { kind: "git", root: join(dir, "wt") });
	});

	it("finds a jj repository, also when it is colocated with git", () => {
		folder("jj", ".jj");
		assert.deepEqual(findVcs(folder("jj", "src")), { kind: "jj", root: join(dir, "jj") });
		folder("colo", ".jj");
		folder("colo", ".git");
		assert.deepEqual(findVcs(join(dir, "colo")), { kind: "jj", root: join(dir, "colo") });
	});

	it("the nearest repository wins over an outer one", () => {
		folder("outer", ".jj");
		folder("outer", "inner", ".git");
		assert.deepEqual(findVcs(folder("outer", "inner", "x")), { kind: "git", root: join(dir, "outer", "inner") });
		folder("outer2", ".git");
		folder("outer2", "inner", ".jj");
		assert.deepEqual(findVcs(join(dir, "outer2", "inner")), { kind: "jj", root: join(dir, "outer2", "inner") });
	});

	it("returns undefined outside any repository", () => {
		assert.equal(findVcs("/x/y", () => false), undefined);
	});
});
