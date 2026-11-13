/**
 * Git plumbing for /git. Every call goes through an injected `GitRunner`
 * so tests can run against a scratch repository (or a fake). Commands run
 * from the repository root so every path is root-relative.
 *
 * Grouped commits use a temporary index file: for each group the index is
 * rebuilt from HEAD plus that group's STAGED entries, then `git commit`
 * runs against it (hooks still run). The real index is never rewritten, so
 * partial (hunk-level) staging and the staged state of other groups survive.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitRunOptions {
	env?: Record<string, string>;
	input?: string;
}

export type GitRunner = (args: string[], options?: GitRunOptions) => Promise<GitResult>;

export function createGitRunner(cwd: string): GitRunner {
	return (args, options = {}) =>
		new Promise((resolve) => {
			const child = spawn("git", args, {
				cwd,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					GIT_OPTIONAL_LOCKS: "0",
					...options.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr || error.message }));
			child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
			child.stdin.on("error", () => {});
			child.stdin.end(options.input ?? "");
		});
}

export class GitError extends Error {}

async function must(git: GitRunner, args: string[], options?: GitRunOptions): Promise<string> {
	const result = await git(args, options);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
		throw new GitError(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
	}
	return result.stdout;
}

/** Repository root of `cwd`, or undefined outside a work tree. */
export async function findRepoRoot(cwd: string, makeRunner = createGitRunner): Promise<string | undefined> {
	const result = await makeRunner(cwd)(["rev-parse", "--show-toplevel"]);
	const root = result.stdout.trim();
	return result.code === 0 && root ? root : undefined;
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface ChangedFile {
	/** Root-relative path (the new path for renames and copies). */
	path: string;
	/** Source path of a rename or copy. */
	oldPath?: string;
	status: ChangeStatus;
	added?: number;
	deleted?: number;
	binary?: boolean;
}

function splitZ(text: string): string[] {
	const parts = text.split("\0");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

/** Parses `git diff --name-status -z -M`. */
export function parseNameStatus(text: string): ChangedFile[] {
	const parts = splitZ(text);
	const files: ChangedFile[] = [];
	for (let index = 0; index < parts.length; ) {
		const code = parts[index++] ?? "";
		const status = (code[0] ?? "M") as ChangeStatus;
		if (status === "R" || status === "C") {
			const oldPath = parts[index++] ?? "";
			const path = parts[index++] ?? "";
			files.push({ path, oldPath, status });
		} else {
			files.push({ path: parts[index++] ?? "", status });
		}
	}
	return files.filter((file) => file.path);
}

/** Parses `git diff --numstat -z -M` into new-path keyed line counts. */
export function parseNumstat(text: string): Map<string, { added?: number; deleted?: number; binary: boolean }> {
	const parts = splitZ(text);
	const stats = new Map<string, { added?: number; deleted?: number; binary: boolean }>();
	for (let index = 0; index < parts.length; ) {
		const head = parts[index++] ?? "";
		const [added = "", deleted = "", inline = ""] = head.split("\t");
		let path = inline;
		if (!inline) {
			index++; // rename source
			path = parts[index++] ?? "";
		}
		const binary = added === "-" && deleted === "-";
		stats.set(path, {
			added: binary ? undefined : Number(added),
			deleted: binary ? undefined : Number(deleted),
			binary,
		});
	}
	return stats;
}

export async function stagedFiles(git: GitRunner): Promise<ChangedFile[]> {
	const [names, numstat] = await Promise.all([
		must(git, ["diff", "--cached", "--name-status", "-z", "-M", "--no-ext-diff", "--no-relative"]),
		must(git, ["diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff", "--no-relative"]),
	]);
	const stats = parseNumstat(numstat);
	return parseNameStatus(names).map((file) => ({ ...file, ...stats.get(file.path) }));
}

/** Paths with unstaged or untracked changes (porcelain v1). */
export async function unstagedPaths(git: GitRunner): Promise<string[]> {
	const parts = splitZ(await must(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
	const paths: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index] ?? "";
		const x = entry[0];
		const y = entry[1];
		if (x === "R" || x === "C") index++; // the source path follows
		if (y !== " " || x === "?") paths.push(entry.slice(3));
	}
	return paths;
}

export async function stageAll(git: GitRunner): Promise<void> {
	await must(git, ["add", "-A"]);
}

/** A merge, cherry-pick, revert, or rebase that must be finished with plain git. */
export async function pendingOperation(git: GitRunner): Promise<string | undefined> {
	for (const [ref, label] of [
		["MERGE_HEAD", "a merge"],
		["CHERRY_PICK_HEAD", "a cherry-pick"],
		["REVERT_HEAD", "a revert"],
		["REBASE_HEAD", "a rebase"],
	] as const) {
		const result = await git(["rev-parse", "-q", "--verify", ref]);
		if (result.code === 0) return label;
	}
	return undefined;
}

export async function currentBranch(git: GitRunner): Promise<string> {
	const result = await git(["branch", "--show-current"]);
	return result.stdout.trim() || "detached HEAD";
}

export async function recentSubjects(git: GitRunner, count = 15): Promise<string[]> {
	const result = await git(["log", `-n${count}`, "--format=%s"]);
	return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

/** Staged diff, split per file, each file and the whole capped. */
export async function stagedDiff(git: GitRunner, options: { perFile?: number; total?: number } = {}): Promise<string> {
	const perFile = options.perFile ?? 4000;
	const total = options.total ?? 30_000;
	const diff = await must(git, [
		"diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--no-relative", "--unified=2",
	]);
	const chunks = diff.split(/(?=^diff --git )/m).filter(Boolean);
	let out = "";
	for (const chunk of chunks) {
		const piece = chunk.length > perFile
			? `${chunk.slice(0, perFile)}\n[... ${chunk.length - perFile} more characters of this file omitted]\n`
			: chunk;
		if (out.length + piece.length > total) {
			out += `\n[... diff truncated: ${chunks.length} files in total]\n`;
			break;
		}
		out += piece;
	}
	return out;
}

/** Every index path a group touches: new paths plus rename sources. */
export function groupPaths(files: readonly ChangedFile[]): string[] {
	const paths = new Set<string>();
	for (const file of files) {
		paths.add(file.path);
		if (file.oldPath && file.status === "R") paths.add(file.oldPath);
	}
	return [...paths];
}

const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };

/**
 * Commits exactly the staged state of `files` with `message`, leaving every
 * other staged change in the real index. Returns the new short hash.
 */
export async function commitFiles(git: GitRunner, files: readonly ChangedFile[], message: string): Promise<string> {
	const paths = groupPaths(files);
	if (paths.length === 0) throw new GitError("the commit group has no files");
	let indexFile = (await must(git, ["rev-parse", "--git-path", "aio-git-commit.index"])).trim();
	if (!isAbsolute(indexFile)) {
		const root = (await must(git, ["rev-parse", "--show-toplevel"])).trim();
		indexFile = join(root, indexFile);
	}
	const temp = { ...LITERAL, GIT_INDEX_FILE: indexFile };
	await rm(indexFile, { force: true });
	try {
		const hasHead = (await git(["rev-parse", "-q", "--verify", "HEAD"])).code === 0;
		await must(git, hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], { env: temp });
		const staged = await must(git, ["ls-files", "-s", "-z", "--", ...paths], { env: LITERAL });
		const present = new Set(splitZ(staged).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
		if (staged) await must(git, ["update-index", "-z", "--index-info"], { env: temp, input: staged });
		const removed = paths.filter((path) => !present.has(path));
		if (removed.length > 0) {
			await must(git, ["update-index", "-z", "--force-remove", "--stdin"], {
				env: temp,
				input: `${removed.join("\0")}\0`,
			});
		}
		await must(git, ["commit", "--quiet", "--cleanup=whitespace", "-F", "-"], { env: temp, input: message });
		return (await must(git, ["rev-parse", "--short", "HEAD"])).trim();
	} finally {
		await rm(indexFile, { force: true });
	}
}
