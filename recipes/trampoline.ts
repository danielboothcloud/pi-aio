// ---------------------------------------------------------------------------
// recipes/trampoline — the relaunch bridge.
//
// Pi chooses the extension load set before factories and model scope before
// session_start; its extension API cannot replace either in-session.
// The bridge closes the gap: when `pi --recipe <name>`
// selects a recipe with restart-scoped keys, AIO (always loaded at factory
// time, before the session and TUI exist) restarts pi once with the recipe
// translated onto pi's own CLI flags, then exits when the replacement exits.
//
//   pi --recipe work
//     └─ factory: decideRelaunch() -> relaunch spec
//          ├─ spawn pi -e <aio> -e <recipe extensions> --models <recipe scope>
//          ├─ forward stdio, inherit the same agent dir + cwd
//          ├─ strip --recipe from the child argv (it travels as AIO_RECIPE_ACTIVE)
//          └─ exit with the child's exit code
//
// A trusted `.pi-recipe` defaultRecipe in the launch cwd takes the same path
// on a fresh start with no --recipe flag (resumes/forks keep their own
// recipe); AIO_RECIPE_ORIGIN=directory tells the child it is a default.
// --continue can bridge the saved branch's recipe instead (origin=session),
// pinning its exact file and leaving session entries authoritative.
//
// The child never relaunches: AIO_RECIPE_STAGE=1 marks it. The child's AIO
// reads AIO_RECIPE_ACTIVE at session_start and applies everything the bridge
// could not (model, thinking, MCP).
//
// The decision engine is pure — decideRelaunch() inspects argv via pi's own
// parseArgs and never performs side effects — so tests cover every guard and
// the translation without spawning anything. execRelaunch() is the thin
// process runner, injectable for tests.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import {
	ACTIVE_RECIPE_ENV,
	PI_SUBCOMMANDS,
	RECIPE_FLAG,
	RECIPE_ORIGIN_ENV,
	RECIPE_STAGE_ENV,
	isRestartScoped,
	resolveExtensionSource,
	type RecipeDefinition,
} from "./config.js";

/** This package's own entry point, re-injected in the child via `-e`. */
export const AIO_RECIPE_EXTENSION_PATH = fileURLToPath(
	new URL("../index.ts", import.meta.url),
);

/** Guard: subagent children are pinned workloads, never bridge. */
export const SUBAGENT_CHILD_ENV = "AIO_SUBAGENT_CHILD";

export interface RelaunchSpec {
	/** What to execute (process.execPath of the parent). */
	command: string;
	/** Child arguments; only uncompiled Node/Bun launches include an on-disk CLI script. */
	args: string[];
	/** Child environment: parent env plus the stage guard and active-recipe marker. */
	env: Record<string, string | undefined>;
	recipeName: string;
	/** What selected the recipe: a flag, directory default, or continued branch. */
	origin?: RecipeLaunchOrigin;
	/** Human-facing reasons ("extension set", "model scope"). */
	reasons: string[];
}

export type RecipeLaunchOrigin = "flag" | "directory" | "session";

export interface TrampolineOptions {
	/** `process.argv`: [runtime, scriptOrVirtualEntry, ...cliArgs]. */
	argv: string[];
	/** What to spawn: `process.execPath`. */
	command: string;
	/** `process.env` of the parent. */
	env: Record<string, string | undefined>;
	/**
	 * Recipes visible to the bridge: the global file plus a trusted
	 * `.pi-recipe` (pi's project trust is not resolved yet, so
	 * `.pi/aio-recipes.json` is never consulted here).
	 */
	recipes: Record<string, RecipeDefinition>;
	/** The trusted `.pi-recipe` defaultRecipe; used only when no --recipe flag is given. */
	directoryRecipe?: string;
	/** Branch-selected recipe and exact session file for --continue. */
	continuedRecipe?: { name: string; file: string };
	/** Defaults to this package's own entry point, re-injected via `-e`. */
	aioExtensionPath?: string;
	/** fs seam for tests. */
	exists?: (path: string) => boolean;
}

