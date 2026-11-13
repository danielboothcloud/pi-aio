import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	statSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkspaceFileChange } from "./types.js";

/**
 * Git worktree isolation for subagent children.
 *
 * A child gets a detached worktree at the parent's HEAD, plus the parent's
 * uncommitted tracked changes and untracked (not ignored) files. A baseline
 * tree is recorded through a private index, so the child's own git index
 * still matches HEAD, as in the parent. After the child, the worktree is
 * hashed again and the difference becomes a patch for `git apply`.
 *
 * Ignored dependency directories (node_modules, virtual environments) are
 * symlinked from the parent so tests can run. They are shared, not isolated.
 */

/** Ignored directories linked (not copied) into the worktree. */
export const LINKED_DEPENDENCY_DIRS: readonly string[] = [
	"node_modules",
	".venv",
	"venv",
];
/** Project config directory copied in when the worktree does not have it. */
const PROJECT_CONFIG_DIR = ".pi";
const MAX_GIT_OUTPUT = 512 * 1024 * 1024;

export interface PreparedWorkspace {
	repoRoot: string;
	worktreePath: string;
	/** The worktree directory that corresponds to the parent's cwd. */
	childCwd: string;
	baseTree: string;
	/** Worktree-relative paths of the linked dependency directories. */
	linkedPaths: string[];
	/** Private directory for index files and patches. */
	stateDir: string;
}

export interface CapturedChanges {
	files: WorkspaceFileChange[];
	patchFile?: string;
}

export class WorkspaceError extends Error {}

/** Git environment without inherited repository overrides. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_PREFIX",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_NAMESPACE",
	])
		delete env[key];
	return { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...extra };
}

interface GitOptions {
	cwd: string;
	env?: Record<string, string>;
	encoding?: "utf8" | "buffer";
	/** A nonexistent hooks directory: worktree/checkout hooks never run. */
	noHooksDir?: string;
}

