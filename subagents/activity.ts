/**
 * Live subagent activity derived from the child's `--mode json` event stream.
 *
 * The runner feeds every parsed stdout event through `applyActivityEvent`;
 * the tool card, the above-editor widget, and `subagent status` render the
 * result with `formatChildActivity`. Everything here is pure (time is passed
 * in) so the rendering contract is unit-testable.
 */
import type {
	ChildActivity,
	ChildRunStatus,
	RunningTool,
	SubagentRun,
} from "./types.js";

/** No event for this long while not inside a tool reads as a possible stall. */
export const ACTIVITY_STALE_MS = 120_000;
/** Show "last event Ns ago" once the stream has been quiet this long. */
const QUIET_HINT_MS = 5_000;
const SUMMARY_MAX_CHARS = 60;

export function createActivity(now: number): ChildActivity {
	return {
		phase: "starting",
		lastEventAt: now,
		turns: 0,
		toolCount: 0,
		runningTools: [],
	};
}

/** Reset per-attempt state; counters carry over across retries. */
export function resetActivityForAttempt(activity: ChildActivity, now: number): void {
	activity.phase = "starting";
	activity.lastEventAt = now;
	activity.runningTools = [];
	activity.retry = undefined;
	activity.settledAt = undefined;
}

function clip(text: string, max = SUMMARY_MAX_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short, human summary of a tool call's arguments. */
export function summarizeToolArgs(name: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value;
		}
		return undefined;
	};
	let preferred: string | undefined;
	if (name === "bash") preferred = pick("command");
	else if (name === "todo") preferred = pick("action");
	else preferred = pick("path", "pattern", "query", "url", "command", "action");
	if (preferred) return clip(preferred);
	const first = Object.values(record).find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
	return first ? clip(first) : "";
}

const PHASE_FOR_DELTA: Record<string, ChildActivity["phase"]> = {
	thinking_start: "thinking",
	thinking_delta: "thinking",
	thinking_end: "thinking",
	text_start: "writing",
	text_delta: "writing",
	text_end: "writing",
	toolcall_start: "writing",
	toolcall_delta: "writing",
	toolcall_end: "writing",
};

/**
 * Fold one child event into the activity model. Returns true when the change
 * is significant enough to re-render immediately (phase/tool/retry changes);
 * streaming deltas return false so callers can throttle them.
 */
export function applyActivityEvent(
	activity: ChildActivity,
	event: Record<string, unknown>,
	now: number,
): boolean {
	activity.lastEventAt = now;
	const previousPhase = activity.phase;
	const setPhase = (phase: ChildActivity["phase"]): boolean => {
		if (activity.settledAt !== undefined && phase !== "finishing") return false;
		activity.phase = phase;
		return phase !== previousPhase;
	};
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			if (event.type === "turn_start") activity.turns++;
			setPhase("waiting");
			return true;
		case "message_update": {
			const inner = event.assistantMessageEvent as
				| { type?: unknown }
				| undefined;
			const phase =
				typeof inner?.type === "string"
					? PHASE_FOR_DELTA[inner.type]
					: undefined;
			if (activity.retry && phase) activity.retry = undefined;
			return phase ? setPhase(phase) : false;
		}
		case "tool_execution_start": {
			const tool: RunningTool = {
				id: String(event.toolCallId ?? `tool-${activity.toolCount}`),
				name: String(event.toolName ?? "tool"),
				summary: summarizeToolArgs(String(event.toolName ?? ""), event.args),
				startedAt: now,
			};
			activity.runningTools.push(tool);
			activity.toolCount++;
			setPhase("tool");
			return true;
		}
		case "tool_execution_end": {
			const id = String(event.toolCallId ?? "");
			activity.runningTools = activity.runningTools.filter(
				(tool) => tool.id !== id,
			);
			if (activity.runningTools.length === 0) setPhase("waiting");
			return true;
		}
		case "auto_retry_start":
			activity.retry = {
				attempt: Number(event.attempt) || 1,
				maxAttempts: Number(event.maxAttempts) || 1,
				error:
					typeof event.errorMessage === "string"
						? clip(event.errorMessage, 80)
						: undefined,
			};
			setPhase("retrying");
			return true;
		case "auto_retry_end":
			activity.retry = undefined;
			setPhase("waiting");
			return true;
		case "compaction_start":
			setPhase("compacting");
			return true;
		case "compaction_end":
			setPhase("waiting");
			return true;
		case "agent_settled":
			activity.settledAt = now;
			activity.runningTools = [];
			activity.retry = undefined;
			activity.phase = "finishing";
			return true;
		default:
			return false;
	}
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export interface FormattedActivity {
	text: string;
	/** Quiet for ACTIVITY_STALE_MS outside a tool: render as a warning. */
	stale: boolean;
}

function describePhase(activity: ChildActivity, now: number): string {
	switch (activity.phase) {
		case "tool": {
			const [latest, ...others] = activity.runningTools.toReversed();
			if (!latest) return "running tool";
			const label = latest.summary ? `${latest.name}: ${latest.summary}` : latest.name;
			const more = others.length ? ` +${others.length} more` : "";
			return `${label} (${formatDuration(now - latest.startedAt)})${more}`;
		}
		case "retrying": {
			const retry = activity.retry;
			if (!retry) return "provider retry";
			return `provider retry ${retry.attempt}/${retry.maxAttempts}${retry.error ? `: ${retry.error}` : ""}`;
		}
		case "compacting":
			return "compacting context";
		case "finishing":
			return `finished · waiting for exit (${formatDuration(now - (activity.settledAt ?? now))})`;
		case "thinking":
			return "thinking";
		case "writing":
			return "writing";
		case "waiting":
			return "waiting for model";
		default:
			return "starting";
	}
}

/** One activity line for a running child (without the agent name). */
export function formatChildActivity(
	child: Pick<ChildRunStatus, "state" | "startedAt" | "attempts" | "activity">,
	now: number,
): FormattedActivity {
	if (child.state !== "running") return { text: child.state, stale: false };
	const activity = child.activity;
	const parts: string[] = [];
	if (child.startedAt !== undefined)
		parts.push(`running ${formatDuration(now - child.startedAt)}`);
	if ((child.attempts ?? 1) > 1) parts.push(`attempt ${child.attempts}`);
	if (!activity) return { text: parts.join(" · ") || "running", stale: false };
	parts.push(describePhase(activity, now));
	if (activity.toolCount > 0)
		parts.push(`${activity.toolCount} tool${activity.toolCount === 1 ? "" : "s"}`);
	const quietMs = now - activity.lastEventAt;
	const inTool = activity.phase === "tool" || activity.phase === "finishing";
	const stale = !inTool && quietMs >= ACTIVITY_STALE_MS;
	if (stale) parts.push(`no events for ${formatDuration(quietMs)} (possible stall)`);
	else if (!inTool && quietMs >= QUIET_HINT_MS)
		parts.push(`last event ${formatDuration(quietMs)} ago`);
	return { text: parts.join(" · "), stale };
}

/** Multi-line progress text for the tool card and `subagent status`. */
export function formatRunProgress(run: SubagentRun, now: number): string {
	const lines = [`Subagent run ${run.id.slice(0, 8)} ${run.state}`];
	for (const child of run.children) {
		const { text, stale } = formatChildActivity(child, now);
		lines.push(`${stale ? "!" : "·"} ${child.agent} · ${text}`);
	}
	return lines.join("\n");
}
