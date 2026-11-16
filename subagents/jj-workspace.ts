import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findVcs } from "../git-commit/vcs.js";
import {
	copyProjectConfig,
	DIFF_FLAGS,
	errorMessage,
	excludePathspecs,
	git,
	gitSync,
	linkDependencyDirs,
	MAX_COMMAND_OUTPUT,
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
	type JjWorkspace,
} from "./workspace-common.js";

/**
 * Jujutsu (jj) workspace isolation for subagent children.
 *
 * Verified against jj 0.47 (colocated and non-colocated repositories):
 *
 * 1. A frozen base: `jj new --no-edit -m <token> 'root()'` plus
 *    `jj restore --from @ --into <base>` makes a commit with @'s current
 *    content on top of the root commit. Nothing the parent does can
 *    auto-rebase it: a child of @ would follow every parent snapshot, and a
 *    sibling of @ would follow rewrites of @- (jj squash, describe @-,
 *    rebase), which also makes the child workspace stale. A conflicted @ is
 *    refused: its git tree holds jj's internal `.jjconflict-*` folders.
 * 2. `jj workspace add --no-colocate --name <n> -r <base> <path>`: the child
 *    edits a working-copy commit on top of the base. `--no-colocate` keeps
 *    git worktree metadata out of a colocated `.git`.
 * 3. Capture snapshots the child workspace with `snapshot.auto-track="all()"`
 *    and a large `snapshot.max-new-file-size`, so new files are never left
 *    untracked by user config. jj commit ids are git commit ids, so
 *    `git diff --binary <base> <wc>` on jj's git store gives an exact patch.
 *    (`jj diff --git` writes "Binary files differ", which git apply rejects.)
 * 4. The linked node_modules symlink is tracked by jj (a dir-only ignore
 *    pattern does not match a symlink), so the diff excludes linked paths.
 * 5. Removal: `jj workspace forget <n>`, `jj abandon <base>::`, delete the
 *    folder. Both use --ignore-working-copy: they never rewrite the parent's
 *    @, so the parent's working copy is not snapshotted mid-edit.
 */

export interface JjRepoInfo {
	vcs: "jj";
	/** The workspace root that holds `.jj` (may be a secondary workspace). */
	repoRoot: string;
	/** cwd relative to the root, with a trailing slash or empty. */
	prefix: string;
	jj: string;
	gitDir: string;
}

/** The jj executable: `AIO_JJ_BINARY`, else `jj` from PATH. */
export function jjBinary(env: Record<string, string | undefined> = process.env): string {
	return env.AIO_JJ_BINARY?.trim() || "jj";
}

const BASE_COMMON_FLAGS = ["--no-pager", "--color=never"];
/** Capture-time snapshot settings; user config could leave new files untracked. */
const CAPTURE_CONFIG = [
	"--config",
	'snapshot.auto-track="all()"',
	"--config",
	'snapshot.max-new-file-size="1GiB"',
];

function jjArgs(args: string[]): string[] {
	return [...BASE_COMMON_FLAGS, ...args];
}

/** "jj <subcommand>" for errors; skips flag values such as --config ones. */
function commandLabel(args: readonly string[]): string {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--config" || arg === "-r" || arg === "-T" || arg === "-m") {
			index++;
			continue;
		}
		if (!arg.startsWith("-")) return arg;
	}
	return args[0] ?? "";
}

