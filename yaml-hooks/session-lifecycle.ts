// Session lifecycle wiring: session_start, session_before_switch, and
// session_shutdown handlers, plus the dedupe tombstone that absorbs the
// duplicate session.deleted Pi emits for the same /new /resume /fork
// transition. Ported from pi-yaml-hooks (MIT), Pi-only.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeRegistry } from "./registry.js";
import type { HooksRuntime } from "./runtime.js";
import { safeGetSessionId } from "./host-adapter.js";

export interface SessionLifecycleDeps {
	readonly runtimeRegistry: RuntimeRegistry;
	/** Captures the freshest context (mirrors adapter handler behavior). */
	remember(ctx: ExtensionContext): void;
}

export function registerSessionLifecycleHandlers(
	pi: ExtensionAPI,
	deps: SessionLifecycleDeps,
): void {
	const { runtimeRegistry, remember } = deps;

	// Pi emits both session_before_switch AND session_shutdown for the same
	// logical /new /resume /fork transition. Track which session ids have
	// already fired session.deleted so cleanup hooks do not double-run.
	// Markers are dropped shortly after to keep the set bounded.
	const deletedSessionIds = new Set<string>();

	function markSessionDeleted(sessionId: string): boolean {
		if (deletedSessionIds.has(sessionId)) return false;
		deletedSessionIds.add(sessionId);
		setTimeout(() => deletedSessionIds.delete(sessionId), 5_000).unref?.();
		return true;
	}

	const dispatchSessionDeleted = async (
		ctx: ExtensionContext,
		sessionId: string,
		reason: string | undefined,
	): Promise<void> => {
		if (!markSessionDeleted(sessionId)) return;
		try {
			const runtime: HooksRuntime = runtimeRegistry.getRuntimeFor(ctx.cwd);
			await runtime.event(buildSessionDeletedEvent(sessionId, reason));
		} catch {
			// Cleanup is best-effort and intentionally lossy; a failure here
			// must not block the transition.
		}
	};

	const dispatchSessionCreated = async (ctx: ExtensionContext): Promise<void> => {
		const sessionId = safeGetSessionId(ctx.sessionManager);
		if (!sessionId) return;
		try {
			const runtime: HooksRuntime = runtimeRegistry.getRuntimeFor(ctx.cwd);
			await runtime.event(buildSessionCreatedEvent(sessionId));
		} catch {
			// Created hooks are fail-open: the turn must not be blocked.
		}
	};

	// ---- session_start ----
	// Pi exposes explicit reasons; only startup and genuinely new sessions
	// fire session.created hooks (resume and fork are excluded upstream).
	pi.on("session_start", async (event, ctx) => {
		remember(ctx);
		if (event.reason !== "new" && event.reason !== "startup") return;
		await dispatchSessionCreated(ctx);
	});

	// ---- session_before_switch ----
	// Dispatch immediately; the shutdown pair dedupe absorbs the follow-up.
	pi.on("session_before_switch", async (event, ctx) => {
		remember(ctx);
		const sessionId = safeGetSessionId(ctx.sessionManager);
		if (!sessionId) return;
		await dispatchSessionDeleted(ctx, sessionId, event.reason);
	});

	// ---- session_shutdown ----
	// Also fires on terminal exit; forwarding the reason is opaque telemetry.
	pi.on("session_shutdown", async (event, ctx) => {
		remember(ctx);
		const sessionId = safeGetSessionId(ctx.sessionManager);
		if (!sessionId) return;
		await dispatchSessionDeleted(ctx, sessionId, event.reason);
	});
}

/** Envelope for the runtime session.created dispatch. */
function buildSessionCreatedEvent(sessionId: string): {
	event: { type: "session.created"; properties: { info: { id: string } } };
} {
	// Do NOT forward Pi's `parentSession` header field: it is a file path to
	// the parent session's JSONL, not a session id. Forwarding it as parentID
	// poisons scope:main|child classification. Omit it so the runtime defers
	// lineage resolution to host.getRootSessionId.
	return {
		event: { type: "session.created", properties: { info: { id: sessionId } } },
	};
}

/** Envelope for the runtime session.deleted dispatch. */
function buildSessionDeletedEvent(
	sessionId: string,
	reason: string | undefined,
): {
	event: { type: "session.deleted"; properties: { info: { id: string }; reason?: string } };
} {
	const properties: { info: { id: string }; reason?: string } = {
		info: { id: sessionId },
	};
	if (reason) {
		properties.reason = reason;
	}
	return { event: { type: "session.deleted", properties } };
}
