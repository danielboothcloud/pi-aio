// /hooks-* commands: status, validate, trust, reload, tail-log. Ported from
// pi-yaml-hooks (MIT), Pi-only.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	__resetTrustListCacheForTests,
	projectCandidatePaths,
	resolveHookConfigPaths,
	resolveProjectHookResolution,
	resolveHookConfigWatchPaths,
	trustedProjectsFilePath,
} from "./paths.js";
import {
	formatHookLoadSummary,
	loadDiscoveredHooks,
	loadHooksFile,
	summarizeHookSources,
} from "./discovery.js";
import { sendHookDiagnostics } from "./diagnostics.js";
import { canonicalizePath } from "./canonicalize.js";

const LOG_FILE_NAME = "aio-yaml-hooks.ndjson";

export function getHookLogFilePath(): string {
	return path.join(getAgentDir(), "logs", LOG_FILE_NAME);
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("hooks-status", {
		description: "Show active hook files, trust state, and log path",
		handler: async (_args, ctx) => {
			const status = getHooksStatus(ctx);
			const lines = [
				`Hooks status for ${status.projectDir}`,
				`Active summary: ${formatHookLoadSummary(status.active.sources)}`,
				`Global config: ${formatStatusPath(status.paths.global)}`,
				`Project config: ${formatStatusPath(status.projectStatusPath)}`,
				`Trust store: ${status.trustFilePath}`,
				`Project trusted: ${status.projectTrusted ? "yes" : "no"}`,
				`Hook log: ${status.logFilePath}`,
			];
			if (status.projectConfigExists && !status.projectTrusted) {
				lines.push("Project hooks exist but are not active until the project is trusted.");
			}
			sendHookDiagnostics(pi, {
				title: "Hook status",
				level: "info",
				content: lines.join("\n"),
				sections: [
					{
						label: "Loaded sources",
						lines: status.active.sources.map(
							(source) => `${source.scope}: ${source.filePath} (${source.hookCount} hooks)`,
						),
					},
				],
			});
		},
	});

	pi.registerCommand("hooks-validate", {
		description: "Validate active and project hook files with actionable feedback",
		handler: async (_args, ctx) => {
			const validation = validateHooks(ctx);
			const lines = [`Hook validation for ${ctx.cwd}`];

			const totalScopedErrors =
				validation.byScope.global.length +
				validation.byScope.project.length +
				validation.byScope.imported.length;

			if (totalScopedErrors === 0) {
				const summary = summarizeHookSources(validation.active.sources);
				lines.push(`Active hooks are valid: ${summary.total} loaded (${summary.global} global, ${summary.project} project).`);
			} else {
				if (validation.byScope.global.length > 0) {
					lines.push("Global hook errors:");
					lines.push(...validation.byScope.global.map(formatValidationError));
				}
				if (validation.byScope.project.length > 0) {
					lines.push("Project hook errors:");
					lines.push(...validation.byScope.project.map(formatValidationError));
				}
				if (validation.byScope.imported.length > 0) {
					lines.push("Imported file errors:");
					lines.push(...validation.byScope.imported.map(formatValidationError));
				}
			}

			if (validation.advisories.length > 0) {
				lines.push("Loader advisories:");
				lines.push(...validation.advisories.map((message) => `- ${message}`));
			}

			if (validation.project.exists && !validation.project.trusted) {
				if (validation.project.errors.length === 0) {
					lines.push(`Project hook file is valid but untrusted: ${validation.project.path}`);
					lines.push(`Run /hooks-trust to add this project to ${trustedProjectsFilePath()}.`);
				} else {
					lines.push(`Project hook file is untrusted and has validation errors: ${validation.project.path}`);
					lines.push(...validation.project.errors.map(formatValidationError));
				}
			} else if (!validation.project.exists) {
				lines.push(`No project hook file is present for the current repo/worktree scope. Create ${validation.project.path}.`);
			}

			const level = totalScopedErrors > 0 || validation.project.errors.length > 0 ? "warning" : "info";
			sendHookDiagnostics(pi, {
				title: "Hook validation",
				level,
				content: lines.join("\n"),
			});
		},
	});

	pi.registerCommand("hooks-trust", {
		description: "Trust the current project hook file",
		handler: async (_args, ctx) => {
			const projectDir = path.resolve(ctx.cwd);
			const project = resolveProjectHookResolution({ projectDir });
			if (!project?.projectConfigPath || !existsSync(project.projectConfigPath)) {
				const projectConfigPath = project?.projectConfigPath ?? path.join(projectDir, ".pi", "hook", "hooks.yaml");
				notifyCommand(ctx, `No project hook file was found for ${projectDir}. Create ${projectConfigPath} first, then run /hooks-trust again.`, "warning");
				return;
			}

			const trustFile = trustedProjectsFilePath();
			const trustAnchor = project.canonicalAnchorDir;
			const updated = updateTrustedProjectsWithLock(trustFile, trustAnchor);
			if (!updated.ok) {
				notifyCommand(
					ctx,
					`Cannot update ${trustFile} because it is not valid JSON. Fix or remove that file, then run /hooks-trust again.`,
					"error",
				);
				return;
			}

			// Invalidate the trust cache so the next event sees the new entry.
			__resetTrustListCacheForTests();
			notifyCommand(
				ctx,
				`Trusted project hooks for ${project.anchorDir}. Trust store: ${trustFile}. Run /hooks-validate or trigger another Pi event to confirm the active hook set.`,
				"info",
			);
		},
	});

	pi.registerCommand("hooks-reload", {
		description: "Reload extensions; edited hooks also refresh lazily on the next relevant event",
		handler: async (_args, ctx) => {
			const message =
				"Reloading Pi extensions. Edited hooks.yaml files also refresh on the next relevant Pi event. In-flight hooks finish under the previously loaded configuration.";
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
			} else {
				// eslint-disable-next-line no-console
				console.info(`[aio yaml hooks] ${message}`);
			}
			await ctx.reload();
		},
	});

	pi.registerCommand("hooks-tail-log", {
		description: "Show the hook log path and a ready-to-run tail command",
		handler: async (args, ctx) => {
			const logFilePath = getHookLogFilePath();
			if (args.trim() === "--path") {
				notifyCommand(ctx, logFilePath, "info");
				return;
			}
			notifyCommand(
				ctx,
				`Hook log: ${logFilePath}\nTail it with: tail -F ${JSON.stringify(logFilePath)}\n(Pass --path to print only the path.)`,
				"info",
			);
		},
	});
}