export type TrampolineDecision =
	| { action: "relaunch"; spec: RelaunchSpec }
	| {
			action: "none";
			reason: "no-recipe" | "sessionless" | "child" | "stage" | "bare-flag" | "resume";
	  }
	| { action: "unknown-recipe"; name: string }
	| {
			action: "session-apply";
			name: string;
			/** Why the bridge stood down, surfaced to the session as a notice. */
			note?: string;
	  };

/**
 * Both Pi entry points call main(process.argv.slice(2)). In a compiled Bun
 * binary argv[1] is a virtual script path (/$bunfs/root/pi or B:\\~BUN\\...),
 * not an argument to pass back to the executable when spawning it again.
 */
export function cliArgsFromArgv(argv: string[]): string[] {
	return argv.slice(2);
}

/** Retain real script entry points for Node/Bun, never Bun's embedded path. */
function relaunchEntryArgs(argv: string[]): string[] {
	const entry = argv[1];
	if (!entry || /(?:^|[\\/])(?:\$bunfs|~BUN)[\\/]/i.test(entry)) return [];
	return [entry];
}

/**
 * Remove the `--recipe` invocation from the CLI args, mirroring pi's parser:
 * `--recipe name` consumes the next token unless it starts with `--`, and
 * `--recipe=name` is one token. Everything from `--` onward is message text
 * and is preserved untouched. Returns undefined when no recipe token exists
 * before the terminator (pi's parser never sees one after it either).
 */
export function stripRecipeInvocation(args: string[]): string[] | undefined {
	const kept: string[] = [];
	let found = false;
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === "--") {
			// Nothing before the terminator was a recipe flag — nothing to strip.
			if (!found) return undefined;
			kept.push(...args.slice(i));
			return kept;
		}
		const isLongRecipe = token === `--${RECIPE_FLAG}`;
		const isEqualsForm = token.startsWith(`--${RECIPE_FLAG}=`);
		if (isLongRecipe) {
			found = true;
			const next = args[i + 1];
			// parseArgs consumes the next non-dash token as the flag value.
			if (next !== undefined && !next.startsWith("-")) i++;
			continue;
		}
		if (isEqualsForm) {
			found = true;
			continue;
		}
		kept.push(token);
	}
	return found ? kept : undefined;
}

/**
 * Decide — purely — what the bridge does for this launch. Order matters:
 * process guards first (never bridge a child or a staged relaunch), then
 * dispatch shape (subcommands never start a session), then unknown recipe
 * names, then the restart-key applicability (explicit user flags win over
 * recipe keys — the same CLI-beats-config contract presets use).
 */
