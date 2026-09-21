// Pi HostAdapter implementation: bash execution, follow-up prompts, UI
// notifications/confirmations, status updates, and session-lineage lookup.
// Ported from pi-yaml-hooks (MIT), Pi-only.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostAdapter, HostDeliveryResult, HookNotifyLevel } from "./types.js";
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js";
import { executeBashHook } from "./bash-executor.js";
import { getRootSessionId } from "./session-lineage.js";
import { ENV } from "./env.js";

/** The SDK's session-manager shape, taken from the context it provides. */
export type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface HostAdapterOptions {
	/** Wires the freshest captured context (kept current by the adapter). */
	readonly getContext: () => ExtensionContext | undefined;
	readonly getSessionManager: () => ReadonlySessionManager | undefined;
	readonly projectDir: string;
	readonly log?: (level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>) => void;
}

export function createHostAdapter(pi: ExtensionAPI, options: HostAdapterOptions): HostAdapter {
	const { getContext, getSessionManager, projectDir, log } = options;
	const warned = new Set<string>();

	const warnOnce = (key: string, message: string): void => {
		if (warned.has(key)) return;
		warned.add(key);
		// eslint-disable-next-line no-console
		console.warn(`[aio yaml hooks] ${message}`);
		log?.("warn", message);
	};

	return {
		// Pi only exposes abort on the current ExtensionContext; there is no
		// cross-session abort channel. action: stop handling routes the common
		// case (current session) through the tool_call block result instead.
		abort: (sessionId: string) => {
			log?.("info", `abort requested for session ${sessionId}: handled via tool_call block result for pre-tool hooks; action: stop on tool.after.* or session.idle is a no-op on Pi.`);
		},

		getRootSessionId: (sessionId: string) => getRootSessionId(sessionId, getSessionManager()),

		runBash: (request: BashExecutionRequest): Promise<BashHookResult> =>
			executeBashHook({ ...request, projectDir: request.projectDir || projectDir }),

		sendPrompt: (sessionId: string, text: string): HostDeliveryResult => {
			// Pi's sendUserMessage always targets the current session. Check
			// sessions match BEFORE calling sendUserMessage so a mismatch never
			// queues a follow-up in the wrong session as a side effect.
			const currentSessionId = safeGetSessionId(getSessionManager());
			if (!currentSessionId || currentSessionId !== sessionId) {
				return {
					status: "degraded",
					reason: "current_session_only",
					details: {
						requestedSessionId: sessionId,
						...(currentSessionId ? { currentSessionId } : {}),
					},
				};
			}

			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				log?.("info", "Queued follow-up prompt in the current Pi session.");
				return { status: "accepted" };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log?.("error", `sendUserMessage failed: ${message}`);
				throw new Error(`sendUserMessage failed: ${message}`);
			}
		},

		notify: (text: string, level?: HookNotifyLevel): HostDeliveryResult => {
			const ctx = getContext();
			if (!ctx?.hasUI || typeof ctx.ui?.notify !== "function") {
				warnOnce("no_notify", "notify action skipped: Pi UI surface unavailable for this context.");
				return {
					status: "degraded",
					reason: "ui_unavailable",
					details: { text, level: level ?? "info" },
				};
			}
			// Pi's notify supports "info" | "warning" | "error"; collapse
			// "success" into "info" so the YAML schema stays host-agnostic.
			const piLevel: "info" | "warning" | "error" =
				level === "warning" || level === "error" ? level : "info";
			try {
				ctx.ui.notify(text, piLevel);
				return { status: "accepted" };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log?.("error", `ui.notify failed: ${message}`);
				throw new Error(`ui.notify failed: ${message}`);
			}
		},

		confirm: async (request: { title?: string; message: string; timeout?: number }): Promise<boolean> => {
			const ctx = getContext();
			if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
				// Fail closed in headless mode so destructive operations are not
				// silently auto-approved; opt back in explicitly via env.
				if (ENV.confirmAutoApprove()) {
					return true;
				}
				warnOnce(
					"no_confirm",
					"confirm action denied: Pi UI surface unavailable for this context. confirm hooks fail closed in headless mode. Set PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE=1 to override.",
				);
				return false;
			}
			try {
				const title = request.title ?? "Confirm";
				const approved = await ctx.ui.confirm(title, request.message);
				return approved;
			} catch {
				// UI errors (dismissed, aborted) fall through as "not approved"
				// so pre-tool block semantics still fire.
				return false;
			}
		},

		setStatus: (hookId: string, text: string): HostDeliveryResult => {
			const ctx = getContext();
			if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") {
				warnOnce("no_set_status", "setStatus action skipped: Pi UI surface unavailable for this context.");
				return {
					status: "degraded",
					reason: "ui_unavailable",
					details: { hookId, text },
				};
			}
			try {
				// Pi clears a status slot when text is undefined; empty strings
				// collapse to "clear" so YAML authors can write setStatus: "".
				ctx.ui.setStatus(hookId, text.length > 0 ? text : undefined);
				return { status: "accepted" };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log?.("error", `ui.setStatus failed: ${message}`);
				throw new Error(`ui.setStatus failed: ${message}`);
			}
		},
	};
}

/** Best-effort session-id read; a missing id degrades the caller. */
export function safeGetSessionId(sessionManager: ReadonlySessionManager | undefined): string | undefined {
	if (!sessionManager) {
		return undefined;
	}
	try {
		const id = sessionManager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}
