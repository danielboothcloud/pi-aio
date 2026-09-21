// ---------------------------------------------------------------------------
// Recovery message assembly and observer channels.
//
// Ported from pi-loop-police (MIT, sebaxzero) — see UPSTREAM.md. Recovery
// messages are configurable via MSG_* keys with {token} substitution;
// unknown tokens stay visible so a typo shows. Observer channels are purely
// observational: they can never block, delay, or alter detection and
// recovery, and the payload carries metadata only — never thinking text or
// tool arguments.
// ---------------------------------------------------------------------------

import type { DetectionEventKind } from "./state.js";
import { substitutePlaceholders, type LoopPoliceConfig, type MsgKey } from "./config.js";
import type { StreamLoop } from "./detect.js";

export const DETECTION_EVENT = "loop-police:detection";

export type MsgKeyForEvent = Extract<
	MsgKey,
	| "MSG_THINKING_LOOP"
	| "MSG_SEMANTIC_LOOP"
	| "MSG_OUTPUT_LOOP"
	| "MSG_OUTPUT_SEMANTIC_LOOP"
	| "MSG_CONSECUTIVE_LOOP"
	| "MSG_STAGNATION"
	| "MSG_FILE_SCAN_LOOP"
	| "MSG_SEARCH_SPIRAL"
	| "MSG_REREAD"
	| "MSG_TOOL_LOOP"
	| "MSG_REDERIVED"
	| "MSG_STUCK"
>;

/** Which MSG_* template an event kind uses. */
export function msgKeyForEvent(kind: DetectionEventKind): MsgKeyForEvent {
	switch (kind) {
		case "thinking_loop":
			return "MSG_THINKING_LOOP";
		case "semantic_loop":
			return "MSG_SEMANTIC_LOOP";
		case "output_loop":
			return "MSG_OUTPUT_LOOP";
		case "output_semantic_loop":
			return "MSG_OUTPUT_SEMANTIC_LOOP";
		case "stagnation":
			return "MSG_STAGNATION";
		case "file_scan_loop":
			return "MSG_FILE_SCAN_LOOP";
		case "search_spiral":
			return "MSG_SEARCH_SPIRAL";
		case "redundant_reread":
			return "MSG_REREAD";
		case "tool_loop":
			return "MSG_TOOL_LOOP";
		default:
			return "MSG_REDERIVED";
	}
}

/** Assemble the recovery message for a detection (template + suffix). */
export function buildRecoveryMessage(
	config: LoopPoliceConfig,
	kind: DetectionEventKind,
	tokens: Record<string, string | number> = {},
): string {
	const template = config.messages[msgKeyForEvent(kind)];
	const body = substitutePlaceholders(template, tokens);
	const suffix = config.messages.MSG_SUFFIX;
	return suffix.length > 0 ? `${body}\n${suffix}` : body;
}

/** Map a stream loop to its event kind (the stream decides thinking vs output). */
export function eventKindForStreamLoop(stream: "thinking" | "output", loop: StreamLoop): "thinking_loop" | "semantic_loop" | "output_loop" | "output_semantic_loop" {
	const semantic = loop.kind === "semantic_loop";
	if (stream === "thinking") {
		return semantic ? "semantic_loop" : "thinking_loop";
	}
	return semantic ? "output_semantic_loop" : "output_loop";
}

// ---- structured detection payload ----

export interface DetectionPayload {
	readonly event: DetectionEventKind;
	readonly timestamp: string;
	readonly model: { readonly id: string; readonly name: string; readonly provider: string } | null;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly cwd: string;
	readonly turnIndex?: number;
	readonly consecutiveLoops: number;
	readonly details: Record<string, unknown>;
}

/** Build the metadata-only payload (never thinking text or tool arguments). */
export function buildDetectionPayload(input: {
	kind: DetectionEventKind;
	cwd: string;
	consecutiveLoops: number;
	model?: { id: string; name: string; provider: string } | null;
	sessionId?: string;
	sessionFile?: string;
	turnIndex?: number;
	details?: Record<string, unknown>;
}): DetectionPayload {
	const payload: DetectionPayload & { sessionId?: string; sessionFile?: string; turnIndex?: number } = {
		event: input.kind,
		timestamp: new Date().toISOString(),
		model: input.model ?? null,
		cwd: input.cwd,
		consecutiveLoops: input.consecutiveLoops,
		details: input.details ?? {},
	};
	if (input.sessionId !== undefined) payload.sessionId = input.sessionId;
	if (input.sessionFile !== undefined) payload.sessionFile = input.sessionFile;
	if (input.turnIndex !== undefined) payload.turnIndex = input.turnIndex;
	return payload;
}

// ---- observer channels ----

export interface ObserverContext {
	readonly config: LoopPoliceConfig;
	readonly bus: { emit(event: string, payload: unknown): void } | null;
	readonly logLine: (text: string) => void;
	readonly runCommand: (cmd: string, args: string[], timeoutMs: number) => Promise<void>;
}

/**
 * Emit one detection to every configured observer channel. All three are
 * fire-and-forget; failures are swallowed (a broken hook must never affect
 * detection or recovery) and each shows at most a one-time warning.
 */
export async function emitDetectionObservers(
	payload: DetectionPayload,
	ctx: ObserverContext,
): Promise<void> {
	// In-process bus: listening extensions get the full payload synchronously.
	ctx.bus?.emit(DETECTION_EVENT, payload);

	// JSONL statistics (zero-code analytics; relative paths resolve against
	// the session cwd upstream — aio writes absolute paths from config).
	const logFile = ctx.config.strings.HOOK_LOG;
	if (logFile.length > 0) {
		try {
			ctx.logLine(`${JSON.stringify(payload)}\n`);
		} catch {
			// ignore — observers must never affect detection
		}
	}

	// External command, fire-and-forget with the payload as the last argument.
	const cmd = ctx.config.strings.HOOK_CMD;
	if (cmd.length > 0) {
		try {
			await ctx.runCommand(cmd, [JSON.stringify(payload)], ctx.config.numeric.HOOK_TIMEOUT_MS);
		} catch {
			// ignore — a failing hook shows at most a one-time warning upstream;
			// aio's env-gated logger already covers stderr surfaces.
		}
	}
}
