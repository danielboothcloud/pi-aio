/**
 * pi-goal-list-loop-audit — v0.24.5
 * extensions/goal-loop-core.ts
 *
 * Shared types, state machine, JSONL persistence, helpers.
 *
 * Design: see docs/DESIGN.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

/** v0.26.1: consecutive heartbeat refires without a real agent turn
 * before the supervisor gives up (pauses the goal / stops the loop).
 * 0 = never escalate (legacy silent-spin behavior). */
export const DEFAULT_STALL_ESCALATION_REFIRES = 5;

/** v0.26.1: pure gate — has the refire streak hit the escalation
 * threshold? threshold 0 disables escalation entirely. */
export function shouldEscalateStall(
	consecutiveStalls: number,
	threshold: number,
): boolean {
	return threshold > 0 && consecutiveStalls >= threshold;
}

// =================================================================
// Types
// =================================================================

export type Status = "active" | "auditing" | "complete" | "paused" | "aborted";

export type Policy = "goal" | "list"; // v0.3.0: "loop".

export interface Task {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "complete";
	subtasks?: Task[];
}

export interface TaskList {
	version: 1;
	tasks: Task[];
}

// =================================================================
// Task-list proposal validation (used by the propose_task_list tool)
//
// The caps are the fix for pi-goal-x flaw #4: the agent could grow subtasks
// indefinitely, drifting into self-generated busywork. Hard limits keep a
// breakdown a breakdown.
// =================================================================

export const MAX_TOP_LEVEL_TASKS = 20;
export const MAX_SUBTASKS_PER_TASK = 5;

export interface TaskProposal {
	title: string;
	subtasks?: string[];
}

/** Validate a proposed breakdown. Returns an error string or null. */
export function validateTaskProposal(tasks: TaskProposal[]): string | null {
	if (!Array.isArray(tasks) || tasks.length === 0) return "Empty task list.";
	if (tasks.length > MAX_TOP_LEVEL_TASKS) {
		return `Too many top-level tasks (${tasks.length}); max ${MAX_TOP_LEVEL_TASKS}. Coarser granularity, please.`;
	}
	for (const t of tasks) {
		if (!t.title || !t.title.trim())
			return "Every task needs a non-empty title.";
		const n = t.subtasks?.length ?? 0;
		if (n > MAX_SUBTASKS_PER_TASK) {
			return `Task "${t.title}" has ${n} subtasks; max ${MAX_SUBTASKS_PER_TASK}. Merge or split into coarser tasks.`;
		}
	}
	return null;
}

/** Assign hierarchical ids ("1", "1.1", …) and pending statuses to a proposal. */
export function buildTaskList(tasks: TaskProposal[]): TaskList {
	return {
		version: 1,
		tasks: tasks.map((t, i) => ({
			id: String(i + 1),
			title: t.title.trim(),
			status: "pending" as const,
			subtasks: (t.subtasks ?? []).map((s, j) => ({
				id: `${i + 1}.${j + 1}`,
				title: s.trim(),
				status: "pending" as const,
			})),
		})),
	};
}

export interface AuditVerdict {
	at: string;
	approved: boolean;
	disapproved: boolean;
	/** v0.24.2: the auditor's third verdict — the goal can NEVER be satisfied as stated. */
	impossible?: boolean;
	impossibleReason?: string;
	model: string;
	thinkingLevel?: string;
	report?: string;
	/** Infrastructure failure detail (abort, auth, no model). Verdicts only — an entry with error and no report is not a real audit. */
	error?: string;
	/** regression_shield outcome when the goal had a verification contract. */
	regressionShieldPassed?: boolean;
	/** Contract items the shield found unreferenced (fed into the next audit's prompt, v0.22.6). */
	regressionShieldMissing?: string[];
}

/**
 * Sum token usage across assistant messages, counting each message once.
 * `agent_end` events may include already-seen history, so callers pass a
 * dedup set keyed by timestamp+tokens (good-enough identity for counting).
 *
 * v0.12.0: counts input+output (real spend) when the usage object carries
 * the split; totalTokens includes cache reads, which inflate 10-50× on long
 * sessions (a day-long goal "used" 216M while real spend was a fraction).
 */
export function sumNewAssistantTokens(
	messages: unknown[],
	seen: Set<string>,
): number {
	let total = 0;
	for (const m of messages) {
		const msg = m as {
			role?: string;
			timestamp?: unknown;
			usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
		};
		if (msg?.role !== "assistant") continue;
		const u = msg.usage;
		const split =
			(typeof u?.input === "number" ? u.input : 0) +
			(typeof u?.output === "number" ? u.output : 0);
		const tokens =
			split > 0
				? split
				: typeof u?.totalTokens === "number"
					? u.totalTokens
					: 0;
		if (tokens <= 0) continue;
		const key = `${String(msg.timestamp ?? "?")}:${tokens}`;
		if (seen.has(key)) continue;
		seen.add(key);
		total += tokens;
	}
	return total;
}

