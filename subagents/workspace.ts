import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findVcs } from "../git-commit/vcs.js";
import {
	baseToken,
	captureJjWorkspace,
	prepareJjWorkspace,
	removeJjWorkspace,
	resolveJjRepo,
	type JjRepoInfo,
} from "./jj-workspace.js";
import {
	APPLY_FLAGS,
	ceilingEnv,
	copyProjectConfig,
	DIFF_FLAGS,
	excludePathspecs,
	git,
	gitSync,
	linkDependencyDirs,
	NUMSTAT_FLAGS,
	parseNumstat,
	replaySeedPatch,
	splitNul,
	trackLiveWorkspace,
	untrackLiveWorkspace,
	withRepoLock,
	workspacePatchFile,
	WorkspaceError,
	type CapturedChanges,
	type GitWorkspace,
	type PreparedWorkspace,
} from "./workspace-common.js";

export {
	removeLiveWorkspacesSync,
	untrackLiveWorkspace,
	withRepoLock,
	workspacePatchFile,
	WorkspaceError,
	type CapturedChanges,
	type PreparedWorkspace,
} from "./workspace-common.js";

/**
 * Workspace isolation for subagent children, for two version control
 * systems. The nearest `.jj` or `.git` folder decides (see findVcs): a
 * Jujutsu (jj) repository, also a colocated one, gets a jj workspace
 * (jj-workspace.ts); any other git repository gets a git worktree.
 *
 * Git: a child gets a detached worktree at the parent's HEAD, plus the
 * parent's uncommitted tracked changes and untracked (not ignored) files. A
 * baseline tree is recorded through a private index, so the child's own git
 * index still matches HEAD, as in the parent. After the child, the worktree
 * is hashed again and the difference becomes a patch for `git apply`.
 *
 * Ignored dependency directories (node_modules, virtual environments) are
 * symlinked from the parent so tests can run. They are shared, not isolated.
 */

export { LINKED_DEPENDENCY_DIRS } from "./workspace-common.js";

export interface GitRepoInfo {
	vcs: "git";
	repoRoot: string;
	/** cwd relative to the repository root, with a trailing slash or empty. */
	prefix: string;
	head: string;
}

export type RepoInfo = GitRepoInfo | JjRepoInfo;

async function resolveGitRepo(cwd: string): Promise<GitRepoInfo> {
	let repoRoot: string;
	let prefix: string;
	try {
		repoRoot = (await git(["rev-parse", "--show-toplevel"], { cwd })).trim();
		prefix = (await git(["rev-parse", "--show-prefix"], { cwd })).trim();
	} catch {
		throw new WorkspaceError(
			`isolation=worktree requires a git or Jujutsu (jj) repository, but ${cwd} is not inside one.`,
		);
	}
	let head: string;
	try {
		head = (await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: repoRoot })).trim();
	} catch {
		throw new WorkspaceError(
			"isolation=worktree requires a git repository with at least one commit.",
		);
	}
	if (!repoRoot || !head)
		throw new WorkspaceError("isolation=worktree could not resolve the repository HEAD.");
	return { vcs: "git", repoRoot, prefix, head };
}

/**
 * Resolve the repository for a cwd; throws a clear error when isolation is
 * impossible (no repository, an empty git repository, or a jj repository
 * whose `jj` command does not run).
 */
