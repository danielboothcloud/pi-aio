// Resolve deterministic resume references before the TUI starts. The saved
// branch, never the cwd's default, owns its restart-scoped recipe keys.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, SettingsManager, parseArgs } from "@earendil-works/pi-coding-agent";
import { latestPersistedRecipe } from "./apply.js";
import { PI_SUBCOMMANDS, RECIPE_FLAG, RECIPE_STAGE_ENV } from "./config.js";
import { cliArgsFromArgv, SUBAGENT_CHILD_ENV } from "./trampoline.js";

export interface ContinuedRecipe {
	name: string;
	file: string;
	/** Set for an explicitly opened session, which may belong to another cwd. */
	cwd?: string;
}

type LaunchOptions = {
	argv: string[];
	env: Record<string, string | undefined>;
	cwd: string;
};

function launchArgs(options: LaunchOptions) {
	if (options.env[RECIPE_STAGE_ENV] || options.env[SUBAGENT_CHILD_ENV]) return undefined;
	const args = cliArgsFromArgv(options.argv);
	if (PI_SUBCOMMANDS.includes(args[0])) return undefined;
	const parsed = parseArgs(args);
	if (
		parsed.noSession || parsed.resume || parsed.fork !== undefined ||
		parsed.help || parsed.version || parsed.export !== undefined || parsed.listModels !== undefined ||
		parsed.unknownFlags.has(RECIPE_FLAG)
	) return undefined;
	return parsed;
}

function sessionDirectory(options: LaunchOptions, parsed: ReturnType<typeof parseArgs>): string | undefined {
	// Pi's own precedence; SessionManager/SettingsManager normalize paths.
	return parsed.sessionDir || options.env.PI_CODING_AGENT_SESSION_DIR ||
		SettingsManager.create(options.cwd).getSessionDir();
}

function selectedRecipe(session: SessionManager): ContinuedRecipe | undefined {
	const file = session.getSessionFile();
	const persisted = latestPersistedRecipe(session.getBranch());
	return file && persisted.name ? { name: persisted.name, file } : undefined;
}

export function continuedRecipeForLaunch(options: LaunchOptions): ContinuedRecipe | undefined {
	const parsed = launchArgs(options);
	if (!parsed?.continue || parsed.session !== undefined || parsed.sessionId !== undefined) return undefined;
	return selectedRecipe(SessionManager.continueRecent(options.cwd, sessionDirectory(options, parsed)));
}

/** Share the same recipe restore for --continue, --session and --session-id.
 * --resume's picker is owned by Pi; its exact choice is handled at session_start.
 */
export async function resumedRecipeForLaunch(options: LaunchOptions): Promise<ContinuedRecipe | undefined> {
	const parsed = launchArgs(options);
	if (!parsed) return undefined;
	if (parsed.continue && parsed.session === undefined && parsed.sessionId === undefined) {
		return continuedRecipeForLaunch(options);
	}
	const reference = parsed.session ?? parsed.sessionId;
	if (!reference) return undefined;
	const sessionDir = sessionDirectory(options, parsed);
	let file: string | undefined;
	if (parsed.session && (/[\\/]/.test(reference) || reference.endsWith(".jsonl"))) {
		// Match Pi's path/ID distinction, including quoted ~ and file URLs.
		const expanded = reference.startsWith("file://") ? fileURLToPath(reference) :
			reference === "~" ? homedir() :
			/^~[/\\]/.test(reference) ? join(homedir(), reference.slice(2)) : reference;
		const path = resolve(options.cwd, expanded);
		if (existsSync(path)) file = path;
	} else {
		file = SessionManager.findById(options.cwd, reference, sessionDir);
		if (!file && parsed.session) {
			// Native --session resolves exact local IDs first, then local prefixes.
			file = (await SessionManager.list(options.cwd, sessionDir)).find(session => session.id.startsWith(reference))?.path;
		}
	}
	// A cross-project ID requires Pi's fork confirmation. Do not guess or
	// repeat the prompt: the TUI startup path can use its actual chosen file.
	if (!file) return undefined;
	const session = SessionManager.open(file, sessionDir);
	const recipe = selectedRecipe(session);
	return recipe ? { ...recipe, cwd: session.getCwd() } : undefined;
}