export interface Goal {
	id: string;
	objective: string;
	status: Status;
	policy: Policy;
	verificationContract?: string;
	autoContinue: boolean;
	taskList?: TaskList;
	auditHistory?: AuditVerdict[];
	stopReason?: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	/** v0.25.0 (contract item 22): auditor objections extracted as TODOs when
	 * aggressiveMode keeps the goal active past the disapproval cap. Rendered
	 * into every continuation prompt until the next audit clears them. */
	pendingTasks?: string[];
	activePath?: string;
	archivedPath?: string;
	usage: {
		tokensUsed: number;
		tokensLimit: number;
	};
	createdAt: string;
	updatedAt: string;
	/** v0.25.2: per-goal telemetry for /glla stats premature-success
	 * detection. Bumped live: turns on agent_end, fileWrites/bashCalls on
	 * tool_result while the goal is active. */
	telemetry?: { turns: number; fileWrites: number; bashCalls: number };
}

/**
 * Route `/goal` args (v0.8.0 top-level consolidation). Subcommands match ONLY
 * on exact word (except tweak/archive which take args) — an objective that
 * starts with "pause" ("/goal pause the pipeline and fix it") must set a
 * goal, not pause one.
 */
export type GoalRoute =
	| { kind: "draft" }
	| { kind: "set"; text: string }
	| {
			kind: "sub";
			name:
				| "status"
				| "pause"
				| "resume"
				| "cancel"
				| "tweak"
				| "archive"
				| "start";
			rest: string;
	  };

const GOAL_EXACT_SUBS = new Set(["status", "pause", "resume", "cancel"]);
const GOAL_ARG_SUBS = new Set(["tweak", "archive", "start"]);

export function routeGoalArgs(raw: string): GoalRoute {
	const trimmed = raw.trim();
	if (!trimmed) return { kind: "draft" };
	const space = trimmed.indexOf(" ");
	const first = (
		space === -1 ? trimmed : trimmed.slice(0, space)
	).toLowerCase();
	const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
	if (GOAL_EXACT_SUBS.has(first) && rest === "") {
		return {
			kind: "sub",
			name: first as "status" | "pause" | "resume" | "cancel",
			rest: "",
		};
	}
	if (GOAL_ARG_SUBS.has(first)) {
		return { kind: "sub", name: first as "tweak" | "archive" | "start", rest };
	}
	return { kind: "set", text: trimmed };
}

/**
 * Layered settings merge (v0.7.0): later layers win, but only for keys they
 * actually define — an `undefined` value in a layer means "not set here",
 * never "set to undefined". Used for defaults → global → project resolution.
 */
export function mergeSettings<T extends Record<string, unknown>>(
	base: T,
	...layers: Array<Partial<T> | null | undefined>
): T {
	const out: Record<string, unknown> = { ...base };
	for (const layer of layers) {
		if (!layer) continue;
		for (const [k, v] of Object.entries(layer)) {
			if (v !== undefined) out[k] = v;
		}
	}
	return out as T;
}

/**
 * Default for executor-visible auditor feedback. 0 = no cap: the executor
 * gets the FULL disapproval report (v0.24.9 — truncating by default cut
 * exactly the actionable tail of multi-item <evidence> blocks; a few KB of
 * report is negligible next to a wasted re-attempt). Set a positive
 * auditFeedbackChars to cap.
 */
export const DEFAULT_AUDIT_FEEDBACK_CHARS = 0;

/**
 * Bound the auditor report returned to the executor after disapproval.
 * A limit of 0 explicitly means "show the full report".
 */
/** Executor-visible excerpt of a disapproval report. Full by default
 * (maxChars 0). When capped, keep the TAIL: since v0.25.4 the auditor
 * ends disapprovals with the actionable `## Required fixes` section —
 * head-slicing would cut exactly what the executor needs. */
export function auditFeedbackExcerpt(output: string, maxChars: number): string {
	if (maxChars === 0 || output.length <= maxChars) return output;
	return `[head truncated — full report via /goal status]
…${output.slice(-maxChars)}`;
}

/**
 * Should /goal args go through contract drafting instead of direct activation?
 * Rule (v0.11.0): any objective WITHOUT an explicit "Done when:" clause is
 * vague enough to grill first — the pi-goal-x lesson (arg + Enter is worse
 * than a 5-minute draft). An explicit contract clause activates instantly.
 */
export function goalArgsNeedDrafting(args: string): boolean {
	const t = args.trim();
	if (!t) return false; // no-args is already the drafting path
	// v0.23.7: any "done when" phrase counts — requiring the colon to
	// immediately follow made "Done when ALL of the following are true:"
	// route to the interview even though the user wrote a contract.
	return !/\bdone\s+when\b/i.test(t);
}

/**
 * Build the seeded drafting message (v0.14.0). v0.13.0 had the PLUGIN ask
 * three canned questions — a questionnaire, not a grilling: it accepted
 * non-answers ("not sure", "none") and produced weak contracts. The LLM
 * does the interviewing (its strength); the plugin only enforces the floor
 * via draftProposalBlock: propose is blocked until the user has replied.
 */