interface HooksStatus {
	readonly projectDir: string;
	readonly projectTrusted: boolean;
	readonly projectConfigExists: boolean;
	readonly projectStatusPath: string;
	readonly paths: ReturnType<typeof resolveHookConfigPaths>;
	readonly active: ReturnType<typeof loadDiscoveredHooks>;
	readonly logFilePath: string;
	readonly trustFilePath: string;
}

function getHooksStatus(ctx: ExtensionCommandContext): HooksStatus {
	const projectDir = path.resolve(ctx.cwd);
	const paths = resolveHookConfigPaths({ projectDir });
	const active = loadDiscoveredHooks({ projectDir });
	const project = resolveProjectHookResolution({ projectDir });
	const projectStatusPath =
		project?.projectConfigPath ?? path.join(projectDir, ".pi", "hook", "hooks.yaml");
	const projectConfigExists = existsSync(projectStatusPath);
	const projectTrusted = project?.trusted ?? false;

	return {
		projectDir,
		projectTrusted,
		projectConfigExists,
		projectStatusPath,
		paths,
		active,
		logFilePath: getHookLogFilePath(),
		trustFilePath: project?.trustFilePath ?? trustedProjectsFilePath(),
	};
}

interface ScopedValidationErrors {
	readonly global: Array<{ filePath: string; path?: string; message: string }>;
	readonly project: Array<{ filePath: string; path?: string; message: string }>;
	readonly imported: Array<{ filePath: string; path?: string; message: string }>;
}

