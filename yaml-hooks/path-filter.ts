// Path-condition evaluation: matchesCodeFiles / matchesAnyPath /
// matchesAllPaths over project-relative globs. Ported from pi-yaml-hooks (MIT).

import { extname, isAbsolute, matchesGlob, relative } from "node:path";
import type { HookCondition } from "./types.js";

export const CODE_EXTENSIONS = new Set([
	".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
	".json", ".jsonc", ".json5", ".yml", ".yaml", ".toml", ".xml", ".ini",
	".cfg", ".conf", ".properties", ".css", ".scss", ".sass", ".less",
	".html", ".vue", ".svelte", ".astro", ".mdx", ".graphql", ".gql",
	".proto", ".sql", ".prisma", ".go", ".rs", ".zig", ".c", ".h", ".cpp",
	".cc", ".cxx", ".hpp", ".java", ".groovy", ".gradle", ".py", ".rb",
	".php", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".psd1",
	".bat", ".cmd", ".kt", ".kts", ".swift", ".m", ".mm", ".cs", ".fs",
	".scala", ".clj", ".hs", ".lua", ".dart", ".elm", ".ex", ".exs",
	".erl", ".hrl", ".nim", ".nix", ".r", ".rkt", ".tf", ".tfvars",
]);

export function hasCodeExtension(filePath: string): boolean {
	const extension = extname(filePath).toLowerCase();
	return Boolean(extension && CODE_EXTENSIONS.has(extension));
}

export interface PathMatchContext {
	readonly changedPaths: readonly string[];
	readonly hasCodeFiles: boolean;
}

export interface PathConditionFailure {
	readonly reason:
		| "matchesCodeFiles_failed"
		| "matchesAnyPath_no_paths"
		| "matchesAnyPath_failed"
		| "matchesAllPaths_no_paths"
		| "matchesAllPaths_failed";
	readonly patterns?: readonly string[];
}

/**
 * Evaluate a hook's path conditions against an already-built match context.
 * Returns undefined when every condition passed, or the first failure.
 */
export function evaluatePathConditions(
	conditions: readonly HookCondition[] | undefined,
	pathMatchContext: PathMatchContext,
): PathConditionFailure | undefined {
	const changedPaths = pathMatchContext.changedPaths;

	for (const condition of conditions ?? []) {
		if (condition === "matchesCodeFiles") {
			if (!pathMatchContext.hasCodeFiles) {
				return { reason: "matchesCodeFiles_failed" };
			}
			continue;
		}

		if ("matchesAnyPath" in condition) {
			if (changedPaths.length === 0) {
				return { reason: "matchesAnyPath_no_paths", patterns: condition.matchesAnyPath };
			}
			if (!changedPaths.some((filePath) => condition.matchesAnyPath.some((pattern) => matchesGlob(filePath, pattern)))) {
				return { reason: "matchesAnyPath_failed", patterns: condition.matchesAnyPath };
			}
			continue;
		}

		if (changedPaths.length === 0) {
			return { reason: "matchesAllPaths_no_paths", patterns: condition.matchesAllPaths };
		}
		if (!changedPaths.every((filePath) => condition.matchesAllPaths.some((pattern) => matchesGlob(filePath, pattern)))) {
			return { reason: "matchesAllPaths_failed", patterns: condition.matchesAllPaths };
		}
	}

	return undefined;
}

/** Derive the changed-path set and hasCodeFiles flag for a dispatch context. */
export function buildPathMatchContext(
	projectDir: string,
	files: readonly string[] | undefined,
	changes: readonly { operation: string; path?: string; fromPath?: string; toPath?: string }[] | undefined,
): PathMatchContext {
	const changedPaths = getFinalChangedPaths(projectDir, files, changes);
	return {
		changedPaths,
		hasCodeFiles: changedPaths.some(hasCodeExtension),
	};
}

export function getFinalChangedPaths(
	projectDir: string,
	files: readonly string[] | undefined,
	changes: readonly { operation: string; path?: string; fromPath?: string; toPath?: string }[] | undefined,
): string[] {
	if (changes && changes.length > 0) {
		return changes.map((change) =>
			normalizeConditionPath(
				projectDir,
				change.operation === "rename" ? (change.toPath ?? change.path ?? "") : (change.path ?? ""),
			),
		);
	}
	return (files ?? []).map((filePath) => normalizeConditionPath(projectDir, filePath));
}

/**
 * Normalize a glob candidate: project-inside absolute paths become
 * project-relative with forward slashes; outside paths stay absolute.
 */
export function normalizeConditionPath(projectDir: string, filePath: string): string {
	const normalizedPath = normalizeGlobCandidate(filePath);
	if (!isAbsolute(filePath)) {
		return normalizedPath;
	}

	const projectRelativePath = normalizeGlobCandidate(relative(projectDir, filePath));
	if (projectRelativePath !== "" && projectRelativePath !== "." && !projectRelativePath.startsWith("../")) {
		return projectRelativePath;
	}

	return normalizedPath;
}

export function normalizeGlobCandidate(filePath: string): string {
	return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}
