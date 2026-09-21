// Root-file import expansion with cycle detection, depth caps, and trust
// gating. Ported from pi-yaml-hooks (MIT); the Pi trust store is the only
// trust surface.

import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { HookValidationError } from "./types.js";
import { MAX_HOOKS_YAML_BYTES } from "./yaml-envelope.js";
import type { ParsedHooksFileEnvelope } from "./yaml-envelope.js";
import { defaultReadFile, formatHookReadError, parseHooksFileEnvelope } from "./yaml-envelope.js";
import { createError } from "./schema.js";
import { ENV } from "./env.js";
import { canonicalizePath } from "./canonicalize.js";

export type HookConfigSourceScope = "global" | "project";

export type DiscoveredHooksFileSnapshot =
	| { readonly scope: HookConfigSourceScope; readonly filePath: string; readonly content: string }
	| { readonly scope: HookConfigSourceScope; readonly filePath: string; readonly readError: string };

/** Import depth cap, well above any legitimate layering chain. */
export const MAX_IMPORT_DEPTH = 32;

export interface ProjectImportContainment {
	/** Canonical trust-anchor directory for the loaded project file, when known. */
	readonly canonicalAnchorDir?: string;
}

export function expandSnapshotImports(
	snapshot: DiscoveredHooksFileSnapshot,
	loadedFiles: Set<string>,
	envelopeCache: Map<string, ParsedHooksFileEnvelope>,
	projectContainment: ProjectImportContainment | undefined,
): { snapshots: DiscoveredHooksFileSnapshot[]; errors: HookValidationError[]; watchPaths: string[] } {
	const ordered: DiscoveredHooksFileSnapshot[] = [];
	const errors: HookValidationError[] = [];
	const watchPaths = new Set<string>();
	const visiting = new Set<string>();

	const visit = (current: DiscoveredHooksFileSnapshot, depth: number): void => {
		if (depth > MAX_IMPORT_DEPTH) {
			errors.push(
				createError(
					current.filePath,
					"invalid_imports",
					`Import depth limit reached at ${current.filePath} (>${MAX_IMPORT_DEPTH}); refusing to recurse further.`,
					"imports",
				),
			);
			return;
		}
		const canonicalPath = canonicalizePath(current.filePath);
		if (loadedFiles.has(canonicalPath)) {
			return;
		}
		if (visiting.has(canonicalPath)) {
			errors.push(createError(current.filePath, "invalid_imports", `Import cycle detected involving ${current.filePath}.`, "imports"));
			return;
		}

		visiting.add(canonicalPath);
		const imported = readSnapshotImports(current, errors, envelopeCache, projectContainment, watchPaths);
		for (const next of imported) {
			visit(next, depth + 1);
		}
		visiting.delete(canonicalPath);

		if (!loadedFiles.has(canonicalPath)) {
			loadedFiles.add(canonicalPath);
			ordered.push(current);
		}
	};

	visit(snapshot, 0);
	return { snapshots: ordered, errors, watchPaths: Array.from(watchPaths) };
}

export function readSnapshotImports(
	snapshot: DiscoveredHooksFileSnapshot,
	errors: HookValidationError[],
	envelopeCache: Map<string, ParsedHooksFileEnvelope>,
	projectContainment: ProjectImportContainment | undefined,
	watchPaths: Set<string>,
): DiscoveredHooksFileSnapshot[] {
	if (!("content" in snapshot)) {
		return [];
	}

	const envelope = getOrParseEnvelope(snapshot.filePath, snapshot.content, envelopeCache);
	// Only surface envelope errors the first time we cache them.
	errors.push(...envelope.errors);
	if (envelope.errors.length > 0) {
		return [];
	}

	const imports: DiscoveredHooksFileSnapshot[] = [];
	for (const specifier of envelope.imports) {
		const resolved = resolveHookImportTargets(snapshot.filePath, specifier, snapshot.scope);
		for (const watchPath of resolved.watchPaths) {
			watchPaths.add(watchPath);
		}
		if (resolved.error) {
			errors.push(resolved.error);
			continue;
		}
		for (const filePath of resolved.filePaths) {
			// Imports declared in a project hooks file may not escape the
			// project's trust anchor (path-traversal guard).
			if (snapshot.scope === "project") {
				const containment = checkProjectImportContainment(
					snapshot.filePath,
					filePath,
					projectContainment?.canonicalAnchorDir,
					specifier,
				);
				if (containment) {
					errors.push(containment);
					continue;
				}
			}
			try {
				// Pre-read size guard; parseHooksFileEnvelope re-checks after read.
				const importStat = statSync(filePath);
				if (importStat.size > (MAX_HOOKS_YAML_BYTES as number)) {
					errors.push(
						createError(
							snapshot.filePath,
							"invalid_imports",
							`[aio yaml hooks] imported hooks file ${filePath} exceeds the ${MAX_HOOKS_YAML_BYTES as number}-byte size cap (got ${importStat.size} bytes); refusing to read.`,
							"imports",
						),
					);
					continue;
				}
			} catch {
				// statSync errors fall through to defaultReadFile which surfaces them.
			}
			try {
				imports.push({ scope: snapshot.scope, filePath, content: defaultReadFile(filePath) });
			} catch (error) {
				imports.push({ scope: snapshot.scope, filePath, readError: formatHookReadError(error) });
			}
		}
	}

	return imports;
}