function git(args: string[], options: GitOptions & { encoding: "buffer" }): Promise<Buffer>;
function git(args: string[], options: GitOptions): Promise<string>;
function git(args: string[], options: GitOptions): Promise<string | Buffer> {
	const prefix = options.noHooksDir
		? ["-c", `core.hooksPath=${options.noHooksDir}`]
		: [];
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[...prefix, "-C", options.cwd, ...args],
			{
				env: gitEnv(options.env),
				encoding: options.encoding === "buffer" ? "buffer" : "utf8",
				maxBuffer: MAX_GIT_OUTPUT,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr ?? "").trim() || error.message;
					reject(new WorkspaceError(`git ${args[0]} failed: ${detail}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

// One git writer per repository at a time: worktree metadata, and the parent
// checkout during merges, must never see concurrent writers from this process.
const repoLocks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoRoot: string, work: () => Promise<T>): Promise<T> {
	const previous = repoLocks.get(repoRoot) ?? Promise.resolve();
	const next = previous.then(work, work);
	const settled = next.catch(() => undefined);
	repoLocks.set(repoRoot, settled);
	try {
		return await next;
	} finally {
		if (repoLocks.get(repoRoot) === settled) repoLocks.delete(repoRoot);
	}
}

export interface RepoInfo {
	repoRoot: string;
	/** cwd relative to the repository root, with a trailing slash or empty. */
	prefix: string;
	head: string;
}

/** Resolve the repository for a cwd; throws a clear error when isolation is impossible. */
export async function resolveRepo(cwd: string): Promise<RepoInfo> {
	let repoRoot: string;
	let prefix: string;
	try {
		repoRoot = (await git(["rev-parse", "--show-toplevel"], { cwd })).trim();
		prefix = (await git(["rev-parse", "--show-prefix"], { cwd })).trim();
	} catch {
		throw new WorkspaceError(
			`isolation=worktree requires a git repository, but ${cwd} is not inside one.`,
		);
	}
	let head: string;
	try {
		head = (await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: repoRoot })).trim();
	} catch {
		throw new WorkspaceError(
			"isolation=worktree requires a repository with at least one commit.",
		);
	}
	if (!repoRoot || !head)
		throw new WorkspaceError("isolation=worktree could not resolve the repository HEAD.");
	return { repoRoot, prefix, head };
}

function splitNul(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function copyEntry(source: string, target: string): void {
	const stat = lstatSync(source);
	mkdirSync(dirname(target), { recursive: true });
	if (stat.isSymbolicLink()) {
		rmSync(target, { force: true });
		symlinkSync(readlinkSync(source), target);
		return;
	}
	if (!stat.isFile()) return;
	copyFileSync(source, target);
	chmodSync(target, stat.mode & 0o777);
}

function excludePathspecs(linkedPaths: readonly string[]): string[] {
	return linkedPaths.map((path) => `:(exclude,literal)${path}`);
}

/**
 * Hash the worktree's current content into a tree through a private index.
 * A seed index with stat data (the worktree's own index, or the baseline
 * index) lets `git add` skip unchanged files instead of rehashing them all.
 */
async function snapshotTree(input: {
	worktreePath: string;
	indexFile: string;
	from: string;
	seedIndex?: string;
	linkedPaths: readonly string[];
}): Promise<string> {
	rmSync(input.indexFile, { force: true });
	const env = { GIT_INDEX_FILE: input.indexFile };
	if (input.seedIndex && existsSync(input.seedIndex)) copyFileSync(input.seedIndex, input.indexFile);
	else await git(["read-tree", input.from], { cwd: input.worktreePath, env });
	await git(
		["add", "-A", "--", ".", ...excludePathspecs(input.linkedPaths)],
		{ cwd: input.worktreePath, env },
	);
	return (await git(["write-tree"], { cwd: input.worktreePath, env })).trim();
}

const DIFF_FLAGS = [
	"--binary",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-renames",
	"--no-relative",
	"--ignore-submodules",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

const APPLY_FLAGS = ["apply", "--binary", "--whitespace=nowarn"];

/** Where a child's patch is saved. Written even when empty at process exit. */
export function workspacePatchFile(stateDir: string): string {
	return join(stateDir, "changes.patch");
}

/** Track live worktrees so a process exit does not leave them behind. */
const liveWorkspaces = new Map<string, PreparedWorkspace>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => removeLiveWorkspacesSync());
}

function gitSync(args: string[], cwd: string, env: Record<string, string> = {}): Buffer {
	return execFileSync("git", ["-C", cwd, ...args], {
		env: gitEnv(env),
		maxBuffer: MAX_GIT_OUTPUT,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
}

/**
 * Synchronous capture for process exit: save the patch (an empty file means
 * "no changes"), so a later resume can replay the interrupted child's edits.
 */
function captureWorkspaceSync(workspace: PreparedWorkspace): void {
	const indexFile = join(workspace.stateDir, "exit.index");
	const env = { GIT_INDEX_FILE: indexFile };
	rmSync(indexFile, { force: true });
	const baseIndex = join(workspace.stateDir, "base.index");
	if (existsSync(baseIndex)) copyFileSync(baseIndex, indexFile);
	else gitSync(["read-tree", workspace.baseTree], workspace.worktreePath, env);
	gitSync(["add", "-A", "--", ".", ...excludePathspecs(workspace.linkedPaths)], workspace.worktreePath, env);
	const tree = gitSync(["write-tree"], workspace.worktreePath, env).toString("utf8").trim();
	const patch = tree === workspace.baseTree
		? Buffer.alloc(0)
		: gitSync(["diff", ...DIFF_FLAGS, workspace.baseTree, tree], workspace.worktreePath);
	writeFileSync(workspacePatchFile(workspace.stateDir), patch, { mode: 0o600 });
}

/**
 * Process exit with children still running: save each live worktree's
 * changes as a patch, then remove the worktree. Best effort and synchronous.
 */
export function removeLiveWorkspacesSync(): void {
	for (const workspace of liveWorkspaces.values()) {
		try {
			captureWorkspaceSync(workspace);
		} catch {
			// The worktree is still removed; resume refuses without a patch.
		}
		try {
			gitSync(["worktree", "remove", "--force", "--force", workspace.worktreePath], workspace.repoRoot);
		} catch {
			try {
				rmSync(workspace.worktreePath, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}
	liveWorkspaces.clear();
}

/** Replay the parent's uncommitted tracked changes in the worktree. */
async function writeParentState(stateDir: string, worktreePath: string, parentDiff: Buffer): Promise<void> {
	if (parentDiff.length === 0) return;
	const parentPatch = join(stateDir, "parent-state.patch");
	writeFileSync(parentPatch, parentDiff, { mode: 0o600 });
	await git([...APPLY_FLAGS, parentPatch], { cwd: worktreePath });
}

/** Symlink ignored dependency directories so the child can build and test. */
function linkDependencyDirs(repoRoot: string, worktreePath: string, ignoredDirs: readonly string[]): string[] {
	const linkedPaths: string[] = [];
	for (const entry of ignoredDirs) {
		if (!entry.endsWith("/")) continue;
		const path = entry.slice(0, -1);
		if (!LINKED_DEPENDENCY_DIRS.includes(basename(path))) continue;
		const target = join(worktreePath, path);
		if (existsSync(target) || !existsSync(dirname(target))) continue;
		symlinkSync(join(repoRoot, path), target, process.platform === "win32" ? "junction" : "dir");
		linkedPaths.push(path);
	}
	return linkedPaths;
}

/**
 * Project config (.pi: blocklist, settings, hooks) is often partly ignored or
 * local. The child must see the same project rules as the parent, so copy
 * only the files the worktree does not have yet (those are ignored files;
 * tracked and untracked ones are already present).
 */
function copyProjectConfig(parentCwd: string, childCwd: string): void {
	const parentConfig = join(parentCwd, PROJECT_CONFIG_DIR);
	if (!existsSync(parentConfig)) return;
	cpSync(parentConfig, join(childCwd, PROJECT_CONFIG_DIR), {
		recursive: true,
		force: false,
		errorOnExist: false,
		verbatimSymlinks: true,
	});
}

/**
 * Create an isolated worktree for one child. `stateDir` is runner-owned and
 * holds the worktree, private index files, and patches.
 */
export async function prepareWorkspace(input: {
	cwd: string;
	stateDir: string;
	name: string;
	/** A previous partial patch to replay on top of the baseline (manual resume). */
	seedPatchFile?: string;
	/** Reuse an exact (removed) worktree path; a resumed session stores it as cwd. */
	worktreePath?: string;
	repo?: RepoInfo;
}): Promise<PreparedWorkspace> {
	const repo = input.repo ?? (await resolveRepo(input.cwd));
	mkdirSync(input.stateDir, { recursive: true });
	const worktreePath = input.worktreePath ?? join(input.stateDir, input.name);
	mkdirSync(dirname(worktreePath), { recursive: true });
	const noHooksDir = join(input.stateDir, "no-hooks");
	if (existsSync(worktreePath))
		throw new WorkspaceError(`Worktree path already exists: ${worktreePath}`);

	// Read the parent's state before creating the worktree, under the lock.
	const { parentDiff, untracked, ignoredDirs } = await withRepoLock(repo.repoRoot, async () => {
		const [parentDiff, untracked, ignored] = await Promise.all([
			git(["diff", ...DIFF_FLAGS, "HEAD"], { cwd: repo.repoRoot, encoding: "buffer" }),
			git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: repo.repoRoot }),
			git(
				["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
				{ cwd: repo.repoRoot },
			),
		]);
		// A resume reuses a removed path whose metadata may remain registered;
		// --force adds over that stale entry without pruning other worktrees.
		await git(["worktree", "add", ...(input.worktreePath ? ["--force"] : []), "--detach", worktreePath, repo.head], {
			cwd: repo.repoRoot,
			noHooksDir,
		});
		return { parentDiff, untracked: splitNul(untracked), ignoredDirs: splitNul(ignored) };
	});
	installExitHook();

	try {
		await writeParentState(input.stateDir, worktreePath, parentDiff);
		for (const path of untracked) {
			copyEntry(join(repo.repoRoot, path), join(worktreePath, path));
		}
		const linkedPaths = linkDependencyDirs(repo.repoRoot, worktreePath, ignoredDirs);
		const childCwd = repo.prefix ? join(worktreePath, repo.prefix) : worktreePath;
		mkdirSync(childCwd, { recursive: true });
		copyProjectConfig(input.cwd, childCwd);

		const ownIndex = (await git(["rev-parse", "--git-path", "index"], { cwd: worktreePath })).trim();
		const baseTree = await snapshotTree({
			worktreePath,
			indexFile: join(input.stateDir, "base.index"),
			from: "HEAD",
			seedIndex: resolve(worktreePath, ownIndex),
			linkedPaths,
		});
		const workspace: PreparedWorkspace = {
			repoRoot: repo.repoRoot,
			worktreePath,
			childCwd,
			baseTree,
			linkedPaths,
			stateDir: input.stateDir,
		};
		liveWorkspaces.set(worktreePath, workspace);
		if (input.seedPatchFile && statSync(input.seedPatchFile).size > 0) {
			try {
				await git([...APPLY_FLAGS, input.seedPatchFile], { cwd: worktreePath });
			} catch (error) {
				throw new WorkspaceError(
					`Could not replay the previous child changes (${input.seedPatchFile}) on the current checkout: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return workspace;
	} catch (error) {
		await removeWorkspace({ repoRoot: repo.repoRoot, worktreePath });
		throw error;
	}
}

/** Parse `--numstat -z` (renames are off, so every record is one field). */
function parseNumstat(output: string): WorkspaceFileChange[] {
	const changes: WorkspaceFileChange[] = [];
	for (const record of output.split("\0")) {
		const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record.replace(/^\n/, ""));
		if (!match) continue;
		changes.push({
			path: match[3],
			added: match[1] === "-" ? null : Number(match[1]),
			deleted: match[2] === "-" ? null : Number(match[2]),
		});
	}
	return changes;
}

