import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
	commitStaged,
	createGitRunner,
	findRepoRoot,
	parseNameStatus,
	parseNumstat,
	pendingOperation,
	pushCommits,
	resolvePushTarget,
	stagedFiles,
	unstagedPaths,
} from "./git.js";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });
}

describe("parsers", () => {
	it("parses name-status with renames", () => {
		const files = parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0A\0b c.ts\0");
		assert.deepEqual(files, [
			{ path: "a.ts", status: "M" },
			{ path: "new.ts", oldPath: "old.ts", status: "R" },
			{ path: "b c.ts", status: "A" },
		]);
	});

	it("parses numstat with renames and binaries", () => {
		const stats = parseNumstat("3\t1\ta.ts\0" + "0\t0\t\0old.ts\0new.ts\0" + "-\t-\timg.png\0");
		assert.deepEqual(stats.get("a.ts"), { added: 3, deleted: 1, binary: false });
		assert.deepEqual(stats.get("new.ts"), { added: 0, deleted: 0, binary: false });
		assert.equal(stats.get("img.png")?.binary, true);
	});
});

describe("commits and pushes in a scratch repository", () => {
	let dir: string;
	let repo: string;
	let remote: string;
	const savedEnv = { ...process.env };

	before(() => {
		Object.assign(process.env, ENV);
		dir = mkdtempSync(join(tmpdir(), "aio-commit-"));
		repo = join(dir, "work");
		remote = join(dir, "remote.git");
		execFileSync("git", ["init", "-q", "--bare", remote], { env: ENV });
		execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
		writeFileSync(join(repo, "keep.txt"), "one\n");
		writeFileSync(join(repo, "gone.txt"), "bye\n");
		writeFileSync(join(repo, "old.txt"), "rename me\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-q", "-m", "chore(repo): init");
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
		Object.assign(process.env, savedEnv);
	});

	it("commits exactly the staged state", async () => {
		const git = createGitRunner(repo);
		assert.equal(await findRepoRoot(repo), execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim());

		writeFileSync(join(repo, "keep.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "new file.txt"), "hello\n");
		rmSync(join(repo, "gone.txt"));
		renameSync(join(repo, "old.txt"), join(repo, "renamed.txt"));
		sh(repo, "add", "-A");
		// An unstaged edit on top of the staged one must not be committed.
		writeFileSync(join(repo, "keep.txt"), "one\ntwo\nunstaged\n");

		const files = await stagedFiles(git);
		const byPath = new Map(files.map((file) => [file.path, file]));
		assert.equal(byPath.get("renamed.txt")?.oldPath, "old.txt");
		assert.equal(byPath.get("gone.txt")?.status, "D");
		assert.deepEqual(await unstagedPaths(git), ["keep.txt"]);

		const hash = await commitStaged(git, "feat(files): change files\n\nBody line.\n");
		assert.equal(hash, sh(repo, "rev-parse", "--short", "HEAD").trim());
		assert.equal(sh(repo, "log", "-1", "--format=%B").trim(), "feat(files): change files\n\nBody line.");
		assert.equal(sh(repo, "show", "HEAD:keep.txt"), "one\ntwo\n");
		assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "");
		assert.equal(sh(repo, "status", "--porcelain").trim(), "M keep.txt");
		assert.equal(await pendingOperation(git), undefined);
	});

	it("resolves the push target and pushes, setting an upstream once", async () => {
		const git = createGitRunner(repo);
		assert.deepEqual(await resolvePushTarget(git), { error: "the repository has no remote" });

		sh(repo, "remote", "add", "backup", remote);
		const first = await resolvePushTarget(git);
		assert.deepEqual(first, { args: ["push", "-u", "backup", "HEAD"], label: "backup/main (new upstream)" });
		await pushCommits(git, first as { args: string[]; label: string });
		assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(),
			"feat(files): change files");

		assert.deepEqual(await resolvePushTarget(git), { args: ["push"], label: "backup/main" });

		sh(repo, "checkout", "-q", "--detach");
		assert.deepEqual(await resolvePushTarget(git), { error: "HEAD is detached, so there is no branch to push" });
		sh(repo, "checkout", "-q", "main");
	});
});
