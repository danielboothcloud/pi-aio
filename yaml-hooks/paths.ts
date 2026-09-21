// Config path discovery and project-trust resolution. Ported from
// pi-yaml-hooks (MIT), adapted to Pi only: global candidates live under
// <agentDir> (getAgentDir()), project candidates under <project>/.pi.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalizePath } from "./canonicalize.js";
import { ENV } from "./env.js";

export const HOOKS_FILE_NAME = "hooks.yaml";
export const TRUSTED_PROJECTS_FILE_NAME = "trusted-projects.json";

export type HookConfigSourceScope = "global" | "project";

export interface DiscoveredHookConfigPath {
	readonly scope: HookConfigSourceScope;
	readonly filePath: string;
}

export interface HookConfigPaths {
	readonly global?: string;
	readonly project?: string;
}

export interface ProjectHookResolution {
	readonly cwd: string;
	readonly anchorDir: string;
	readonly canonicalCwd: string;
	readonly canonicalAnchorDir: string;
	readonly worktreeRoot?: string;
	readonly discoveredProjectRoot?: string;
	readonly trustFilePath: string;
	readonly projectConfigPath?: string;
	readonly trusted: boolean;
}

export interface HookConfigDiscoveryOptions {
	readonly projectDir?: string;
	readonly exists?: (filePath: string) => boolean;
	readonly readFile?: (filePath: string) => string;
	readonly realpath?: (filePath: string) => string;
	readonly resolveGitWorktreeRoot?: (cwd: string) => string | undefined;
}

export function globalHookDir(): string {
	return path.join(getAgentDir(), "hook");
}

export function globalCandidatePaths(exists: (filePath: string) => boolean): string[] {
	const agentDir = getAgentDir();
	return [
		path.join(agentDir, "hook", HOOKS_FILE_NAME),
		path.join(agentDir, HOOKS_FILE_NAME),
	].filter((filePath) => exists(filePath));
}

export function projectCandidatePaths(projectRoot: string): string[] {
	return [
		path.join(projectRoot, CONFIG_DIR_NAME, "hook", HOOKS_FILE_NAME),
		path.join(projectRoot, CONFIG_DIR_NAME, HOOKS_FILE_NAME),
	];
}

export function trustedProjectsFilePath(): string {
	return path.join(getAgentDir(), TRUSTED_PROJECTS_FILE_NAME);
}

export function resolveHookConfigPaths(options: HookConfigDiscoveryOptions = {}): HookConfigPaths {
	const exists = options.exists ?? existsSync;
	const project = resolveProjectHookResolution(options);
	return {
		global: globalCandidatePaths(exists)[0],
		project: project?.projectConfigPath,
	};
}

/** Resolve the complete set of paths that can affect hook discovery. */
export function resolveHookConfigWatchPaths(options: HookConfigDiscoveryOptions = {}): { paths: string[] } {
	const paths = [
		path.join(getAgentDir(), "hook", HOOKS_FILE_NAME),
		path.join(getAgentDir(), HOOKS_FILE_NAME),
		trustedProjectsFilePath(),
	];

	if (!options.projectDir) {
		return { paths: uniquePaths(paths) };
	}

	const project = resolveProjectHookResolution(options)!;
	for (const dir of ancestorDirs(project.canonicalCwd, project.canonicalAnchorDir)) {
		paths.push(...projectCandidatePaths(dir));
		paths.push(path.join(dir, ".git"));
	}
	return { paths: uniquePaths(paths) };
}

const MAX_WARNED_UNTRUSTED_PROJECTS = 128;
const warnedUntrustedProjects = new Map<string, true>();

function rememberWarnedUntrustedProject(projectDir: string): boolean {
	if (warnedUntrustedProjects.has(projectDir)) {
		warnedUntrustedProjects.delete(projectDir);
		warnedUntrustedProjects.set(projectDir, true);
		return false;
	}
	warnedUntrustedProjects.set(projectDir, true);
	while (warnedUntrustedProjects.size > MAX_WARNED_UNTRUSTED_PROJECTS) {
		const oldest = warnedUntrustedProjects.keys().next().value;
		if (oldest === undefined) break;
		warnedUntrustedProjects.delete(oldest);
	}
	return true;
}

function warnUntrustedProjectOnce(projectDir: string, candidate: string, trustFilePath: string): void {
	if (!rememberWarnedUntrustedProject(projectDir)) return;
	const message =
		`[aio yaml hooks] Skipping untrusted project hooks at ${candidate}.\n` +
		`         To trust this project, either:\n` +
		`           - set PI_YAML_HOOKS_TRUST_PROJECT=1 for this session, or\n` +
		`           - add ${JSON.stringify(projectDir)} to ${trustFilePath}`;
	// eslint-disable-next-line no-console
	console.warn(message);
}

function warnTrustBypassOnce(projectDir: string): void {
	const key = `PI_YAML_HOOKS_TRUST_PROJECT:${projectDir}`;
	if (warnedTrustBypasses.has(key)) return;
	warnedTrustBypasses.add(key);
	const message =
		`[aio yaml hooks] PI_YAML_HOOKS_TRUST_PROJECT=1 is temporarily bypassing project hook trust for ${projectDir}. ` +
		`Trusted project hooks can execute bash and inspect hook context for this session.`;
	// eslint-disable-next-line no-console
	console.warn(message);
}

const warnedTrustBypasses = new Set<string>();

/**
 * Resolve the project scope for a cwd: repo/worktree-aware anchor, the
 * nearest project root containing a hooks file, and the trust decision for
 * that anchor. Returns undefined only when no projectDir was supplied.
 */
