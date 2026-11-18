/**
 * handoff/recipe — the cwd's `.pi-recipe` default that a handoff enforces in
 * the new session. Trust goes through recipes/trust.ts: an unknown version is
 * asked once in the handoff flow, never applied silently.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

import {
	ACTIVE_RECIPE_ENV,
	RECIPE_STAGE_ENV,
	directoryRecipesPath,
	isRestartScoped,
	loadRecipes,
	parseModelSpec,
} from "../recipes/config.js";
import { cliArgsFromArgv } from "../recipes/trampoline.js";
import {
	TRUST_CHOICE_LABELS,
	recipeFileTrust,
	recordRecipeFileTrust,
	trustPromptTitle,
	type TrustChoice,
} from "../recipes/trust.js";
import { recipeOwnedKeys, type HandoffRecipeData } from "./core.js";

export interface HandoffRecipeResolution {
	recipe?: HandoffRecipeData;
	/** Why a `.pi-recipe` in the cwd is not enforced. */
	note?: string;
}

export interface ResolveHandoffRecipeOptions {
	argv?: string[];
	env?: Record<string, string | undefined>;
	/** Test seams over the trust store. */
	trustOf?: (file: string) => ReturnType<typeof recipeFileTrust>;
	recordTrust?: (file: string, trusted: boolean) => void;
}

const TRUST_ORDER: TrustChoice[] = ["trust", "skip", "deny"];

async function askTrust(ctx: ExtensionContext, file: string): Promise<TrustChoice> {
	const labels = TRUST_ORDER.map((choice) => TRUST_CHOICE_LABELS[choice]);
	const picked = await ctx.ui.select(trustPromptTitle(file), labels);
	return TRUST_ORDER[labels.indexOf(picked ?? "")] ?? "skip";
}

/** Why the running launch cannot give the recipe its extension set or model scope. */
function restartNote(
	name: string,
	restartScoped: boolean,
	env: Record<string, string | undefined>,
): string | undefined {
	const launched = env[RECIPE_STAGE_ENV] ? env[ACTIVE_RECIPE_ENV]?.trim() || undefined : undefined;
	if (launched === name) return undefined;
	if (launched) return `this launch keeps the extension set and model scope of recipe "${launched}"`;
	if (restartScoped) return `its extension set and model scope need a restart`;
	return undefined;
}

export async function resolveHandoffRecipe(
	ctx: ExtensionContext,
	options: ResolveHandoffRecipeOptions = {},
): Promise<HandoffRecipeResolution> {
	const file = directoryRecipesPath(ctx.cwd);
	if (!file) return {};
	const fileName = basename(file);
	const argv = options.argv ?? process.argv;
	const env = options.env ?? process.env;
	const trustOf = options.trustOf ?? ((path: string) => recipeFileTrust(path, { cliArgs: cliArgsFromArgv(argv) }));
	const recordTrust = options.recordTrust ?? ((path: string, trusted: boolean) => recordRecipeFileTrust(path, trusted));

	let trust = trustOf(file);
	if (trust === "unknown" && ctx.hasUI) {
		const choice = await askTrust(ctx, file);
		if (choice !== "skip") {
			try {
				recordTrust(file, choice === "trust");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return { note: `${fileName}: could not save trust (${reason}); the new session keeps the current recipe` };
			}
			trust = trustOf(file);
		}
	}
	if (trust !== "trusted") {
		const why = trust === "denied" ? "is not trusted" : "is not trusted yet";
		return { note: `${fileName} ${why}; the new session keeps the current recipe` };
	}

	const config = loadRecipes(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), directoryTrusted: true });
	const name = config.defaultSource === "directory" ? config.defaultRecipe : undefined;
	const def = name ? config.recipes[name] : undefined;
	if (!name || !def) {
		return { note: `${fileName} has no valid defaultRecipe; the new session keeps the current recipe` };
	}
	const specThinking = def.config.model ? parseModelSpec(def.config.model).thinking !== undefined : false;
	const note = restartNote(name, isRestartScoped(def.config), env);
	return {
		recipe: {
			name,
			file,
			owns: recipeOwnedKeys(def.config, specThinking),
			...(note ? { restartNote: note } : {}),
		},
	};
}
