/**
 * handoff — `/handoff <goal>`: transfer context to a new focused session
 * through a generated, reviewed prompt instead of lossy compaction. Based on
 * pi-handoff (MIT, jalbarrang — see handoff/LICENSE and handoff/UPSTREAM.md).
 *
 * Flow (propose → confirm → execute, like plan mode):
 * 1. A trusted `.pi-recipe` default in the cwd is resolved first; an unknown
 *    version is asked about once. That recipe is enforced in the new session.
 * 2. One isolated `ctx.modelRegistry.complete()` call on the session model
 *    turns the branch (as the model last saw it, after compaction) plus the
 *    goal into a self-contained prompt. TUI shows a cancellable loader.
 * 3. The prompt (plus a link to the previous JSONL transcript) appears as a
 *    proposal card in the transcript (never in model context), followed by a
 *    menu: start, edit, refine with feedback (regenerate), or cancel.
 * 4. Only "start" calls `ctx.newSession({ parentSession })`. Its `setup`
 *    copies the newest recipe/advisor/style entries (minus the keys the
 *    enforced recipe sets), pins the enforced recipe, and writes an
 *    `aio-handoff` entry, all before the new session's session_start. The new
 *    instance of this feature restores the previous model and thinking level
 *    unless the recipe sets them. The prompt waits in the editor.
 *
 * Pi re-evaluates extensions for the replacement session (moduleCache off),
 * so nothing crosses the switch in memory: only session entries do.
 * Subagent children register only the entry renderers.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";

import { ADVISOR_STATE_ENTRY } from "../advisor/config.js";
import { findRecipeModel } from "../recipes/apply.js";
import { RECIPE_STATE_ENTRY } from "../recipes/config.js";
import { STYLE_ENTRY_TYPE } from "../styles/index.js";
import { chromeHeader, chromeHint, fitLine, type ChromeTheme } from "../ui/chrome.js";
import {
	HANDOFF_ENTRY_TYPE,
	HANDOFF_PROPOSAL_ENTRY_TYPE,
	HANDOFF_SYSTEM_PROMPT,
	PROPOSAL_ACTIONS,
	type BranchEntryLike,
	type HandoffEntryData,
	type HandoffProposalData,
	appendPreviousConversationLink,
	boundConversation,
	buildHandoffRequest,
	buildRefineRequest,
	carriedEntries,
	carriedTypesFor,
	conversationBudget,
	getHandoffMessages,
	hasNoMessages,
	latestHandoffEntry,
	proposalActionOf,
	responseText,
} from "./core.js";
import { resolveHandoffRecipe, type HandoffRecipeResolution } from "./recipe.js";

/** Session preferences that follow the work into the new session. */
export const CARRIED_ENTRY_TYPES = [RECIPE_STATE_ENTRY, ADVISOR_STATE_ENTRY, STYLE_ENTRY_TYPE] as const;

export interface HandoffResponse {
	content: Array<Record<string, unknown>>;
	stopReason: string;
	errorMessage?: string;
}

/** Seam over ctx.modelRegistry.complete(); tests inject it. */
export type HandoffCompleteFn = (
	ctx: ExtensionContext,
	request: { systemPrompt: string; text: string },
	signal: AbortSignal,
) => Promise<HandoffResponse>;

export interface RegisterHandoffOptions {
	complete?: HandoffCompleteFn;
	/** Seam over the cwd's `.pi-recipe` resolution (trust store, files). */
	resolveRecipe?: (ctx: ExtensionContext) => Promise<HandoffRecipeResolution>;
}

type Generated = { prompt: string } | { cancelled: true } | { error: string };

const PROPOSAL_TITLE = "Handoff ready — what next?";