function jj(binary: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			jjArgs(args),
			{ cwd, encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr ?? "").trim() || error.message;
					reject(new WorkspaceError(`jj ${commandLabel(args)} failed: ${detail}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

function jjSync(binary: string, args: string[], cwd: string): string {
	return execFileSync(binary, jjArgs(args), {
		cwd,
		encoding: "utf8",
		maxBuffer: MAX_COMMAND_OUTPUT,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
}

/** The repository directory: `.jj/repo` is a pointer file in secondary workspaces. */
function jjRepoDir(root: string): string {
	const repo = join(root, ".jj", "repo");
	if (statSync(repo).isDirectory()) return repo;
	const target = readFileSync(repo, "utf8").trim();
	return isAbsolute(target) ? target : resolve(root, ".jj", target);
}

/** jj's git store; jj repositories on other backends cannot be isolated. */
function jjGitDir(root: string): string {
	const store = join(jjRepoDir(root), "store");
	const targetFile = join(store, "git_target");
	if (!existsSync(targetFile))
		throw new WorkspaceError(
			`isolation=worktree supports jj repositories with the git backend only; ${root} has no ${targetFile}.`,
		);
	const target = readFileSync(targetFile, "utf8").trim();
	return isAbsolute(target) ? target : resolve(store, target);
}

/** Resolve a jj repository; throws when `jj` does not run or the store is unusable. */
export async function resolveJjRepo(cwd: string, env: Record<string, string | undefined> = process.env): Promise<JjRepoInfo> {
	const vcs = findVcs(cwd);
	if (vcs?.kind !== "jj")
		throw new WorkspaceError(`${cwd} is not inside a Jujutsu (jj) repository.`);
	const binary = jjBinary(env);
	try {
		await jj(binary, ["--version"], cwd);
	} catch (error) {
		throw new WorkspaceError(
			`isolation=worktree found a Jujutsu (jj) repository at ${vcs.root}, but the jj command did not run (${errorMessage(error)}). Install jj, make it available in this folder (for example with mise), or set AIO_JJ_BINARY.`,
		);
	}
	const rel = relative(vcs.root, resolve(cwd));
	return {
		vcs: "jj",
		repoRoot: vcs.root,
		prefix: rel ? `${rel.split(sep).join("/")}/` : "",
		jj: binary,
		gitDir: jjGitDir(vcs.root),
	};
}

/** Ignored dependency directories, read through jj's git store. */
async function ignoredDirs(repo: JjRepoInfo, stateDir: string): Promise<string[]> {
	// A private, nonexistent index: never read or write a colocated .git/index.
	const output = await git(
		[
			"--git-dir", repo.gitDir,
			"--work-tree", repo.repoRoot,
			"ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory",
		],
		{ cwd: repo.repoRoot, env: { GIT_INDEX_FILE: join(stateDir, "ls-files.index") } },
	);
	return splitNul(output);
}

/** The description token of a child's base commit (also used in removal hints). */
export function baseToken(name: string): string {
	return `aio-subagent-base ${name}`;
}

const isConflicted = async (binary: string, revision: string, cwd: string) =>
	(await jj(binary, ["log", "--no-graph", "--ignore-working-copy", "-r", revision, "-T", "conflict"], cwd)).trim() === "true";

/**
 * Best-effort cleanup of a partly created workspace: forget it, abandon the
 * commits found by the unique token, and delete the folder.
 */
async function discardPartial(repo: JjRepoInfo, parentCwd: string, name: string, token: string, worktreePath: string): Promise<void> {
	await jj(repo.jj, ["workspace", "forget", "--quiet", "--ignore-working-copy", name], parentCwd).catch(() => undefined);
	await jj(repo.jj, ["abandon", "--quiet", "--ignore-working-copy", `description(substring:${JSON.stringify(token)})::`], parentCwd).catch(() => undefined);
	rmSync(worktreePath, { recursive: true, force: true });
}

/** Create the frozen base and the child workspace. Runs under the repo lock. */
async function createJjWorkspace(input: {
	repo: JjRepoInfo;
	parentCwd: string;
	name: string;
	worktreePath: string;
}): Promise<{ baseChange: string; baseCommit: string }> {
	const { repo, parentCwd, name, worktreePath } = input;
	const token = `${baseToken(name)} ${randomUUID()}`;
	const lookup = `visible_heads() & description(substring:${JSON.stringify(token)})`;
	await jj(repo.jj, ["new", "--quiet", "--no-edit", "-m", token, "root()"], parentCwd);
	try {
		const baseChange = (await jj(repo.jj, ["log", "--no-graph", "--ignore-working-copy", "-r", lookup, "-T", "change_id"], parentCwd)).trim();
		if (!/^[a-z]+$/.test(baseChange))
			throw new WorkspaceError(`Could not find the new jj base commit (${baseChange || "no output"}).`);
		await jj(repo.jj, ["restore", "--quiet", "--from", "@", "--into", baseChange], parentCwd);
		if (await isConflicted(repo.jj, baseChange, parentCwd))
			throw new WorkspaceError(
				"The working-copy commit (@) has unresolved conflicts. Resolve them before you start isolated subagents: a conflicted commit cannot be copied into a workspace and patched back safely.",
			);
		const add = ["workspace", "add", "--quiet", "--name", name, "-m", `aio subagent ${name} (temporary)`, "-r", baseChange];
		try {
			await jj(repo.jj, [...add.slice(0, 2), "--no-colocate", ...add.slice(2), worktreePath], parentCwd);
		} catch (error) {
			// jj before workspace colocation has no --no-colocate flag.
			if (!/unexpected argument '--no-colocate'/.test(errorMessage(error))) throw error;
			await jj(repo.jj, [...add, worktreePath], parentCwd);
		}
		const baseCommit = (await jj(repo.jj, ["log", "--no-graph", "--ignore-working-copy", "-r", baseChange, "-T", "commit_id"], parentCwd)).trim();
		return { baseChange, baseCommit };
	} catch (error) {
		await discardPartial(repo, parentCwd, name, token, worktreePath);
		throw error;
	}
}

export async function prepareJjWorkspace(input: {
	cwd: string;
	stateDir: string;
	name: string;
	worktreePath: string;
	seedPatchFile?: string;
	repo: JjRepoInfo;
}): Promise<JjWorkspace> {
	const { repo, worktreePath } = input;
	// jj workspace names must be unique; one run child owns one name.
	const name = input.name;
	const { baseChange, baseCommit, ignored } = await withRepoLock(repo.repoRoot, async () => {
		const ignored = await ignoredDirs(repo, input.stateDir);
		const created = await createJjWorkspace({ repo, parentCwd: input.cwd, name, worktreePath });
		return { ...created, ignored };
	});
	const workspace: JjWorkspace = {
		vcs: "jj",
		repoRoot: repo.repoRoot,
		worktreePath,
		childCwd: repo.prefix ? join(worktreePath, repo.prefix) : worktreePath,
		linkedPaths: [],
		stateDir: input.stateDir,
		jj: repo.jj,
		gitDir: repo.gitDir,
		name,
		baseChange,
		baseCommit,
		copiedPaths: [],
		parentCwd: input.cwd,
	};
	try {
		workspace.linkedPaths = linkDependencyDirs(repo.repoRoot, worktreePath, ignored);
		mkdirSync(workspace.childCwd, { recursive: true });
		workspace.copiedPaths = copyProjectConfig(input.cwd, workspace.childCwd).map((path) => `${repo.prefix}${path}`);
		trackLiveWorkspace(worktreePath, {
			captureSync: () => captureJjWorkspaceSync(workspace),
			removeSync: () => removeJjWorkspaceSync(workspace),
		});
		await replaySeedPatch(worktreePath, input.seedPatchFile);
		return workspace;
	} catch (error) {
		await removeJjWorkspace(workspace);
		throw error;
	}
}

function diffArgs(workspace: JjWorkspace, wcCommit: string, flags: readonly string[]): string[] {
	const excludes = excludePathspecs([...workspace.linkedPaths, ...workspace.copiedPaths]);
	return [
		"--git-dir", workspace.gitDir,
		"diff", ...flags, workspace.baseCommit, wcCommit,
		...(excludes.length ? ["--", ...excludes] : []),
	];
}

const CONFLICT_REFUSAL =
	"The child's working-copy commit has jj conflicts; its git tree holds jj's internal conflict folders, so the patch would be wrong";

/** Snapshot the child workspace (forcing auto-track) and return its @ commit id. */
async function snapshotChild(workspace: JjWorkspace): Promise<string> {
	const [commit, conflict] = (await jj(
		workspace.jj,
		[...CAPTURE_CONFIG, "log", "--no-graph", "-r", "@", "-T", 'commit_id ++ " " ++ conflict'],
		workspace.worktreePath,
	)).trim().split(" ");
	if (conflict === "true") throw new WorkspaceError(CONFLICT_REFUSAL);
	return commit;
}

export async function captureJjWorkspace(workspace: JjWorkspace): Promise<CapturedChanges> {
	const wcCommit = await withRepoLock(workspace.repoRoot, () => snapshotChild(workspace));
	const [patch, numstat] = await Promise.all([
		git(diffArgs(workspace, wcCommit, DIFF_FLAGS), { cwd: workspace.repoRoot, encoding: "buffer" }),
		git(diffArgs(workspace, wcCommit, NUMSTAT_FLAGS), { cwd: workspace.repoRoot }),
	]);
	if (patch.length === 0) return { files: [] };
	const patchFile = workspacePatchFile(workspace.stateDir);
	writeFileSync(patchFile, patch, { mode: 0o600 });
	return { files: parseNumstat(numstat), patchFile };
}

function captureJjWorkspaceSync(workspace: JjWorkspace): void {
	const [wcCommit, conflict] = jjSync(
		workspace.jj,
		[...CAPTURE_CONFIG, "log", "--no-graph", "-r", "@", "-T", 'commit_id ++ " " ++ conflict'],
		workspace.worktreePath,
	).trim().split(" ");
	if (conflict === "true") throw new WorkspaceError(CONFLICT_REFUSAL);
	const patch = gitSync(diffArgs(workspace, wcCommit, DIFF_FLAGS), workspace.repoRoot);
	writeFileSync(workspacePatchFile(workspace.stateDir), patch, { mode: 0o600 });
}

const FORGET = (workspace: JjWorkspace) => ["workspace", "forget", "--quiet", "--ignore-working-copy", workspace.name];
const ABANDON = (workspace: JjWorkspace) => ["abandon", "--quiet", "--ignore-working-copy", `${workspace.baseChange}::`];

function removeJjWorkspaceSync(workspace: JjWorkspace): void {
	for (const args of [FORGET(workspace), ABANDON(workspace)]) {
		try {
			jjSync(workspace.jj, args, workspace.parentCwd);
		} catch {
			// Best effort at process exit.
		}
	}
	rmSync(workspace.worktreePath, { recursive: true, force: true });
}

/** Forget the workspace, abandon its temporary commits, delete the folder. Never throws. */
export async function removeJjWorkspace(workspace: JjWorkspace): Promise<void> {
	await withRepoLock(workspace.repoRoot, async () => {
		for (const args of [FORGET(workspace), ABANDON(workspace)]) {
			try {
				await jj(workspace.jj, args, workspace.parentCwd);
			} catch {
				// A leftover record shows in `jj workspace list`; keep going.
			}
		}
	});
	try {
		rmSync(workspace.worktreePath, { recursive: true, force: true });
	} catch {
		// Best effort.
	}
	untrackLiveWorkspace(workspace.worktreePath);
}