export function buildSeedGrillMessage(
	tmpl: string,
	seed: string,
	tool: string,
): string {
	return `${tmpl}\n\nThe user's initial objective (verbatim): ${seed}\n\nGRILL THEM ABOUT THIS SEED BEFORE PROPOSING. ${tool} is BLOCKED until the user has replied to at least one of your questions — proposing without interviewing returns an error.\n\nHow to grill:\n- Ask ONE sharp, seed-specific question at a time — about THIS objective, not generic filler. If an ask_user_question tool is available in this session, prefer it (structured options render better); plain conversation is fine for free-form answers.\n- Every question ships with a recommended default the user can accept with "yes".\n- Probe what matters: what "done" concretely looks like (checkable evidence — files, commands, behaviors), scope boundaries (what is explicitly OUT), constraints (what must not change), and priorities when the seed bundles several wishes.\n- A non-answer ("not sure", "none", "whatever") is a trigger to offer 2-3 concrete options to pick from — never silently proceed on a non-answer.\n- Do targeted read-only research first when it makes your questions sharper (repo layout, existing docs).\n- Do NOT activate the raw seed. Do NOT implement anything. When the contract is concrete, call ${tool}.`;
}

/**
 * The drafting floor (v0.14.0): the propose tools call this before opening
 * the user's Confirm dialog. 0 user replies since drafting started → the
 * agent is attempting a contract dump; block it with instructions. The
 * mechanism guarantees an interview HAPPENED; question quality is the
 * model's job (shaped by buildSeedGrillMessage).
 */
export function draftProposalBlock(
	userReplies: number,
	blockedAttempts = 0,
): string | null {
	if (userReplies > 0) return null;
	const base =
		"INTERVIEW FIRST — you have not received a single user reply since drafting started. Ask the user ONE sharp question about their objective (seed-specific, with a recommended default; challenge non-answers by offering concrete options), wait for the answer, and only then call the propose tool again. The Confirm dialog stays closed until the user has actually been heard.";
	// v0.15.1 escape hatch: typed chat replies AND answered ask_user_question
	// dialogs both count. If we have blocked 3+ proposals, the replies are
	// arriving through a path this plugin cannot see — hand the user a manual
	// unlock instead of manufacturing yet another interview round.
	if (blockedAttempts >= 3) {
		return (
			base +
			" NOTE: proposals have been blocked repeatedly despite interviewing — the reply counter may not see your channel. Tell the user plainly: 'type any chat message (e.g. \"go on\") to unlock the Confirm dialog', wait for it, then propose again. Do NOT ask another interview question first."
		);
	}
	return base;
}

/**
 * v0.15.1: an ask_user_question tool result counts as a user reply during
 * drafting — dialog answers arrive as tool results, not chat messages.
 * Answered = not cancelled (Esc) with at least one answer recorded.
 */
export function askUserQuestionAnswered(
	toolName: string,
	details: unknown,
): boolean {
	if (toolName !== "ask_user_question") return false;
	if (!details || typeof details !== "object") return false;
	const d = details as { answers?: unknown; cancelled?: unknown };
	return (
		d.cancelled === false && Array.isArray(d.answers) && d.answers.length > 0
	);
}

export interface State {
	goal: Goal | null;
}

/** v0.24.2: count TRAILING consecutive disapprovals (the disapproval-cap
 *  input). Shield-blocks (approved:true) and infra errors (neither flag)
 *  break the streak — they are not verdicts on the work. */
/** v0.24.2: count TRAILING consecutive disapprovals (the disapproval-cap
 *  input). Shield-blocks (approved:true) break the streak — the work was
 *  judged good. v0.25.4: pure infra errors (error set, neither verdict
 *  flag) are TRANSPARENT, not streak-breakers — the auditor never judged
 *  the work, so D,D,infra,D is still 3 trailing disapprovals (before, 39
 *  hegemon-style infra errors would reset the cap and re-open infinite
 *  re-continuation). */
export function countTrailingDisapprovals(history: AuditVerdict[]): number {
	let n = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const v = history[i]!;
		if (v.disapproved) n++;
		else if (v.error && !v.approved)
			continue; // infra: not a verdict
		else break;
	}
	return n;
}

/** Default per-goal token budget (v0.9.7): a runaway threshold, not a
 * "big goal" threshold — real research/feature goals legitimately burn 2-4M.
 * Loop 3 doesn't rely on this cap (it has max-iterations + plateau brakes). */
export const DEFAULT_TOKEN_LIMIT = 0; // 0 = opt-in guard, off by default (v0.12.0)

export const DEFAULT_STATE: State = {
	goal: null,
};

// =================================================================
// Path helpers
// =================================================================

export function piGlaDir(cwd: string): string {
	const dir = path.join(cwd, ".pi-glla");
	// v0.17.0: one-time migration of the pre-rename state dir (.pi-gla →
	// .pi-glla). Active goals, ledgers, and project settings move with the
	// name — no relics, no lost state.
	const legacy = path.join(cwd, ".pi-gla");
	try {
		if (!fs.existsSync(dir) && fs.existsSync(legacy))
			fs.renameSync(legacy, dir);
	} catch {
		// read-only fs or partial state — fall through and use the new dir
	}
	return dir;
}

