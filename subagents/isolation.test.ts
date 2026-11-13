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
import { afterEach, test } from "node:test";
import { clearRuns } from "./registry.ts";
import { decodeHistoricalRun, publicRun } from "./history.ts";
import {
	buildSpawnSpec,
	executeSubagentRun,
	formatRunResult,
	resumeSubagentChild,
} from "./runner.ts";
import {
	applyWorkspacePatch,
	captureWorkspaceChanges,
	prepareWorkspace,
	removeWorkspace,
	resolveRepo,
} from "./workspace.ts";
import { RESULT_SCHEMA_ENV, SUBMIT_RESULT_TOOL } from "./result-schema.ts";
import type { AgentConfig, ParentLaunchContext } from "./types.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "test-fixture-child.mjs");
const directories: string[] = [];

afterEach(() => {
	clearRuns();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const base = join(process.cwd(), ".pi-subagents");
	mkdirSync(base, { recursive: true });
	const dir = realpathSync(mkdtempSync(join(base, prefix)));
	directories.push(dir);
	return dir;
}

/** The scratch base sits inside this repository; stop git discovery there. */
async function outsideRepo<T>(work: () => Promise<T>): Promise<T> {
	const saved = process.env.GIT_CEILING_DIRECTORIES;
	process.env.GIT_CEILING_DIRECTORIES = realpathSync(join(process.cwd(), ".pi-subagents"));
	try {
		return await work();
	} finally {
		if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = saved;
	}
}

function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	return env;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
		{ encoding: "utf8", env: cleanGitEnv() },
	);
}

/**
 * A repository with a committed file, an uncommitted edit, an untracked file,
 * an ignored dependency directory, and ignored project config in `.pi`.
 */
function makeRepo(): string {
	const repo = scratch("isolation-repo-");
	git(repo, "init", "-q");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n.pi/\n");
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, "shared.txt"), "base\n");
	mkdirSync(join(repo, "pkg"));
	writeFileSync(join(repo, "pkg", "b.txt"), "bee\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "init");
	writeFileSync(join(repo, "a.txt"), "one\nparent edit\n");
	writeFileSync(join(repo, "untracked.txt"), "new in parent\n");
	mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
	mkdirSync(join(repo, "pkg", ".pi"), { recursive: true });
	writeFileSync(join(repo, "pkg", ".pi", "aio-blocklist.json"), '{"entries":[]}\n');
	return repo;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Edits files",
		systemPrompt: "Do the work.",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		source: "builtin",
		filePath: "/agents/worker.md",
		...overrides,
	};
}

function parent(cwd: string, overrides: Partial<ParentLaunchContext> = {}): ParentLaunchContext {
	return { cwd, model: "openai-codex/gpt-parent", thinking: "high", ...overrides };
}

function deps(extra: Record<string, unknown> = {}) {
	return {
		piBinary: process.execPath,
		piArgsPrefix: [fixture],
		runsBaseDir: scratch("isolation-runs-"),
		retryBackoffMs: 0,
		...extra,
	};
}

function worktreeCount(repo: string): number {
	return git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
}

const schema = {
	type: "object",
	properties: { status: { type: "string" }, files: { type: "array", items: { type: "string" } } },
	required: ["status", "files"],
};

test("resolveRepo rejects directories outside a repository and empty repositories", async () => {
	const outside = scratch("not-a-repo-");
	await outsideRepo(() => assert.rejects(resolveRepo(outside), /requires a git repository/));
	const empty = scratch("empty-repo-");
	git(empty, "init", "-q");
	await assert.rejects(resolveRepo(empty), /at least one commit/);
});

