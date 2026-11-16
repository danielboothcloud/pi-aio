import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { clearRuns } from "./registry.ts";
import { executeSubagentRun, formatRunResult, resumeSubagentChild } from "./runner.ts";
import {
	applyWorkspacePatch,
	captureWorkspaceChanges,
	prepareWorkspace,
	removeWorkspace,
	resolveRepo,
} from "./workspace.ts";
import type { AgentConfig } from "./types.ts";

/**
 * Real-jj tests. They run when `AIO_JJ_BINARY` (or `jj` on PATH) works and
 * skip otherwise; the missing-binary test always runs.
 */
const fixture = join(dirname(fileURLToPath(import.meta.url)), "test-fixture-child.mjs");
const directories: string[] = [];
const savedEnv = { ...process.env };

function probeJj(): string | undefined {
	const candidate = process.env.AIO_JJ_BINARY?.trim() || "jj";
	try {
		execFileSync(candidate, ["--version"], { stdio: "ignore" });
		return candidate;
	} catch {
		return undefined;
	}
}
const JJ = probeJj();
const needsJj = { skip: JJ ? false : "jj is not available (set AIO_JJ_BINARY)" };

function scratch(prefix: string): string {
	const base = join(process.cwd(), ".pi-subagents");
	mkdirSync(base, { recursive: true });
	const dir = realpathSync(mkdtempSync(join(base, prefix)));
	directories.push(dir);
	return dir;
}

before(() => {
	const config = join(scratch("jj-config-"), "config.toml");
	writeFileSync(config, '[user]\nname = "t"\nemail = "t@example.com"\n');
	process.env.JJ_CONFIG = config;
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	if (JJ) process.env.AIO_JJ_BINARY = JJ;
});

after(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

afterEach(() => {
	clearRuns();
	for (const dir of directories.splice(1)) rmSync(dir, { recursive: true, force: true });
});

function jj(cwd: string, ...args: string[]): string {
	return execFileSync(JJ ?? "jj", ["--no-pager", "--color=never", ...args], { cwd, encoding: "utf8" });
}

/**
 * A jj repository with a committed file, an uncommitted edit, a new file
 * (auto-tracked into @), a binary file, an ignored node_modules, and ignored
 * project config in a `.pi` folder of the `pkg` subfolder.
 */
function makeJjRepo(colocate = true): string {
	const repo = scratch(colocate ? "jj-colo-" : "jj-plain-");
	jj(repo, "git", "init", "--quiet", colocate ? "--colocate" : "--no-colocate", ".");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n.pi/\n");
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, "shared.txt"), "base\n");
	writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	mkdirSync(join(repo, "pkg"));
	writeFileSync(join(repo, "pkg", "b.txt"), "bee\n");
	jj(repo, "commit", "--quiet", "-m", "init");
	writeFileSync(join(repo, "a.txt"), "one\nparent edit\n");
	writeFileSync(join(repo, "new-in-parent.txt"), "new in parent\n");
	mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
	mkdirSync(join(repo, "pkg", ".pi"), { recursive: true });
	writeFileSync(join(repo, "pkg", ".pi", "aio-blocklist.json"), '{"entries":[]}\n');
	return repo;
}

/** jj state is clean: only the default workspace and no temporary commits. */
function assertNoLeftovers(repo: string): void {
	assert.match(jj(repo, "workspace", "list"), /^default/);
	assert.equal(jj(repo, "workspace", "list").trim().split("\n").length, 1);
	assert.equal(jj(repo, "log", "--no-graph", "-r", 'description(substring:"aio-subagent") | description(substring:"aio subagent")', "-T", "change_id").trim(), "");
	if (existsSync(join(repo, ".git")))
		assert.equal(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length, 1);
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "Edits files",
		systemPrompt: "Do the work.",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		source: "builtin",
		filePath: "/agents/worker.md",
	};
}

