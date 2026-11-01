import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Internal, human-only signals. Never appended to model context. */
export const NOTIFICATION_EVENT = "aio:notification";
export const GOAL_ACTIVITY_EVENT = "aio:notification:goal-activity";
export const AGENT_PROMPT_EVENT = "aio:notification:agent-prompt";
export interface AgentPrompt {
	id: number;
	sessionId: string;
	kind: "select" | "confirm" | "input" | "editor" | "custom";
	title: string;
	body: string;
	preview?: string;
}
let nextPromptId = 0;

/** Mark only agent-owned dialogs, immediately around the actual UI call. */
export async function withAgentPrompt<T>(
	pi: ExtensionAPI | undefined,
	ctx: ExtensionContext,
	prompt: Omit<AgentPrompt, "id" | "sessionId">,
	show: () => Promise<T>,
): Promise<T> {
	const id = ++nextPromptId;
	const emit = (active: boolean) => {
		try { pi?.events?.emit(AGENT_PROMPT_EVENT, { ...prompt, id, sessionId: ctx.sessionManager.getSessionId(), active }); }
		catch { /* the dialog must work without observers */ }
	};
	emit(true);
	try { return await show(); }
	finally { emit(false); }
}
export type NotificationCategory = "core" | "goal" | "background" | "critical";
export interface NotificationSignal {
	category: Exclude<NotificationCategory, "core">;
	id: string;
	sessionId: string;
	title: string;
	body: string;
	preview?: string;
	/** A specific outcome replaces the next generic idle notification. */
	replacesCompletion?: boolean;
}

export function emitNotification(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: Omit<NotificationSignal, "sessionId">,
): void {
	try {
		if (ctx.mode !== "tui" || process.env.AIO_SUBAGENT_CHILD === "1") return;
		pi.events?.emit(NOTIFICATION_EVENT, { ...signal, sessionId: ctx.sessionManager.getSessionId() });
	} catch {
		// Observability must never change the producer's behavior.
	}
}

export function emitGoalActivity(pi: ExtensionAPI | null, ctx: ExtensionContext, status: string, quietSettle = false): void {
	try {
		pi?.events?.emit(GOAL_ACTIVITY_EVENT, { sessionId: ctx.sessionManager.getSessionId(), active: status === "active" || status === "auditing", quietSettle });
	} catch { /* optional observer */ }
}