export function decideRelaunch(options: TrampolineOptions): TrampolineDecision {
	const env = options.env;
	if (env[RECIPE_STAGE_ENV]) return { action: "none", reason: "stage" };
	if (env[SUBAGENT_CHILD_ENV]) return { action: "none", reason: "child" };
	if (options.argv.length < 2) return { action: "none", reason: "no-recipe" };

	const cliArgs = cliArgsFromArgv(options.argv);
	const firstToken = cliArgs[0];
	if (
		typeof firstToken === "string" &&
		!firstToken.startsWith("-") &&
		PI_SUBCOMMANDS.includes(firstToken)
	) {
		return { action: "none", reason: "sessionless" };
	}

	// pi's own parser: unknown long flags land in `unknownFlags` with their
	// values; unknown short flags are collected as error diagnostics we ignore.
	const parsed = parseArgs(cliArgs);
	const flagValue = parsed.unknownFlags.get(RECIPE_FLAG);
	let name: string;
	let origin: RecipeLaunchOrigin;
	if (flagValue === undefined && options.continuedRecipe && parsed.continue) {
		name = options.continuedRecipe.name;
		origin = "session";
	} else if (flagValue === undefined) {
		const directoryName = options.directoryRecipe?.trim();
		if (!directoryName) return { action: "none", reason: "no-recipe" };
		// A directory default is a default, not an override: a resumed or
		// forked session keeps the recipe pinned on its own branch.
		if (
			parsed.continue ||
			parsed.resume ||
			parsed.session !== undefined ||
			parsed.sessionId !== undefined ||
			parsed.fork !== undefined
		) {
			return { action: "none", reason: "resume" };
		}
		name = directoryName;
		origin = "directory";
	} else if (typeof flagValue !== "string" || !flagValue.trim()) {
		// `--recipe` with no value parses as boolean true; pi's registered-string
		// flag surfaces that as a warning at session time. Nothing to bridge.
		return { action: "none", reason: "bare-flag" };
	} else {
		name = flagValue.trim();
		origin = "flag";
	}
	const label = origin === "flag" ? `--recipe "${name}"` :
		origin === "session" ? `continued recipe "${name}"` : `.pi-recipe default "${name}"`;

	// Launches that print-and-exit: no session starts, so no bridge.
	if (parsed.help || parsed.version || parsed.export !== undefined) {
		return { action: "none", reason: "sessionless" };
	}
	if (parsed.listModels !== undefined) {
		return { action: "none", reason: "sessionless" };
	}

	const recipe = options.recipes[name];
	if (!recipe) return { action: "unknown-recipe", name };
	if (!isRestartScoped(recipe.config)) return { action: "session-apply", name };

	// CLI flags the user typed win over recipe keys (preset contract).
	const userExtFlags = parsed.noExtensions || (parsed.extensions?.length ?? 0) > 0;
	const extensionsApplicable = (recipe.config.extensions?.length ?? 0) > 0 && !userExtFlags;
	const modelsApplicable = (recipe.config.models?.length ?? 0) > 0 && !parsed.models;
	if (!extensionsApplicable && !modelsApplicable) {
		const skipped: string[] = [];
		if (!extensionsApplicable) skipped.push("extension set");
		if (!modelsApplicable) skipped.push("model scope");
		return {
			action: "session-apply",
			name,
			note: `${label}: ${skipped.join(" and ")} left unchanged (overridden by explicit CLI flags); everything else applies in-session`,
		};
	}

	const injected: string[] = [];
	const reasons: string[] = [];
	if (extensionsApplicable) {
		const resolvedSources: string[] = [];
		const exists = options.exists ?? ((_path: string) => true);
		for (const entry of recipe.config.extensions ?? []) {
			const resolved = resolveExtensionSource(entry, exists);
			if (resolved) resolvedSources.push(resolved);
		}
		// A recipe whose every source failed to resolve would silently drop all
		// of the user's extensions — stand down and tell the session instead.
		if (resolvedSources.length === 0) {
			return {
				action: "session-apply",
				name,
				note: `${label}: no extension sources resolved; extension set left unchanged`,
			};
		}
		const aioPath = options.aioExtensionPath ?? AIO_RECIPE_EXTENSION_PATH;
		injected.push("-ne", "-e", aioPath);
		for (const source of resolvedSources) {
			injected.push("-e", source);
		}
		reasons.push("extension set");
	}
	if (modelsApplicable) {
		injected.push("--models", (recipe.config.models ?? []).join(","));
		reasons.push("model scope");
	}

	// parseArgs found the flag before any `--`, so stripRecipeInvocation found
	// its tokens too; if they ever disagree, forwarding the unstripped args is
	// the conservative choice (no message text is ever dropped). A directory
	// default has no token to strip.
	let bridgeable = origin === "flag" ? (stripRecipeInvocation(cliArgs) ?? cliArgs) : cliArgs;
	if (origin === "session" && options.continuedRecipe) {
		// Pin the file we inspected, rather than racing another --continue
		// lookup. Never interpret prompt text after the option terminator.
		const kept: string[] = [];
		for (const arg of bridgeable) {
			// Ask the parser whether this is a flag, not prompt text or a
			// value consumed by another option (--append-system-prompt "-c").
			if ((arg === "-c" || arg === "--continue") && parseArgs([...kept, arg]).continue) continue;
			kept.push(arg);
		}
		bridgeable = ["--session", options.continuedRecipe.file, ...kept];
	}
	const args = [...relaunchEntryArgs(options.argv), ...injected, ...bridgeable];
	const childEnv: Record<string, string | undefined> = {
		...env,
		[RECIPE_STAGE_ENV]: "1",
		[ACTIVE_RECIPE_ENV]: name,
		[RECIPE_ORIGIN_ENV]: origin,
	};

	return {
		action: "relaunch",
		spec: {
			command: options.command,
			args,
			env: childEnv,
			recipeName: name,
			origin,
			reasons,
		},
	};
}