export function goalMdPath(cwd: string, id: string): string {
	return path.join(piGlaDir(cwd), "goals", `${id}.md`);
}

export function archiveDir(cwd: string): string {
	return path.join(piGlaDir(cwd), "archive");
}

export function archivedGoalPath(cwd: string, id: string): string {
	return path.join(archiveDir(cwd), `${id}.md`);
}

export function ledgerPath(cwd: string): string {
	return path.join(piGlaDir(cwd), "active.jsonl");
}

// =================================================================
// Persistence
// =================================================================

export function ensureDirs(cwd: string): void {
	fs.mkdirSync(path.join(piGlaDir(cwd), "goals"), { recursive: true });
	fs.mkdirSync(archiveDir(cwd), { recursive: true });
}

export function readState(cwd: string): State {
	const file = ledgerPath(cwd);
	if (!fs.existsSync(file)) return { ...DEFAULT_STATE };
	const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
	if (lines.length === 0) return { ...DEFAULT_STATE };
	let parsed: Partial<State> = {};
	for (const line of lines) {
		try {
			const evt = JSON.parse(line);
			if (evt.type === "state") parsed = { ...parsed, ...evt.value };
		} catch {
			// skip malformed lines
		}
	}
	return {
		goal: parsed.goal ?? null,
	};
}

export function appendLedger(cwd: string, type: string, value: unknown): void {
	ensureDirs(cwd);
	const line = JSON.stringify({ type, value, at: new Date().toISOString() });
	fs.appendFileSync(ledgerPath(cwd), line + "\n");
}

export function writeGoalMd(cwd: string, goal: Goal): string {
	ensureDirs(cwd);
	const file = goalMdPath(cwd, goal.id);
	const md = renderGoalMarkdown(goal);
	fs.writeFileSync(file, md);
	return file;
}

export function readGoalMd(cwd: string, id: string): string | null {
	const file = goalMdPath(cwd, id);
	if (!fs.existsSync(file)) return null;
	return fs.readFileSync(file, "utf-8");
}

// =================================================================
// Renderer — replace pi-goal-x's hand-concat detailedSummary
// =================================================================