test("a worktree starts from the parent's current files and returns only the child's changes", async () => {
	const repo = makeRepo();
	const stateDir = scratch("isolation-state-");
	const workspace = await prepareWorkspace({ cwd: join(repo, "pkg"), stateDir, name: "child" });
	try {
		assert.equal(workspace.childCwd, join(workspace.worktreePath, "pkg/"));
		// Parent state: the uncommitted edit, the untracked file, linked deps, project config.
		assert.equal(readFileSync(join(workspace.worktreePath, "a.txt"), "utf8"), "one\nparent edit\n");
		assert.equal(readFileSync(join(workspace.worktreePath, "untracked.txt"), "utf8"), "new in parent\n");
		assert.ok(lstatSync(join(workspace.worktreePath, "node_modules")).isSymbolicLink());
		assert.ok(existsSync(join(workspace.childCwd, ".pi", "aio-blocklist.json")));
		// The child's own index still matches HEAD, like the parent's.
		assert.match(git(workspace.worktreePath, "status", "--porcelain"), /^ M a\.txt$/m);

		writeFileSync(join(workspace.childCwd, "b.txt"), "bee\nchild edit\n");
		writeFileSync(join(workspace.worktreePath, "created.txt"), "child file\n");
		rmSync(join(workspace.worktreePath, "untracked.txt"));
		const changes = await captureWorkspaceChanges(workspace);
		assert.deepEqual(
			changes.files.map((file) => file.path).sort(),
			["created.txt", "pkg/b.txt", "untracked.txt"],
		);
		const patch = readFileSync(changes.patchFile ?? "", "utf8");
		assert.doesNotMatch(patch, /parent edit|node_modules|aio-blocklist/);

		const applied = await applyWorkspacePatch({ repoRoot: repo, patchFile: changes.patchFile ?? "" });
		assert.deepEqual(applied, { applied: true });
		assert.equal(readFileSync(join(repo, "pkg", "b.txt"), "utf8"), "bee\nchild edit\n");
		assert.equal(readFileSync(join(repo, "created.txt"), "utf8"), "child file\n");
		assert.equal(existsSync(join(repo, "untracked.txt")), false);
		// The parent's own uncommitted edit and index are untouched.
		assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\nparent edit\n");
		assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
	} finally {
		await removeWorkspace(workspace);
	}
	assert.equal(existsSync(workspace.worktreePath), false);
	assert.equal(worktreeCount(repo), 1);
	assert.ok(existsSync(join(repo, "node_modules", "dep", "index.js")), "linked deps survive removal");
});

test("a patch that no longer applies changes nothing in the parent", async () => {
	const repo = makeRepo();
	const workspace = await prepareWorkspace({ cwd: repo, stateDir: scratch("isolation-state-"), name: "child" });
	writeFileSync(join(workspace.worktreePath, "shared.txt"), "child\n");
	const changes = await captureWorkspaceChanges(workspace);
	await removeWorkspace(workspace);
	writeFileSync(join(repo, "shared.txt"), "parent changed meanwhile\n");
	const outcome = await applyWorkspacePatch({ repoRoot: repo, patchFile: changes.patchFile ?? "" });
	assert.equal(outcome.applied, false);
	assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "parent changed meanwhile\n");
});

test("no changes produce no patch", async () => {
	const repo = makeRepo();
	const workspace = await prepareWorkspace({ cwd: repo, stateDir: scratch("isolation-state-"), name: "child" });
	const changes = await captureWorkspaceChanges(workspace);
	await removeWorkspace(workspace);
	assert.deepEqual(changes, { files: [] });
});

test("spawn spec: worktree cwd, mirrored project trust, and the typed result wiring", () => {
	const root = scratch("isolation-spec-");
	const base = {
		runId: "run-iso",
		index: 0,
		task: { agent: "worker", task: "work" },
		request: { agent: "worker", task: "work" },
		agent: agent({ tools: ["read", "edit"] }),
		deps: { runsBaseDir: root },
	};
	const trusted = buildSpawnSpec({
		...base,
		parent: parent("/parent", { projectTrusted: true }),
		workspace: { repoRoot: "/parent", worktreePath: "/wt", childCwd: "/wt/pkg" },
		resultSchema: schema,
	});
	assert.equal(trusted.cwd, "/wt/pkg");
	assert.ok(trusted.args.includes("--approve"));
	const toolList = trusted.args[trusted.args.indexOf("--tools") + 1];
	assert.ok(toolList.split(",").includes(SUBMIT_RESULT_TOOL));
	const schemaFile = trusted.env[RESULT_SCHEMA_ENV] ?? "";
	assert.deepEqual(JSON.parse(readFileSync(schemaFile, "utf8")), schema);
	const prompt = readFileSync(join(root, "run-iso", "child-0", "system-prompt.md"), "utf8");
	assert.match(prompt, /ISOLATED WORKTREE/);
	assert.match(prompt, /The parent checkout \/parent is mirrored here at \/wt\./);
	assert.match(prompt, /TYPED RESULT REQUIRED/);

	const untrusted = buildSpawnSpec({
		...base,
		parent: parent("/parent", { projectHooksTrusted: false }),
		workspace: { repoRoot: "/parent", worktreePath: "/wt", childCwd: "/wt" },
	});
	assert.ok(untrusted.args.includes("--no-approve"));
	assert.equal(untrusted.env[RESULT_SCHEMA_ENV], undefined);
	assert.equal(untrusted.env.PI_YAML_HOOKS_TRUST_PROJECT, process.env.PI_YAML_HOOKS_TRUST_PROJECT);
	const hooksTrusted = buildSpawnSpec({
		...base,
		parent: parent("/parent", { projectHooksTrusted: true }),
		workspace: { repoRoot: "/parent", worktreePath: "/wt", childCwd: "/wt" },
	});
	assert.equal(hooksTrusted.env.PI_YAML_HOOKS_TRUST_PROJECT, "1");

	const shared = buildSpawnSpec({ ...base, parent: parent("/parent", { projectTrusted: true }) });
	assert.equal(shared.cwd, "/parent");
	assert.equal(shared.args.includes("--approve") || shared.args.includes("--no-approve"), false);
});

