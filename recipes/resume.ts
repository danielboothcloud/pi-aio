// Post-selection bridge, shared by the native CLI picker and TUI /resume.
//
// Boundary             Recipe identity          Relaunch policy
// CLI direct reference factory lookup           original explicit flags win
// CLI picker startup   committed session branch original explicit flags win
// TUI /resume          committed session branch drop old recipe injection/prompts
// /reload              unchanged                never reapply the launch scope
//
// RPC session replacement cannot transfer an already-active JSONL reader to
// a child safely. Print/JSON startup may already have consumed piped input.
// Those late paths get a restart hint, never a competing inherited reader.
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import {
	RECIPE_INJECTED_ARGS_ENV,
	RECIPE_STAGE_ENV,
	type RecipeDefinition,
} from "./config.js";
import {
	cliArgsFromArgv,
	baselineSessionRelaunch,
	SUBAGENT_CHILD_ENV,
	decideRelaunch,
	execRelaunch,
	stripRecipeInvocation,
	type RelaunchSpec,
	type TrampolineDecision,
} from "./trampoline.js";

/** Keep user flags, but never replay an old initial prompt or recipe's CLI injection. */
export function argvForSessionSwitch(argv: string[], env: Record<string, string | undefined>): string[] {
	let args = cliArgsFromArgv(argv);
	const count = Number(env[RECIPE_INJECTED_ARGS_ENV]);
	if (env[RECIPE_STAGE_ENV] && Number.isSafeInteger(count) && count > 0 && count <= args.length) {
		args = args.slice(count);
	}
	args = stripRecipeInvocation(args) ?? args;
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const parsed = parseArgs([...kept, arg]);
		if (arg === "--no-session" && parsed.noSession) continue;
		if (arg === "--fork" || arg === "--name" || arg === "-n") {
			const withValue = parseArgs([...kept, arg, ...args.slice(i + 1, i + 2)]);
			if ((arg === "--fork" ? withValue.fork : withValue.name) !== undefined) {
				i++;
				continue;
			}
		}
		if (parsed.messages.length || parsed.fileArgs.length) continue;
		kept.push(arg);
	}
	return [...argv.slice(0, 2), ...kept];
}

export function selectedSessionRelaunch(options: {
	argv: string[];
	command: string;
	env: Record<string, string | undefined>;
	reason: SessionStartEvent["reason"];
	file: string | undefined;
	def?: RecipeDefinition;
}): TrampolineDecision | undefined {
	if (!options.file || options.env[SUBAGENT_CHILD_ENV]) return undefined;
	const parsed = parseArgs(cliArgsFromArgv(options.argv));
	const switching = options.reason === "resume";
	const startup = options.reason === "startup" &&
		(parsed.resume || parsed.session !== undefined || parsed.sessionId !== undefined || parsed.continue);
	if (!switching && !startup) return undefined;
	const env = { ...options.env };
	if (switching) delete env[RECIPE_STAGE_ENV]; // Intentional new target, not a startup retry.
	const argv = switching ? argvForSessionSwitch(options.argv, options.env) : options.argv;
	const decision = options.def && options.def.source !== "project" ? decideRelaunch({
		argv, command: options.command, env,
		recipes: { [options.def.name]: options.def },
		continuedRecipe: { name: options.def.name, file: options.file },
	}) : undefined;
	if (decision?.action === "relaunch") return decision;
	const count = Number(options.env[RECIPE_INJECTED_ARGS_ENV]);
	const hadInjection = options.env[RECIPE_STAGE_ENV] && Number.isSafeInteger(count) &&
		count > 0 && count <= cliArgsFromArgv(options.argv).length;
	if (switching && hadInjection) {
		return { action: "relaunch", spec: baselineSessionRelaunch({
			argv, command: options.command, env, file: options.file, recipeName: options.def?.name,
		}) };
	}
	return decision;
}

/** Use the same public terminal handoff as tuicr and Pi's interactive-shell example. */
export async function relaunchFromSession(
	ctx: ExtensionContext,
	spec: RelaunchSpec,
	relaunch: typeof execRelaunch = execRelaunch,
): Promise<boolean> {
	if (ctx.mode !== "tui") return relaunch(spec);
	return ctx.ui.custom<boolean>(async (tui, _theme, _keys, done) => {
		tui.stop();
		let tookOver = false;
		try {
			tookOver = await relaunch(spec);
		} finally {
			// Successful production relaunches exit the parent and never reach
			// this block. Spawn failure restores a usable original terminal.
			tui.start();
			tui.requestRender(true);
		}
		done(tookOver);
		return { render: () => [], invalidate: () => {} };
	});
}
