/**
 * aio goal-loop — /goal command.
 *
 * Vendored from pi-goal-list-loop-audit (MIT, DraconDev) and adapted for
 * aio: only the /goal loop is retained (the /list, /loop, /gla, /review
 * commands and their machinery were stripped). The isolated completion
 * auditor, regression shield, agent_end-driven continuation loop, heartbeat
 * self-watchdog, and drafting/Confirm flow are preserved verbatim in
 * behavior.
 *
 * Subagent adaptation: aio's subagents feature spawns a CHILD pi process
 * (AIO_SUBAGENT_CHILD=1). That child loads this extension too and shares the
 * parent's .pi-glla/active.jsonl — without a guard it would restore the
 * parent's goal and drive its own continuation loop. The factory bails out
 * early in any child process so the extension is inert there.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	type Goal,
	type State,
	type Status,
	type AuditLogEntry,
	type TaskProposal,
	appendLedger,
	archiveDir,
	archivedGoalPath,
	buildTaskList,
	buildTaskSummary,
	auditFeedbackExcerpt,
	DEFAULT_AUDIT_FEEDBACK_CHARS,
	DEFAULT_QUOTA_RETRY_MINUTES,
	DEFAULT_STALL_ESCALATION_REFIRES,
	DEFAULT_TOKEN_LIMIT,
	classifyImpossibleReason,
	extractPendingTasks,
	isFullAuditObjective,
	resolveEffectiveAggressiveSettings,
	appendAuditLog,
	runWithInfraRetry,
	stripThinkBlocks,
	shouldEscalateStall,
	isStaleApiError,
	sumNewAssistantTokens,
	countTrailingDisapprovals,
	goalArgsNeedDrafting,
	buildSeedGrillMessage,
	askUserQuestionAnswered,
	draftProposalBlock,
	validateTaskProposal,
	ensureDirs,
	findNextPendingTask,
	goalMdPath,
	newGoalId,
	nowIso,
	normalizeDraftContract,
	draftContractItemCount,
	extractVerificationContract,
	classifySessionCtx,
	readState,
	renderGoalMarkdown,
	shouldAutoResumeOnSessionStart,
	statusLabel,
	writeGoalMd,
	missingGllaTools,
	routeGoalArgs,
} from "./goal-loop-core.js";
import {
	isQuotaError,
	parseQuotaError,
	scheduleQuotaRetry,
	cancelQuotaRetry,
} from "./quota-retry.js";
import { loadSettings, type Settings } from "./goal-settings.js";
import { runGoalCompletionAuditor } from "./goal-loop-auditor.js";
import {
	buildStatusText,
	buildWidgetLines,
	type AuditDisplayProgress,
} from "./goal-loop-display.js";
import {
	accountTurnForNudges,
	BACKOFF_IDLE_RETRY_MS,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_MAX_NUDGES,
	HEARTBEAT_STALL_MS,
	shouldHeartbeatRefire,
	WEDGE_ALERT_DEFAULT_MINUTES,
	shouldWedgeAlert,
	PENDING_LATCH_STUCK_MS,
	shouldFirePendingLatchWatchdog,
} from "./goal-loop-backoff.js";

// =================================================================
// Constants
// =================================================================

const GOAL_EVENT_ENTRY = "goal-event";
/** stopReason marker for a goal held (not stopped) by the fresh-session restore gate. */
const HELD_ON_RESTORE = "held: restored in a fresh session";

// =================================================================
// Module-level state (one per session)
// =================================================================

let extensionApi: ExtensionAPI | null = null;
let extensionApiStale = false;

function goStaleTerminal(ctx: ExtensionContext, where: string): void {
	if (extensionApiStale) return;
	extensionApiStale = true;
	appendLedger(ctx.cwd, "extension_api_stale", { where, kind: "goal" });
	const guidance =
		"pi invalidated this session's extension handle (session replacement — compaction triggers it in pi 0.82.x). Sends can never land in this process. Restart pi (or reload extensions), then /goal resume.";
	if (state.goal && state.goal.status === "active") {
		updateGoal(
			{
				status: "paused",
				pauseReason: "extension api stale (pi session replacement)",
				pauseSuggestedAction: guidance,
			},
			ctx,
		);
	}
	ctx.ui.notify(`aio goal: ${guidance}`, "warning");
	notifyExternal(ctx, `aio goal: extension api stale — restart pi. (${where})`);
}

let lastCtx: ExtensionContext | null = null;
let ownerSession: unknown = null;

function rememberCtx(ctx: ExtensionContext): void {
	let ownerLive = false;
	if (ownerSession && lastCtx) {
		try {
			lastCtx.isIdle();
			ownerLive = true;
		} catch {
			/* owner went stale */
		}
	}
	const claim = classifySessionCtx(ownerSession, ownerLive, ctx.sessionManager);
	if (claim === "foreign") return;
	ownerSession = ctx.sessionManager;
	lastCtx = ctx;
}

function isForeignCtx(ctx: ExtensionContext): boolean {
	return ownerSession !== null && ctx.sessionManager !== ownerSession;
}

const FOREIGN_SESSION_TOOL_MESSAGE =
	"This tool changes goal state, which only the MAIN session owns — you are running in a subagent session. Report back to the main agent; it owns the goal and can call this tool.";

function foreignToolGuard(execCtx: unknown): string | null {
	const c = execCtx as ExtensionContext | undefined;
	return c && isForeignCtx(c) ? FOREIGN_SESSION_TOOL_MESSAGE : null;
}

let state: State = { goal: null };

let draftingTarget: "goal" | null = null;
let draftingUserReplies = 0;
let draftingBlockedProposals = 0;
let draftingSeedInFlight = false;

const countedTokenMessages = new Set<string>();

let lastActivityAt = Date.now();
let lastWedgeAlertAt = 0;
let heartbeatNudges = 0;
let consecutiveStalls = 0;
let completionAuditInFlight = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

function noteActivity(real = false): void {
	lastActivityAt = Date.now();
	if (real) consecutiveStalls = 0;
}

function isSupervising(): boolean {
	return (
		!!state.goal && state.goal.status === "active" && state.goal.autoContinue
	);
}

// =================================================================
// Live TUI: persistent status segment + above-editor widget.
// =================================================================

let latestAuditProgress: AuditDisplayProgress | null = null;
let uiTicker: NodeJS.Timeout | null = null;

function refreshUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	try {
		const theme = ctx.ui.theme as unknown as
			| import("./goal-loop-display.js").DisplayTheme
			| undefined;
		const width = process.stdout.columns || 80;
		ctx.ui.setStatus(
			"aio-goal",
			buildStatusText(state, latestAuditProgress, Date.now(), theme, {
				stalls: consecutiveStalls,
			}),
		);
		ctx.ui.setWidget(
			"aio-goal",
			buildWidgetLines(state, latestAuditProgress, Date.now(), theme, width, {
				stalls: consecutiveStalls,
			}),
		);
	} catch {
		// stale ctx — next event refreshes
	}
}

function startUITicker(): void {
	if (uiTicker) return;
	uiTicker = setInterval(() => {
		const ctx = freshCtx();
		if (ctx && isSupervising()) refreshUI(ctx);
	}, 1_000);
	uiTicker.unref?.();
}

function escalateStallNow(ctx: ExtensionContext, threshold: number): boolean {
	if (!shouldEscalateStall(consecutiveStalls, threshold)) return false;
	consecutiveStalls = 0;
	appendLedger(ctx.cwd, "stall_escalated", { threshold, kind: "goal" });
	if (state.goal && state.goal.status === "active") {
		updateGoal(
			{
				status: "paused",
				pauseReason: `stalled: ${threshold} continuation refires landed no turn`,
				pauseSuggestedAction:
					"The continuation chain is broken in this process (wedged message queue or stale API). Restart pi, then /goal resume.",
			},
			ctx,
		);
		ctx.ui.notify(
			`Goal paused: ${threshold} refires produced no turn. Restart pi, then /goal resume.`,
			"warning",
		);
		notifyExternal(ctx, "Goal paused: stalled (continuation not landing).");
		return true;
	}
	return true;
}