export function renderGoalMarkdown(goal: Goal): string {
	const lines: string[] = [];
	lines.push(`# Goal`);
	lines.push("");
	lines.push(`**Status**: ${statusLabel(goal.status)}`);
	lines.push(`**Policy**: ${goal.policy}`);
	lines.push(`**Auto-continue**: ${goal.autoContinue ? "on" : "off"}`);
	if (goal.activePath)
		lines.push(
			`**File**: \`${path.relative(path.dirname(goal.activePath), goal.activePath) || goal.activePath}\``,
		);
	if (goal.archivedPath)
		lines.push(
			`**Archive**: \`${path.relative(path.dirname(goal.archivedPath), goal.archivedPath) || goal.archivedPath}\``,
		);
	if (goal.stopReason) lines.push(`**Stop reason**: ${goal.stopReason}`);
	if (goal.pauseReason) lines.push(`**Pause reason**: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction)
		lines.push(`**Agent suggests**: ${goal.pauseSuggestedAction}`);
	lines.push("");
	lines.push("## Objective");
	lines.push("");
	lines.push("> " + goal.objective);
	lines.push("");
	if (goal.verificationContract) {
		lines.push("## Verification contract");
		lines.push("");
		lines.push(goal.verificationContract);
		lines.push("");
	}
	if (goal.taskList && goal.taskList.tasks.length > 0) {
		lines.push("## Tasks");
		lines.push("");
		renderTaskTreeMarkdown(goal.taskList.tasks, lines, 0);
		lines.push("");
	}
	if (goal.auditHistory && goal.auditHistory.length > 0) {
		lines.push("## Audit history");
		lines.push("");
		for (const v of goal.auditHistory) {
			lines.push(
				`- ${v.at} — ${v.approved ? "approved" : v.impossible ? "impossible" : "disapproved"} — \`${v.model}\``,
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderTaskTreeMarkdown(
	tasks: Task[],
	out: string[],
	depth: number,
): void {
	for (const t of tasks) {
		const indent = "  ".repeat(depth);
		const bullet =
			t.status === "complete"
				? "- [x]"
				: t.status === "in_progress"
					? "- [~]"
					: "- [ ]";
		out.push(`${indent}${bullet} ${t.title} \`${t.id}\``);
		if (t.subtasks && t.subtasks.length > 0) {
			renderTaskTreeMarkdown(t.subtasks, out, depth + 1);
		}
	}
}

// =================================================================
// Status helpers
// =================================================================

export function statusLabel(status: Status | null | undefined): string {
	switch (status) {
		case "active":
			return "active";
		case "auditing":
			return "auditing";
		case "complete":
			return "complete";
		case "paused":
			return "paused";
		case "aborted":
			return "aborted";
		default:
			return "no goal";
	}
}

// =================================================================
// ID generation
// =================================================================

export function nowIso(): string {
	return new Date().toISOString();
}

export function newGoalId(): string {
	const ts = new Date()
		.toISOString()
		.replace(/[-:T.Z]/g, "")
		.slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${ts}-${rand}`;
}

// =================================================================
// Task helpers
// =================================================================

export function findNextPendingTask(
	tasks: Task[],
): { id: string; title: string } | undefined {
	const queue = [...tasks];
	while (queue.length > 0) {
		const t = queue.shift()!;
		if (t.status === "pending") return { id: t.id, title: t.title };
		// Push subtasks regardless of parent status; we want BFS to find
		// the first pending task anywhere in the tree. A parent's status
		// does not preclude one of its subtasks being pending.
		if (t.subtasks && t.subtasks.length > 0) queue.push(...t.subtasks);
	}
	return undefined;
}

export function buildTaskSummary(tasks: Task[]): string {
	let total = 0;
	let complete = 0;
	const queue = [...tasks];
	while (queue.length > 0) {
		const t = queue.shift()!;
		total++;
		if (t.status === "complete") complete++;
		if (t.subtasks) queue.push(...t.subtasks);
	}
	return `${complete}/${total} done`;
}

/**
 * Session-restore gate (v0.21.0): a session that carries conversation
 * history ("resume" | "reload" | "fork") IS the goal's own context —
 * auto-resuming work there is natural. A fresh session ("startup" | "new",
 * or an older pi that reports no reason) has no context — restored state
 * HOLDS until an explicit /goal resume (or /glla autoresume=on, the rig
 * setting for unattended restarts). One mechanical predicate; no heuristics.
 */
export function shouldAutoResumeOnSessionStart(
	reason: string | undefined,
	autoResume: boolean | undefined,
): boolean {
	if (autoResume === true) return true;
	return reason === "resume" || reason === "reload" || reason === "fork";
}

/**
 * v0.23.5: normalize a drafter-supplied verification contract for the
 * Confirm dialog AND for storage. Three cleanups, all mechanical:
 *  1. Drop bare introducer lines ("Done when:", "Done when ALL of the
 *     following are true:") — the dialog adds its own "Done when" header;
 *     a model-supplied one renders doubled (field-observed) and pollutes
 *     the shield's item list.
 *  2. Strip a glued "Done when: " prefix on a content line.
 *  3. Renumber bullet/numbered lines sequentially ("1.", "2.", ...) so the
 *     dialog reads as a checklist and reject-feedback can cite item
 *     numbers. Non-bullet prose lines pass through untouched.
 */
export function normalizeDraftContract(raw: string): string {
	const lines = raw
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) =>
				!/^(?:done when|verified when|verify|verification)\b[^:]*:\s*$/i.test(
					l,
				),
		)
		.map((l) => l.replace(/^(?:done when|verified when)\s*:\s+/i, ""))
		.filter((l) => l.length > 0);
	let n = 0;
	return lines
		.map((l) => {
			const m = l.match(/^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/);
			return m ? `${++n}. ${m[1]}` : l;
		})
		.join("\n");
}

/** Count the numbered checklist items in a normalized contract. */
export function draftContractItemCount(normalized: string): number {
	return normalized.split("\n").filter((l) => /^\d+\.\s/.test(l)).length;
}

/**
 * Split raw objective text into { objective, verificationContract } at the
 * first "Done when…:"-family marker (line-start preferred, inline fallback
 * for one-liners). v0.23.7: the marker family accepts ANY text between the
 * keyword and the colon ("Done when ALL of the following are true:") —
 * the shield's contractItems already drops such introducer lines
 * (v0.23.4), and goalArgsNeedDrafting recognizes the same phrase, so the
 * three "done when" parsers can no longer drift apart. Lives in the pure
 * module so tests exercise THIS function, not a copy (the pre-0.23.7 test
 * re-implemented it and silently went stale).
 */
export function extractVerificationContract(raw: string): {
	objective: string;
	verificationContract: string;
} {
	// Line-based first: a marker at line start begins the contract block.
	const lines = raw.split("\n");
	let mode: "obj" | "verify" = "obj";
	const objParts: string[] = [];
	const verifyParts: string[] = [];
	for (const line of lines) {
		if (
			line.match(
				/^\s*(?:done when|verified when|verify|verification|done)\b[^:]*:/i,
			)
		) {
			mode = "verify";
		}
		if (mode === "obj") objParts.push(line);
		else verifyParts.push(line);
	}
	let objective = objParts.join("\n").trim();
	let verificationContract = verifyParts.join("\n").trim();

	// Inline fallback: users write one-liners like
	//   "Create x.txt. Done when: grep -q ok x.txt"
	// where the marker is mid-line. Split at the first inline marker.
	if (!verificationContract) {
		const m = raw.match(
			/^(.*?)(?:\.|;)??\s+(?:done when|verified when|verify|verification)\b[^:]*:\s*(.+)$/is,
		);
		if (m) {
			objective = (m[1] ?? "").trim().replace(/[.;]\s*$/, "");
			verificationContract = (m[2] ?? "").trim();
		}
	}
	return { objective, verificationContract };
}

/**
 * v0.23.8: subagent-session ownership. pi-subagents binds extensions in
 * subagent sessions too, so glla's session_start/handlers fire there with
 * the same module state. The MAIN session owns the goal/loop; subagent
 * sessions are workers — they must never clobber the loop's ctx handle
 * (a headless subagent ctx would silently kill the heartbeat/wedge
 * machinery), never receive continuation injection, and never mutate goal
 * state. pi hands a FRESH ctx wrapper per event (verified in
 * dist/core/extensions/runner.js — createContext() per emit), so object
 * identity is useless; ctx.sessionManager is the stable per-session
 * discriminator (each subagent gets its own SessionManager).
 */
export type OwnerClaim = "claim" | "refresh" | "foreign";
export function classifySessionCtx(
	ownerSession: unknown,
	ownerLive: boolean,
	sessionManager: unknown,
): OwnerClaim {
	if (!ownerSession || !ownerLive) return "claim";
	return sessionManager === ownerSession ? "refresh" : "foreign";
}

// =================================================================
// v0.24.5: tool-visibility self-heal
// =================================================================
//
// Root cause (INCIDENT-COMPLETION-BLACKHOLE-2026-07-23): external
// extensions like pi-plugin-list-selector-modlist call pi.setActiveTools
// with a frozen tool snapshot at session_start. When glla's session_start
// handler runs BEFORE theirs (load order), our lazily-registered agent
// tools get registered, briefly auto-activated, then wiped from the
// model-facing active set on the very next pi.setActiveTools call from
// modlist. Commands, widget, watchdog keep working (they don't go
// through the tool registry), but every agent tool — complete_goal,
// propose_loop_draft, etc. — answers "Tool not found" to the model.
//
// Self-heal: any handler that triggers registerAgentTools must also
// ensure the registered tool names are present in pi.getActiveTools(),
// re-adding any missing ones via pi.setActiveTools. Once per session,
// notify the user naming the external allowlist as the likely culprit
// so they can fix their profile once and silence it.

export const GLLA_TOOL_NAMES = [
	"complete_goal",
	"pause_goal",
	"complete_task",
	"update_task_status",
	"propose_goal_draft",
	"propose_task_list",
] as const;

export type GllaToolName = (typeof GLLA_TOOL_NAMES)[number];

export function missingGllaTools(
	activeNames: readonly string[],
): readonly GllaToolName[] {
	const active = new Set(activeNames);
	return GLLA_TOOL_NAMES.filter((n) => !active.has(n));
}

// -----------------------------------------------------------------
// v0.25.0 — eager-continuation contract helpers
// -----------------------------------------------------------------

/** Base defaults (aggressiveMode OFF). auditCap base raised 3 → 5 in
 * v0.25.0 (contract item 7 — the "fairly eager" baseline). */
export const BASE_AUDIT_CAP = 5;
export const BASE_STUCK_MAX_INTERVENTIONS = 5;
/** aggressiveMode defaults (contract item 5). Explicit per-key settings
 * always win over these — aggressiveMode flips DEFAULTS, not user choices. */
export const AGGRESSIVE_AUDIT_CAP = 10;
export const AGGRESSIVE_STUCK_MAX_INTERVENTIONS = 10;
export const DEFAULT_QUOTA_RETRY_MINUTES = 60;

export interface EffectiveAggressiveSettings {
	auditCap: number;
	stuckMaxInterventions: number;
	/** 0 = wedge alerts off. */
	wedgeAlertMinutes: number;
	autoResume: boolean;
	aggressiveMode: boolean;
}

/** Layered resolution: explicit per-key value > aggressiveMode default >
 * base default (contract items 5+7). Pure so tests can assert the matrix
 * without a settings file. */
export function resolveEffectiveAggressiveSettings(s: {
	aggressiveMode?: boolean;
	auditCap?: number;
	stuckMaxInterventions?: number;
	wedgeAlertMinutes?: number;
	autoResume?: boolean;
}): EffectiveAggressiveSettings {
	const aggressiveMode = s.aggressiveMode === true;
	return {
		aggressiveMode,
		auditCap:
			s.auditCap ?? (aggressiveMode ? AGGRESSIVE_AUDIT_CAP : BASE_AUDIT_CAP),
		stuckMaxInterventions:
			s.stuckMaxInterventions ??
			(aggressiveMode
				? AGGRESSIVE_STUCK_MAX_INTERVENTIONS
				: BASE_STUCK_MAX_INTERVENTIONS),
		wedgeAlertMinutes: s.wedgeAlertMinutes ?? (aggressiveMode ? 0 : 30),
		autoResume: s.autoResume ?? aggressiveMode,
	};
}

/** Extract up to `cap` actionable objection lines from an auditor report
 * (contract item 22): numbered/bulleted lines, most recent last-report
 * wins, longest tails trimmed. Pure — the audit-cap branch and its test
 * share this. */
export function extractPendingTasks(report: string, cap = 5): string[] {
	const out: string[] = [];
	for (const raw of report.split("\n")) {
		const line = raw.trim();
		const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.{8,200})$/);
		if (!m) continue;
		const text = m[1]!.trim();
		// Skip pure-evidence bullets ("file X exists", "tests pass") — we want
		// OBJECTIONS: missing/failing/not-done language.
		if (
			!/miss|fail|not |no |lack|absent|doesn|didn|won|can'?t|remain|todo|fix|requir|incomplete|unverified/i.test(
				text,
			)
		)
			continue;
		if (!out.includes(text)) out.push(text);
		if (out.length >= cap) break;
	}
	return out;
}

/** Contract item 23: is the auditor's IMPOSSIBLE reason about the WHOLE
 * goal or only part of it? Default "full" (safe — keeps the pause);
 * partial only on explicit subset language. */
export function classifyImpossibleReason(reason: string): "partial" | "full" {
	if (
		/\b(partial|some items|subset|remaining items|narrow|only .{0,30}(item|part|section)|the rest|rest of)\b/i.test(
			reason,
		)
	) {
		return "partial";
	}
	return "full";
}

/** Contract items 25/28: does this objective read as a full-audit /
 * survey pivot? */
export function isFullAuditObjective(objective: string): boolean {
	return /full audit|survey|find all|task ?list|enumerate|audit the (whole |entire )?project/i.test(
		objective,
	);
}

// --- Auto-committer daemon sentinel (contract item 31) ---

/** Sentinel the auto-committer (dracon-sync) filter checks: when present,
 * the daemon must not rewrite/commit in this repo. The agent writes it
 * after detecting filter-branch damage (see DETACHED COMMIT DETECTION in
 * the continuation prompt). */
export const PAUSE_AUTO_COMMIT_SENTINEL = ".pause-auto-commit";

export function pauseAutoCommit(cwd: string, reason: string): string {
	const dir = path.join(cwd, ".pi-glla");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, PAUSE_AUTO_COMMIT_SENTINEL);
	fs.writeFileSync(file, `pausedAt: ${nowIso()}\nreason: ${reason}\n`, "utf-8");
	return file;
}

export function resumeAutoCommit(cwd: string): boolean {
	const file = path.join(cwd, ".pi-glla", PAUSE_AUTO_COMMIT_SENTINEL);
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

export function isAutoCommitPaused(cwd: string): boolean {
	try {
		fs.accessSync(path.join(cwd, ".pi-glla", PAUSE_AUTO_COMMIT_SENTINEL));
		return true;
	} catch {
		return false;
	}
}

// --- Heartbeat ship-suppression (contract item 27) ---

/** Suppress the heartbeat when work shipped very recently — a session
 * that just committed is transitioning, not stalled. Pure; the tick
 * gathers the timestamps. */
/** @deprecated v0.26.6: no longer called by the heartbeat (self-sustaining
 * under ledger writes / auto-commit daemons). Kept for API compatibility. */
export function shouldSuppressHeartbeatForRecentShip(args: {
	nowMs: number;
	lastShippedAtMs: number | null;
	windowMs?: number;
}): boolean {
	const windowMs = args.windowMs ?? 5 * 60_000;
	if (args.lastShippedAtMs === null) return false;
	return args.nowMs - args.lastShippedAtMs < windowMs;
}

/** Best-effort "when did work last ship" for a repo: newest of the HEAD
 * commit time and the .pi-glla state file mtime. Null when unknown. */
/** v0.26.7: pi's exact stale-runtime error signature — thrown by every
 * runtime-bound method after pi invalidates the extension on session
 * replacement (newSession/fork/switchSession/reload; compaction reaches
 * the same teardown in pi 0.82.x). See dist/core/extensions/loader.js
 * createExtensionRuntime().invalidate. */
export function isStaleApiError(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.includes("stale after session replacement")
	);
}

export function lastShippedAtMs(cwd: string): number | null {
	// v0.26.6: the .pi-glla/active.jsonl MTIME term was REMOVED — the
	// heartbeat's own ledger writes refreshed it every 15s, which made the
	// 0.25.0 ship-suppression self-sustaining (darklord: 9.1h / 2,184
	// suppressed ticks). Only a real git commit counts as a ship now.
	let best: number | null = null;
	try {
		const out = execSync("git log -1 --format=%ct", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		const sec = Number(out);
		if (Number.isFinite(sec) && sec > 0) best = sec * 1000;
	} catch {
		/* not a git repo or no commits */
	}
	return best;
}

// =================================================================
// v0.25.4: auditor polish — durable audit log, think-block hygiene,
// actionable-tail slicing, infra-transparent streaks
// =================================================================

/** Strip think-block leakage from auditor reports before storage/display.
 * Motivation (wild, 2026-07-25): MiniMax-M3 reports arrive with
 * `<think>...</think>` bodies, stray `</think>` fragments, and non-English
 * reasoning spillover — the executor's feedback should be the verdict,
 * not the auditor's private monologue. */
export function stripThinkBlocks(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<\/?think>/gi, "")
		.replace(/<200b>/g, "") // stray partial-tag artifact seen in the wild
		.replace(/^\s+/, "");
}

/** One durable audit-log entry — survives state-snapshot rotation, so
 * /glla audits can answer "where are we weak" across the whole project. */
export interface AuditLogEntry {
	at: string;
	goalId: string;
	objective: string;
	verdict:
		| "approved"
		| "disapproved"
		| "impossible"
		| "shield_blocked"
		| "error";
	model: string;
	thinkingLevel: string;
	report: string;
	impossibleReason?: string;
	error?: string;
	/** v0.25.4 post-audit: how long the audit took, and whether the infra
	 * retry fired. */
	durationMs?: number;
	retriedOnce?: boolean;
}

export function auditLogPath(cwd: string): string {
	return path.join(cwd, ".pi-glla", "audits.jsonl");
}

export function appendAuditLog(cwd: string, entry: AuditLogEntry): void {
	try {
		ensureDirs(cwd);
		fs.appendFileSync(auditLogPath(cwd), JSON.stringify(entry) + "\n");
	} catch {
		/* log best-effort — never block the verdict path */
	}
}

export function readAuditLog(cwd: string, limit?: number): AuditLogEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(auditLogPath(cwd), "utf-8");
	} catch {
		return [];
	}
	const out: AuditLogEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t);
			if (e && typeof e.goalId === "string" && typeof e.verdict === "string")
				out.push(e as AuditLogEntry);
		} catch {
			/* skip malformed */
		}
	}
	return limit !== undefined ? out.slice(-limit) : out;
}

const VERDICT_GLYPH: Record<AuditLogEntry["verdict"], string> = {
	approved: "✔",
	disapproved: "✖",
	impossible: "⛔",
	shield_blocked: "🛡",
	error: "⚠",
};

/** /glla audits list view: one line per verdict, newest last. */
export function formatAuditLog(entries: AuditLogEntry[]): string {
	if (entries.length === 0)
		return "(no audits logged yet — the log starts with the next verdict)";
	return entries
		.map((e) => {
			const day = e.at.slice(5, 16).replace("T", " ");
			const firstLine = (e.report.split("\n").find((l) => l.trim()) ?? "")
				.trim()
				.slice(0, 90);
			return `${VERDICT_GLYPH[e.verdict]} ${day} [${e.goalId.slice(-6)}] ${e.model} — ${firstLine}`;
		})
		.join("\n");
}

// =================================================================
// v0.25.4 (post-audit fix): infra-failure retry-once-with-backoff
// =================================================================

/** Which auditor infra errors are worth an automatic retry? User aborts
 * and missing-model config are NOT — retrying can't help them. */
export function isRetriableInfraError(error?: string): boolean {
	if (!error) return false;
	if (/aborted/i.test(error)) return false;
	if (/no model/i.test(error)) return false;
	return true;
}

export interface InfraRetryOutcome<T> {
	result: T;
	retriedOnce: boolean;
}

/** Run the auditor; on a retriable infra failure, wait `backoffMs` and
 * retry EXACTLY once before reporting "auditor infrastructure error
 * (retried once)". The failed pair is never a verdict on the work. */
export async function runWithInfraRetry<
	T extends { error?: string; approved: boolean; disapproved: boolean },
>(
	run: () => Promise<T>,
	opts: {
		backoffMs?: number;
		sleep?: (ms: number) => Promise<void>;
		onRetry?: (error: string) => void;
	} = {},
): Promise<InfraRetryOutcome<T>> {
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const first = await run();
	if (
		first.approved ||
		first.disapproved ||
		!isRetriableInfraError(first.error)
	) {
		return { result: first, retriedOnce: false };
	}
	opts.onRetry?.(first.error!);
	await sleep(opts.backoffMs ?? 5000);
	const second = await run();
	return { result: second, retriedOnce: true };
}

/** /glla audits default view: the ACTIVE goal's own audit history (the
 * surface the goal spec asked for), one line per verdict. */
export function formatGoalAuditHistory(goal: {
	id: string;
	auditHistory?: Array<any>;
}): string {
	const history = goal.auditHistory ?? [];
	if (history.length === 0) return "(no audits on this goal yet)";
	return history
		.map((v) => {
			const glyph = v.approved
				? v.regressionShieldPassed === false
					? "🛡"
					: "✔"
				: v.impossible
					? "⛔"
					: v.disapproved
						? "✖"
						: "⚠";
			const day = String(v.at ?? "")
				.slice(5, 16)
				.replace("T", " ");
			const elapsed = v.durationMs
				? ` · ${Math.round(v.durationMs / 60000)}m`
				: "";
			const firstLine = (
				String(v.report ?? "")
					.split("\n")
					.find((l: string) => l.trim()) ?? ""
			)
				.trim()
				.slice(0, 80);
			return `${glyph} ${day} ${v.model ?? "?"}${elapsed} — ${firstLine}`;
		})
		.join("\n");
}