export function resolveProjectHookResolution(options: HookConfigDiscoveryOptions = {}): ProjectHookResolution | undefined {
	const projectDir = options.projectDir;
	if (!projectDir) {
		return undefined;
	}

	const exists = options.exists ?? existsSync;
	const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
	const realpath = options.realpath ?? defaultRealpath;
	const cwd = path.resolve(projectDir);
	const canonicalCwd = canonicalizePath(cwd, realpath);
	const worktreeRoot = resolveWorktreeRoot(cwd, options.resolveGitWorktreeRoot, realpath);
	const discoveredProjectRoot = findNearestProjectRoot(canonicalCwd, worktreeRoot, exists);
	const projectConfigPath = discoveredProjectRoot
		? projectCandidatePaths(discoveredProjectRoot).find((filePath) => exists(filePath))
		: undefined;
	const anchorDir = worktreeRoot ?? discoveredProjectRoot ?? cwd;
	const canonicalAnchorDir = canonicalizePath(anchorDir, realpath);
	const trustFilePath = trustedProjectsFilePath();

	const trusted = isProjectTrusted(canonicalAnchorDir, trustFilePath, readFile, realpath);
	if (projectConfigPath && !trusted) {
		warnUntrustedProjectOnce(anchorDir, projectConfigPath, trustFilePath);
	}
	if (projectConfigPath && trusted && ENV.trustProject()) {
		warnTrustBypassOnce(anchorDir);
	}

	return {
		cwd,
		anchorDir,
		canonicalCwd,
		canonicalAnchorDir,
		...(worktreeRoot ? { worktreeRoot } : {}),
		...(discoveredProjectRoot ? { discoveredProjectRoot } : {}),
		trustFilePath,
		...(projectConfigPath ? { projectConfigPath } : {}),
		trusted,
	};
}

// Cache parsed trusted-projects.json keyed on the file's stat fingerprint so
// dispatches do not re-read JSON on every event.
interface CachedTrustList {
	fingerprint: string;
	canonicalEntries: Set<string>;
}
const trustListCache = new Map<string, CachedTrustList>();

export function __resetTrustListCacheForTests(): void {
	trustListCache.clear();
}

function fingerprintTrustFile(trustFile: string): string {
	try {
		const stat = statSync(trustFile, { bigint: true });
		return `${stat.mtimeNs}|${stat.ctimeNs}|${stat.size}|${stat.ino}|${stat.mode}`;
	} catch {
		return "missing";
	}
}

function isProjectTrusted(
	canonicalAnchorDir: string,
	trustFile: string,
	readFile: (filePath: string) => string,
	realpath: (filePath: string) => string,
): boolean {
	if (ENV.trustProject()) {
		return true;
	}

	const fingerprint = fingerprintTrustFile(trustFile);
	const cached = trustListCache.get(trustFile);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.canonicalEntries.has(canonicalAnchorDir);
	}

	const canonicalEntries = new Set<string>();
	try {
		if (existsSync(trustFile)) {
			const parsed: unknown = JSON.parse(readFile(trustFile));
			if (Array.isArray(parsed)) {
				for (const entry of parsed) {
					if (typeof entry !== "string" || !path.isAbsolute(entry)) continue;
					try {
						canonicalEntries.add(canonicalizePath(entry, realpath));
					} catch {
						// Ignore entries that fail to canonicalize.
					}
				}
			}
		}
	} catch {
		// A broken trust file must not take down discovery; treat as empty.
	}
	trustListCache.set(trustFile, { fingerprint, canonicalEntries });
	return canonicalEntries.has(canonicalAnchorDir);
}

export function resolveWorktreeRoot(
	cwd: string,
	injected: ((cwd: string) => string | undefined) | undefined,
	realpath: (filePath: string) => string,
): string | undefined {
	if (injected) {
		return injected(cwd);
	}
	return resolveGitWorktreeRoot(cwd, realpath);
}

/**
 * Best-effort git worktree resolution. `git rev-parse --show-toplevel` is the
 * source of truth; a direct `.git` directory (not a worktree link) is only a
 * fallback for non-git repos that still keep a `.git` marker.
 */
export function resolveGitWorktreeRoot(cwd: string, realpath: (filePath: string) => string): string | undefined {
	try {
		const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (topLevel && path.isAbsolute(topLevel)) {
			try {
				return realpath(topLevel);
			} catch {
				return path.resolve(topLevel);
			}
		}
	} catch {
		// Not a git repo — fall through to the direct .git check.
	}
	const directGit = path.join(cwd, ".git");
	try {
		if (statSync(directGit).isDirectory()) {
			return realpath(cwd);
		}
	} catch {
		// Ignore — no worktree marker.
	}
	return undefined;
}

function findNearestProjectRoot(
	canonicalCwd: string,
	worktreeRoot: string | undefined,
	exists: (filePath: string) => boolean,
): string | undefined {
	// Within a worktree, only the worktree root and its ancestors may carry a
	// project hooks file; otherwise walk all the way to the filesystem root.
	const stopDir = worktreeRoot ?? path.parse(canonicalCwd).root;
	let current = canonicalCwd;
	while (true) {
		if (projectCandidatePaths(current).some((filePath) => exists(filePath))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		if (parent === stopDir) {
			return projectCandidatePaths(parent).some((filePath) => exists(filePath)) ? parent : undefined;
		}
		// Stop at the worktree boundary: hooks files above the worktree root
		// belong to a different project scope.
		if (!pathInside(parent, stopDir) && parent !== stopDir) {
			return undefined;
		}
		current = parent;
	}
}

function pathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function ancestorDirs(start: string, stop: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(start);
	const stopDir = path.resolve(stop);
	while (true) {
		dirs.push(current);
		if (current === stopDir) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths));
}

export function defaultRealpath(filePath: string): string {
	return realpathSync(filePath);
}
