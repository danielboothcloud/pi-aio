// Discovery + snapshot loading: find the one global and (trusted) project
// root config, expand imports, parse, merge, resolve overrides, and cache
// results by a stat fingerprint of everything that can affect the result.
// Ported from pi-yaml-hooks (MIT); Pi-only discovery.

import { statSync } from "node:fs";
import path from "node:path";
import type {
	HookMap,
	HookOverrideEntry,
	HookPolicy,
	HookValidationError,
} from "./types.js";
import type {
	DiscoveredHooksFileSnapshot,
	HookConfigSourceScope,
	ProjectImportContainment,
} from "./imports.js";
import { expandSnapshotImports } from "./imports.js";
import type { ParsedHooksFileEnvelope } from "./yaml-envelope.js";
import { defaultReadFile, formatHookReadError } from "./yaml-envelope.js";
import {
	dedupeValidationErrors,
	loadHooksFile,
	mergeHookMaps,
	mergeHookMapsInto,
	resolveOverrides,
	setActiveHookPolicy,
} from "./composition.js";
import type { HookConfigDiscoveryOptions, ProjectHookResolution } from "./paths.js";
import { globalCandidatePaths } from "./paths.js";
import { projectCandidatePaths, resolveProjectHookResolution } from "./paths.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HookSourceSummary {
	readonly scope: HookConfigSourceScope;
	readonly filePath: string;
	readonly hookCount: number;
}

export interface HookLoadSummary {
	readonly total: number;
	readonly global: number;
	readonly project: number;
}

export interface HookDiscoveryResult {
	readonly hooks: HookMap;
	readonly errors: HookValidationError[];
	readonly advisories: string[];
	readonly sources: HookSourceSummary[];
	readonly files: string[];
	readonly watchPaths: string[];
	readonly signature: string;
}

export interface HookLoadOptions extends HookConfigDiscoveryOptions {
	readonly policy?: HookPolicy;
	/** Skip the trust gate for the project scope (for /hooks-validate previews). */
	readonly ignoreTrust?: boolean;
}

export interface HookLoadSnapshot extends HookDiscoveryResult {}

// Cache parsed trusted-projects-style results keyed on a stat fingerprint.
interface SnapshotCacheEntry {
	fingerprint: string;
	result: HookDiscoveryResult;
}
const snapshotCache = new Map<string, SnapshotCacheEntry>();

export function __resetSnapshotCacheForTests(): void {
	snapshotCache.clear();
}

export function __snapshotCacheSizeForTests(): number {
	return snapshotCache.size;
}

/**
 * Load active hooks for a cwd with discovery, imports, overrides, and cache.
 * Returns cached results until a watched path's stat fingerprint changes.
 */
export function loadDiscoveredHooks(options: HookLoadOptions): HookDiscoveryResult {
	const projectDir = options.projectDir ? path.resolve(options.projectDir) : undefined;
	const watchPaths = computeWatchPaths(options, projectDir);
	const fingerprint = computeStatFingerprint(watchPaths);

	const cacheKey = projectDir ?? "<global-only>";
	const cached = snapshotCache.get(cacheKey);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.result;
	}

	const result = loadDiscoveredHooksFresh(options, projectDir, watchPaths);
	snapshotCache.set(cacheKey, { fingerprint, result });
	return result;
}

/** Convenience wrapper returning a stable snapshot object. */
export function loadDiscoveredHooksSnapshot(options: HookLoadOptions): HookLoadSnapshot {
	return loadDiscoveredHooks(options);
}

