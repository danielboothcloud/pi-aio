/**
 * btw — registrar for the /btw ("by the way") side-question channel.
 *
 * - Command: `/btw <question>`. pi executes extension commands immediately
 *   even while the main agent streams (AgentSession.prompt dispatches
 *   commands before queueing), so a mid-flow question runs the handler
 *   without interrupting, queuing, or steering the run — and nothing about
 *   it enters LLM context.
 * - Engine: one bounded, isolated ctx.modelRegistry.complete() call on the
 *   session model (the YSK shadow-audit seam) with its OWN AbortController:
 *   an Esc abort of the main flow never touches it; a newer /btw replaces it
 *   (last wins) and shutdown aborts it.
 * - Context: a bounded recent-flow digest + a bounded workspace snapshot
 *   (btw/context.ts), capped at 28 KB; the handler returns fast and the
 *   assembly + call run detached.
 * - Surfaces (chrome-composed, see display.ts): the transient asking pill —
 *   frame metadata protocol when the minimalist frame owns the surface
 *   (probe-gated), else the footer status; the above-editor card (pending →
 *   answered, answered cards auto-hide after answerCardMs, default 60s); the
 *   one-line arrival toast; and the permanent transcript box — a custom
 *   entry that never enters LLM context.
 * - Failure: the card clears and a warning toast carries the error; no
 *   entry is appended. No settings file, no sub-model pin: always the
 *   session model.
 * - Subagent children (AIO_SUBAGENT_CHILD=1) register no command (headless)
 *   but keep the entry renderer so resumed sessions still render their boxes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitNotification } from "../notifications/protocol.js";

import {
	probeFrameEditor,
	requestFrameRepaint,
	setFrameMetadataContributor,
} from "../frame/protocol.js";
import {
	buildBtwPrompt,
	buildFlowDigest,
	buildProjectSnapshot,
	MAX_QUESTION_CHARS,
} from "./context.js";
import { runSideQuestion, type BtwCompleteFn, type SideQuestionOutcome } from "./engine.js";
import {
	BTW_ENTRY_TYPE,
	BTW_FRAME_KEY,
	BTW_STATUS_KEY,
	BTW_WIDGET_KEY,
	buildBtwCardRows,
	btwToastText,
	frameAskingMeta,
	registerBtwRenderer,
	statusAskingLine,
	toChromeTheme,
	type BtwAnswerCard,
	type BtwCard,
	type BtwEntryData,
} from "./display.js";

export interface RegisterBtwOptions {
	/** How long the answered card stays above the editor (default 60s). */
	answerCardMs?: number;
}

const DEFAULT_ANSWER_CARD_MS = 60_000;

interface QuestionRun {
	seq: number;
	question: string;
	model: unknown;
	modelDescription: string;
	midFlow: boolean;
	startedAt: number;
	abort: AbortController;
	ctx: ExtensionContext;
}

