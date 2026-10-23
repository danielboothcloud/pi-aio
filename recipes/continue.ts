// Resolve --continue before the TUI starts: the saved recipe, not the cwd's
// default, owns its restart-scoped keys. Use Pi's own session selection so
// custom session directories and branch-pinned "off" have native semantics.
import { SessionManager, SettingsManager, parseArgs } from "@earendil-works/pi-coding-agent";
import { latestPersistedRecipe } from "./apply.js";
import { PI_SUBCOMMANDS, RECIPE_FLAG, RECIPE_STAGE_ENV } from "./config.js";
import { cliArgsFromArgv, SUBAGENT_CHILD_ENV } from "./trampoline.js";

export interface ContinuedRecipe {
	name: string;
	file: string;
}

export function continuedRecipeForLaunch(options: {
	argv: string[];
	env: Record<string, string | undefined>;
	cwd: string;
}): ContinuedRecipe | undefined {
	if (options.env[RECIPE_STAGE_ENV] || options.env[SUBAGENT_CHILD_ENV]) return undefined;
	const args = cliArgsFromArgv(options.argv);
	if (PI_SUBCOMMANDS.includes(args[0])) return undefined;
	const parsed = parseArgs(args);
	if (
		!parsed.continue || parsed.noSession || parsed.resume || parsed.session !== undefined ||
		parsed.sessionId !== undefined || parsed.fork !== undefined ||
		parsed.help || parsed.version || parsed.export !== undefined || parsed.listModels !== undefined ||
		parsed.unknownFlags.has(RECIPE_FLAG)
	) return undefined;

	// Same precedence as Pi's CLI. SessionManager normalizes CLI/env paths;
	// SettingsManager normalizes the setting (including a leading tilde).
	const sessionDir = parsed.sessionDir || options.env.PI_CODING_AGENT_SESSION_DIR ||
		SettingsManager.create(options.cwd).getSessionDir();
	const session = SessionManager.continueRecent(options.cwd, sessionDir);
	const file = session.getSessionFile();
	const persisted = latestPersistedRecipe(session.getBranch());
	return file && persisted.name ? { name: persisted.name, file } : undefined;
}