/** Diff the worktree against its baseline and save the patch. */
export async function captureWorkspaceChanges(
	workspace: PreparedWorkspace,
): Promise<CapturedChanges> {
	if (!existsSync(workspace.worktreePath))
		throw new WorkspaceError("The worktree was removed before its changes were captured.");
	const resultTree = await snapshotTree({
		worktreePath: workspace.worktreePath,
		indexFile: join(workspace.stateDir, "result.index"),
		from: workspace.baseTree,
		seedIndex: join(workspace.stateDir, "base.index"),
		linkedPaths: workspace.linkedPaths,
	});
	if (resultTree === workspace.baseTree) return { files: [] };
	const [patch, numstat] = await Promise.all([
		git(["diff", ...DIFF_FLAGS, workspace.baseTree, resultTree], {
			cwd: workspace.worktreePath,
			encoding: "buffer",
		}),
		git(["diff", "--numstat", "-z", "--no-renames", "--no-relative", "--ignore-submodules", workspace.baseTree, resultTree], {
			cwd: workspace.worktreePath,
		}),
	]);
	if (patch.length === 0) return { files: [] };
	const patchFile = workspacePatchFile(workspace.stateDir);
	writeFileSync(patchFile, patch, { mode: 0o600 });
	return { files: parseNumstat(numstat), patchFile };
}

