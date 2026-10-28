// ---------------------------------------------------------------------------
// Workspace guard — file mutations outside the active directory need a human.
//
// The agent may freely edit/write/apply_patch inside the session's working
// directory (ctx.cwd) and every directory below it. A target anywhere else —
// an absolute path, `../sibling`, `~/…`, or a symlink inside the workspace
// that points out of it — requires manual approval in EVERY mode, auto
// included. Without a UI to ask (print/JSON runs, subagent children) such a
// mutation is blocked.
//
// Paths are resolved the way Pi's file tools resolve them (leading `@`
// stripped, `~` expanded, relative to the cwd) and then canonicalized through
// the nearest existing ancestor's realpath, so symlinks and `..` cannot
// smuggle a write out of the workspace. When resolution is ambiguous the
// path is treated as outside: this guard fails closed.
//
// Scope: the structured file-mutation tools only. Shell commands (bash,
// hypa_shell) can write anywhere and are governed by the regular mode rules
// and the hard blocklist, not by this guard.
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveApplyPatchChanges } from "../diff-tools/core/cursor-compat.js";

/** Tools whose targets this guard checks. */
export const WORKSPACE_GUARDED_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"apply_patch",
]);

/** Same set Pi's path normalizer folds to a plain space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** One mutation target that falls outside the workspace. */
export interface OutsideTarget {
	/** The path exactly as the tool call wrote it. */
	raw: string;
	/** Canonical absolute path (symlinks resolved where they exist). */
	resolved: string;
}

/** Raw target paths of an edit/write/apply_patch call, in call order. */
export function mutationTargetPaths(
	tool: string,
	input: Record<string, unknown>,
): string[] {
	if (tool === "apply_patch") {
		// The exact parser apply_patch's execute uses, so the guard checks what
		// would actually be written (structured changes or a unified diff).
		return resolveApplyPatchChanges(input).flatMap((change) =>
			change.action === "move" && change.movePath
				? [change.path, change.movePath]
				: [change.path],
		);
	}
	const paths: string[] = [];
	for (const key of ["path", "file_path"] as const) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) paths.push(value);
	}
	return paths;
}

/** Mirror of Pi's tool path resolution (`resolveToCwd`). */
export function resolveToolPath(filePath: string, base: string): string {
	let normalized = filePath.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized);
}

/**
 * Canonicalize a path that may not exist yet: realpath its nearest existing
 * ancestor (following symlinks, normalizing case on macOS) and re-append the
 * missing tail. An existing symlink target is followed, because writing to
 * it writes wherever it points.
 */
export function canonicalPath(target: string): string {
	const tail: string[] = [];
	let current = resolve(target);
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return tail.length > 0 ? join(real, ...tail.reverse()) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(target);
			tail.push(basename(current));
			current = parent;
		}
	}
}

/** True when `target` is `root` or below it. Both must be canonical. */
export function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Targets of a mutation that fall outside `cwd` and every `allowedRoots`
 * entry. Relative paths are checked against both the session cwd and the
 * process cwd (the base Pi's file tools actually use); outside either one
 * counts as outside.
 */
export function findOutsideTargets(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	allowedRoots: Iterable<string> = [],
	processCwd: string = process.cwd(),
): OutsideTarget[] {
	if (!WORKSPACE_GUARDED_TOOLS.has(tool)) return [];
	const roots = [canonicalPath(cwd), ...allowedRoots];
	const bases = [...new Set([resolve(cwd), resolve(processCwd)])];
	const outside: OutsideTarget[] = [];
	const seen = new Set<string>();
	for (const raw of mutationTargetPaths(tool, input)) {
		for (const base of bases) {
			const resolved = canonicalPath(resolveToolPath(raw, base));
			if (roots.some((root) => isWithin(root, resolved))) continue;
			if (!seen.has(resolved)) {
				seen.add(resolved);
				outside.push({ raw, resolved });
			}
		}
	}
	return outside;
}

/** The folder a "this session" approval grants: each target's parent. */
export function approvalScopes(targets: readonly OutsideTarget[]): string[] {
	return [...new Set(targets.map((target) => dirname(target.resolved)))];
}
