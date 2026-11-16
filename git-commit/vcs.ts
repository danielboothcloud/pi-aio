import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Version control detection without running a binary.
 *
 * The nearest folder (walking up from `cwd`) with a `.jj` or `.git` entry
 * decides. A folder with `.jj` is a Jujutsu (jj) repository, also when it
 * is colocated with `.git`: git commands there bypass jj and must not run.
 * `.git` can be a file (git worktrees, submodules), so only existence counts.
 */
export type VcsKind = "jj" | "git";

export interface VcsInfo {
	kind: VcsKind;
	/** The folder that holds `.jj` or `.git`. */
	root: string;
}

export function findVcs(
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): VcsInfo | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (exists(join(dir, ".jj"))) return { kind: "jj", root: dir };
		if (exists(join(dir, ".git"))) return { kind: "git", root: dir };
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