/** Remove a worktree and its git metadata. Never throws. */
export async function removeWorkspace(input: { repoRoot: string; worktreePath: string }): Promise<void> {
	try {
		await withRepoLock(input.repoRoot, () =>
			git(["worktree", "remove", "--force", "--force", input.worktreePath], { cwd: input.repoRoot }),
		);
	} catch {
		try {
			// Stale metadata stays "prunable" in `git worktree list`; never prune
			// the user's other worktrees from here.
			rmSync(input.worktreePath, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	}
	liveWorkspaces.delete(input.worktreePath);
}

/**
 * Apply a saved patch to the parent checkout (working tree only, not the
 * index). The patch is checked first, so a conflict changes nothing.
 */
export async function applyWorkspacePatch(input: {
	repoRoot: string;
	patchFile: string;
}): Promise<{ applied: true } | { applied: false; message: string }> {
	return withRepoLock(input.repoRoot, async () => {
		try {
			await git([...APPLY_FLAGS, "--check", input.patchFile], { cwd: input.repoRoot });
		} catch (error) {
			return {
				applied: false as const,
				message: error instanceof Error ? error.message : String(error),
			};
		}
		await git([...APPLY_FLAGS, input.patchFile], { cwd: input.repoRoot });
		return { applied: true as const };
	});
}