function deps(extra: Record<string, unknown> = {}) {
	return {
		piBinary: process.execPath,
		piArgsPrefix: [fixture],
		runsBaseDir: scratch("jj-runs-"),
		retryBackoffMs: 0,
		...extra,
	};
}

test("a .jj repository without a working jj command fails clearly", async () => {
	const repo = scratch("jj-fake-");
	mkdirSync(join(repo, ".jj"));
	mkdirSync(join(repo, ".git"));
	const saved = process.env.AIO_JJ_BINARY;
	process.env.AIO_JJ_BINARY = join(repo, "no-such-jj");
	try {
		await assert.rejects(resolveRepo(repo), /found a Jujutsu \(jj\) repository at .*jj command did not run.*AIO_JJ_BINARY/s);
	} finally {
		if (saved === undefined) delete process.env.AIO_JJ_BINARY;
		else process.env.AIO_JJ_BINARY = saved;
	}
});

for (const colocate of [true, false]) {
	const label = colocate ? "colocated" : "non-colocated";

	test(`${label}: the workspace starts from @, ignores later parent edits, and returns only the child's changes`, needsJj, async () => {
		const repo = makeJjRepo(colocate);
		const info = await resolveRepo(join(repo, "pkg"));
		assert.equal(info.vcs, "jj");
		const workspace = await prepareWorkspace({ cwd: join(repo, "pkg"), stateDir: scratch("jj-state-"), name: "aio-test-0" });
		try {
			assert.equal(workspace.vcs, "jj");
			assert.equal(workspace.childCwd, join(workspace.worktreePath, "pkg/"));
			assert.ok(existsSync(join(workspace.worktreePath, ".jj")));
			assert.equal(existsSync(join(workspace.worktreePath, ".git")), false, "no git worktree in the child");
			// Parent state at preparation: the uncommitted edit and the new file.
			assert.equal(readFileSync(join(workspace.worktreePath, "a.txt"), "utf8"), "one\nparent edit\n");
			assert.equal(readFileSync(join(workspace.worktreePath, "new-in-parent.txt"), "utf8"), "new in parent\n");
			assert.ok(lstatSync(join(workspace.worktreePath, "node_modules")).isSymbolicLink());
			assert.ok(existsSync(join(workspace.childCwd, ".pi", "aio-blocklist.json")));

			// The parent keeps working: nothing leaks into the frozen base.
			writeFileSync(join(repo, "shared.txt"), "base\nparent later\n");
			jj(repo, "status");
			assert.equal(readFileSync(join(workspace.worktreePath, "shared.txt"), "utf8"), "base\n");

			writeFileSync(join(workspace.childCwd, "b.txt"), "bee\nchild edit\n");
			writeFileSync(join(workspace.worktreePath, "bin.dat"), Buffer.from([0, 255, 254, 7]));
			writeFileSync(join(workspace.worktreePath, "created.txt"), "child file\n");
			rmSync(join(workspace.worktreePath, "new-in-parent.txt"));
			const changes = await captureWorkspaceChanges(workspace);
			assert.deepEqual(
				changes.files.map((file) => file.path).sort(),
				["bin.dat", "created.txt", "new-in-parent.txt", "pkg/b.txt"],
			);
			assert.deepEqual(changes.files.find((file) => file.path === "bin.dat"), { path: "bin.dat", added: null, deleted: null });
			const patch = readFileSync(changes.patchFile ?? "", "utf8");
			assert.match(patch, /GIT binary patch/);
			assert.doesNotMatch(patch, /parent later|parent edit|node_modules|aio-blocklist/);

			const applied = await applyWorkspacePatch({ repoRoot: repo, patchFile: changes.patchFile ?? "", vcs: "jj" });
			assert.deepEqual(applied, { applied: true });
			assert.equal(readFileSync(join(repo, "pkg", "b.txt"), "utf8"), "bee\nchild edit\n");
			assert.deepEqual([...readFileSync(join(repo, "bin.dat"))], [0, 255, 254, 7]);
			assert.equal(readFileSync(join(repo, "created.txt"), "utf8"), "child file\n");
			assert.equal(existsSync(join(repo, "new-in-parent.txt")), false);
			// The parent's own later edit is kept.
			assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "base\nparent later\n");
		} finally {
			await removeWorkspace(workspace);
		}
		assert.equal(existsSync(workspace.worktreePath), false);
		assertNoLeftovers(repo);
		assert.ok(existsSync(join(repo, "node_modules", "dep", "index.js")), "linked deps survive removal");
	});
}

