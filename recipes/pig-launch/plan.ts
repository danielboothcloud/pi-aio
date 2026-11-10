// ---------------------------------------------------------------------------
// aio-pig launch planner: the recipe relaunch bridge, run BEFORE pig starts.
//
// PiG runs AIO in a helper process that cannot hand the terminal to a new
// pig, so the factory-time bridge (trampoline.ts) cannot work there. The
// launcher (bin/aio-pig.mjs) runs this planner first and then starts pig
// exactly once, with the same arguments and environment markers that Pi's
// relaunch would have given its child. AIO inside pig then sees a normal
// staged child: `--recipe`, `.pi-recipe` defaults (with the terminal trust
// question), and `--continue`/`--session` recipes behave as under Pi.
//
// Launcher-only extras (never active under native Pi):
//   - `--piglet <name>` is an alias for `--recipe <name>` when a recipe of
//     that name exists; anything else (a real Piglet, a path) passes through.
//   - PiG subcommands (`pig status`, `pig piglet …`) pass through untouched.
//
// Every launch carries AIO_PIG_LAUNCHER=1 so AIO inside pig knows the bridge
// already ran and never suggests the launcher again.
// ---------------------------------------------------------------------------

import { parseArgs } from "@earendil-works/pi-coding-agent";
import {
	RECIPE_FLAG,
	RECIPE_STAGE_ENV,
	directoryRecipesPath,
	loadRecipes,
	type RecipeDefinition,
} from "../config.js";
import { resumedRecipeForLaunch } from "../continue.js";
import {
	recipeFileTrust,
	recordRecipeFileTrust,
	type TrustChoice,
} from "../trust.js";
import {
	AIO_RECIPE_EXTENSION_PATH,
	SUBAGENT_CHILD_ENV,
	canPromptAtLaunch,
	decideRelaunch,
	settingsDisabledBuiltins,
} from "../trampoline.js";
import { PIG_LAUNCHER_ENV, PIG_TRUST_ASKED_ENV } from "../pig-host.js";
import { pigAgentDir, pigSessionDirEnv } from "./pi-shim.js";

export { PIG_LAUNCHER_ENV, PIG_TRUST_ASKED_ENV };

/** `pig` subcommands (pig --help, v0.7.0): they start no session. */
export const PIG_SUBCOMMANDS: readonly string[] = [
	"install",
	"remove",
	"uninstall",
	"update",
	"list",
	"config",
	"auth",
	"mcp",
	"login",
	"logout",
	"piglet",
	"package",
	"extension",
	"reload",
	"setup",
	"verify",
	"status",
	"docs",
	"version",
	"diagnose",
	"build",
];

type Env = Record<string, string | undefined>;

export interface PigLaunchOptions {
	/** CLI arguments after `pig`. */
	args: string[];
	env: Env;
	cwd: string;
	/** The real pig executable. */
	pigBinary: string;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	/** The terminal trust question for a new or changed `.pi-recipe`. */
	promptTrust: (file: string) => Promise<TrustChoice>;
	stderr?: (line: string) => void;
	/** Test seam; defaults to this package's entry point. */
	aioExtensionPath?: string;
}

export interface PigLaunch {
	command: string;
	args: string[];
	env: Env;
	/** Set when the recipe's restart-scoped keys were applied. */
	recipeName?: string;
}

function isPathLike(value: string): boolean {
	return /[/\\]/.test(value) || /\.ya?ml$/i.test(value);
}

/**
 * Replace the first `--piglet <name>` / `--piglet=<name>` before `--` with
 * `--recipe <name>` when `name` is a known recipe. Returns undefined when
 * nothing changed.
 */
export function aliasPigletToRecipe(
	args: string[],
	recipes: Record<string, RecipeDefinition>,
): string[] | undefined {
	const isRecipe = (name: string | undefined): name is string =>
		!!name && !isPathLike(name) && Object.hasOwn(recipes, name);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return undefined;
		if (arg === "--piglet") {
			const name = args[i + 1];
			if (!isRecipe(name)) return undefined;
			return [...args.slice(0, i), `--${RECIPE_FLAG}`, name, ...args.slice(i + 2)];
		}
		if (arg.startsWith("--piglet=")) {
			const name = arg.slice("--piglet=".length);
			if (!isRecipe(name)) return undefined;
			return [...args.slice(0, i), `--${RECIPE_FLAG}=${name}`, ...args.slice(i + 1)];
		}
	}
	return undefined;
}