export async function resolveRepo(cwd: string): Promise<RepoInfo> {
	return findVcs(cwd)?.kind === "jj" ? resolveJjRepo(cwd) : resolveGitRepo(cwd);
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

/**
 * Synchronous capture for process exit: save the patch (an empty file means
 * "no changes"), so a later resume can replay the interrupted child's edits.
 */
function captureGitWorkspaceSync(workspace: GitWorkspace): void {
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

function removeGitWorkspaceSync(workspace: GitWorkspace): void {
	try {
		gitSync(["worktree", "remove", "--force", "--force", workspace.worktreePath], workspace.repoRoot);
	} catch {
		rmSync(workspace.worktreePath, { recursive: true, force: true });
	}
}

/** Replay the parent's uncommitted tracked changes in the worktree. */
async function writeParentState(stateDir: string, worktreePath: string, parentDiff: Buffer): Promise<void> {
	if (parentDiff.length === 0) return;
	const parentPatch = join(stateDir, "parent-state.patch");
	writeFileSync(parentPatch, parentDiff, { mode: 0o600 });
	await git([...APPLY_FLAGS, parentPatch], { cwd: worktreePath });
}

interface PrepareInput {
	cwd: string;
	stateDir: string;
	name: string;
	/** A previous partial patch to replay on top of the baseline (manual resume). */
	seedPatchFile?: string;
	/** Reuse an exact (removed) worktree path; a resumed session stores it as cwd. */
	worktreePath?: string;
	repo?: RepoInfo;
}

/**
 * Create an isolated workspace for one child: a jj workspace in a Jujutsu
 * repository, else a git worktree. `stateDir` is runner-owned and holds the
 * workspace, private index files, and patches.
 */
export async function prepareWorkspace(input: PrepareInput): Promise<PreparedWorkspace> {
	const repo = input.repo ?? (await resolveRepo(input.cwd));
	mkdirSync(input.stateDir, { recursive: true });
	const worktreePath = input.worktreePath ?? join(input.stateDir, input.name);
	mkdirSync(dirname(worktreePath), { recursive: true });
	if (existsSync(worktreePath))
		throw new WorkspaceError(`Worktree path already exists: ${worktreePath}`);
	if (repo.vcs === "jj")
		return prepareJjWorkspace({ ...input, repo, worktreePath });
	return prepareGitWorkspace({ ...input, repo, worktreePath });
}

async function prepareGitWorkspace(
	input: PrepareInput & { repo: GitRepoInfo; worktreePath: string },
): Promise<GitWorkspace> {
	const { repo, worktreePath } = input;
	const noHooksDir = join(input.stateDir, "no-hooks");
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
		const workspace: GitWorkspace = {
			vcs: "git",
			repoRoot: repo.repoRoot,
			worktreePath,
			childCwd,
			baseTree,
			linkedPaths,
			stateDir: input.stateDir,
		};
		trackLiveWorkspace(worktreePath, {
			captureSync: () => captureGitWorkspaceSync(workspace),
			removeSync: () => removeGitWorkspaceSync(workspace),
		});
		await replaySeedPatch(worktreePath, input.seedPatchFile);
		return workspace;
	} catch (error) {
		await removeGitWorkspace({ repoRoot: repo.repoRoot, worktreePath });
		throw error;
	}
}

/** Diff the workspace against its baseline and save the patch. */
export async function captureWorkspaceChanges(
	workspace: PreparedWorkspace,
): Promise<CapturedChanges> {
	if (!existsSync(workspace.worktreePath))
		throw new WorkspaceError("The worktree was removed before its changes were captured.");
	if (workspace.vcs === "jj") return captureJjWorkspace(workspace);
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
		git(["diff", ...NUMSTAT_FLAGS, workspace.baseTree, resultTree], {
			cwd: workspace.worktreePath,
		}),
	]);
	if (patch.length === 0) return { files: [] };
	const patchFile = workspacePatchFile(workspace.stateDir);
	writeFileSync(patchFile, patch, { mode: 0o600 });
	return { files: parseNumstat(numstat), patchFile };
}

async function removeGitWorkspace(input: { repoRoot: string; worktreePath: string }): Promise<void> {
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
	untrackLiveWorkspace(input.worktreePath);
}

/** Remove a workspace and its metadata. Never throws. */
export async function removeWorkspace(workspace: PreparedWorkspace): Promise<void> {
	if (workspace.vcs === "jj") return removeJjWorkspace(workspace);
	return removeGitWorkspace(workspace);
}

/** How a user removes a workspace that was kept on disk. */
export function workspaceRemovalHint(input: {
	vcs?: "git" | "jj";
	repoRoot?: string;
	worktreePath?: string;
	workspaceName?: string;
}): string {
	const path = input.worktreePath ?? "<path>";
	const name = input.workspaceName ?? "<name>";
	return input.vcs === "jj"
		? `jj workspace forget ${name} && jj abandon '${`description(substring:${JSON.stringify(`${baseToken(name)} `)})::`}' (in ${input.repoRoot ?? "the repository"}), then delete ${path}`
		: `git -C ${input.repoRoot ?? "<repo>"} worktree remove --force ${path}`;
}

/**
 * Apply a saved patch to the parent checkout (working tree only, not the
 * index). The patch is checked first, so a conflict changes nothing. In a
 * jj repository without `.git`, git discovery stops at the repository root.
 */
export async function applyWorkspacePatch(input: {
	repoRoot: string;
	patchFile: string;
	vcs?: "git" | "jj";
}): Promise<{ applied: true } | { applied: false; message: string }> {
	const env = input.vcs === "jj" ? ceilingEnv(input.repoRoot) : undefined;
	return withRepoLock(input.repoRoot, async () => {
		try {
			await git([...APPLY_FLAGS, "--check", input.patchFile], { cwd: input.repoRoot, env });
		} catch (error) {
			return {
				applied: false as const,
				message: error instanceof Error ? error.message : String(error),
			};
		}
		await git([...APPLY_FLAGS, input.patchFile], { cwd: input.repoRoot, env });
		return { applied: true as const };
	});
}
