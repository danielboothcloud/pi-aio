/**
 * goals — `/goal`: give the agent a goal and let it work until it is done.
 *
 * Flow:
 * - `/goal <text>` sends a visible draft message. The agent asks clarifying
 *   questions only when the request is unclear, then calls `goal_propose`;
 *   the user confirms, and the agent starts the work in the same run.
 * - While the goal is active, `agent_before_settle` adds one hidden
 *   continuation message and requests one more run, so the agent keeps
 *   going. Esc (an aborted run skips that boundary), a model error, the
 *   continuation cap, `goal_blocked`, and `/goal pause` stop the loop.
 * - `goal_done` runs one isolated review call. Approval finishes the goal;
 *   a rejection sends the reason back and the loop continues.
 *
 * State is bound to the session: the newest `aio-goal` custom entry in the
 * session file wins, and nothing touches the project directory. Every
 * session start holds an active goal paused until `/goal resume`.
 * Subagent children register nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { emitGoalActivity, emitNotification, withAgentPrompt } from "../notifications/protocol.js";
import { chromeHeader, fitLine } from "../ui/chrome.js";
import {
	continuationPrompt,
	describeGoal,
	draftPrompt,
	GOAL_MESSAGE_TYPE,
	GOAL_STATE_ENTRY,
	GOAL_STATUS_KEY,
	GOAL_SUBCOMMANDS,
	type Goal,
	type GoalMessageDetails,
	type GoalStateData,
	latestGoal,
	MAX_CONTINUATIONS,
	MAX_REJECTIONS,
	newGoal,
	nowIso,
	oneLine,
	parseGoalArgs,
	startedText,
	statusText,
} from "./core.js";
import { reviewGoal, type ReviewCompleteFn, type ReviewExecFn } from "./review.js";

export const GOAL_TOOL_NAMES = ["goal_propose", "goal_done", "goal_blocked"] as const;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

export function registerGoals(pi: ExtensionAPI): void {
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	let goal: Goal | null = null;
	/** The pending `/goal` text while the agent prepares `goal_propose`. */
	let drafting: string | null = null;
	let reviewing = false;

	function refresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			const text = statusText(goal, { drafting: drafting !== null, reviewing });
			const tone = goal?.status === "paused" ? "warning" : "accent";
			ctx.ui.setStatus(GOAL_STATUS_KEY, text ? ctx.ui.theme.fg(tone, text) : undefined);
		} catch {
			/* the status is cosmetic */
		}
	}

	/** Update UI and observers after a local state change (no persistence). */
	function publish(ctx: ExtensionContext, quietSettle = false): void {
		refresh(ctx);
		emitGoalActivity(pi, ctx, goal?.status ?? "none", quietSettle);
	}

	function persist(ctx: ExtensionContext, quietSettle = false): void {
		try {
			pi.appendEntry<GoalStateData>(GOAL_STATE_ENTRY, { goal: goal ? { ...goal } : null });
		} catch {
			/* a stale runtime cannot persist; the next session start re-reads */
		}
		publish(ctx, quietSettle);
	}

	function attention(ctx: ExtensionContext, reason: string): void {
		if (!goal) return;
		emitNotification(pi, ctx, {
			category: "goal",
			id: `${goal.id}:paused:${goal.updatedAt}`,
			title: "Goal needs attention",
			body: "The goal is paused. Return to Pi to review the next action.",
			preview: reason,
			replacesCompletion: true,
		});
	}

	/** Set the goal to paused in memory; the caller persists it. */
	function markPaused(reason: string): void {
		if (!goal) return;
		goal = { ...goal, status: "paused", pauseReason: reason, updatedAt: nowIso() };
	}

	function pause(ctx: ExtensionContext, reason: string, notify: boolean): void {
		if (goal?.status !== "active") return;
		markPaused(reason);
		persist(ctx, true);
		if (notify) attention(ctx, reason);
		if (ctx.hasUI) ctx.ui.notify(`Goal paused: ${reason}. Run /goal resume to continue.`, notify ? "warning" : "info");
	}

	function sendContinuation(ctx: ExtensionContext): void {
		if (goal?.status !== "active") return;
		goal = { ...goal, continuations: goal.continuations + 1, updatedAt: nowIso() };
		persist(ctx);
		try {
			pi.sendMessage<GoalMessageDetails>(
				{
					customType: GOAL_MESSAGE_TYPE,
					content: continuationPrompt(goal),
					display: false,
					details: { kind: "continue", text: "" },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (err) {
			pause(ctx, `could not continue: ${err instanceof Error ? err.message : String(err)}`, true);
		}
	}

	// -----------------------------------------------------------------------
	// Transcript card for the visible draft message
	// -----------------------------------------------------------------------

	pi.registerMessageRenderer<GoalMessageDetails>(GOAL_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as GoalMessageDetails | undefined;
		if (details?.kind !== "draft") return undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				const rows = [chromeHeader(theme, { title: "Goal", meta: "drafting", icon: "◎" }, width)];
				for (const line of wrapTextWithAnsi(details.text, Math.max(1, width - 2))) {
					rows.push(fitLine(`  ${line}`, width));
				}
				return rows;
			},
		};
	});

	// -----------------------------------------------------------------------
	// Agent tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "goal_propose",
		label: "Propose goal",
		description:
			"Propose the goal the user started with /goal: a precise objective and concrete done criteria. The user confirms it, then you start the work. Use only after a /goal draft message.",
		parameters: Type.Object({
			objective: Type.String({ description: "Precise statement of what to build or change" }),
			doneWhen: Type.String({ description: "Concrete behavior, tests, or checks that prove the goal is complete" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (drafting === null) {
				throw new Error("No goal draft is waiting. Call goal_propose only after the user runs /goal <text>.");
			}
			const objective = params.objective.trim();
			const doneWhen = params.doneWhen.trim();
			if (!objective) throw new Error("The objective is empty.");
			if (ctx.hasUI) {
				const confirmed = await withAgentPrompt(
					pi,
					ctx,
					{ kind: "confirm", title: "Confirm goal", body: "The agent is waiting for you to confirm the goal.", preview: objective },
					() => ctx.ui.confirm("Start this goal?", `${objective}\n\nDone when:\n${doneWhen || "(not specified)"}`),
				);
				if (!confirmed) {
					return textResult(
						"The user did not start this goal. Ask the user what to change, then call goal_propose again. Stop if they no longer want the goal.",
					);
				}
			}
			drafting = null;
			goal = newGoal(objective, doneWhen);
			persist(ctx);
			if (ctx.hasUI) ctx.ui.notify(`Goal started: ${oneLine(objective, 70)}`, "info");
			return textResult(startedText(goal));
		},
	});

	pi.registerTool({
		name: "goal_done",
		label: "Goal done",
		description:
			"Report that the active /goal is complete. An independent review checks the claim; if it rejects, you get the open points and continue. Use only while a goal is active.",
		parameters: Type.Object({
			summary: Type.String({ description: "What you did and the evidence that each done criterion is met" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (goal?.status !== "active") {
				throw new Error("No active goal. Call goal_done only while a /goal is active.");
			}
			const target = goal;
			reviewing = true;
			refresh(ctx);
			onUpdate?.({ content: [{ type: "text", text: "Reviewing the goal…" }], details: {} });
			let outcome: Awaited<ReturnType<typeof reviewGoal>>;
			try {
				outcome = await reviewGoal({
					goal: target,
					summary: params.summary,
					branch: ctx.sessionManager.getBranch(),
					cwd: ctx.cwd,
					model: ctx.model,
					// SAFETY: the registry's complete() fulfills the narrowed review seam.
					complete: ctx.modelRegistry.complete.bind(ctx.modelRegistry) as unknown as ReviewCompleteFn,
					exec: ((command, args, options) => pi.exec(command, args, options)) as ReviewExecFn,
					signal,
				});
			} finally {
				reviewing = false;
				refresh(ctx);
			}
			if (goal?.id !== target.id || goal.status !== "active") {
				return textResult("The goal changed during the review, so the review result was discarded.");
			}
			if ("error" in outcome) {
				if (signal?.aborted) return textResult("The review was aborted.");
				pause(ctx, `review failed: ${outcome.error}`, true);
				return textResult(`The review could not run: ${outcome.error}\nThe goal is paused. Tell the user and stop.`);
			}
			if (outcome.approved) {
				goal = {
					...goal,
					status: "done",
					summary: params.summary,
					lastReview: outcome.reason,
					rejections: 0,
					pauseReason: undefined,
					updatedAt: nowIso(),
				};
				persist(ctx);
				emitNotification(pi, ctx, {
					category: "goal",
					id: `${goal.id}:complete`,
					title: "Goal complete",
					body: "The goal has been marked complete.",
					preview: goal.objective,
					replacesCompletion: true,
				});
				if (ctx.hasUI) ctx.ui.notify(`Goal complete: ${oneLine(goal.objective, 70)}`, "info");
				return textResult(`Review approved: ${outcome.reason}\nThe goal is complete. Give the user a short final summary and stop.`);
			}
			goal = { ...goal, rejections: goal.rejections + 1, lastReview: outcome.reason, updatedAt: nowIso() };
			if (goal.rejections >= MAX_REJECTIONS) {
				const reason = `the review rejected the completion ${MAX_REJECTIONS} times`;
				markPaused(reason);
				persist(ctx, true);
				attention(ctx, reason);
				if (ctx.hasUI) ctx.ui.notify(`Goal paused: ${reason}. Run /goal resume to continue.`, "warning");
				return textResult(
					`Review rejected: ${outcome.reason}\nThe goal is paused after ${MAX_REJECTIONS} rejected reviews. Explain the open points to the user and stop.`,
				);
			}
			persist(ctx);
			return textResult(`Review rejected: ${outcome.reason}\nContinue working on the open points, then call goal_done again.`);
		},
	});

	pi.registerTool({
		name: "goal_blocked",
		label: "Goal blocked",
		description:
			"Pause the active /goal when you cannot continue without the user (missing access, a decision only the user can make). Use only while a goal is active.",
		parameters: Type.Object({
			reason: Type.String({ description: "What you need from the user" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (goal?.status !== "active") {
				throw new Error("No active goal. Call goal_blocked only while a /goal is active.");
			}
			pause(ctx, oneLine(params.reason, 200) || "blocked", true);
			return textResult("The goal is paused. Ask the user for what you need, then stop. The user runs /goal resume to continue.");
		},
	});

	// -----------------------------------------------------------------------
	// /goal command
	// -----------------------------------------------------------------------

	pi.registerCommand("goal", {
		description: "Give the agent a goal to work on until it is done: /goal <text> | status | pause | resume | cancel",
		getArgumentCompletions: (prefix: string) => {
			const query = prefix.trim().toLowerCase();
			const matches = GOAL_SUBCOMMANDS.filter((sub) => sub.name.startsWith(query)).map((sub) => ({
				label: sub.name,
				value: sub.name,
				description: sub.description,
			}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const command = parseGoalArgs(args ?? "");
			switch (command.kind) {
				case "status": {
					if (goal) ctx.ui.notify(describeGoal(goal), "info");
					else if (drafting !== null) ctx.ui.notify(`Goal draft waiting for the agent: ${oneLine(drafting, 120)}`, "info");
					else ctx.ui.notify("No goal. Use /goal <what you want done> to start one.", "info");
					return;
				}
				case "pause": {
					if (goal?.status !== "active") {
						ctx.ui.notify("No active goal to pause.", "info");
						return;
					}
					markPaused("paused by the user");
					persist(ctx, true);
					if (!ctx.isIdle()) ctx.abort();
					ctx.ui.notify("Goal paused. Run /goal resume to continue.", "info");
					return;
				}
				case "resume": {
					if (goal?.status === "active") {
						ctx.ui.notify("The goal is already active.", "info");
						return;
					}
					if (goal?.status !== "paused") {
						ctx.ui.notify("No paused goal to resume.", "info");
						return;
					}
					goal = { ...goal, status: "active", pauseReason: undefined, continuations: 0, rejections: 0, updatedAt: nowIso() };
					persist(ctx);
					ctx.ui.notify(`Goal resumed: ${oneLine(goal.objective, 70)}`, "info");
					// A running turn continues through agent_before_settle; an
					// idle session needs one explicit continuation.
					if (ctx.isIdle()) sendContinuation(ctx);
					return;
				}
				case "cancel": {
					if (!goal && drafting === null) {
						ctx.ui.notify("No goal to cancel.", "info");
						return;
					}
					const wasActive = goal?.status === "active";
					goal = null;
					drafting = null;
					persist(ctx, true);
					if (wasActive && !ctx.isIdle()) ctx.abort();
					ctx.ui.notify("Goal cleared.", "info");
					return;
				}
				case "start": {
					if (goal && goal.status !== "done") {
						const replace = ctx.hasUI
							? await ctx.ui.confirm("Replace the current goal?", oneLine(goal.objective, 200))
							: true;
						if (!replace) return;
						goal = null;
						persist(ctx, true);
					}
					drafting = command.text;
					publish(ctx);
					pi.sendMessage<GoalMessageDetails>(
						{
							customType: GOAL_MESSAGE_TYPE,
							content: draftPrompt(command.text),
							display: true,
							details: { kind: "draft", text: command.text },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					return;
				}
				default: {
					const unknown: never = command;
					throw new Error(`Unknown /goal command: ${JSON.stringify(unknown)}`);
				}
			}
		},
	});

	// -----------------------------------------------------------------------
	// Loop lifecycle
	// -----------------------------------------------------------------------

	pi.on("agent_before_settle", (event, ctx) => {
		if (goal?.status !== "active") return;
		if (event.outcome === "aborted") return; // agent_settled pauses it
		const entries = [...event.entries];
		if (event.outcome === "error") {
			const reason = "the model stopped with an error";
			markPaused(reason);
			entries.push({ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: { ...goal } } });
			publish(ctx, true);
			attention(ctx, reason);
			if (ctx.hasUI) ctx.ui.notify(`Goal paused: ${reason}. Run /goal resume to continue.`, "warning");
			return { entries };
		}
		if (goal.continuations >= MAX_CONTINUATIONS) {
			const reason = `reached ${MAX_CONTINUATIONS} automatic continuations`;
			markPaused(reason);
			entries.push({ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: { ...goal } } });
			publish(ctx, true);
			attention(ctx, reason);
			if (ctx.hasUI) ctx.ui.notify(`Goal paused: ${reason}. Run /goal resume to continue.`, "warning");
			return { entries };
		}
		goal = { ...goal, continuations: goal.continuations + 1, updatedAt: nowIso() };
		entries.push(
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: { ...goal } } },
			{
				type: "custom_message",
				customType: GOAL_MESSAGE_TYPE,
				content: continuationPrompt(goal),
				display: false,
				details: { kind: "continue", text: "" } satisfies GoalMessageDetails,
			},
		);
		publish(ctx);
		return { entries, continue: true };
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted && goal?.status === "active") pause(ctx, "stopped with Esc", false);
	});

	pi.on("session_start", (_event, ctx) => {
		drafting = null;
		reviewing = false;
		goal = latestGoal(ctx.sessionManager.getEntries());
		if (goal?.status === "active") {
			// Every reopen holds the goal until the user resumes it.
			markPaused("session reopened");
			persist(ctx, true);
			if (ctx.hasUI) {
				ctx.ui.notify(`Goal paused: ${oneLine(goal.objective, 70)}. Run /goal resume to continue.`, "info");
			}
			return;
		}
		publish(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		goal = null;
		drafting = null;
		reviewing = false;
		if (ctx.hasUI) {
			try {
				ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
			} catch {
				/* the UI may already be gone */
			}
		}
	});
}

export default registerGoals;