function loadDiscoveredHooksFresh(
	options: HookLoadOptions,
	projectDir: string | undefined,
	watchPaths: string[],
): HookDiscoveryResult {
	if (options.policy) {
		setActiveHookPolicy(options.policy);
	}

	const exists = options.exists ?? ((filePath: string) => {
		try {
			return statSync(filePath).isFile();
		} catch {
			return false;
		}
	});
	const readFile = options.readFile ?? defaultReadFile;

	const envelopeCache = new Map<string, ParsedHooksFileEnvelope>();
	const loadedFiles = new Set<string>();
	const sources: HookSourceSummary[] = [];
	const files: string[] = [];
	const errors: HookValidationError[] = [];
	const advisories: string[] = [];
	const orderedSnapshots: DiscoveredHooksFileSnapshot[] = [];
	const overrides: HookOverrideEntry[] = [];
	const globalScopeHooks: HookMap = new Map();
	const projectScopeHooks: HookMap = new Map();
	const scopeHooks = (scope: HookConfigSourceScope): HookMap =>
		scope === "global" ? globalScopeHooks : projectScopeHooks;

	const globalPath = globalCandidatePaths(exists)[0];
	if (globalPath) {
		orderedSnapshots.push(...expandRootSnapshot(
			"global",
			globalPath,
			readFile,
			errors,
			loadedFiles,
			envelopeCache,
			undefined,
		));
	}

	let projectResolution: ProjectHookResolution | undefined;
	if (projectDir) {
		projectResolution = resolveProjectHookResolution(options);
		const projectPath = projectResolution?.projectConfigPath;
		const projectTrusted = options.ignoreTrust ? true : (projectResolution?.trusted ?? false);
		if (projectPath) {
			if (projectTrusted) {
				const containment: ProjectImportContainment = {
					canonicalAnchorDir: projectResolution?.canonicalAnchorDir,
				};
				orderedSnapshots.push(...expandRootSnapshot(
					"project",
					projectPath,
					readFile,
					errors,
					loadedFiles,
					envelopeCache,
					containment,
				));
			} else if (!options.ignoreTrust) {
				errors.push({
					code: "invalid_frontmatter",
					filePath: projectPath,
					message: `Project hooks file exists but the project is untrusted; run /hooks-trust or set PI_YAML_HOOKS_TRUST_PROJECT=1.`,
					path: "trust",
				});
			}
		}
	}

	for (const snapshot of orderedSnapshots) {
		if (!("content" in snapshot)) {
			errors.push({
				code: "invalid_frontmatter",
				filePath: snapshot.filePath,
				message: snapshot.readError,
			});
			continue;
		}

		// Parse exactly once per load. Load order (global roots and imports
		// first, then project roots and imports) matches upstream merge
		// semantics so project overrides can target global hook ids.
		const parsed = loadHooksFile(snapshot.filePath, () => snapshot.content);
		errors.push(...parsed.errors);
		if (parsed.advisories) {
			advisories.push(...parsed.advisories);
		}

		if (parsed.hooks.size > 0) {
			mergeHookMapsInto(scopeHooks(snapshot.scope), parsed.hooks);
		}
		if (parsed.overrides.length > 0) {
			overrides.push(...parsed.overrides);
		}
		if (parsed.hooks.size > 0 || parsed.overrides.length > 0) {
			const hookCount = countHooks(parsed.hooks);
			sources.push({ scope: snapshot.scope, filePath: snapshot.filePath, hookCount });
		}
		files.push(snapshot.filePath);
	}

	// Merge global hooks first so project overrides can target them, then
	// resolve overrides across the union.
	const merged = mergeHookMaps(globalScopeHooks, projectScopeHooks);
	const resolved = resolveOverrides(merged, overrides);
	errors.push(...resolved.errors);

	const signature = JSON.stringify({
		files: [...files].sort(),
		errors: errors.length,
		hooks: countHooks(resolved.hooks),
		overrides: overrides.length,
	});

	return {
		hooks: resolved.hooks,
		errors: dedupeValidationErrors(errors),
		advisories: Array.from(new Set(advisories)),
		sources,
		files: Array.from(new Set(files)),
		watchPaths,
		signature,
	};
}

function countHooks(hooks: HookMap): number {
	let total = 0;
	for (const hookList of hooks.values()) {
		total += hookList.length;
	}
	return total;
}

function expandRootSnapshot(
	scope: HookConfigSourceScope,
	filePath: string,
	readFile: (filePath: string) => string,
	errors: HookValidationError[],
	loadedFiles: Set<string>,
	envelopeCache: Map<string, ParsedHooksFileEnvelope>,
	containment: ProjectImportContainment | undefined,
): DiscoveredHooksFileSnapshot[] {
	let content: string;
	try {
		content = readFile(filePath);
	} catch (error) {
		errors.push({
			code: "invalid_frontmatter",
			filePath,
			message: formatHookReadError(error),
		});
		return [];
	}

	const root: DiscoveredHooksFileSnapshot = { scope, filePath, content };
	const expanded = expandSnapshotImports(root, loadedFiles, envelopeCache, containment);
	errors.push(...expanded.errors);
	return expanded.snapshots;
}

function computeWatchPaths(_options: HookConfigDiscoveryOptions, projectDir: string | undefined): string[] {
	const watchPaths = new Set<string>();
	for (const candidate of globalCandidatePaths((filePath) => pathExists(filePath))) {
		watchPaths.add(candidate);
	}
	watchPaths.add(globalCandidateDir());
	if (projectDir) {
		for (const dir of walkAncestors(projectDir)) {
			for (const candidate of projectCandidatePaths(dir)) {
				watchPaths.add(candidate);
			}
			watchPaths.add(path.join(dir, ".git"));
		}
	}
	return Array.from(watchPaths);
}

function globalCandidateDir(): string {
	return globalCandidatePaths((filePath) => pathExists(filePath)).length > 0
		? path.dirname(globalCandidatePaths((filePath) => pathExists(filePath))[0])
		: path.join(getAgentDirSafe(), "hook");
}

function getAgentDirSafe(): string {
	try {
		return getAgentDir();
	} catch {
		return path.join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), ".pi", "agent");
	}
}

function walkAncestors(start: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(start);
	while (true) {
		dirs.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function pathExists(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function computeStatFingerprint(files: readonly string[]): string {
	if (files.length === 0) {
		return "";
	}
	const parts: string[] = [];
	for (const filePath of files) {
		try {
			const stat = statSync(filePath, { bigint: true });
			parts.push(`${filePath}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.size}|${stat.ino}|${stat.mode}`);
		} catch {
			parts.push(`${filePath}|missing`);
		}
	}
	return parts.join("\n");
}

export function formatHookLoadSummary(sources: readonly HookSourceSummary[]): string {
	const summary = summarizeHookSources(sources);
	return `${summary.total} hooks (${summary.global} global, ${summary.project} project)`;
}

export function summarizeHookSources(sources: readonly HookSourceSummary[]): HookLoadSummary {
	let global = 0;
	let project = 0;
	for (const source of sources) {
		if (source.scope === "global") {
			global += source.hookCount;
		} else {
			project += source.hookCount;
		}
	}
	return { total: global + project, global, project };
}

export type { HookConfig } from "./types.js";