test("parallel worktree children edit in isolation and both patches are applied in task order", async () => {
	const repo = makeRepo();
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "worker", task: "edit-alpha" },
				{ agent: "worker", task: "edit-beta" },
			],
			concurrency: 2,
			isolation: "worktree",
		},
		agents: [agent()],
		parent: parent(repo),
		deps: deps(),
	});
	assert.equal(run.state, "completed");
	assert.equal(run.isolation, "worktree");
	assert.equal(readFileSync(join(repo, "alpha.txt"), "utf8"), "edited by alpha\n");
	assert.equal(readFileSync(join(repo, "beta.txt"), "utf8"), "edited by beta\n");
	assert.deepEqual(run.results.map((result) => result.workspace?.state), ["applied", "applied"]);
	assert.deepEqual(run.results[0].workspace?.files, [{ path: "alpha.txt", added: 1, deleted: 0 }]);
	assert.equal(worktreeCount(repo), 1, "worktrees are removed after the run");
	const text = formatRunResult(run);
	assert.match(text, /worktree isolation/);
	assert.match(text, /Workspace: applied 1 file to/);
	const details = publicRun(run);
	const restored = decodeHistoricalRun(JSON.parse(JSON.stringify(details)));
	assert.equal(restored?.isolation, "worktree");
	assert.equal(restored?.children[0].workspace?.state, "applied");
});

test("conflicting siblings: the first patch applies, the second is kept with its path", async () => {
	const repo = makeRepo();
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "worker", task: "clash-first" },
				{ agent: "worker", task: "clash-second" },
			],
			concurrency: 2,
			isolation: "worktree",
		},
		agents: [agent()],
		parent: parent(repo),
		deps: deps(),
	});
	assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "first\n");
	const [first, second] = run.results.map((result) => result.workspace);
	assert.equal(first?.state, "applied");
	assert.equal(second?.state, "conflict");
	assert.ok(second?.patchFile && existsSync(second.patchFile));
	assert.match(formatRunResult(run), /Workspace conflict: 1 file NOT applied/);
});

test("the apply gate and applyChanges=false keep patches instead of touching the parent", async () => {
	const repo = makeRepo();
	const gated = await executeSubagentRun({
		request: { agent: "worker", task: "edit-gamma", isolation: "worktree" },
		agents: [agent()],
		parent: parent(repo),
		deps: deps(),
		applyGate: () => "the parent session is in plan mode",
	});
	assert.equal(gated.results[0].workspace?.state, "kept");
	assert.match(gated.results[0].workspace?.message ?? "", /plan mode/);
	assert.equal(existsSync(join(repo, "gamma.txt")), false);

	const kept = await executeSubagentRun({
		request: { agent: "worker", task: "edit-delta", isolation: "worktree", applyChanges: false },
		agents: [agent()],
		parent: parent(repo),
		deps: deps(),
	});
	assert.equal(kept.results[0].workspace?.state, "kept");
	assert.equal(existsSync(join(repo, "delta.txt")), false);
	assert.match(readFileSync(kept.results[0].workspace?.patchFile ?? "", "utf8"), /edited by delta/);
});

test("a failed worktree child keeps its partial patch and resumes in a recreated worktree", async () => {
	const repo = makeRepo();
	const runnerDeps = deps({ maxAttempts: 1 });
	const run = await executeSubagentRun({
		request: { agent: "worker", task: "edit-partial quota-once", isolation: "worktree" },
		agents: [agent()],
		parent: parent(repo),
		deps: runnerDeps,
	});
	const child = run.children[0];
	assert.equal(child.state, "failed");
	assert.equal(child.workspace?.state, "kept");
	assert.equal(existsSync(join(repo, "partial.txt")), false);
	assert.equal(existsSync(child.workspace?.worktreePath ?? ""), false);

	assert.match(child.error ?? "", /429 quota exhausted/);
	const continuation = await resumeSubagentChild({ run, child, deps: runnerDeps });
	assert.equal(continuation.state, "completed", continuation.children[0].error);
	const workspace = continuation.children[0].workspace;
	assert.equal(workspace?.worktreePath, child.workspace?.worktreePath, "same worktree path as the saved session cwd");
	assert.equal(workspace?.state, "applied");
	// The replayed partial patch is part of the continuation's patch.
	assert.equal(readFileSync(join(repo, "partial.txt"), "utf8"), "edited by partial\n");
	assert.equal(worktreeCount(repo), 1);
});