test("user config auto-track=none() and large new files never drop the child's files", needsJj, async () => {
	const repo = makeJjRepo();
	const workspace = await prepareWorkspace({ cwd: repo, stateDir: scratch("jj-state-"), name: "aio-test-1" });
	const config = process.env.JJ_CONFIG ?? "";
	const saved = readFileSync(config, "utf8");
	writeFileSync(config, `${saved}[snapshot]\nauto-track = "none()"\n`);
	try {
		writeFileSync(join(workspace.worktreePath, "untracked-by-config.txt"), "x\n");
		writeFileSync(join(workspace.worktreePath, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
		const changes = await captureWorkspaceChanges(workspace);
		assert.deepEqual(changes.files.map((file) => file.path).sort(), ["big.bin", "untracked-by-config.txt"]);
	} finally {
		writeFileSync(config, saved);
		await removeWorkspace(workspace);
	}
	assertNoLeftovers(repo);
});

test("a conflicted @ is refused and leaves nothing behind", needsJj, async () => {
	const repo = makeJjRepo();
	jj(repo, "describe", "--quiet", "-m", "side one");
	writeFileSync(join(repo, "shared.txt"), "one\n");
	jj(repo, "new", "--quiet", "-m", "side two", "@-");
	writeFileSync(join(repo, "shared.txt"), "two\n");
	jj(repo, "new", "--quiet", 'description(exact:"side one\n")', "@");
	assert.match(jj(repo, "log", "--no-graph", "-r", "@", "-T", "conflict"), /true/);
	await assert.rejects(
		prepareWorkspace({ cwd: repo, stateDir: scratch("jj-state-"), name: "aio-test-c" }),
		/unresolved conflicts/,
	);
	assertNoLeftovers(repo);
});

test("parent history rewrites (jj squash) during the run do not touch the frozen base", needsJj, async () => {
	const repo = makeJjRepo();
	const workspace = await prepareWorkspace({ cwd: repo, stateDir: scratch("jj-state-"), name: "aio-test-sq" });
	try {
		writeFileSync(join(workspace.worktreePath, "created.txt"), "child\n");
		jj(repo, "squash", "--quiet");
		jj(repo, "describe", "--quiet", "-m", "rewritten", "@-");
		// The child's own jj commands still work (its workspace is not stale).
		assert.match(jj(workspace.worktreePath, "status"), /created\.txt/);
		const changes = await captureWorkspaceChanges(workspace);
		assert.deepEqual(changes.files.map((file) => file.path), ["created.txt"]);
		assert.deepEqual(await applyWorkspacePatch({ repoRoot: repo, patchFile: changes.patchFile ?? "", vcs: "jj" }), { applied: true });
	} finally {
		await removeWorkspace(workspace);
	}
	assertNoLeftovers(repo);
});

test("untracked .pi files copied into the child are never returned (auto-track none)", needsJj, async () => {
	const repo = makeJjRepo();
	const config = process.env.JJ_CONFIG ?? "";
	const saved = readFileSync(config, "utf8");
	writeFileSync(config, `${saved}[snapshot]\nauto-track = "none()"\n`);
	// .pi is not ignored here, and with auto-track none() it stays untracked.
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
	try {
		const workspace = await prepareWorkspace({ cwd: join(repo, "pkg"), stateDir: scratch("jj-state-"), name: "aio-test-pi" });
		try {
			assert.ok(existsSync(join(workspace.childCwd, ".pi", "aio-blocklist.json")));
			writeFileSync(join(workspace.childCwd, "b.txt"), "bee\nchild\n");
			const changes = await captureWorkspaceChanges(workspace);
			assert.deepEqual(changes.files.map((file) => file.path), ["pkg/b.txt"]);
			assert.deepEqual(await applyWorkspacePatch({ repoRoot: repo, patchFile: changes.patchFile ?? "", vcs: "jj" }), { applied: true });
		} finally {
			await removeWorkspace(workspace);
		}
	} finally {
		writeFileSync(config, saved);
	}
	assertNoLeftovers(repo);
});

test("parallel jj children edit in isolation; patches apply in task order; conflicts are kept", needsJj, async () => {
	const repo = makeJjRepo();
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "worker", task: "edit-alpha clash-first" },
				{ agent: "worker", task: "edit-beta clash-second" },
			],
			concurrency: 2,
			isolation: "worktree",
		},
		agents: [agent()],
		parent: { cwd: repo, model: "openai-codex/gpt-parent" },
		deps: deps(),
	});
	assert.equal(run.state, "completed");
	assert.equal(readFileSync(join(repo, "alpha.txt"), "utf8"), "edited by alpha\n");
	assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "first\n");
	const [first, second] = run.results.map((result) => result.workspace);
	assert.equal(first?.vcs, "jj");
	assert.equal(first?.state, "applied");
	assert.equal(second?.state, "conflict", "the second child changed shared.txt too");
	assert.equal(existsSync(join(repo, "beta.txt")), false, "a conflicting patch changes nothing");
	assert.match(second?.workspaceName ?? "", /^aio-/);
	assert.match(formatRunResult(run), /Workspace conflict: 2 files NOT applied/);
	assertNoLeftovers(repo);
	// jj sees the applied files in the parent's working-copy commit.
	assert.match(jj(repo, "diff", "--name-only"), /alpha\.txt/);
});