export function registerBtw(pi: ExtensionAPI, options: RegisterBtwOptions = {}): void {
	// Custom entries only ever render for humans: parents and children.
	registerBtwRenderer(pi);

	// Subagent children run headless (`pi --mode json -p`): no command surface.
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	const answerCardMs = Math.max(0, options.answerCardMs ?? DEFAULT_ANSWER_CARD_MS);

	let seq = 0;
	let active: QuestionRun | null = null;
	let cardTimer: ReturnType<typeof setTimeout> | null = null;
	let lastCtx: ExtensionContext | undefined;

	function clearCardTimer(): void {
		if (cardTimer) {
			clearTimeout(cardTimer);
			cardTimer = null;
		}
	}

	function clearWidget(ctx: ExtensionContext): void {
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(BTW_WIDGET_KEY, undefined);
	}

	/** Transient asking pill: frame border when probed, else footer status. */
	function syncAsking(ctx: ExtensionContext, run: QuestionRun | null): void {
		const modelId = run ? run.modelDescription.split("/").pop() : undefined;
		if (probeFrameEditor(pi).supported) {
			setFrameMetadataContributor(
				BTW_FRAME_KEY,
				run ? () => ({ btw: frameAskingMeta(modelId) }) : undefined,
			);
			requestFrameRepaint();
			if (ctx.hasUI) ctx.ui.setStatus(BTW_STATUS_KEY, undefined);
			return;
		}
		setFrameMetadataContributor(BTW_FRAME_KEY, undefined);
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(BTW_STATUS_KEY, run ? statusAskingLine(modelId) : undefined);
	}

	/** Installs one frozen card snapshot; transitions re-set the widget. */
	function showCard(ctx: ExtensionContext, card: BtwCard): void {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		clearCardTimer();
		ctx.ui.setWidget(
			BTW_WIDGET_KEY,
			(_tui, theme) => ({
				render(width: number): string[] {
					return buildBtwCardRows(toChromeTheme(theme), card, width, Date.now());
				},
				invalidate(): void {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	function getBranchSafe(ctx: ExtensionContext): readonly unknown[] {
		try {
			return ctx.sessionManager.getBranch();
		} catch {
			return [];
		}
	}

	/** Surfaces the outcome for the (still-active) run; never throws. */
	function finish(run: QuestionRun, outcome: SideQuestionOutcome): void {
		active = null;
		syncAsking(run.ctx, null);

		if (outcome.error) {
			emitNotification(pi, run.ctx, { category: "background", id: `btw:${run.seq}`, title: "Side question failed", body: "The background side question could not be answered.", preview: outcome.error });
			// User-initiated command: always explain why no answer came.
			clearCardTimer();
			clearWidget(run.ctx);
			if (run.ctx.hasUI) {
				run.ctx.ui.notify(`btw — ${outcome.error}`, "warning");
			}
			return;
		}

		const data: BtwEntryData = {
			question: run.question,
			answer: outcome.answer,
			model: run.modelDescription,
			answeredMidFlow: run.midFlow,
			usage: outcome.usage,
			latencyMs: outcome.latencyMs,
			timestamp: Date.now(),
		};
		pi.appendEntry(BTW_ENTRY_TYPE, data);
		emitNotification(pi, run.ctx, { category: "background", id: `btw:${run.seq}`, title: "Side answer ready", body: "Your /btw answer is ready in Pi.", preview: outcome.answer });

		if (run.ctx.hasUI) {
			run.ctx.ui.notify(btwToastText(data), "info");
		}
		if (answerCardMs > 0) {
			const card: BtwAnswerCard = {
				phase: "answered",
				question: run.question,
				answer: outcome.answer,
				answeredAt: Date.now(),
				dismissAt: Date.now() + answerCardMs,
			};
			showCard(run.ctx, card);
			if (run.ctx.mode === "tui" && run.ctx.hasUI) {
				cardTimer = setTimeout(() => {
					cardTimer = null;
					clearWidget(run.ctx);
				}, answerCardMs);
			}
		} else {
			clearWidget(run.ctx);
		}
	}

	async function askSide(run: QuestionRun): Promise<void> {
		try {
			const [digest, snapshot] = await Promise.all([
				Promise.resolve(buildFlowDigest(getBranchSafe(run.ctx))).catch(() => ""),
				buildProjectSnapshot(run.ctx.cwd).catch(() => ""),
			]);
			if (active !== run) return; // replaced while assembling context
			const prompt = buildBtwPrompt({
				question: run.question,
				flowDigest: digest,
				projectSnapshot: snapshot,
			});
			const outcome = await runSideQuestion({
				model: run.model,
				prompt,
				// SAFETY: the registry's complete() fulfills the injected
				// engine signature; its generic SDK types are erased at this
				// single seam (the same cast you-should-know uses).
				complete: run.ctx.modelRegistry.complete.bind(
					run.ctx.modelRegistry,
				) as unknown as BtwCompleteFn,
				signal: run.abort.signal,
			});
			if (active !== run) return; // replaced mid-call
			finish(run, outcome);
		} catch {
			if (active === run) {
				finish(run, {
					answer: "",
					latencyMs: Date.now() - run.startedAt,
					error: "the side call failed",
				});
			}
		}
	}

	pi.registerCommand("btw", {
		description:
			"Ask a quick side question without interrupting the agent — answered in the background by the session model (works mid-flow)",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const question = (args ?? "").trim().slice(0, MAX_QUESTION_CHARS);
			if (!question) {
				const id = active?.modelDescription.split("/").pop();
				let state = "no question in flight";
				if (active) {
					state = id ? `a side question is in flight (${id})` : "a side question is in flight";
				}
				ctx.ui.notify(`Usage: /btw <question> · ${state}`, "info");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("btw — no model is active; pick one with /model first.", "warning");
				return;
			}

			// Last wins: a newer question aborts the older run.
			if (active) {
				active.abort.abort();
				active = null;
			}
			clearCardTimer();

			const run: QuestionRun = {
				seq: ++seq,
				question,
				model,
				modelDescription: `${model.provider}/${model.id}`,
				// ctx.signal exists only while a run is streaming.
				midFlow: ctx.signal !== undefined,
				startedAt: Date.now(),
				abort: new AbortController(),
				ctx,
			};
			active = run;
			syncAsking(ctx, run);
			showCard(ctx, {
				phase: "pending",
				question,
				model: run.modelDescription,
				startedAt: run.startedAt,
			});
			void askSide(run);
			// Return immediately: pi awaits command handlers even mid-flow.
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		if (active) {
			active.abort.abort();
			active = null;
		}
		clearCardTimer();
		setFrameMetadataContributor(BTW_FRAME_KEY, undefined);
		if (lastCtx) {
			clearWidget(lastCtx);
			if (lastCtx.hasUI) lastCtx.ui.setStatus(BTW_STATUS_KEY, undefined);
		}
		lastCtx = undefined;
	});
}