test("isolation=worktree outside a repository fails the child without spawning it", async () => {
	const outside = scratch("no-repo-");
	const run = await outsideRepo(() =>
		executeSubagentRun({
			request: { agent: "worker", task: "edit-x", isolation: "worktree" },
			agents: [agent()],
			parent: parent(outside),
			deps: deps(),
		}),
	);
	assert.equal(run.results[0].state, "failed");
	assert.equal(run.results[0].attempts, 0);
	assert.match(run.results[0].error ?? "", /requires a git repository/);
	assert.equal(run.results[0].workspace?.state, "error");
	assert.equal(existsSync(join(outside, "x.txt")), false);
});

test("a stop during worktree preparation never spawns the child", async () => {
	const repo = makeRepo();
	let stopped = false;
	const run = await executeSubagentRun({
		request: { agent: "worker", task: "edit-late", isolation: "worktree" },
		agents: [agent()],
		parent: parent(repo),
		deps: deps(),
		onUpdate: (current) => {
			// Stop once the child starts, while its worktree is prepared.
			if (!stopped && current.children[0].state === "running") {
				stopped = true;
				current.stopRequested = true;
			}
		},
	});
	assert.equal(run.state, "stopped");
	assert.equal(run.results[0].attempts, 0);
	assert.equal(run.results[0].workspace?.state, "empty");
	assert.equal(existsSync(join(repo, "late.txt")), false);
	assert.equal(worktreeCount(repo), 1);
});

test("the workspace location is published while the child runs and survives a checkpoint", async () => {
	const repo = makeRepo();
	const seen: string[] = [];
	await executeSubagentRun({
		request: { agent: "worker", task: "edit-early", isolation: "worktree" },
		agents: [agent()],
		parent: parent(repo),
		deps: deps(),
		onUpdate: (current) => {
			const workspace = current.children[0].workspace;
			if (workspace) seen.push(workspace.state);
			if (workspace?.state === "active") {
				const restored = decodeHistoricalRun(JSON.parse(JSON.stringify(publicRun(current))));
				assert.equal(restored?.children[0].workspace?.state, "kept");
				assert.equal(restored?.children[0].workspace?.worktreePath, workspace.worktreePath);
			}
		},
	});
	assert.ok(seen.includes("active"));
	assert.equal(seen.at(-1), "applied");
});

test("the typed-result reminder has its own budget after a crash retry", async () => {
	const run = await executeSubagentRun({
		request: { agent: "worker", task: "typed-late quota-once", outputSchema: schema },
		agents: [agent()],
		parent: parent(process.cwd()),
		deps: deps(),
	});
	assert.equal(run.results[0].state, "completed", run.results[0].error);
	assert.equal(run.results[0].attempts, 3);
});

test("typed results: submitted, JSON text, late after a reminder, and invalid", async () => {
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "worker", task: "typed-ok" },
				{ agent: "worker", task: "typed-text" },
				{ agent: "worker", task: "typed-late" },
				{ agent: "worker", task: "typed-wrong" },
			],
			concurrency: 4,
			outputSchema: schema,
		},
		agents: [agent()],
		parent: parent(process.cwd()),
		deps: deps(),
	});
	const [ok, text, late, wrong] = run.results;
	assert.deepEqual(ok.result, { status: "ok", files: ["a.txt"] });
	assert.equal(ok.attempts, 1);
	assert.deepEqual(text.result, { status: "ok", files: ["a.txt"] });
	assert.equal(late.state, "completed");
	assert.equal(late.attempts, 2, "the child was asked once more for the result");
	assert.deepEqual(late.result, { status: "ok", files: ["a.txt"] });
	assert.equal(wrong.state, "failed");
	assert.equal(wrong.result, undefined);
	assert.match(wrong.error ?? "", /did not return a valid typed result.*\/status/);
	const output = formatRunResult(run);
	assert.match(output, /Typed result \(validated against outputSchema\):\n```json\n\{\n  "status": "ok"/);
	assert.deepEqual((publicRun(run).children as Array<{ result?: unknown }>)[0].result, ok.result);
});

test("an invalid outputSchema fails the call before any child starts", async () => {
	await assert.rejects(
		executeSubagentRun({
			request: { tasks: [{ agent: "worker", task: "x", outputSchema: [] as never }] },
			agents: [agent()],
			parent: parent(process.cwd()),
			deps: deps(),
		}),
		/tasks\[0\]\.outputSchema must be a JSON Schema object/,
	);
});