/**
 * May the factory ask a `.pi-recipe` trust question on this terminal? Only
 * an interactive session launch qualifies — the same mode rule pi uses for
 * its own trust prompt (no -p/--print, no --mode rpc|json, both stdin and
 * stdout TTYs) — and never a relaunched child, a subagent, a subcommand,
 * a print-and-exit flag, or --no-approve.
 */
export function canPromptAtLaunch(options: {
	argv: string[];
	env: Record<string, string | undefined>;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}): boolean {
	if (options.env[RECIPE_STAGE_ENV] || options.env[SUBAGENT_CHILD_ENV]) return false;
	const cliArgs = cliArgsFromArgv(options.argv);
	const first = cliArgs[0];
	if (typeof first === "string" && !first.startsWith("-") && PI_SUBCOMMANDS.includes(first)) {
		return false;
	}
	const parsed = parseArgs(cliArgs);
	if (parsed.help || parsed.version || parsed.export !== undefined || parsed.listModels !== undefined) {
		return false;
	}
	if (parsed.print || parsed.mode === "rpc" || parsed.mode === "json") return false;
	if (parsed.projectTrustOverride === false) return false;
	return options.stdinIsTTY && options.stdoutIsTTY;
}

export interface RelaunchDeps {
	spawn?: (command: string, args: string[], options: RelaunchSpawnOptions) => ChildProcess;
	/** Test seam: capture the exit the runner performs. */
	exit?: (code: number) => never;
	stderr?: (line: string) => void;
}

export interface RelaunchSpawnOptions {
	stdio: "inherit";
	env: Record<string, string | undefined>;
	windowsHide: boolean;
}

/** One stderr line the parent prints before handing the terminal to the child. */
export function relaunchNotice(spec: RelaunchSpec): string {
	const from = spec.origin === "directory" ? ".pi-recipe default, " :
		spec.origin === "session" ? "continued session, " : "";
	return `recipes: restarting pi with recipe "${spec.recipeName}" (${from}${spec.reasons.join(" + ")})`;
}

/**
 * Execute a relaunch spec: spawn the replacement with inherited stdio, then
 * hold the parent until the child closes and propagate its exit code. The
 * promise only resolves(false) when the spawn failed — on success the child
 * keeps the terminal and the parent exits inside the close handler. The
 * bridge installs no signal forwarders: child and parent share the terminal's
 * foreground process group, so interactive signals already reach the child.
 */
export function execRelaunch(
	spec: RelaunchSpec,
	deps: RelaunchDeps = {},
): Promise<boolean> {
	const spawnChild = deps.spawn ?? spawn;
	const exit = deps.exit ?? ((code: number): never => process.exit(code));
	const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

	let child: ChildProcess;
	try {
		child = spawnChild(spec.command, spec.args, {
			stdio: "inherit",
			env: spec.env as NodeJS.ProcessEnv,
			windowsHide: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr(`recipes: could not relaunch for recipe "${spec.recipeName}": ${message}`);
		return Promise.resolve(false);
	}

	return new Promise((resolve) => {
		let settled = false;
		const fail = (message: string): void => {
			if (settled) return;
			settled = true;
			stderr(`recipes: relaunch for recipe "${spec.recipeName}" failed: ${message}`);
			resolve(false);
		};
		child.on("error", (error) => {
			fail(error instanceof Error ? error.message : String(error));
		});
		child.on("close", (code) => {
			// A failed spawn emits error and then close. Failure already resumed
			// the in-session fallback; that trailing close must not exit it.
			if (settled) return;
			settled = true;
			// A close without a prior error is the terminal handback. Signal deaths
			// exit 1 so shell pipelines see the restart, not a silent success.
			exit(typeof code === "number" ? code : 1);
		});
	});
}