test("a failed jj child keeps its partial patch and resumes in a recreated workspace", needsJj, async () => {
	const repo = makeJjRepo(false);
	const runnerDeps = deps({ maxAttempts: 1 });
	const run = await executeSubagentRun({
		request: { agent: "worker", task: "edit-partial quota-once", isolation: "worktree" },
		agents: [agent()],
		parent: { cwd: repo, model: "openai-codex/gpt-parent" },
		deps: runnerDeps,
	});
	const child = run.children[0];
	assert.equal(child.state, "failed");
	assert.equal(child.workspace?.state, "kept");
	assert.equal(existsSync(join(repo, "partial.txt")), false);
	assertNoLeftovers(repo);

	const continuation = await resumeSubagentChild({ run, child, deps: runnerDeps });
	assert.equal(continuation.state, "completed", continuation.children[0].error ?? "");
	const workspace = continuation.children[0].workspace;
	assert.equal(workspace?.worktreePath, child.workspace?.worktreePath);
	assert.equal(workspace?.state, "applied");
	assert.equal(readFileSync(join(repo, "partial.txt"), "utf8"), "edited by partial\n");
	assertNoLeftovers(repo);
});

test("a stop during jj workspace preparation never spawns the child", needsJj, async () => {
	const repo = makeJjRepo();
	let stopped = false;
	const run = await executeSubagentRun({
		request: { agent: "worker", task: "edit-late", isolation: "worktree" },
		agents: [agent()],
		parent: { cwd: repo, model: "openai-codex/gpt-parent" },
		deps: deps(),
		onUpdate: (current) => {
			if (!stopped && current.children[0].state === "running") {
				stopped = true;
				current.stopRequested = true;
			}
		},
	});
	assert.equal(run.state, "stopped");
	assert.equal(run.results[0].attempts, 0);
	assert.equal(existsSync(join(repo, "late.txt")), false);
	assertNoLeftovers(repo);
});