function validateHooks(ctx: ExtensionCommandContext): {
	readonly active: ReturnType<typeof loadDiscoveredHooks>;
	readonly byScope: ScopedValidationErrors;
	readonly advisories: string[];
	readonly project: {
		readonly exists: boolean;
		readonly trusted: boolean;
		readonly path: string;
		readonly errors: Array<{ filePath: string; path?: string; message: string }>;
	};
} {
	const status = getHooksStatus(ctx);
	const activeProjectRootPaths = new Set(
		status.active.sources
			.filter((source) => source.scope === "project" && source.filePath === status.paths.project)
			.map((source) => source.filePath),
	);
	const activeGlobalRootPaths = new Set(
		status.active.sources
			.filter((source) => source.scope === "global" && source.filePath === status.paths.global)
			.map((source) => source.filePath),
	);
	const projectPath = status.projectStatusPath;
	const projectExists = status.projectConfigExists;
	const trusted = activeProjectRootPaths.has(projectPath);
	const projectErrors = projectExists ? loadHooksFile(projectPath).errors : [];

	// Bucket every error from the active discovery result by source scope;
	// files pulled in via imports land in the imported bucket.
	const byScope: ScopedValidationErrors = { global: [], project: [], imported: [] };
	for (const error of status.active.errors) {
		if (activeGlobalRootPaths.has(error.filePath)) {
			byScope.global.push(error);
		} else if (activeProjectRootPaths.has(error.filePath)) {
			byScope.project.push(error);
		} else {
			byScope.imported.push(error);
		}
	}

	// Re-validate the global file directly: discovery skips a global file with
	// hard parse errors when the project scope succeeds.
	const globalPath = status.paths.global;
	if (globalPath && existsSync(globalPath) && !activeGlobalRootPaths.has(globalPath)) {
		const directGlobal = loadHooksFile(globalPath).errors;
		if (directGlobal.length > 0) {
			const seen = new Set(byScope.global.map((error) => `${error.filePath}#${error.path ?? ""}|${error.message}`));
			for (const error of directGlobal) {
				const key = `${error.filePath}#${error.path ?? ""}|${error.message}`;
				if (!seen.has(key)) {
					seen.add(key);
					byScope.global.push(error);
				}
			}
		}
	}

	const advisories: string[] = [];
	for (const filePath of new Set([...activeGlobalRootPaths, ...activeProjectRootPaths])) {
		const loaded = loadHooksFile(filePath);
		if (loaded.advisories) {
			advisories.push(...loaded.advisories);
		}
	}

	return {
		active: status.active,
		byScope,
		advisories,
		project: {
			exists: projectExists,
			trusted,
			path: projectPath,
			errors: projectErrors,
		},
	};
}

function notifyCommand(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	} else {
		// eslint-disable-next-line no-console
		console.info(`[aio yaml hooks] ${message}`);
	}
}

function formatValidationError(error: { filePath: string; path?: string; message: string }): string {
	return `- ${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`;
}

function formatStatusPath(filePath: string | undefined): string {
	if (!filePath) {
		return "not applicable";
	}
	return existsSync(filePath) ? filePath : `${filePath} (missing)`;
}

function readTrustedProjects(filePath: string): { readonly ok: true; readonly entries: string[] } | { readonly ok: false } {
	try {
		if (!existsSync(filePath)) {
			return { ok: true, entries: [] };
		}
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!Array.isArray(parsed)) {
			return { ok: false };
		}
		return { ok: true, entries: parsed.filter((entry): entry is string => typeof entry === "string") };
	} catch {
		return { ok: false };
	}
}

function updateTrustedProjectsWithLock(filePath: string, trustAnchor: string): { readonly ok: true } | { readonly ok: false } {
	return withTrustedProjectsLock(filePath, () => {
		const current = readTrustedProjects(filePath);
		if (!current.ok) {
			return { ok: false };
		}

		const normalizedCurrent = new Set(current.entries.map(canonicalizeForTrust));
		let isTrustFileSymlink = false;
		try {
			isTrustFileSymlink = lstatSync(filePath).isSymbolicLink();
		} catch {
			// A missing trust file is created below when the anchor is absent.
		}

		if (!normalizedCurrent.has(trustAnchor) || isTrustFileSymlink) {
			const nextEntries = normalizedCurrent.has(trustAnchor) ? current.entries : [...current.entries, trustAnchor];
			const nextContent = `${JSON.stringify(nextEntries, null, 2)}\n`;
			writeFileSync(filePath, nextContent, { encoding: "utf8", mode: 0o600 });
		}
		return { ok: true };
	});
}

function withTrustedProjectsLock<T>(filePath: string, run: () => T): T {
	const dir = path.dirname(filePath);
	mkdirSync(dir, { recursive: true });
	const lockDir = path.join(dir, `${path.basename(filePath)}.lock`);
	const deadline = Date.now() + 5_000;
	while (true) {
		try {
			mkdirSync(lockDir, 0o700);
			break;
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: "";
			if (code !== "EEXIST" || Date.now() >= deadline) {
				throw error;
			}
			sleepSync(25);
		}
	}

	try {
		return run();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

function sleepSync(ms: number): void {
	const view = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(view, 0, 0, ms);
}

function canonicalizeForTrust(filePath: string): string {
	return canonicalizePath(filePath, (p) => path.resolve(realpathSync.native(p)));
}

// Watch-path resolution is exercised through discovery; keep the export
// referenced so the surface stays wired.
void resolveHookConfigWatchPaths;
void projectCandidatePaths;
