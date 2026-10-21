import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";
import { cliArgsFromArgv } from "../recipes/trampoline.js";

export const AIO_EXTENSION_PATH = fileURLToPath(
	new URL("../index.ts", import.meta.url),
);

function parseExtraExtensionPaths(): string[] {
	const raw = process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS?.trim();
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function resolveCursorExtensionPath(): string | undefined {
	const fromEnv = process.env.AIO_SUBAGENT_CURSOR_EXTENSION?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	const candidates = [
		join(
			homedir(),
			".config",
			"pi",
			"npm",
			"node_modules",
			"pi-cursor-sdk",
			"src",
			"index.ts",
		),
		join(
			homedir(),
			".config",
			"pi",
			"npm",
			"node_modules",
			"pi-cursor-sdk",
			"dist",
			"index.js",
		),
	];
	try {
		candidates.push(
			join(
				dirname(getAgentDir()),
				"npm",
				"node_modules",
				"pi-cursor-sdk",
				"src",
				"index.ts",
			),
		);
	} catch {
		// getAgentDir() can fail in unusual test harnesses.
	}
	return candidates.find((candidate) => existsSync(candidate));
}

/** How a subagent child loads extensions. */
export interface ChildExtensionLaunch {
	/**
	 * Pass `--no-extensions`. Mirrors the parent: when the parent loaded its
	 * configured packages (settings.json), the child loads the same set; when
	 * the parent ran with `-ne` (e.g. a recipe relaunch), only `paths` load.
	 */
	noExtensions: boolean;
	/** Explicit `--extension` entries, in load order. */
	paths: string[];
}

const PACKAGE_SOURCE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The parent process's own `--no-extensions`/`--extension` flags. Local
 * paths are resolved against the parent's cwd so the child (which may run
 * elsewhere) loads the same files; package specs (`npm:`, `git:`) pass through.
 */
export function parentExtensionFlags(
	argv: string[] = process.argv,
	cwd: string = process.cwd(),
): { noExtensions: boolean; extensions: string[] } {
	const parsed = parseArgs(cliArgsFromArgv(argv));
	return {
		noExtensions: parsed.noExtensions === true,
		extensions: (parsed.extensions ?? []).map((entry) =>
			PACKAGE_SOURCE.test(entry) ? entry : resolve(cwd, entry),
		),
	};
}

export function resolveChildExtensionLaunch(input: {
	modelProvider?: string;
	argv?: string[];
	cwd?: string;
}): ChildExtensionLaunch {
	const parent = parentExtensionFlags(input.argv, input.cwd);
	const paths: string[] = [];
	const add = (entry: string): void => {
		if (!paths.includes(entry)) paths.push(entry);
	};
	// Under -ne the child only gets what we list, so aio must be explicit.
	// Otherwise aio comes from the same configured packages (or the parent's
	// own -e) and listing it again would load it twice.
	if (parent.noExtensions) add(AIO_EXTENSION_PATH);
	for (const entry of parent.extensions) add(entry);
	if (parent.noExtensions && input.modelProvider === "cursor") {
		const cursorExtension = resolveCursorExtensionPath();
		if (cursorExtension) add(cursorExtension);
	}
	for (const extra of parseExtraExtensionPaths()) {
		if (existsSync(extra)) add(extra);
	}
	return enforceChildExtensions({ noExtensions: parent.noExtensions, paths });
}

/**
 * Subagents always run with extensions: they carry the parent's gates
 * (permission modes, blocklists, hooks, provider auth), so a child without
 * them could step around those mechanical boundaries. A `-ne` launch must
 * therefore always list aio explicitly; without `-ne` the child loads the
 * parent's configured packages. There is deliberately no bare option.
 */
export function enforceChildExtensions(
	launch: ChildExtensionLaunch,
): ChildExtensionLaunch {
	if (!launch.noExtensions || launch.paths.includes(AIO_EXTENSION_PATH)) {
		return { noExtensions: launch.noExtensions, paths: [...launch.paths] };
	}
	return {
		noExtensions: true,
		paths: [AIO_EXTENSION_PATH, ...launch.paths],
	};
}

export function childSupportsModel(
	launch: ChildExtensionLaunch,
	model?: string,
): boolean {
	if (!model?.startsWith("cursor/")) return true;
	// Without -ne the child loads the parent's configured packages; any
	// provider the parent has, the child has too.
	if (!launch.noExtensions) return true;
	const cursorExtension = resolveCursorExtensionPath();
	return !!cursorExtension && launch.paths.includes(cursorExtension);
}