/** Ask (when allowed) and return the trust state of `cwd`'s `.pi-recipe`. */
async function launchTrust(
	cwd: string,
	argv: string[],
	interactive: boolean,
	options: PigLaunchOptions,
	asked: { value: boolean },
): Promise<boolean> {
	const file = directoryRecipesPath(cwd);
	if (!file) return false;
	let trust = recipeFileTrust(file, { cliArgs: argv.slice(2) });
	if (trust === "unknown" && interactive && !asked.value) {
		asked.value = true;
		const choice = await options.promptTrust(file);
		if (choice !== "skip") {
			try {
				recordRecipeFileTrust(file, choice === "trust");
			} catch (error) {
				options.stderr?.(`recipes: could not save trust for ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (choice === "trust") trust = "trusted";
	}
	return trust === "trusted";
}

/** Decide how to start pig. Pure apart from reading recipe/session files and the trust prompt. */
export async function planPigLaunch(options: PigLaunchOptions): Promise<PigLaunch> {
	const env = options.env;
	const marked = (extra: Env = {}): Env => ({ ...env, ...extra, [PIG_LAUNCHER_ENV]: "1" });
	const passthrough = (args = options.args, extra: Env = {}): PigLaunch => ({
		command: options.pigBinary,
		args,
		env: marked(extra),
	});

	// Children and staged launches are never bridged twice.
	if (env[RECIPE_STAGE_ENV] || env[SUBAGENT_CHILD_ENV]) return passthrough();
	const first = options.args[0];
	if (first !== undefined && !first.startsWith("-") && PIG_SUBCOMMANDS.includes(first)) {
		return { command: options.pigBinary, args: options.args, env };
	}

	// Pi's own argv shape: [runtime, entry, ...cliArgs]. An empty entry keeps
	// the relaunch from re-adding a script path (pig is a native binary).
	const argvFor = (args: string[]) => [options.pigBinary, "", ...args];
	const interactive = canPromptAtLaunch({
		argv: argvFor(options.args),
		env,
		stdinIsTTY: options.stdinIsTTY,
		stdoutIsTTY: options.stdoutIsTTY,
	});
	const asked = { value: false };
	// PiG reads its own session-dir variable; continue.ts reads Pi's name.
	const sessionEnv: Env = { ...env, PI_CODING_AGENT_SESSION_DIR: pigSessionDirEnv(env) };

	let args = options.args;
	let resumed = await resumedRecipeForLaunch({ argv: argvFor(args), env: sessionEnv, cwd: options.cwd });
	let launchCwd = resumed?.cwd ?? options.cwd;
	let trusted = await launchTrust(launchCwd, argvFor(args), interactive, options, asked);
	let launch = loadRecipes(launchCwd, { projectTrusted: false, directoryTrusted: trusted });

	const aliased = aliasPigletToRecipe(args, launch.recipes);
	if (aliased) {
		// An explicit recipe flag wins over a resumed branch, as in Pi.
		args = aliased;
		resumed = undefined;
		if (launchCwd !== options.cwd) {
			launchCwd = options.cwd;
			trusted = await launchTrust(launchCwd, argvFor(args), interactive, options, asked);
			launch = loadRecipes(launchCwd, { projectTrusted: false, directoryTrusted: trusted });
		}
	}
	const trustExtra: Env = asked.value ? { [PIG_TRUST_ASKED_ENV]: "1" } : {};

	// The native --resume picker runs inside pig; its choice is handled there.
	if (parseArgs(args).resume) return passthrough(args, trustExtra);

	const decision = decideRelaunch({
		argv: argvFor(args),
		command: options.pigBinary,
		env,
		recipes: launch.recipes,
		directoryRecipe: launch.defaultSource === "directory" ? launch.defaultRecipe : undefined,
		continuedRecipe: resumed,
		aioExtensionPath: options.aioExtensionPath ?? AIO_RECIPE_EXTENSION_PATH,
		disabledBuiltins: settingsDisabledBuiltins(pigAgentDir(env)),
	});
	if (decision.action !== "relaunch") return passthrough(args, trustExtra);
	return {
		command: decision.spec.command,
		args: decision.spec.args,
		env: { ...decision.spec.env, ...trustExtra, [PIG_LAUNCHER_ENV]: "1" },
		recipeName: decision.spec.recipeName,
	};
}