export function getOrParseEnvelope(
	filePath: string,
	content: string,
	envelopeCache: Map<string, ParsedHooksFileEnvelope>,
): ParsedHooksFileEnvelope {
	const canonicalKey = canonicalizePath(filePath);
	const cached = envelopeCache.get(canonicalKey);
	if (cached) {
		return cached;
	}
	const envelope = parseHooksFileEnvelope(filePath, content);
	envelopeCache.set(canonicalKey, envelope);
	return envelope;
}

const warnedImportBypasses = new Set<string>();

function warnImportBypassOnce(env: string, boundary: string, details: Record<string, unknown>): void {
	const key = `${env}:${boundary}`;
	if (warnedImportBypasses.has(key)) return;
	warnedImportBypasses.add(key);
	const message = `[aio yaml hooks] ${env}=1 bypasses ${boundary}. Imported hooks may execute bash with the importing hook's trust.`;
	// eslint-disable-next-line no-console
	console.warn(message);
	void details;
}

// Trust-anchor containment helper. Returns an error when the resolved import
// target falls outside the project trust anchor (and the override env is not
// set); returns undefined when the import is allowed.
function checkProjectImportContainment(
	importerPath: string,
	resolvedTargetPath: string,
	anchor: string | undefined,
	specifier: string,
): HookValidationError | undefined {
	if (ENV.allowProjectImportsOutsideAnchor()) {
		warnImportBypassOnce("PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR", "project import trust anchor", {
			importerPath,
			resolvedTargetPath,
			specifier,
		});
		return undefined;
	}
	if (!anchor) {
		return undefined;
	}
	const canonicalTarget = canonicalizePath(resolvedTargetPath);
	if (isPathInsideAnchor(canonicalTarget, anchor)) {
		return undefined;
	}
	return createError(
		importerPath,
		"invalid_imports",
		`[aio yaml hooks] Refusing to resolve project import ${JSON.stringify(specifier)} → ${canonicalTarget}: target escapes the trust anchor ${anchor}. Move the file inside the project, or set PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1 to opt in.`,
		"imports",
	);
}

function isPathInsideAnchor(target: string, anchor: string): boolean {
	// path.relative returns "" when target === anchor, "../foo" when outside,
	// and a relative descent otherwise. The isAbsolute check rejects
	// "/anchor-extra" as inside "/anchor".
	if (target === anchor) return true;
	const rel = path.relative(anchor, target);
	if (rel === "" || rel === ".") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

// Imports declared inside the global hooks.yaml are refused by default;
// a stray import there is effectively an unsanctioned escalation.
function isGlobalImportsAllowed(): boolean {
	const allowed = ENV.allowGlobalImports();
	if (allowed) {
		warnImportBypassOnce("PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS", "global hooks import boundary", {});
	}
	return allowed;
}

// Bare-specifier (npm package) imports resolve through Node's module
// resolution and require an explicit opt-in.
function isPackageImportsAllowed(): boolean {
	const allowed = ENV.allowPackageImports();
	if (allowed) {
		warnImportBypassOnce("PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS", "package import boundary", {});
	}
	return allowed;
}

function isBareSpecifier(specifier: string): boolean {
	if (specifier.startsWith(".")) return false;
	if (path.isAbsolute(specifier)) return false;
	return true;
}

export function resolveHookImportTargets(
	importerPath: string,
	specifier: string,
	importerScope: HookConfigSourceScope,
): { filePaths: string[]; watchPaths: string[]; error?: HookValidationError } {
	if (importerScope === "global" && !isGlobalImportsAllowed()) {
		return {
			filePaths: [],
			watchPaths: [],
			error: createError(
				importerPath,
				"invalid_imports",
				`[aio yaml hooks] Refusing to resolve import ${JSON.stringify(specifier)} from the global hooks file. Global imports are disabled by default; set PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1 to opt in.`,
				"imports",
			),
		};
	}

	if (isBareSpecifier(specifier) && !isPackageImportsAllowed()) {
		return {
			filePaths: [],
			watchPaths: [],
			error: createError(
				importerPath,
				"invalid_imports",
				`[aio yaml hooks] Refusing to resolve package import ${JSON.stringify(specifier)}. Bare-specifier (npm package) imports are disabled by default; use a relative path or set PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1 to opt in.`,
				"imports",
			),
		};
	}

	let resolvedPath: string | undefined;
	try {
		resolvedPath = !isBareSpecifier(specifier)
			? path.resolve(path.dirname(importerPath), specifier)
			: createRequire(importerPath).resolve(specifier, { paths: [path.dirname(importerPath)] });
		const filePaths = expandHookImportPath(resolvedPath);
		return { filePaths, watchPaths: [resolvedPath, ...filePaths] };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			filePaths: [],
			watchPaths: resolvedPath === undefined ? [] : [resolvedPath],
			error: createError(importerPath, "invalid_imports", `Failed to resolve import ${JSON.stringify(specifier)}: ${detail}`, "imports"),
		};
	}
}

// Directory imports must only pick up real hook files: .yaml/.yml only,
// dotfiles skipped so OS metadata and editor swap files stay out.
function isImportableHookEntry(entryName: string): boolean {
	if (entryName.startsWith(".")) {
		return false;
	}
	const lower = entryName.toLowerCase();
	return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

export function expandHookImportPath(resolvedPath: string): string[] {
	const stat = statSync(resolvedPath);
	if (stat.isDirectory()) {
		return [...readdirSync(resolvedPath)]
			.sort((a, b) => a.localeCompare(b))
			.map((entry) => path.join(resolvedPath, entry))
			.filter((entryPath) => isImportableHookEntry(path.basename(entryPath)))
			.filter((entryPath) => statSync(entryPath).isFile());
	}
	return [resolvedPath];
}