const defaultComplete: HandoffCompleteFn = async (ctx, request, signal) => {
	const model = ctx.model;
	if (!model) throw new Error("no model is active");
	// SAFETY: a single text user message is a valid pi-ai Context; the
	// generic SDK types are erased at this seam.
	const registry = ctx.modelRegistry as unknown as {
		complete(m: unknown, c: unknown, o: unknown): Promise<HandoffResponse>;
	};
	return registry.complete(
		model,
		{
			systemPrompt: request.systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: request.text }], timestamp: Date.now() }],
		},
		// A one-off request: no cache write, no session-affine routing.
		{ signal, cacheRetention: "none" },
	);
};

function chromeOf(theme: { fg(role: never, text: string): string; bold(text: string): string }): ChromeTheme {
	// SAFETY: shared chrome passes Pi theme roles; the adapter bridges its
	// string role type to Pi's role union.
	return { fg: (role, text) => theme.fg(role as never, text), bold: (text) => theme.bold(text) };
}

function wrapped(chrome: ChromeTheme, role: string, text: string, width: number): string[] {
	const rows: string[] = [];
	for (const line of wrapTextWithAnsi(chrome.fg(role, text), Math.max(1, width - 2))) {
		rows.push(fitLine(`  ${line}`, width));
	}
	return rows;
}

/** Width-safe transcript note at the top of a handoff session. */
export function renderHandoffRows(data: HandoffEntryData, chrome: ChromeTheme, width: number): string[] {
	if (width <= 0) return [];
	const rows = [chromeHeader(chrome, { title: "Handoff", meta: "new focused session", icon: "⇢" }, width)];
	rows.push(...wrapped(chrome, "text", data.goal, width));
	const parts = [
		data.parentSession ? `from ${data.parentSession}` : "from an unsaved session",
		data.recipe ? `recipe ${data.recipe.name}` : undefined,
		data.model,
		data.carried.length > 0 ? `kept ${data.carried.join(", ")}` : undefined,
	].filter(Boolean);
	rows.push(chromeHint(chrome, parts.join(" · "), width));
	return rows;
}

/** Width-safe proposal card: the full prompt plus what the new session gets. */
export function renderProposalRows(data: HandoffProposalData, chrome: ChromeTheme, width: number): string[] {
	if (width <= 0) return [];
	const meta = data.revision > 1 ? `revision ${data.revision}` : "review, then confirm";
	const rows = [chromeHeader(chrome, { title: "Handoff proposal", meta, icon: "⇢" }, width)];
	rows.push(...wrapped(chrome, "muted", `Goal: ${data.goal}`, width));
	rows.push("");
	for (const line of data.prompt.split("\n")) rows.push(...wrapped(chrome, "text", line, width));
	rows.push("");
	const recipe = data.recipe;
	const parts = [
		recipe ? `recipe ${recipe.name} (${basename(recipe.file)})` : undefined,
		data.model && !recipe?.owns.includes("model") ? `model ${data.model}` : undefined,
		data.carried.length > 0 ? `keeps ${data.carried.join(", ")}` : undefined,
	].filter(Boolean);
	if (parts.length > 0) rows.push(...wrapped(chrome, "dim", `New session: ${parts.join(" · ")}`, width));
	if (recipe?.restartNote) {
		rows.push(...wrapped(chrome, "warning", `Recipe ${recipe.name}: ${recipe.restartNote}.`, width));
	}
	if (data.recipeNote) rows.push(...wrapped(chrome, "warning", data.recipeNote, width));
	return rows;
}