function heartbeatTick(): void {
	const ctx = freshCtx();
	if (!ctx) return;
	let idle = false;
	let pending = false;
	try {
		idle = ctx.isIdle();
		pending = ctx.hasPendingMessages();
	} catch {
		return;
	}
	const sessionIdle = idle && !pending;
	const latchSilentMs = Date.now() - lastActivityAt;
	if (
		shouldFirePendingLatchWatchdog({
			supervising: isSupervising(),
			idle,
			pending,
			timerPending: continuationTimer !== null,
			silentMs: latchSilentMs,
			thresholdMs: PENDING_LATCH_STUCK_MS,
		})
	) {
		consecutiveStalls++;
		appendLedger(ctx.cwd, "pending_latch_stuck", {
			consecutiveStalls,
			silentMs: latchSilentMs,
		});
		noteActivity();
		const stallEscalation =
			loadSettings(ctx.cwd).stallEscalationRefires ??
			DEFAULT_STALL_ESCALATION_REFIRES;
		if (escalateStallNow(ctx, stallEscalation)) return;
		const msg = `Heartbeat: a queued continuation never started its turn for ${Math.round(latchSilentMs / 60_000)}m — pi's pending-message latch appears stuck (known post-compaction failure; stall ${consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}). If this repeats, restart pi.`;
		ctx.ui.notify(msg, "warning");
		notifyExternal(ctx, msg);
		return;
	}
	const fire = shouldHeartbeatRefire({
		supervising: isSupervising(),
		sessionIdle,
		timerPending: continuationTimer !== null,
		msSinceActivity: Date.now() - lastActivityAt,
		stallMs: HEARTBEAT_STALL_MS,
	});
	const wedgeMinutes =
		resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd))
			.wedgeAlertMinutes ?? WEDGE_ALERT_DEFAULT_MINUTES;
	if (
		shouldWedgeAlert({
			supervising: isSupervising(),
			sessionBusy: !idle,
			silentMs: Date.now() - lastActivityAt,
			msSinceLastAlert: Date.now() - lastWedgeAlertAt,
			thresholdMs: wedgeMinutes * 60_000,
		})
	) {
		lastWedgeAlertAt = Date.now();
		const msg = `Goal appears wedged: no activity for ${Math.round((Date.now() - lastActivityAt) / 60_000)}m while the session is busy — likely a hung command (test/build/dev server without a timeout). Check the session; Esc kills a stuck tool call.`;
		appendLedger(ctx.cwd, "wedge_alert", {
			silentMs: Date.now() - lastActivityAt,
		});
		ctx.ui.notify(msg, "warning");
		notifyExternal(ctx, msg);
	}
	if (!fire) return;
	if (completionAuditInFlight) return;
	noteActivity();
	consecutiveStalls++;
	appendLedger(ctx.cwd, "heartbeat_refire", {
		nudgesSoFar: heartbeatNudges,
		consecutiveStalls,
	});
	const stallEscalation =
		loadSettings(ctx.cwd).stallEscalationRefires ??
		DEFAULT_STALL_ESCALATION_REFIRES;
	if (escalateStallNow(ctx, stallEscalation)) return;
	ctx.ui.notify(
		`Heartbeat: supervisor active but session stalled — re-firing continuation (stall ${consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}).`,
		"info",
	);
	scheduleContinuation(ctx, true);
}

function startHeartbeat(): void {
	if (heartbeatTimer) return;
	heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref?.();
}

let continuationTimer: NodeJS.Timeout | null = null;
let continuationScheduledFor: string | null = null;
let iterationCounter = 0;
let toolCallsThisTurn = 0;
let consecutiveErrorIterations = 0;

// =================================================================
// Helpers
// =================================================================

function clearContinuationTimer(): void {
	if (continuationTimer) {
		clearTimeout(continuationTimer);
		continuationTimer = null;
	}
	continuationScheduledFor = null;
}

function isActionableGoal(): boolean {
	return (
		!!state.goal && state.goal.status === "active" && state.goal.autoContinue
	);
}

function freshCtx(): ExtensionContext | null {
	if (!lastCtx) return null;
	try {
		lastCtx.isIdle();
		return lastCtx;
	} catch {
		lastCtx = null;
		return null;
	}
}

function scheduleContinuation(ctx: ExtensionContext, force = false): void {
	if (!isActionableGoal()) return;
	rememberCtx(ctx);
	const goalId = state.goal!.id;
	if (!force && continuationScheduledFor === goalId) return;
	clearContinuationTimer();
	let delay = 0;
	try {
		delay =
			ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS;
	} catch {
		return;
	}
	continuationScheduledFor = goalId;
	continuationTimer = setTimeout(() => sendContinuation(goalId), delay);
	continuationTimer.unref?.();
}

