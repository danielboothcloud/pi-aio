import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WorkspaceFileChange } from "./types.js";

/**
 * Shared pieces of the git-worktree and jj-workspace isolation backends:
 * the git runner (both backends produce `git apply` patches), the per-repo
 * lock, dependency linking, project config copying, and the process-exit
 * registry for live workspaces.
 */

/** Ignored directories linked (not copied) into the worktree. */
export const LINKED_DEPENDENCY_DIRS: readonly string[] = [
	"node_modules",
	".venv",
	"venv",
];
/** Project config directory copied in when the worktree does not have it. */
const PROJECT_CONFIG_DIR = ".pi";
export const MAX_COMMAND_OUTPUT = 512 * 1024 * 1024;

interface WorkspaceCommon {
	repoRoot: string;
	worktreePath: string;
	/** The worktree directory that corresponds to the parent's cwd. */
	childCwd: string;
	/** Worktree-relative paths of the linked dependency directories. */
	linkedPaths: string[];
	/** Private directory for index files and patches. */
	stateDir: string;
}

export interface GitWorkspace extends WorkspaceCommon {
	vcs: "git";
	baseTree: string;
}

export interface JjWorkspace extends WorkspaceCommon {
	vcs: "jj";
	/** The jj executable used for this workspace. */
	jj: string;
	/** jj's git store (colocated `.git` or `.jj/repo/store/git`). */
	gitDir: string;
	/** jj workspace name (unique per run child). */
	name: string;
	/** Change id of the frozen base commit (sibling of the parent's @). */
	baseChange: string;
	/** Commit id of the base at preparation; diffs always start here. */
	baseCommit: string;
	/**
	 * Repo-relative files AIO copied in (missing `.pi` files). Untracked in
	 * the parent, so not in the base: the diff must never return them.
	 */
	copiedPaths: string[];
	/** The parent cwd the workspace was created from (its @ is the user's). */
	parentCwd: string;
}

export type PreparedWorkspace = GitWorkspace | JjWorkspace;

export interface CapturedChanges {
	files: WorkspaceFileChange[];
	patchFile?: string;
}

export class WorkspaceError extends Error {}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Git environment without inherited repository overrides. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
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

/**
 * Keep git discovery inside `dir`: `git apply` in a folder without `.git`
 * (a non-colocated jj workspace) then patches files relative to that folder
 * instead of finding an unrelated outer repository.
 */
export function ceilingEnv(dir: string): Record<string, string> {
	return { GIT_CEILING_DIRECTORIES: dirname(dir) };
}

export interface GitOptions {
	cwd: string;
	env?: Record<string, string>;
	encoding?: "utf8" | "buffer";
	/** A nonexistent hooks directory: worktree/checkout hooks never run. */
	noHooksDir?: string;
}

export function git(args: string[], options: GitOptions & { encoding: "buffer" }): Promise<Buffer>;
export function git(args: string[], options: GitOptions): Promise<string>;
export function git(args: string[], options: GitOptions): Promise<string | Buffer> {
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
				maxBuffer: MAX_COMMAND_OUTPUT,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr ?? "").trim() || error.message;
					reject(new WorkspaceError(`git ${args.find((arg) => !arg.startsWith("-")) ?? args[0]} failed: ${detail}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export function gitSync(args: string[], cwd: string, env: Record<string, string> = {}): Buffer {
	return execFileSync("git", ["-C", cwd, ...args], {
		env: gitEnv(env),
		maxBuffer: MAX_COMMAND_OUTPUT,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
}

// One writer per repository at a time: worktree/workspace metadata, and the
// parent checkout during merges, must never see concurrent writers from this
// process.
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

export function splitNul(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

export function excludePathspecs(linkedPaths: readonly string[]): string[] {
	return linkedPaths.map((path) => `:(exclude,literal)${path}`);
}

export const DIFF_FLAGS = [
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

export const NUMSTAT_FLAGS = ["--numstat", "-z", "--no-renames", "--no-relative", "--ignore-submodules"];

export const APPLY_FLAGS = ["apply", "--binary", "--whitespace=nowarn"];

/** Parse `--numstat -z` (renames are off, so every record is one field). */
export function parseNumstat(output: string): WorkspaceFileChange[] {
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

/** Where a child's patch is saved. Written even when empty at process exit. */
export function workspacePatchFile(stateDir: string): string {
	return join(stateDir, "changes.patch");
}

/** Replay a saved partial patch in a fresh worktree (manual resume). */
export async function replaySeedPatch(worktreePath: string, seedPatchFile: string | undefined): Promise<void> {
	if (!seedPatchFile || statSync(seedPatchFile).size === 0) return;
	try {
		await git([...APPLY_FLAGS, seedPatchFile], { cwd: worktreePath, env: ceilingEnv(worktreePath) });
	} catch (error) {
		throw new WorkspaceError(
			`Could not replay the previous child changes (${seedPatchFile}) on the current checkout: ${errorMessage(error)}`,
		);
	}
}

/** Symlink ignored dependency directories so the child can build and test. */
export function linkDependencyDirs(repoRoot: string, worktreePath: string, ignoredDirs: readonly string[]): string[] {
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
 * only the files the worktree does not have yet (tracked files are already
 * present). Returns the copied paths relative to `childCwd`.
 */
export function copyProjectConfig(parentCwd: string, childCwd: string): string[] {
	const copied: string[] = [];
	const walk = (relativeDir: string) => {
		const source = join(parentCwd, relativeDir);
		for (const entry of readdirSync(source)) {
			const rel = join(relativeDir, entry);
			const from = join(parentCwd, rel);
			const to = join(childCwd, rel);
			const stat = lstatSync(from);
			if (stat.isDirectory()) {
				walk(rel);
				continue;
			}
			if (existsSync(to) || (!stat.isFile() && !stat.isSymbolicLink())) continue;
			mkdirSync(dirname(to), { recursive: true });
			if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
			else copyFileSync(from, to);
			copied.push(rel.split("\\").join("/"));
		}
	};
	if (existsSync(join(parentCwd, PROJECT_CONFIG_DIR))) walk(PROJECT_CONFIG_DIR);
	return copied;
}

/** Synchronous handlers for a live workspace at process exit. */
export interface LiveWorkspaceHandlers {
	/** Save the patch (an empty file means "no changes"). */
	captureSync: () => void;
	/** Remove the workspace and its metadata. */
	removeSync: () => void;
}

const liveWorkspaces = new Map<string, LiveWorkspaceHandlers>();
let exitHookInstalled = false;

export function trackLiveWorkspace(worktreePath: string, handlers: LiveWorkspaceHandlers): void {
	liveWorkspaces.set(worktreePath, handlers);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => removeLiveWorkspacesSync());
}

export function untrackLiveWorkspace(worktreePath: string): void {
	liveWorkspaces.delete(worktreePath);
}

/**
 * Process exit with children still running: save each live workspace's
 * changes as a patch, then remove the workspace. A workspace whose capture
 * fails stays on disk. Best effort and synchronous.
 */
export function removeLiveWorkspacesSync(): void {
	for (const handlers of liveWorkspaces.values()) {
		try {
			handlers.captureSync();
		} catch {
			// Keep the workspace: removing it now would lose the child's edits.
			// Resume refuses while it exists and tells the user to inspect it.
			continue;
		}
		try {
			handlers.removeSync();
		} catch {
			// Best effort.
		}
	}
	liveWorkspaces.clear();
}