export function registerHandoff(pi: ExtensionAPI, options: RegisterHandoffOptions = {}): void {
	pi.registerEntryRenderer<HandoffEntryData>(HANDOFF_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (data?.version !== 1) return undefined;
		const chrome = chromeOf(theme);
		return { render: (width: number) => renderHandoffRows(data, chrome, width), invalidate() {} };
	});
	pi.registerEntryRenderer<HandoffProposalData>(HANDOFF_PROPOSAL_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (data?.version !== 1) return undefined;
		const chrome = chromeOf(theme);
		return { render: (width: number) => renderProposalRows(data, chrome, width), invalidate() {} };
	});

	// Subagent children are headless: no command, nothing to restore.
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	const complete = options.complete ?? defaultComplete;
	const resolveRecipe = options.resolveRecipe ?? ((ctx: ExtensionContext) => resolveHandoffRecipe(ctx));

	// A fresh handoff session: restore the previous model and thinking level,
	// except the keys an enforced recipe sets. Registered after recipes.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;
		let branch: readonly BranchEntryLike[];
		try {
			branch = ctx.sessionManager.getBranch() as readonly BranchEntryLike[];
		} catch {
			return;
		}
		const data = latestHandoffEntry(branch);
		if (!data || !hasNoMessages(branch)) return;
		const owns = data.recipe?.owns ?? [];
		if (data.model && !owns.includes("model")) {
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const model = current === data.model ? undefined : findRecipeModel(ctx, data.model);
			if (model) {
				try {
					await pi.setModel(model);
				} catch {
					// Keep the session default; the prompt still works.
				}
			}
		}
		if (data.thinkingLevel && !owns.includes("thinking")) {
			try {
				pi.setThinkingLevel(data.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
			} catch {
				// Unsupported level for this model: keep the clamped default.
			}
		}
	});

	async function generate(ctx: ExtensionCommandContext, text: string, label: string): Promise<Generated> {
		const run = async (signal: AbortSignal): Promise<Generated> => {
			try {
				const response = await complete(ctx, { systemPrompt: HANDOFF_SYSTEM_PROMPT, text }, signal);
				if (signal.aborted || response.stopReason === "aborted") return { cancelled: true };
				if (response.stopReason === "error") return { error: response.errorMessage ?? "the model call failed" };
				const prompt = responseText(response.content);
				return prompt ? { prompt } : { error: "the model returned an empty prompt" };
			} catch (error) {
				if (signal.aborted) return { cancelled: true };
				return { error: error instanceof Error ? error.message : String(error) };
			}
		};

		if (ctx.mode === "tui") {
			const result = await ctx.ui.custom<Generated>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, `${label}… (esc to cancel)`);
				loader.onAbort = () => done({ cancelled: true });
				void run(loader.signal).then(done);
				return loader;
			});
			// A host without custom UI support falls through to the plain path.
			if (result !== undefined) return result;
		}
		ctx.ui.notify(`${label}…`, "info");
		return run(new AbortController().signal);
	}

	/** Proposal loop: undefined means the user cancelled. */
	async function review(
		ctx: ExtensionCommandContext,
		request: string,
		initial: string,
		card: Omit<HandoffProposalData, "prompt" | "revision">,
	): Promise<string | undefined> {
		let prompt = initial;
		let revision = 1;
		let changed = true;
		const sessionFile = ctx.sessionManager.getSessionFile();
		for (;;) {
			if (changed) pi.appendEntry<HandoffProposalData>(HANDOFF_PROPOSAL_ENTRY_TYPE, { ...card, prompt, revision });
			changed = false;
			const action = proposalActionOf(await ctx.ui.select(PROPOSAL_TITLE, Object.values(PROPOSAL_ACTIONS)));
			if (action === "start") return prompt;
			if (action === "cancel") return undefined;
			if (action === "edit") {
				const edited = await ctx.ui.editor("Edit the handoff prompt", prompt);
				if (edited?.trim() && edited !== prompt) {
					prompt = edited;
					revision++;
					changed = true;
				}
				continue;
			}
			const feedback = (await ctx.ui.editor("Refine the handoff prompt: what should change?", ""))?.trim();
			if (!feedback) continue;
			const refined = await generate(ctx, buildRefineRequest(request, prompt, feedback), "Refining handoff prompt");
			if ("cancelled" in refined) {
				ctx.ui.notify("Refinement cancelled — the previous draft stays", "info");
				continue;
			}
			if ("error" in refined) {
				ctx.ui.notify(`handoff — could not refine the prompt: ${refined.error}`, "warning");
				continue;
			}
			prompt = appendPreviousConversationLink(refined.prompt, sessionFile);
			revision++;
			changed = true;
		}
	}

	pi.registerCommand("handoff", {
		description: "Propose a focused new session from a generated prompt, then start it on confirm: /handoff <goal>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff needs an interactive session (TUI or RPC)", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("handoff — no model is active; pick one with /model first.", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("handoff — wait for the agent to finish (or press Esc), then run /handoff again.", "warning");
				return;
			}

			let goal = (args ?? "").trim();
			if (!goal) goal = ((await ctx.ui.input("Handoff goal", "what should the new session do?")) ?? "").trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for the new session>", "info");
				return;
			}

			const branch = ctx.sessionManager.getBranch() as readonly BranchEntryLike[];
			const messages = getHandoffMessages(branch);
			if (messages.length === 0) {
				ctx.ui.notify("handoff — there is no conversation to hand off", "warning");
				return;
			}
			// SAFETY: getHandoffMessages yields Pi AgentMessages (session
			// messages and the summary roles convertToLlm understands).
			const conversation = serializeConversation(convertToLlm(messages as never));
			const request = buildHandoffRequest(
				boundConversation(conversation, conversationBudget(ctx.model.contextWindow)),
				goal,
			);
			const sessionFile = ctx.sessionManager.getSessionFile();
			const model = `${ctx.model.provider}/${ctx.model.id}`;
			const thinkingLevel = ctx.thinkingLevel;

			// Before the slow model call, so a trust question never follows a long wait.
			const { recipe, note: recipeNote } = await resolveRecipe(ctx);
			const carried = carriedEntries(
				branch,
				carriedTypesFor(CARRIED_ENTRY_TYPES, recipe, {
					recipe: RECIPE_STATE_ENTRY,
					style: STYLE_ENTRY_TYPE,
					advisor: ADVISOR_STATE_ENTRY,
				}),
			);
			const carriedTypes = carried.map((entry) => entry.customType);

			const generated = await generate(ctx, request, "Generating handoff prompt");
			if ("cancelled" in generated) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}
			if ("error" in generated) {
				ctx.ui.notify(`handoff — could not generate the prompt: ${generated.error}`, "warning");
				return;
			}

			const prompt = await review(ctx, request, appendPreviousConversationLink(generated.prompt, sessionFile), {
				version: 1,
				goal,
				model,
				carried: carriedTypes,
				...(recipe ? { recipe } : {}),
				...(recipeNote ? { recipeNote } : {}),
			});
			if (prompt === undefined) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}

			const data: HandoffEntryData = {
				version: 1,
				goal,
				...(sessionFile ? { parentSession: sessionFile } : {}),
				model,
				...(thinkingLevel ? { thinkingLevel } : {}),
				carried: carriedTypes,
				createdAt: new Date().toISOString(),
				...(recipe ? { recipe } : {}),
			};

			// The original ctx is stale after a successful replacement: all
			// post-switch work uses the replacement context.
			const result = await ctx.newSession({
				parentSession: sessionFile,
				setup: async (sessionManager) => {
					for (const entry of carried) sessionManager.appendCustomEntry(entry.customType, entry.data);
					// The recipes feature applies a pinned directory default on /new
					// ahead of launch flags; see recipes sessionStart.
					if (recipe) sessionManager.appendCustomEntry(RECIPE_STATE_ENTRY, { name: recipe.name });
					sessionManager.appendCustomEntry(HANDOFF_ENTRY_TYPE, data);
				},
				withSession: async (next) => {
					next.ui.setEditorText(prompt);
					next.ui.notify("Handoff ready — review the prompt and press Enter to start.", "info");
					if (recipe?.restartNote) {
						next.ui.notify(
							`Recipe "${recipe.name}": ${recipe.restartNote}. After the first reply, restart with: pi --session ${JSON.stringify(next.sessionManager.getSessionFile() ?? "<file>")}`,
							"warning",
						);
					}
				},
			});
			if (result.cancelled) ctx.ui.notify("Handoff cancelled: the new session was not created", "info");
		},
	});
}