function sendContinuation(goalId: string): void {
	continuationTimer = null;
	continuationScheduledFor = null;
	if (!isActionableGoal()) return;
	const ctx = freshCtx();
	if (!ctx) {
		continuationScheduledFor = goalId;
		continuationTimer = setTimeout(
			() => sendContinuation(goalId),
			BACKOFF_IDLE_RETRY_MS,
		);
		continuationTimer.unref?.();
		return;
	}
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		continuationScheduledFor = goalId;
		continuationTimer = setTimeout(
			() => sendContinuation(goalId),
			BACKOFF_IDLE_RETRY_MS,
		);
		continuationTimer.unref?.();
		return;
	}
	if (!extensionApi || extensionApiStale) return;
	try {
		extensionApi.sendMessage(
			{
				customType: GOAL_EVENT_ENTRY,
				content: continuationPrompt(state.goal!),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		appendLedger(ctx.cwd, "goal_continuation_sent", { goalId });
	} catch (err) {
		appendLedger(ctx.cwd, "goal_continuation_send_failed", {
			goalId,
			error: err instanceof Error ? err.message : String(err),
		});
		if (isStaleApiError(err)) goStaleTerminal(ctx, "sendContinuation");
	}
}

function continuationPrompt(goal: Goal): string {
	const next = findNextPendingTask(goal.taskList?.tasks ?? []);
	const nextBlock = next
		? `**Next pending task**: \`${next.id}\` — ${next.title}`
		: "**Next pending task**: (none — only call complete_goal when the objective is satisfied)";
	const taskSummary = goal.taskList?.tasks.length
		? buildTaskSummary(goal.taskList.tasks)
		: "(no task list)";
	const tmplPath = path.resolve(
		__dirname,
		"prompts",
		"goal-loop-continuation.md",
	);
	let tmpl: string;
	try {
		tmpl = fs.readFileSync(tmplPath, "utf-8");
	} catch {
		tmpl = "[template-not-found]";
	}
	const directives: string[] = [];
	const effSettings = resolveEffectiveAggressiveSettings(
		loadSettings(freshCtx()?.cwd ?? process.cwd()),
	);
	if (goal.pendingTasks && goal.pendingTasks.length > 0) {
		directives.push(
			`## AUDITOR TODO LIST (from ${goal.pauseReason?.includes("cap") ? "the disapproval cap" : "the last audit"})\n\nAddress these objections, in order, before re-calling complete_goal:\n${goal.pendingTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
		);
	}
	if (effSettings.aggressiveMode && isFullAuditObjective(goal.objective)) {
		directives.push(
			"## FULL-AUDIT MODE (aggressiveMode + survey objective)\n\nThis objective is a survey, not a single fix. Spawn 3+ read-only `subagent` runs NOW — one per subsystem, in a single message so they run in parallel — synthesize their findings, and call `propose_task_list` with the result. Do not start fixing before the task list exists.",
		);
	}
	const dynamicDirectives =
		directives.length > 0 ? directives.join("\n\n") : "(no active directives)";
	return tmpl
		.replace(/\$\{GOAL_ID\}/g, goal.id)
		.replace(/\$\{OBJECTIVE\}/g, goal.objective)
		.replace(
			/\$\{VERIFICATION_CONTRACT\}/g,
			goal.verificationContract ||
				"(none — auditor will decide based on objective)",
		)
		.replace(/\$\{TASK_LIST\}/g, taskSummary)
		.replace(/\$\{NEXT_PENDING_TASK_BLOCK\}/g, nextBlock)
		.replace(/\$\{DYNAMIC_DIRECTIVES\}/g, dynamicDirectives);
}

// =================================================================
// Goal lifecycle
// =================================================================

function createGoal(objective: string, ctx: ExtensionContext): Goal {
	ensureDirs(ctx.cwd);
	const { objective: cleanObj, verificationContract } =
		extractVerificationContract(objective);
	const id = newGoalId();
	const goal: Goal = {
		id,
		objective: cleanObj,
		status: "active",
		policy: "goal",
		autoContinue: true,
		verificationContract: verificationContract || "",
		usage: {
			tokensUsed: 0,
			tokensLimit: loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT,
		},
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	return goal;
}

function persistState(ctx: ExtensionContext): void {
	appendLedger(ctx.cwd, "state", { goal: state.goal });
	refreshUI(ctx);
}

function setGoal(goal: Goal, ctx: ExtensionContext): void {
	state = { goal };
	const file = writeGoalMd(ctx.cwd, goal);
	state.goal!.activePath = path.relative(ctx.cwd, file) || file;
	persistState(ctx);
	appendLedger(ctx.cwd, "goal_created", {
		goalId: goal.id,
		objective: goal.objective,
		policy: goal.policy,
	});
}

function updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void {
	if (!state.goal) return;
	state.goal = { ...state.goal, ...patch, updatedAt: nowIso() };
	const file = writeGoalMd(ctx.cwd, state.goal);
	state.goal.activePath = path.relative(ctx.cwd, file) || file;
	persistState(ctx);
}

function archiveCurrentGoal(
	ctx: ExtensionContext,
	status: Status,
	stopReason?: string,
): void {
	if (!state.goal) return;
	const goal = state.goal;
	ensureDirs(ctx.cwd);
	const target = archivedGoalPath(ctx.cwd, goal.id);
	const md = renderGoalMarkdown({ ...goal, status, stopReason });
	fs.writeFileSync(target, md);
	try {
		fs.unlinkSync(goalMdPath(ctx.cwd, goal.id));
	} catch {}
	state = {
		goal: {
			...goal,
			status,
			archivedPath: path.relative(ctx.cwd, target) || target,
			stopReason,
		},
	};
	appendLedger(ctx.cwd, "goal_archived", {
		goalId: goal.id,
		status,
		stopReason,
	});
	persistState(ctx);
}

function notifyExternal(ctx: ExtensionContext, message: string): void {
	try {
		const cmd = loadSettings(ctx.cwd).notifyCmd;
		if (!cmd || !extensionApi) return;
		void extensionApi
			.exec("bash", ["-c", cmd, "aio-goal", message], { cwd: ctx.cwd })
			.catch(() => {});
	} catch {
		// non-fatal by design
	}
}

// =================================================================
// Drafting: /goal with no args → clarify → Confirm dialog → activate
// =================================================================

async function startDrafting(
	ctx: ExtensionContext,
	seed?: string,
): Promise<void> {
	draftingTarget = "goal";
	const label = "Goal drafting";
	const tool = "propose_goal_draft";
	ctx.ui.notify(
		seed
			? `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Skip the interview entirely: /goal start <objective>.`
			: `${label} started. The agent will grill until the contract is concrete, then ${tool} opens a Confirm dialog. No work begins before confirmation.`,
		"info",
	);
	const tmplPath = path.resolve(__dirname, "prompts", "goal-loop-draft.md");
	let tmpl: string;
	try {
		tmpl = fs.readFileSync(tmplPath, "utf-8");
	} catch {
		tmpl = `[DRAFTING] Clarify the user's goal, then call ${tool}.`;
	}
	if (seed) {
		tmpl = buildSeedGrillMessage(tmpl, seed, tool);
	}
	try {
		extensionApi?.sendUserMessage(tmpl, {
			deliverAs: ctx.isIdle() ? "followUp" : "steer",
		});
		draftingUserReplies = 0;
		draftingBlockedProposals = 0;
		draftingSeedInFlight = true;
	} catch {
		draftingTarget = null;
	}
}

// =================================================================
// /goal router: subcommands route to their handlers; everything else is
// an objective (draft if empty, set+start otherwise).
// =================================================================

async function cmdGoal(args: string, ctx: ExtensionContext): Promise<void> {
	const route = routeGoalArgs(args);
	if (route.kind === "sub") {
		if (route.name === "status") return cmdStatus(ctx);
		if (route.name === "pause") return cmdPause(ctx);
		if (route.name === "resume") return cmdResume(ctx);
		if (route.name === "cancel") return cmdCancel(ctx);
		if (route.name === "tweak") return cmdTweak(route.rest, ctx);
		if (route.name === "archive") return cmdGoals(ctx);
		if (route.name === "start") {
			if (!route.rest) {
				ctx.ui.notify(
					"Usage: /goal start <objective> — activates immediately, skipping the drafting interview. (Without start, an objective needs a 'Done when:' clause or it gets drafted first.)",
					"warning",
				);
				return;
			}
			return cmdSet(route.rest, ctx, true);
		}
	}
	return cmdSet(route.kind === "set" ? route.text : "", ctx);
}

async function cmdSet(
	args: string,
	ctx: ExtensionContext,
	skipDraft = false,
): Promise<void> {
	let raw = args.trim();
	if (
		raw.length >= 2 &&
		((raw.startsWith('"') && raw.endsWith('"')) ||
			(raw.startsWith("'") && raw.endsWith("'")))
	) {
		raw = raw.slice(1, -1).trim();
	}
	if (!raw) {
		await startDrafting(ctx);
		return;
	}
	// A contract-less objective gets drafted, not activated raw — the
	// pi-goal-x lesson: arg + Enter is worse than a 5-minute draft.
	// Include an explicit "Done when: …" clause to activate instantly.
	// /goal start bypasses this by explicit user command.
	if (!skipDraft && goalArgsNeedDrafting(raw)) {
		await startDrafting(ctx, raw);
		return;
	}
	draftingTarget = null;
	const goal = createGoal(raw, ctx);
	setGoal(goal, ctx);
	iterationCounter = 0;
	consecutiveErrorIterations = 0;
	ctx.ui.notify(
		`Goal ${goal.id} created — starting now. Auditor will verify on completion.`,
		"info",
	);
	scheduleContinuation(ctx, true);
}

async function cmdStatus(ctx: ExtensionContext): Promise<void> {
	if (!state.goal) {
		ctx.ui.notify("No active goal. Use /goal <objective>.", "info");
		return;
	}
	const g = state.goal;
	const lines = [
		`[${g.id}] ${statusLabel(g.status)}`,
		`Objective: ${g.objective}`,
		`Auto-continue: ${g.autoContinue ? "on" : "off"}`,
		`Iteration: ${iterationCounter}`,
		`Tokens: ${(g.usage?.tokensUsed ?? 0).toLocaleString()}${(g.usage?.tokensLimit ?? 0) > 0 ? ` / ${g.usage!.tokensLimit.toLocaleString()}` : " (no cap)"}`,
	];
	if (g.auditHistory && g.auditHistory.length > 0) {
		lines.push(
			`Audits: ${g.auditHistory.length} (${g.auditHistory.filter((v) => v.approved).length} approved)`,
		);
	}
	if (g.pauseReason) lines.push(`Paused: ${g.pauseReason}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdPause(ctx: ExtensionContext): Promise<void> {
	if (!state.goal) return;
	updateGoal({ status: "paused" }, ctx);
	ctx.ui.notify(
		`Goal ${state.goal.id} paused. /goal resume to continue.`,
		"info",
	);
}

async function cmdResume(ctx: ExtensionContext): Promise<void> {
	if (!state.goal || state.goal.status !== "paused") return;
	const freshLimit = loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT;
	const usage = state.goal.usage
		? { tokensUsed: state.goal.usage.tokensUsed, tokensLimit: freshLimit }
		: undefined;
	updateGoal(
		{
			status: "active",
			pauseReason: undefined,
			pauseSuggestedAction: undefined,
			...(usage ? { usage } : {}),
		},
		ctx,
	);
	ctx.ui.notify(
		`Resumed goal [${state.goal.id}]: ${state.goal.objective.replace(/\s+/g, " ").slice(0, 70)}`,
		"info",
	);
	scheduleContinuation(ctx, true);
}

async function cmdCancel(ctx: ExtensionContext): Promise<void> {
	if (!state.goal) return;
	archiveCurrentGoal(ctx, "aborted", "user cancelled");
	ctx.abort();
	ctx.ui.notify("Goal aborted.", "info");
}

async function cmdGoals(ctx: ExtensionContext): Promise<void> {
	const dir = archiveDir(ctx.cwd);
	if (!fs.existsSync(dir)) {
		ctx.ui.notify("No archived goals yet.", "info");
		return;
	}
	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.reverse();
	if (files.length === 0) {
		ctx.ui.notify("No archived goals yet.", "info");
		return;
	}
	const lines = files.slice(0, 20).map((f) => {
		let status = "?";
		let stop = "";
		let obj = "";
		try {
			const content = fs.readFileSync(path.join(dir, f), "utf-8");
			status = content.match(/\*\*Status\*\*:\s*(\w+)/)?.[1] ?? "?";
			stop = content.match(/\*\*Stop reason\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
			obj = content.match(/## Objective\s+>\s*(.+)/)?.[1]?.trim() ?? "";
		} catch {
			/* unreadable file — show name only */
		}
		return `${f.replace(/\.md$/, "")} [${status}] ${obj.slice(0, 60)}${stop ? ` — ${stop.slice(0, 40)}` : ""}`;
	});
	ctx.ui.notify(
		`Archived goals (${files.length}${files.length > 20 ? ", showing 20" : ""}):\n` +
			lines.join("\n"),
		"info",
	);
}

async function cmdTweak(args: string, ctx: ExtensionContext): Promise<void> {
	if (!state.goal || state.goal.status !== "active") {
		ctx.ui.notify(
			"No active goal to tweak. /goal <objective> to start one.",
			"info",
		);
		return;
	}
	let raw = args.trim();
	if (
		raw.length >= 2 &&
		((raw.startsWith('"') && raw.endsWith('"')) ||
			(raw.startsWith("'") && raw.endsWith("'")))
	) {
		raw = raw.slice(1, -1).trim();
	}
	if (!raw) {
		ctx.ui.notify(
			"Usage: /goal tweak <replacement objective, optional 'Done when: ...' clause>",
			"info",
		);
		return;
	}
	const current = state.goal;
	const proposed = extractVerificationContract(raw);
	const newObjective = proposed.objective;
	const newContract = proposed.verificationContract;
	let confirmed = false;
	try {
		confirmed = await ctx.ui.confirm(
			"Tweak goal?",
			`CURRENT:\n${current.objective}\n\nNEW:\n${newObjective}` +
				(newContract
					? `\n\nNew contract:\n${newContract}`
					: "\n\n(New text carries no contract; old contract is dropped.)"),
		);
	} catch {
		confirmed = false;
	}
	if (!confirmed) {
		ctx.ui.notify("Tweak cancelled; goal unchanged.", "info");
		return;
	}
	updateGoal(
		{ objective: newObjective, verificationContract: newContract },
		ctx,
	);
	appendLedger(ctx.cwd, "goal_tweaked", {
		goalId: current.id,
		objective: newObjective,
	});
	ctx.ui.notify(
		"Goal tweaked. The loop continues against the new objective.",
		"info",
	);
	scheduleContinuation(ctx, true);
}

// =================================================================
// Tools exposed to the agent
// =================================================================

function registerAgentTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
	pi.registerTool(
		defineTool({
			name: "complete_goal",
			label: "Complete goal",
			description:
				"Mark the active goal as complete. Spawns an isolated auditor to verify. Use only when the objective is genuinely satisfied.",
			parameters: Type.Object({
				completionSummary: Type.Optional(
					Type.String({ description: "1-paragraph completion claim" }),
				),
				verificationSummary: Type.Optional(
					Type.String({
						description: "Per-item evidence for the verification contract",
					}),
				),
				newObjective: Type.Optional(
					Type.String({
						description:
							"When the work has legitimately shifted, pass the new objective here — it atomically replaces the goal objective AND the audit proceeds against the NEW objective in this same call. Do not use to dodge a legitimate disapproval; the auditor sees the change.",
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, execCtx) {
				const foreign0 = foreignToolGuard(execCtx);
				if (foreign0)
					return { content: [{ type: "text", text: foreign0 }], details: {} };
				if (!state.goal || state.goal.status !== "active") {
					return {
						content: [{ type: "text", text: "No active goal." }],
						details: {},
					};
				}
				const p = params as {
					completionSummary?: string;
					verificationSummary?: string;
					newObjective?: string;
				};
				if (p.newObjective?.trim()) {
					const oldObjective = state.goal.objective;
					const { objective: cleanObj, verificationContract } =
						extractVerificationContract(p.newObjective.trim());
					updateGoal(
						{
							objective: cleanObj,
							...(verificationContract ? { verificationContract } : {}),
						},
						ctx,
					);
					appendLedger(ctx.cwd, "goal_tweaked", {
						via: "complete_goal.newObjective",
						from: oldObjective.slice(0, 200),
						to: cleanObj.slice(0, 200),
					});
					ctx.ui.notify(
						`Objective updated (complete_goal newObjective): ${cleanObj.slice(0, 80)}`,
						"info",
					);
				}
				updateGoal({ status: "auditing", pendingTasks: undefined }, ctx);
				const settings = loadSettings(ctx.cwd);
				const {
					model: auditorModel,
					error: modelError,
					via,
				} = resolveAuditorModel(ctx, settings.auditorModel);
				if (modelError) {
					ctx.ui.notify(`Auditor model issue: ${modelError}`, "warning");
				}
				ctx.ui.notify(
					`Auditor running (isolated session, model: ${via ?? "setting"})…`,
					"info",
				);
				latestAuditProgress = { label: "starting", lastEventAt: Date.now() };
				const runAudit = () =>
					runGoalCompletionAuditor({
						ctx,
						goal: state.goal!,
						completionSummary: p.completionSummary,
						verificationSummary: p.verificationSummary,
						model: auditorModel,
						thinkingLevel:
							settings.auditorThinkingLevel ?? getSessionThinkingLevel(),
						signal: signal ?? undefined,
						onProgress: (progress) => {
							latestAuditProgress = {
								currentTool: progress.currentTool,
								label: progress.label,
								elapsedMs: progress.elapsedMs,
								lastEventAt: Date.now(),
							};
							refreshUI(ctx);
						},
					});
				const auditStartMs = Date.now();
				completionAuditInFlight = true;
				let result: Awaited<ReturnType<typeof runAudit>>;
				let retriedOnce = false;
				try {
					({ result, retriedOnce } = await runWithInfraRetry(runAudit, {
						onRetry: (err) => {
							latestAuditProgress = {
								label: `infra error (${err.slice(0, 40)}) — retrying once`,
								lastEventAt: Date.now(),
							};
							refreshUI(ctx);
							appendLedger(ctx.cwd, "audit_infra_retry", {
								goalId: state.goal?.id,
								error: err.slice(0, 200),
							});
						},
					}));
				} finally {
					completionAuditInFlight = false;
				}
				const auditDurationMs = Date.now() - auditStartMs;
				latestAuditProgress = null;
				const auditorRan = result.output.trim().length > 0;
				const history = state.goal.auditHistory ?? [];
				if (auditorRan) {
					const cleanOutput = stripThinkBlocks(result.output);
					result.output = cleanOutput;
					history.push({
						at: nowIso(),
						approved: result.approved,
						disapproved: result.disapproved,
						impossible: result.impossible,
						impossibleReason: result.impossibleReason,
						model: result.model,
						thinkingLevel: result.thinkingLevel,
						report: cleanOutput,
						error: result.error,
						regressionShieldPassed: result.regressionShieldPassed,
						regressionShieldMissing: result.regressionShieldMissing,
						durationMs: auditDurationMs,
					} as any);
					if (history.length > 20) history.splice(0, history.length - 20);
					const verdict: AuditLogEntry["verdict"] =
						result.error && !result.approved && !result.disapproved
							? "error"
							: result.approved && result.regressionShieldPassed === false
								? "shield_blocked"
								: result.approved
									? "approved"
									: result.impossible
										? "impossible"
										: "disapproved";
					appendAuditLog(ctx.cwd, {
						at: nowIso(),
						goalId: state.goal.id,
						objective: state.goal.objective.slice(0, 200),
						verdict,
						model: result.model,
						thinkingLevel: result.thinkingLevel ?? "(default)",
						report: cleanOutput,
						impossibleReason: result.impossibleReason,
						error: result.error,
						durationMs: auditDurationMs,
						retriedOnce,
					} as AuditLogEntry);
				}

				// Escape hatch: the user aborted the audit (Esc).
				if (result.error === "Auditor aborted.") {
					updateGoal(
						{
							status: "active",
							auditHistory: history,
							pauseReason: "audit aborted by user (Esc)",
						},
						ctx,
					);
					let completeAnyway = false;
					try {
						completeAnyway = await ctx.ui.confirm(
							"Audit aborted",
							"You aborted the auditor (Escape).\n\nYes = mark the goal COMPLETE WITHOUT AUDIT (you take responsibility for verification).\nNo = continue working; the auditor will verify on the next complete_goal.",
						);
					} catch {
						completeAnyway = false;
					}
					if (completeAnyway) {
						updateGoal({ auditHistory: history }, ctx);
						archiveCurrentGoal(
							ctx,
							"complete",
							"completed without audit (user choice after Esc)",
						);
						return {
							content: [
								{
									type: "text",
									text: "Goal marked complete without audit (user choice).",
								},
							],
							details: {},
						};
					}
					scheduleContinuation(ctx, true);
					return {
						content: [
							{
								type: "text",
								text: "Audit aborted; continuing. Call complete_goal again when ready — the auditor will re-run.",
							},
						],
						details: {},
					};
				}

				if (result.approved) {
					updateGoal({ auditHistory: history }, ctx);
					const objective = state.goal.objective;
					archiveCurrentGoal(
						ctx,
						"complete",
						`auditor ${result.model} approved`,
					);
					notifyExternal(
						ctx,
						`Goal complete (auditor approved): ${objective.slice(0, 120)}`,
					);
					return {
						content: [
							{
								type: "text",
								text: `Goal approved by auditor ${result.model}.`,
							},
						],
						details: {},
					};
				}

				// IMPOSSIBLE: the auditor's escape hatch for goals that can NEVER
				// be satisfied as stated. Not a disapproval — continuing would burn
				// tokens on a provably unwinnable objective.
				if (result.impossible) {
					const reason = result.impossibleReason || "(no reason given)";
					const effectiveImp = resolveEffectiveAggressiveSettings(
						loadSettings(ctx.cwd),
					);
					if (
						effectiveImp.aggressiveMode &&
						classifyImpossibleReason(reason) === "partial"
					) {
						updateGoal(
							{
								status: "active",
								auditHistory: history,
								pauseReason: `auditor verdict: IMPOSSIBLE (partial) — ${reason}`,
								pauseSuggestedAction:
									"Narrow the objective past the impossible part (complete_goal newObjective or /goal tweak) and continue",
							},
							ctx,
						);
						ctx.ui.notify(
							`Auditor: part of the goal is IMPOSSIBLE — ${reason.slice(0, 100)}. aggressiveMode: narrowing and continuing.`,
							"warning",
						);
						appendLedger(ctx.cwd, "impossible_partial_continue", {
							reason: reason.slice(0, 200),
						});
						scheduleContinuation(ctx, true);
						return {
							content: [
								{
									type: "text",
									text: `The auditor says PART of this goal can never be satisfied: ${reason}\n\naggressiveMode is ON, so the goal stays ACTIVE. Do NOT keep attempting the impossible part. Narrow the objective to the remaining shippable items — pass newObjective to complete_goal at completion time (or pause_goal proposing /goal tweak if the narrowing needs the user's call) — and continue working the rest now.`,
								},
							],
							details: {},
						};
					}
					updateGoal(
						{
							status: "paused",
							auditHistory: history,
							pauseReason: `auditor verdict: IMPOSSIBLE — ${reason}`,
							pauseSuggestedAction:
								"The auditor says this goal can never be satisfied as stated. /goal tweak the objective (or /goal cancel), then /goal resume.",
						},
						ctx,
					);
					ctx.ui.notify(
						`Auditor: goal IMPOSSIBLE — ${reason}. Goal paused; /goal tweak or /goal cancel, then /goal resume.`,
						"warning",
					);
					appendLedger(ctx.cwd, "goal_paused", {
						reason: `auditor impossible: ${reason}`,
					});
					notifyExternal(
						ctx,
						`Goal paused (auditor: impossible): ${reason.slice(0, 120)}`,
					);
					return {
						content: [
							{
								type: "text",
								text: `The auditor's verdict is IMPOSSIBLE: ${reason}\n\nThis is not a disapproval — the auditor says the objective can never be satisfied as stated. The goal is now PAUSED. Do not call complete_goal again. Report the verdict to the user and suggest /goal tweak (narrow or correct the objective) or /goal cancel.`,
							},
						],
						details: {},
					};
				}

				// THREE-WAY SPLIT: infrastructure failure is NOT a verdict.
				if (result.error && !result.disapproved) {
					if (isQuotaError(result.error)) {
						const settingsNow = loadSettings(ctx.cwd);
						const defaultSec =
							(settingsNow.quotaRetryMinutes ?? DEFAULT_QUOTA_RETRY_MINUTES) *
							60;
						const quota = parseQuotaError(result.error, defaultSec);
						const retryMin = Math.max(1, Math.round(quota.retryAfterSec / 60));
						updateGoal(
							{
								status: "paused",
								auditHistory: history,
								pauseReason: `auditor quota: ${result.error}`,
								pauseSuggestedAction: `Quota auto-retry in ${retryMin}m — or /goal resume to retry now`,
							},
							ctx,
						);
						appendLedger(ctx.cwd, "goal_paused", {
							reason: `auditor quota: retry in ${quota.retryAfterSec}s (${quota.fromUpstream ? "upstream hint" : "default"})`,
						});
						scheduleQuotaRetry(ctx, quota.retryAfterSec, result.error, () => {
							if (
								state.goal &&
								state.goal.status === "paused" &&
								(state.goal.pauseReason ?? "").startsWith("auditor quota:")
							) {
								updateGoal({ status: "active" }, ctx);
								appendLedger(ctx.cwd, "goal_resumed", { via: "quota-retry" });
								if (
									resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd))
										.aggressiveMode
								) {
									ctx.ui.notify(
										"Auto-resume fired (event: auditor quota window elapsed). Continue working.",
										"info",
									);
								}
								scheduleContinuation(ctx, true);
							}
						});
						return {
							content: [
								{
									type: "text",
									text: `The auditor hit a QUOTA / rate-limit error (infrastructure, NOT a verdict): ${result.error}\nThe goal is PAUSED with an automatic retry scheduled in ${retryMin} minute(s)${quota.fromUpstream ? " (upstream Retry-After hint)" : " (default window)"}. Your completion claim was not evaluated; do not change your deliverable for this. /goal resume retries immediately.`,
								},
							],
							details: {},
						};
					}
					updateGoal(
						{
							status: "active",
							auditHistory: history,
							pauseReason: `auditor infrastructure${retriedOnce ? " (retried once)" : ""}: ${result.error}`,
							pauseSuggestedAction:
								"Fix the auditor model (edit ~/.pi/agent/aio-goal.settings.json auditorModel) and call complete_goal again — your work was NOT judged",
						},
						ctx,
					);
					scheduleContinuation(ctx, true);
					return {
						content: [
							{
								type: "text",
								text: `The auditor could not run (infrastructure, NOT a verdict${retriedOnce ? "; retried once with backoff, both attempts failed" : ""}): ${result.error}\nYour completion claim was not evaluated. Fix the auditor model (set auditorModel in ~/.pi/agent/aio-goal.settings.json) and call complete_goal again — do not change your deliverable for this.`,
							},
						],
						details: {},
					};
				}

				// Shield-blocked approval: the auditor APPROVED but the regression
				// shield found contract items the evidence never referenced.
				if (
					result.regressionShieldPassed === false &&
					result.regressionShieldMissing &&
					result.regressionShieldMissing.length > 0
				) {
					const missing = result.regressionShieldMissing;
					updateGoal(
						{
							status: "active",
							auditHistory: history,
							pauseReason: `regression shield: auditor approved, but evidence never referenced ${missing.length} contract item(s)`,
							pauseSuggestedAction:
								"call complete_goal again — the next auditor run is told exactly which items to quote evidence for",
						},
						ctx,
					);
					scheduleContinuation(ctx, true);
					return {
						content: [
							{
								type: "text",
								text: `The auditor APPROVED, but the orchestrator's regression shield blocked completion: the report's evidence never referenced these contract items:\n${missing.map((i) => `- ${i}`).join("\n")}\n\nThis is NOT a verdict on your work — do not change your deliverable for this. Call complete_goal again; the next auditor run is explicitly told to quote raw evidence for each of these items.`,
							},
						],
						details: {},
					};
				}

				const noContractHint = state.goal.verificationContract?.trim()
					? ""
					: "\n\nNote: this goal has no verification contract, so the auditor inferred done-criteria from the objective text. For sharper verdicts, /goal tweak the objective to add a 'Done when: ...' clause.";
				const effectiveCap = resolveEffectiveAggressiveSettings(settings);
				const auditCap = effectiveCap.auditCap;
				const configuredFeedbackChars = settings.auditFeedbackChars;
				const auditFeedbackChars =
					Number.isInteger(configuredFeedbackChars) &&
					configuredFeedbackChars! >= 0
						? configuredFeedbackChars!
						: DEFAULT_AUDIT_FEEDBACK_CHARS;
				const auditFeedback = auditFeedbackExcerpt(
					result.output,
					auditFeedbackChars,
				);
				const auditFeedbackIsFull =
					auditFeedbackChars === 0 ||
					result.output.length <= auditFeedbackChars;
				const auditFeedbackLabel = auditFeedbackIsFull
					? "full report"
					: `last ${auditFeedbackChars} chars (Required-fixes tail)`;
				const auditFeedbackTruncationHint = auditFeedbackIsFull
					? ""
					: "\n\nReport truncated at the configured limit. /goal status shows the full report.";
				const trailingDisapprovals = countTrailingDisapprovals(history);
				if (auditCap > 0 && trailingDisapprovals >= auditCap) {
					if (effectiveCap.aggressiveMode) {
						const pendingTasks = extractPendingTasks(result.output, 5);
						updateGoal(
							{
								status: "active",
								auditHistory: history,
								pendingTasks,
								pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}) — aggressiveMode: continuing with TODOs`,
							},
							ctx,
						);
						const todoBlock =
							pendingTasks.length > 0
								? pendingTasks.map((t, i) => ` ${i + 1}. ${t}`).join("\n")
								: " (no discrete objections extracted — re-read the latest report in /goal status)";
						ctx.ui.notify(
							`Auditor disapproved ${trailingDisapprovals}× (cap). Treating as TODOs:\n${todoBlock}`,
							"warning",
						);
						appendLedger(ctx.cwd, "audit_cap_keep_going", {
							trailingDisapprovals,
							auditCap,
							pendingTasks,
						});
						scheduleContinuation(ctx, true);
						return {
							content: [
								{
									type: "text",
									text: `The auditor has disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}), but aggressiveMode is ON — the goal stays ACTIVE and the objections are now your TODO list:\n${todoBlock}\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nWork the TODOs in order. If the auditor is WRONG about an objection, follow WHEN THE AUDITOR DISAPPROVES: investigate, quote its objection, compare against what you shipped, and present the user YOUR ASSESSMENT. If the objective itself has drifted, pass newObjective to complete_goal.`,
								},
							],
							details: {},
						};
					}
					updateGoal(
						{
							status: "paused",
							auditHistory: history,
							pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap})`,
							pauseSuggestedAction:
								"Read the audit history (/goal status), fix the actual gap or /goal tweak the objective, then /goal resume.",
						},
						ctx,
					);
					ctx.ui.notify(
						`Goal paused: auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}). /goal status for the reports; /goal resume to continue.`,
						"warning",
					);
					appendLedger(ctx.cwd, "goal_paused", {
						reason: `disapproval cap: ${trailingDisapprovals} consecutive (cap ${auditCap})`,
					});
					notifyExternal(
						ctx,
						`Goal paused: ${trailingDisapprovals} consecutive auditor disapprovals`,
					);
					return {
						content: [
							{
								type: "text",
								text: `The auditor has now disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}). The goal is PAUSED — continuing to re-attempt without addressing the pattern wastes tokens.\n\nBefore asking the user, INVESTIGATE:\n1. Read the audit history (the auditor's previous reports — /goal status shows them).\n2. Identify the SPECIFIC objections — quote them.\n3. Compare against what you actually shipped (commits, diffs, test output).\n4. Form a clear opinion: is the auditor right, wrong, or partially right?\n5. Present the user YOUR ASSESSMENT with quoted objections and shipped evidence — not a generic menu of options.\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nDo not call complete_goal again until the pattern is addressed. /goal resume resumes; /goal tweak fixes a drifted objective.`,
							},
						],
						details: {},
					};
				}
				updateGoal(
					{
						status: "active",
						auditHistory: history,
						pauseReason: "auditor disapproved",
						pauseSuggestedAction:
							"Inspect auditor feedback and fix the actual gap before calling complete_goal again",
					},
					ctx,
				);
				scheduleContinuation(ctx, true);
				return {
					content: [
						{
							type: "text",
							text: `Auditor disapproved. Report (${auditFeedbackLabel}):\n${auditFeedback}${auditFeedbackTruncationHint}${noContractHint}`,
						},
					],
					details: {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "pause_goal",
			label: "Pause goal",
			description:
				"Pause the active goal with a reason and suggested action. Use when blocked on user input or unable to make progress.",
			parameters: Type.Object({
				reason: Type.String({ description: "Why the work is paused" }),
				suggestedAction: Type.Optional(
					Type.String({ description: "What the user should do next" }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, execCtx) {
				const foreign1 = foreignToolGuard(execCtx);
				if (foreign1)
					return { content: [{ type: "text", text: foreign1 }], details: {} };
				const p = params as { reason: string; suggestedAction?: string };
				if (!state.goal)
					return {
						content: [{ type: "text", text: "No active goal." }],
						details: {},
					};
				updateGoal(
					{
						status: "paused",
						pauseReason: p.reason,
						pauseSuggestedAction: p.suggestedAction,
					},
					ctx,
				);
				ctx.ui.notify(`Goal paused: ${p.reason}`, "info");
				notifyExternal(ctx, `Goal paused: ${p.reason.slice(0, 120)}`);
				return {
					content: [
						{ type: "text", text: "Goal paused. /goal resume to continue." },
					],
					details: {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "complete_task",
			label: "Complete task",
			description:
				"Mark a task in the active goal's task list as complete (does not stop the turn).",
			parameters: Type.Object({
				id: Type.String({ description: "Task id to complete" }),
			}),
			async execute(_id, params) {
				const p = params as { id: string };
				if (!state.goal || !state.goal.taskList) {
					return {
						content: [{ type: "text", text: "No task list in this goal." }],
						details: {},
					};
				}
				const tl = state.goal.taskList;
				const queue: any[] = [...tl.tasks];
				while (queue.length > 0) {
					const t = queue.shift();
					if (t.id === p.id && t.status !== "complete") {
						t.status = "complete";
						updateGoal({ taskList: tl }, ctx);
						return {
							content: [
								{ type: "text", text: `Task ${p.id} marked complete.` },
							],
							details: {},
						};
					}
					if (t.subtasks) queue.push(...t.subtasks);
				}
				return {
					content: [{ type: "text", text: `Task ${p.id} not found.` }],
					details: {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "update_task_status",
			label: "Update task status",
			description: "Update a task's status (pending/in_progress/complete).",
			parameters: Type.Object({
				id: Type.String(),
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("complete"),
				]),
			}),
			async execute(_id, params) {
				const p = params as {
					id: string;
					status: "pending" | "in_progress" | "complete";
				};
				if (!state.goal || !state.goal.taskList) {
					return {
						content: [{ type: "text", text: "No task list in this goal." }],
						details: {},
					};
				}
				const tl = state.goal.taskList;
				const queue: any[] = [...tl.tasks];
				while (queue.length > 0) {
					const t = queue.shift();
					if (t.id === p.id) {
						t.status = p.status;
						updateGoal({ taskList: tl }, ctx);
						return {
							content: [{ type: "text", text: `Task ${p.id} → ${p.status}` }],
							details: {},
						};
					}
					if (t.subtasks) queue.push(...t.subtasks);
				}
				return {
					content: [{ type: "text", text: `Task ${p.id} not found.` }],
					details: {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "propose_goal_draft",
			label: "Propose goal draft",
			description:
				"During goal drafting (/goal with no args), propose the clarified goal contract. Opens the user's Confirm dialog — nothing activates until they confirm. BLOCKED until the user has replied to at least one of your interview questions.",
			parameters: Type.Object({
				objective: Type.String({
					description: "The clarified, concrete objective",
				}),
				verificationContract: Type.Optional(
					Type.String({
						description:
							"Checkable done-criteria (commands, file states, test outcomes)",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, execCtx) {
				const foreign2 = foreignToolGuard(execCtx);
				if (foreign2)
					return { content: [{ type: "text", text: foreign2 }], details: {} };
				const p = params as {
					objective: string;
					verificationContract?: string;
				};
				if (draftingTarget !== "goal") {
					return {
						content: [
							{
								type: "text",
								text: "Not in goal drafting mode. The user starts drafting with /goal (no args), or activates directly with /goal <objective>.",
							},
						],
						details: {},
					};
				}
				const autoAccept = loadSettings(ctx.cwd).autoAcceptDrafts === true;
				if (!autoAccept) {
					if (draftingUserReplies === 0) draftingBlockedProposals++;
					const block = draftProposalBlock(
						draftingUserReplies,
						draftingBlockedProposals,
					);
					if (block) {
						return { content: [{ type: "text", text: block }], details: {} };
					}
				}
				const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
				const normContract = p.verificationContract?.trim()
					? normalizeDraftContract(p.verificationContract)
					: "";
				const checkCount = normContract
					? draftContractItemCount(normContract)
					: 0;
				const contractBlock = normContract
					? `\n\nDone when${checkCount > 0 ? ` — ${checkCount} check${checkCount === 1 ? "" : "s"}` : ""}:\n${normContract}`
					: "\n\n(No verification contract — the auditor will infer done-criteria from the objective. Consider adding one.)";
				let confirmed = false;
				if (autoAccept) {
					confirmed = true;
					liveCtx.ui.notify(
						`Draft auto-accepted (autoAcceptDrafts=on) — ACTIVATING now: ${p.objective.trim().slice(0, 90)}`,
						"info",
					);
					appendLedger(liveCtx.cwd, "draft_autoaccepted", {
						kind: "goal",
						objective: p.objective.trim().slice(0, 200),
					});
				} else {
					try {
						confirmed = await liveCtx.ui.confirm(
							"Confirm goal",
							`${p.objective.trim()}${contractBlock}`,
						);
					} catch {
						confirmed = false;
					}
				}
				if (!confirmed) {
					return {
						content: [
							{
								type: "text",
								text: "Draft rejected by the user. Ask what to change, refine, and propose again. Do not repeat the identical draft.",
							},
						],
						details: {},
					};
				}
				draftingTarget = null;
				const full =
					p.objective.trim() +
					(normContract ? `\nDone when:\n${normContract}` : "");
				const goal = createGoal(full, liveCtx);
				setGoal(goal, liveCtx);
				iterationCounter = 0;
				consecutiveErrorIterations = 0;
				scheduleContinuation(liveCtx, true);
				return {
					content: [
						{
							type: "text",
							text: `Goal confirmed and activated (id ${goal.id}). Begin work now; call complete_goal only when the objective is genuinely satisfied.`,
						},
					],
					details: {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "propose_task_list",
			label: "Propose task list",
			description:
				"Propose a task breakdown for the active goal. Opens the user's Confirm dialog. Limits: 20 top-level tasks, 5 subtasks per task.",
			parameters: Type.Object({
				tasks: Type.Array(
					Type.Object({
						title: Type.String(),
						subtasks: Type.Optional(Type.Array(Type.String())),
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, execCtx) {
				if (!state.goal || state.goal.status !== "active") {
					return {
						content: [{ type: "text", text: "No active goal to break down." }],
						details: {},
					};
				}
				if (state.goal.taskList && state.goal.taskList.tasks.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: "A task list already exists. Use update_task_status / complete_task to work it.",
							},
						],
						details: {},
					};
				}
				const p = params as { tasks: TaskProposal[] };
				const invalid = validateTaskProposal(p.tasks);
				if (invalid) {
					return { content: [{ type: "text", text: invalid }], details: {} };
				}
				const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
				const preview = p.tasks
					.map((t, i) => {
						const subs = (t.subtasks ?? [])
							.map((s, j) => `   ${i + 1}.${j + 1} ${s}`)
							.join("\n");
						return `${i + 1}. ${t.title}` + (subs ? `\n${subs}` : "");
					})
					.join("\n");
				const autoAcceptTasks = loadSettings(ctx.cwd).autoAcceptDrafts === true;
				let confirmed = false;
				if (autoAcceptTasks) {
					confirmed = true;
					liveCtx.ui.notify(
						`Task list auto-accepted (autoAcceptDrafts=on): ${p.tasks.length} tasks.`,
						"info",
					);
					appendLedger(liveCtx.cwd, "draft_autoaccepted", {
						kind: "tasks",
						count: p.tasks.length,
					});
				} else {
					try {
						confirmed = await liveCtx.ui.confirm("Confirm task list", preview);
					} catch {
						confirmed = false;
					}
				}
				if (!confirmed) {
					return {
						content: [
							{
								type: "text",
								text: "Task list rejected by the user. Adjust and propose again.",
							},
						],
						details: {},
					};
				}
				const taskList = buildTaskList(p.tasks);
				updateGoal({ taskList }, liveCtx);
				const subCount = taskList.tasks.reduce(
					(n, t) => n + (t.subtasks?.length ?? 0),
					0,
				);
				return {
					content: [
						{
							type: "text",
							text: `Task list set: ${taskList.tasks.length} tasks, ${subCount} subtasks. Track progress with complete_task / update_task_status.`,
						},
					],
					details: {},
				};
			},
		}),
	);
}

// =================================================================
// Auditor model resolution + thinking floor
// =================================================================

function getSessionThinkingLevel():
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh" {
	try {
		const level = extensionApi?.getThinkingLevel?.();
		if (
			level &&
			["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)
		) {
			return level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
		}
	} catch {
		// fall through to the floor
	}
	return "high";
}

function resolveAuditorModel(
	ctx: ExtensionContext,
	ref?: string,
): { model: any; error?: string; via?: string } {
	if (ref && ref.trim()) {
		const trimmed = ref.trim();
		const slash = trimmed.indexOf("/");
		if (slash > 0) {
			const provider = trimmed.slice(0, slash);
			const id = trimmed.slice(slash + 1);
			const model = ctx.modelRegistry.find(provider, id);
			return model
				? { model, via: "setting" }
				: { model: undefined, error: `model not found: ${trimmed}` };
		}
		const matches = ctx.modelRegistry
			.getAvailable()
			.filter((m: any) => m.id === trimmed || m.name === trimmed);
		return matches[0]
			? { model: matches[0], via: "setting" }
			: { model: undefined, error: `no available model matching: ${trimmed}` };
	}
	const sessionModel = ctx.model as any;
	if (sessionModel) return { model: sessionModel, via: "session" };
	return {
		model: undefined,
		error:
			"no session model and no auditorModel configured — set auditorModel in ~/.pi/agent/aio-goal.settings.json",
	};
}

// =================================================================
// Command-collision + provider-risk warnings
// =================================================================

const OUR_COMMANDS = ["goal"];
let collisionWarned = false;

const KNOWN_BUILTIN_PROVIDERS = new Set([
	"anthropic",
	"google",
	"google-vertex",
	"google-gemini-cli",
	"openai",
	"openai-codex",
	"openrouter",
	"opencode",
	"azure-openai-responses",
	"groq",
	"cerebras",
	"xai",
	"zai",
	"minimax",
	"minimax-cn",
	"moonshotai",
	"kimi-coding",
	"github-copilot",
	"mistral",
	"huggingface",
]);
let providerWarned = false;

function warnIfAuditorProviderRisky(ctx: ExtensionContext): void {
	if (providerWarned) return;
	providerWarned = true;
	try {
		const settings = loadSettings(ctx.cwd);
		if (settings.auditorModel) return;
		const provider = (ctx.model as any)?.provider as string | undefined;
		if (!provider || KNOWN_BUILTIN_PROVIDERS.has(provider)) return;
		ctx.ui.notify(
			`aio goal: session provider "${provider}" is not a known built-in. The auditor inherits the resolved model in-process, so this usually works — but if audits error with auth/provider failures, set an explicit auditorModel override in ~/.pi/agent/aio-goal.settings.json.`,
			"info",
		);
	} catch {
		// non-fatal by design
	}
}

function warnOnCommandCollision(ctx: ExtensionContext): void {
	if (collisionWarned) return;
	collisionWarned = true;
	try {
		if (!extensionApi) return;
		const counts = new Map<string, number>();
		for (const cmd of extensionApi.getCommands() as any[]) {
			const name =
				String(cmd.invocationName ?? cmd.name ?? "").split(":")[0] ?? "";
			if (OUR_COMMANDS.includes(name)) {
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
		}
		const dupes = [...counts.entries()]
			.filter(([, n]) => n > 1)
			.map(([n]) => `/${n}`);
		if (dupes.length > 0) {
			ctx.ui.notify(
				`aio goal: command collision on ${dupes.join(", ")}. Another extension registered the same name; ours may be reachable as /goal:2. Consider disabling the other plugin.`,
				"warning",
			);
		}
	} catch {
		// getCommands unavailable or shape changed — collision is non-fatal.
	}
}

// =================================================================
// Public extension entry
// =================================================================

export default function (pi: ExtensionAPI): void {
	// Subagent adaptation: aio's subagents spawn a CHILD pi process with
	// AIO_SUBAGENT_CHILD=1. That child shares the parent's .pi-glla state and
	// would otherwise restore the parent's goal and drive its own continuation
	// loop. The extension is inert in any child process — the main session owns
	// the goal.
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	extensionApi = pi;
	extensionApiStale = false;
	startHeartbeat();
	startUITicker();

	const completions = (items: Array<[string, string]>) => (prefix: string) =>
		items
			.filter(([value]) => value.startsWith(prefix))
			.map(([value, description]) => ({ value, label: value, description }));

	pi.registerCommand("goal", {
		description:
			"Set/draft a goal, or /goal status|pause|resume|cancel|tweak <text>|archive|start <objective>. Objectives without a 'Done when:' clause are grilled into a contract first; include the clause or use /goal start to skip the interview and activate instantly.",
		getArgumentCompletions: completions([
			[
				"start",
				"skip drafting — /goal start <objective> activates immediately",
			],
			["status", "show the active goal and its task list"],
			["pause", "pause the active goal"],
			["resume", "resume a paused goal"],
			["cancel", "abort the active goal"],
			["tweak", "change the objective: /goal tweak <text>"],
			["archive", "list archived goals"],
		]),
		handler: (args: string, ctx: ExtensionContext) => {
			rememberCtx(ctx);
			return cmdGoal(args, ctx);
		},
	});

	let registeredCtx: ExtensionContext | null = null;
	let toolHealNotified = false;

	function ensureAgentToolsActive(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
	): void {
		try {
			const active = pi.getActiveTools();
			const missing = missingGllaTools(active);
			if (missing.length === 0) return;
			pi.setActiveTools([...active, ...missing]);
			if (!toolHealNotified) {
				toolHealNotified = true;
				const list = missing.join(", ");
				ctx.ui.notify(
					`aio goal: ${missing.length} agent tool(s) were hidden by an external tool allowlist and have been re-activated (${list}). Add them to your allowlist profile to silence this.`,
					"warning",
				);
			}
		} catch {
			// Older pi without getActiveTools/setActiveTools — nothing we can do.
		}
	}

	// Compaction ends WITHOUT an agent_end, so the continuation chain can
	// dangle until the 60s heartbeat notices. Re-arm it once pi settles.
	pi.on("session_compact", async (_event: any, ctx: ExtensionContext) => {
		if (isForeignCtx(ctx)) return;
		rememberCtx(ctx);
		if (!isSupervising()) return;
		appendLedger(ctx.cwd, "session_compact", {});
		const settle = setTimeout(() => {
			const c = freshCtx();
			if (!c) return;
			try {
				if (
					c.isIdle() &&
					!c.hasPendingMessages() &&
					continuationTimer === null &&
					isSupervising()
				) {
					appendLedger(c.cwd, "compaction_refire", {});
					scheduleContinuation(c, true);
				}
			} catch {
				/* settle race — the 60s heartbeat covers it */
			}
		}, 2000);
		settle.unref?.();
	});

	pi.on("message_start", async (event: any, _ctx: ExtensionContext) => {
		if (draftingTarget === null) return;
		if (event?.message?.role !== "user") return;
		if (draftingSeedInFlight) {
			draftingSeedInFlight = false;
			return;
		}
		draftingUserReplies++;
	});

	// ask_user_question answers arrive as tool results, not chat messages —
	// count answered (non-cancelled) questionnaires as drafting replies too.
	pi.on("tool_result", async (event: any) => {
		if (draftingTarget === null) return;
		if (
			askUserQuestionAnswered(String(event?.toolName ?? ""), event?.details)
		) {
			draftingUserReplies++;
		}
	});

	pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
		rememberCtx(ctx);
		if (isForeignCtx(ctx)) return;
		state = readState(ctx.cwd);
		if (!registeredCtx) {
			registerAgentTools(pi, ctx);
			registeredCtx = ctx;
		}
		ensureAgentToolsActive(pi, ctx);
		warnOnCommandCollision(ctx);
		warnIfAuditorProviderRisky(ctx);
		const autoResume = shouldAutoResumeOnSessionStart(
			event?.reason,
			resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).autoResume,
		);
		if (
			autoResume &&
			resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd))
				.aggressiveMode &&
			state.goal &&
			state.goal.status === "active"
		) {
			ctx.ui.notify(
				"Auto-resume fired (event: session start). Continue working.",
				"info",
			);
		}
		if (
			state.goal &&
			state.goal.status === "active" &&
			state.goal.autoContinue
		) {
			if (autoResume) {
				ctx.ui.notify(
					`Resuming goal [${state.goal.id}]: ${state.goal.objective.slice(0, 70)}`,
					"info",
				);
				scheduleContinuation(ctx, true);
			} else {
				updateGoal(
					{
						status: "paused",
						pauseReason: "restored in a fresh session — no work started",
						pauseSuggestedAction: "/goal resume to continue",
					},
					ctx,
				);
				ctx.ui.notify(
					`Goal held on restore [${state.goal.id}]: ${state.goal.objective.slice(0, 70)} — /goal resume to continue.`,
					"info",
				);
			}
		} else if (state.goal && state.goal.status === "active") {
			ctx.ui.notify(
				`Restored goal [${state.goal.id}]: ${state.goal.objective.slice(0, 70)}`,
				"info",
			);
		}
		refreshUI(ctx);
	});

	pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
		rememberCtx(ctx);
		if (isForeignCtx(ctx)) return;
		noteActivity(true);
		if (!registeredCtx) {
			registerAgentTools(pi, ctx);
			registeredCtx = ctx;
		}
		ensureAgentToolsActive(pi, ctx);
		if (isSupervising()) {
			heartbeatNudges = accountTurnForNudges(
				toolCallsThisTurn,
				heartbeatNudges,
			);
			if (heartbeatNudges >= HEARTBEAT_MAX_NUDGES) {
				heartbeatNudges = 0;
				if (state.goal) {
					updateGoal(
						{
							status: "paused",
							pauseReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive turns with no tool calls`,
							pauseSuggestedAction:
								"Inspect the goal — /goal resume to retry, /goal tweak to narrow it, /goal cancel to abort.",
						},
						ctx,
					);
					ctx.ui.notify(
						`Goal paused: stalled (${HEARTBEAT_MAX_NUDGES} turns, no tools).`,
						"warning",
					);
					notifyExternal(ctx, "Goal paused: stalled (no tool calls).");
					return;
				}
			}
		}
		toolCallsThisTurn = 0;
		if (!state.goal) return;
		if (state.goal.status !== "active") return;
		clearContinuationTimer();

		const last = [...(event.messages as any[])]
			.reverse()
			.find((m) => m.role === "assistant");
		const stopReason = last?.stopReason;
		iterationCounter++;

		const newTokens = sumNewAssistantTokens(
			event.messages as unknown[],
			countedTokenMessages,
		);
		if (newTokens > 0) {
			const used = (state.goal.usage?.tokensUsed ?? 0) + newTokens;
			const limit = state.goal.usage?.tokensLimit ?? DEFAULT_TOKEN_LIMIT;
			if (limit > 0 && used > limit) {
				updateGoal(
					{
						usage: { tokensUsed: used, tokensLimit: limit },
						status: "paused",
						pauseReason: `token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()})`,
						pauseSuggestedAction:
							"raise the cap (tokenLimit in settings) or 0 to disable, then /goal resume",
					},
					ctx,
				);
				ctx.ui.notify(
					`Goal paused: token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()}).`,
					"warning",
				);
				notifyExternal(
					ctx,
					`Goal paused: token limit exceeded (${used} > ${limit}).`,
				);
				return;
			}
			updateGoal({ usage: { tokensUsed: used, tokensLimit: limit } }, ctx);
		}

		if (stopReason === "error" || stopReason === "aborted") {
			consecutiveErrorIterations++;
			if (consecutiveErrorIterations >= 5) {
				updateGoal(
					{
						status: "paused",
						pauseReason: `5 consecutive errors: ${stopReason}`,
						pauseSuggestedAction:
							"Use /goal resume to retry, or /goal cancel to abort.",
					},
					ctx,
				);
				ctx.ui.notify("Goal paused: 5 consecutive errors.", "warning");
				notifyExternal(ctx, "Goal paused: 5 consecutive errors.");
				return;
			}
		} else {
			consecutiveErrorIterations = 0;
		}

		scheduleContinuation(ctx, false);
	});

	pi.on("tool_call", () => {
		toolCallsThisTurn++;
		noteActivity(true);
	});
}
