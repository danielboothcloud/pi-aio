/**
 * handoff — `/handoff <goal>`: transfer context to a new focused session
 * through a generated, editable prompt instead of lossy compaction. Based on
 * pi-handoff (MIT, jalbarrang — see handoff/LICENSE and handoff/UPSTREAM.md).
 *
 * Flow:
 * 1. One isolated `ctx.modelRegistry.complete()` call on the session model
 *    turns the branch (as the model last saw it, after compaction) plus the
 *    goal into a self-contained prompt. TUI shows a cancellable loader.
 * 2. The prompt gets a link to the previous JSONL transcript (persisted
 *    sessions only) and opens in the editor dialog for review.
 * 3. `ctx.newSession({ parentSession })` starts the new session. Its `setup`
 *    copies the newest recipe/advisor/style entries and writes an
 *    `aio-handoff` entry, all before the new session's session_start, so each
 *    feature restores its state there. The new instance of this feature
 *    reads the entry at session_start (reason "new") and restores the
 *    previous model and thinking level. The prompt waits in the editor.
 *
 * Pi re-evaluates extensions for the replacement session (moduleCache off),
 * so nothing crosses the switch in memory: only session entries do.
 * Subagent children register only the entry renderer.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { ADVISOR_STATE_ENTRY } from "../advisor/config.js";
import { findRecipeModel } from "../recipes/apply.js";
import { RECIPE_STATE_ENTRY } from "../recipes/config.js";
import { STYLE_ENTRY_TYPE } from "../styles/index.js";
import { chromeHeader, chromeHint, fitLine, type ChromeTheme } from "../ui/chrome.js";
import {
	HANDOFF_ENTRY_TYPE,
	HANDOFF_SYSTEM_PROMPT,
	type BranchEntryLike,
	type HandoffEntryData,
	appendPreviousConversationLink,
	boundConversation,
	buildHandoffRequest,
	carriedEntries,
	conversationBudget,
	getHandoffMessages,
	hasNoMessages,
	latestHandoffEntry,
	responseText,
} from "./core.js";

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
}

type Generated = { prompt: string } | { cancelled: true } | { error: string };

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

/** Width-safe transcript note at the top of a handoff session. */
export function renderHandoffRows(data: HandoffEntryData, chrome: ChromeTheme, width: number): string[] {
	if (width <= 0) return [];
	const rows = [chromeHeader(chrome, { title: "Handoff", meta: "new focused session", icon: "⇢" }, width)];
	for (const line of wrapTextWithAnsi(chrome.fg("text", data.goal), Math.max(1, width - 2))) {
		rows.push(fitLine(`  ${line}`, width));
	}
	const parts = [
		data.parentSession ? `from ${data.parentSession}` : "from an unsaved session",
		data.model,
		data.carried.length > 0 ? `kept ${data.carried.join(", ")}` : undefined,
	].filter(Boolean);
	rows.push(chromeHint(chrome, parts.join(" · "), width));
	return rows;
}

export function registerHandoff(pi: ExtensionAPI, options: RegisterHandoffOptions = {}): void {
	pi.registerEntryRenderer<HandoffEntryData>(HANDOFF_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (data?.version !== 1) return undefined;
		const chrome = chromeOf(theme);
		return { render: (width: number) => renderHandoffRows(data, chrome, width), invalidate() {} };
	});

	// Subagent children are headless: no command, nothing to restore.
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	const complete = options.complete ?? defaultComplete;

	// A fresh handoff session: restore the previous model and thinking level.
	// Registered after recipes, so this wins over a recipe's model.
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
		if (data.model) {
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
		if (data.thinkingLevel) {
			try {
				pi.setThinkingLevel(data.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
			} catch {
				// Unsupported level for this model: keep the clamped default.
			}
		}
	});

	async function generate(ctx: ExtensionCommandContext, text: string): Promise<Generated> {
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
				const loader = new BorderedLoader(tui, theme, "Generating handoff prompt… (esc to cancel)");
				loader.onAbort = () => done({ cancelled: true });
				void run(loader.signal).then(done);
				return loader;
			});
			// A host without custom UI support falls through to the plain path.
			if (result !== undefined) return result;
		}
		ctx.ui.notify("Generating handoff prompt…", "info");
		return run(new AbortController().signal);
	}

	pi.registerCommand("handoff", {
		description: "Start a new focused session from a generated, editable prompt: /handoff <goal for the new session>",
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
			const text = buildHandoffRequest(
				boundConversation(conversation, conversationBudget(ctx.model.contextWindow)),
				goal,
			);
			const sessionFile = ctx.sessionManager.getSessionFile();

			const generated = await generate(ctx, text);
			if ("cancelled" in generated) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}
			if ("error" in generated) {
				ctx.ui.notify(`handoff — could not generate the prompt: ${generated.error}`, "warning");
				return;
			}

			const edited = await ctx.ui.editor(
				"Edit the handoff prompt",
				appendPreviousConversationLink(generated.prompt, sessionFile),
			);
			if (edited === undefined || !edited.trim()) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}

			const carried = carriedEntries(branch, CARRIED_ENTRY_TYPES);
			const data: HandoffEntryData = {
				version: 1,
				goal,
				...(sessionFile ? { parentSession: sessionFile } : {}),
				model: `${ctx.model.provider}/${ctx.model.id}`,
				...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
				carried: carried.map((entry) => entry.customType),
				createdAt: new Date().toISOString(),
			};

			// The original ctx is stale after a successful replacement: all
			// post-switch work uses the replacement context.
			const result = await ctx.newSession({
				parentSession: sessionFile,
				setup: async (sessionManager) => {
					for (const entry of carried) sessionManager.appendCustomEntry(entry.customType, entry.data);
					sessionManager.appendCustomEntry(HANDOFF_ENTRY_TYPE, data);
				},
				withSession: async (next) => {
					next.ui.setEditorText(edited);
					next.ui.notify("Handoff ready — review the prompt and press Enter to start.", "info");
				},
			});
			if (result.cancelled) ctx.ui.notify("Handoff cancelled: the new session was not created", "info");
		},
	});
}
