// ---------------------------------------------------------------------------
// loop-police runtime: stream watchers, tool gate, context scrub, recovery.
//
// Ported from pi-loop-police (MIT, sebaxzero) — see UPSTREAM.md, adapted to
// the Pi SDK surfaces this port verified:
//
//   message_update is notify-only (runner.emit ignores return values), so
//   the "abort mid-stream" path is ctx.abort() called from the watcher; the
//   contaminated assistant message is then sanitized through message_end's
//   MessageEndEventResult replacement (same role required), and recovery
//   starts through pi.sendMessage({ triggerTurn: true }).
//
//   The context event chains through handlers sequentially, so the
//   stagnation scrub composes with blocklist's dedupe filter and
//   permission-modes' transforms: only assistant thinking blocks in the
//   stagnant window are replaced — every other message passes unchanged.
//
// All tool detectors block in place on the tool_call gate (first block
// wins) and hand the recovery message back as the tool's result in the same
// turn — no duplicate sendMessage recovery enters context.
//
// A detector failure must never escape the streaming path: the runner
// calls message_update inside its emit chain, so a throw from here
// surfaces as a hard extension error and kills the turn. The watch is
// guarded end-to-end — the abort runs before bookkeeping, and every
// failure after detection degrades to a console warn.
// ---------------------------------------------------------------------------

import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import {
	detectStreamLoop,
	textSimilarity,
	wordTokens,
	isReadTool,
	isSearchTool,
	isWriteTool,
	pickToolPath,
} from "./detect.js";
import {
	checkRead,
	checkSearch,
	clearReadWindow,
	createLoopPoliceState,
	recordRead,
	recordSearch,
	recordWrite,
	resetLoopPoliceState,
	type DetectionEventKind,
	type LoopPoliceState,
} from "./state.js";import {
	buildDetectionPayload,
	buildRecoveryMessage,
	emitDetectionObservers,
	eventKindForStreamLoop,
	type ObserverContext,
} from "./messages.js";
import { readLoopPoliceConfig, writeLoopPoliceConfig, isSettableKey, defaultConfig, type LoopPoliceConfig, type NumericKey } from "./config.js";

// The SDK defines the streaming event surfaces in core/extensions but does
// not re-export them from the package root (verified against
// @earendil-works/pi-coding-agent@0.80.10), so the runtime mirrors the shapes
// it consumes; AgentMessage comes from pi-agent-core, matching index.ts. The
// loose assistant-event shape accepts every AssistantMessageEvent variant —
// the watcher early-returns on stream types it does not track.
interface AssistantMessageEventLike {
	type: string;
	contentIndex?: number;
	delta?: string;
	content?: string;
}

interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEventLike;
}

interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

interface MessageEndEventResult {
	message?: AgentMessage;
}

/** Marker text replacing sanitized thinking (ordinary text, no signature). */
export const SANITIZED_THINKING_MARKER =
	"[loop-police] The reasoning that produced a detected loop was removed.";

export interface LoopPoliceRuntimeOptions {
	/** Observers bus (pi.events) or null (children/tests). */
	readonly bus?: { emit(event: string, payload: unknown): void } | null;
	/** Exec seam for the external HOOK_CMD observer. */
	readonly runCommand?: (cmd: string, args: string[], timeoutMs: number) => Promise<void>;
	/** JSONL log seam for the HOOK_LOG observer. */
	readonly logLine?: (text: string) => void;
	/** Model descriptor for detection payloads. */
	readonly getModel?: () => { id: string; name: string; provider: string } | null;
}

export class LoopPoliceRuntime {
	readonly state: LoopPoliceState = createLoopPoliceState();
	config: LoopPoliceConfig;

	constructor(options: LoopPoliceRuntimeOptions = {}) {
		this.config = readLoopPoliceConfig();
		this.observerContext = {
			config: this.config,
			bus: options.bus ?? null,
			logLine: options.logLine ?? (() => {}),
			runCommand: options.runCommand ?? (async () => {}),
		};
		this.getModel = options.getModel ?? (() => null);
	}

	private observerContext: ObserverContext;
	private getModel: () => { id: string; name: string; provider: string } | null;

	/** Per-stream accumulation keyed by contentIndex (Pi's streaming block id). */
	private readonly streams = new Map<number, { kind: "thinking" | "text"; checkedLength: number; text: string }>();

	/** Active turn index for payloads (turn_start increments). */
	private turnIndex = 0;

	// ---- state/config surfaces (commands) ----

	reset(): void {
		resetLoopPoliceState(this.state);
		this.streams.clear();
		this.turnIndex = 0;
	}

	setConfigValues(assignments: readonly string[]): string[] {
		const applied: string[] = [];
		const errors: string[] = [];
		const numeric = { ...this.config.numeric } as Record<NumericKey, number>;
		const strings = { ...this.config.strings };
		for (const assignment of assignments) {
			const eq = assignment.indexOf("=");
			if (eq <= 0) {
				errors.push(`Invalid assignment: ${assignment} (expected KEY=VAL)`);
				continue;
			}
			const key = assignment.slice(0, eq);
			const value = assignment.slice(eq + 1);
			if (key === "TOOL_LOOP_BAN" || key === "TOOL_LOOP_EXEMPT") {
				errors.push(`${key} is obsolete; identical tool-call sequence detection has been removed`);
				continue;
			}
			if (!isSettableKey(key)) {
				errors.push(`${key} is not settable with set (MSG_* keys are edited in the JSON file)`);
				continue;
			}
			const numericValue = Number.parseFloat(value);
			if (!Number.isFinite(numericValue)) {
				errors.push(`${key} must be a number (got ${value})`);
				continue;
			}
			numeric[key as NumericKey] = numericValue;
			applied.push(`${key}=${value}`);
		}
		if (applied.length > 0) {
			this.config = { numeric, strings, messages: this.config.messages };
			this.observerContext = { ...this.observerContext, config: this.config };
		}
		return errors;
	}

	saveConfig(): string {
		writeLoopPoliceConfig(this.config);
		return "loop-police config saved";
	}

	// ---- stream watchers (message_update is notify-only) ----

	/**
	 * Watch streaming thinking/text (guarded entry).
	 *
	 * message_update is called on the runner's streaming path (emit →
	 * streamAssistantResponse), so a throw from a detector would surface as
	 * a hard extension error and kill the turn — exactly what a loop
	 * breaker must never do. The whole watch degrades to a console warn
	 * instead; nothing escapes the runner.
	 */
	watchMessageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext): void {
		try {
			this.watchStreamText(event, ctx);
		} catch (error) {
			console.error("[loop-police] stream watch failed:", error);
		}
	}

	/**
	 * Fires the char-level and semantic detectors every STRIDE new
	 * characters; on detection calls ctx.abort() (the stream aborts
	 * immediately) and records the pending sanitize + recovery for
	 * message_end. Post-abort bookkeeping is separately guarded: breaking
	 * the loop is the only action that must always run.
	 */
	private watchStreamText(event: MessageUpdateEvent, ctx: ExtensionContext): void {
		const cfg = this.config.numeric;
		const delta = event.assistantMessageEvent;
		let kind: "thinking" | "text" | undefined;
		let contentIndex: number | undefined;

		if (delta.type === "thinking_delta" || delta.type === "thinking_end") {
			kind = "thinking";
			contentIndex = delta.contentIndex;
		} else if (delta.type === "text_delta" || delta.type === "text_end") {
			kind = "text";
			contentIndex = delta.contentIndex;
		}
		if (kind === undefined || contentIndex === undefined) return;

		const windowKey = cfg.MAX_WINDOW;
		let stream = this.streams.get(contentIndex);
		if (!stream || stream.kind !== kind) {
			stream = { kind, checkedLength: 0, text: "" };
			this.streams.set(contentIndex, stream);
		}

		if (delta.type === "thinking_delta" || delta.type === "text_delta") {
			stream.text = (stream.text + delta.delta).slice(-windowKey);
		} else {
			// *_end carries the full block content; authoritative snapshot.
			stream.text = (delta.content ?? "").slice(-windowKey);
		}

		const newChars = stream.text.length - stream.checkedLength;
		if (newChars < cfg.STRIDE) return;
		stream.checkedLength = stream.text.length;

		const charOptions =
			kind === "thinking"
				? { window: cfg.THINKING_WINDOW, maxWindow: cfg.MAX_WINDOW }
				: { window: cfg.OUTPUT_WINDOW, maxWindow: cfg.MAX_WINDOW };
		const semanticOptions = {
			paraMinLen: cfg.PARA_MIN_LEN,
			fingerprintLen: cfg.FINGERPRINT_LEN,
			threshold: cfg.SEMANTIC_THRESHOLD,
		};

		const loop = detectStreamLoop(stream.text, charOptions, semanticOptions);
		if (!loop) return;

		// The payload vocabulary calls a text stream "output"; the runtime's
		// internal stream id is "text" (this mismatch was masked while the
		// import above pointed at the wrong module).
		const eventKind = eventKindForStreamLoop(kind === "thinking" ? "thinking" : "output", loop);
		const boundaryInStream = loop.boundary;
		const boundaryAbsolute = Math.max(0, boundaryInStream);

		// Abort the running stream immediately (message_update is notify-only;
		// ctx.abort() aborts the current agent operation). Breaking the loop
		// is the only action that must always run: everything after is
		// metadata, so it is guarded separately and can only degrade to a
		// console warn — it must not undo the abort or escape the watch.
		ctx.abort();

		try {
			this.pendingSanitize = {
				contentIndex,
				kind,
				streamText: stream.text,
				boundaryAbsolute,
				eventKind,
			};
			this.streams.clear();

			const escalated = this.registerDetection(eventKind, {
				stream: kind,
				kind: loop.kind,
				...(loop.kind === "char_loop" ? { unit: loop.unit?.length } : { fingerprint: loop.fingerprint?.length }),
			});
			void escalated;
		} catch (error) {
			console.error("[loop-police] post-abort bookkeeping failed:", error);
		}
	}

	/** Pending sanitize from a just-aborted stream (cleared by message_end). */
	private pendingSanitize: {
		readonly contentIndex: number;
		readonly kind: "thinking" | "text";
		readonly streamText: string;
		readonly boundaryAbsolute: number;
		readonly eventKind: DetectionEventKind;
	} | undefined;

	// ---- message_end: sanitize the aborted message ----

	/** Replace the aborted assistant message's looped tail with a marker. */
	sanitizeMessageEnd(event: MessageEndEvent): MessageEndEventResult | undefined {
		const pending = this.pendingSanitize;
		this.pendingSanitize = undefined;
		if (!pending) return undefined;

		const message = event.message;
		if (message.role !== "assistant") return undefined;
		const assistant = message as AssistantMessage;
		const block = assistant.content[pending.contentIndex];
		if (!block) return undefined;

		if (pending.kind === "thinking") {
			const thinking = block as ThinkingContent;
			if (thinking.type !== "thinking") return undefined;
			// Replace with an ordinary text-shaped thinking block: no
			// thinkingSignature and no redacted payload, so providers cannot
			// replay opaque reasoning that was supposedly removed.
			const sanitized: ThinkingContent = {
				type: "thinking",
				thinking: SANITIZED_THINKING_MARKER,
			};
			const content = [...assistant.content];
			content[pending.contentIndex] = sanitized;
			return { message: { ...assistant, content } as AgentMessage };
		}

		// Output loop: truncate the visible text at the detected boundary.
		const truncated = pending.streamText.slice(0, pending.boundaryAbsolute);
		if (block.type === "text") {
			const content = [...assistant.content];
			content[pending.contentIndex] = { type: "text", text: truncated };
			return { message: { ...assistant, content } as AgentMessage };
		}
		return undefined;
	}

	// ---- tool_call gate: block runaway reads and searches in place ----

	/**
	 * Gate a pending tool call. Returns block results for the file-ceiling,
	 * re-read-window, and search-spiral detectors; the recovery message is the
	 * block reason, so it becomes the tool's result in the same turn without a
	 * duplicate recovery message in context.
	 */
	async gateToolCall(event: ToolCallEvent, pi: { sendMessage(message: unknown, options?: unknown): void }): Promise<ToolCallEventResult | undefined> {
		const cfg = this.config.numeric;

		if (isReadTool(event.toolName)) {
			const read = checkRead(this.state, event.toolName, event.input as Record<string, unknown>, {
				fileScanLimit: cfg.FILE_SCAN_LIMIT,
				reReadWindow: cfg.REREAD_WINDOW,
				reReadRatio: cfg.REREAD_RATIO,
			});
			if (read.ceilingBlocked) {
				const message = buildRecoveryMessage(this.config, "file_scan_loop", {
					path: read.path ?? "",
					count: read.executedCount,
				});
				this.registerDetection("file_scan_loop", { toolName: event.toolName, path: read.path ?? "", count: read.executedCount });
				return { block: true, reason: message };
			}
			if (read.reReadBlocked) {
				const message = buildRecoveryMessage(this.config, "redundant_reread", {
					path: read.path ?? "",
					count: read.redundantCount,
					window: cfg.REREAD_WINDOW,
				});
				clearReadWindow(this.state);
				this.registerDetection("redundant_reread", {
					toolName: event.toolName,
					path: read.path ?? "",
					count: read.redundantCount,
					window: cfg.REREAD_WINDOW,
				});
				return { block: true, reason: message };
			}
		}

		const search = checkSearch(this.state, event.toolName, event.input as Record<string, unknown>, cfg.SEARCH_EXPAND_LIMIT);
		if (search.blocked) {
			const message = buildRecoveryMessage(this.config, "search_spiral", {
				pattern: search.pattern ?? "",
				paths: search.pathCount,
			});
			this.registerDetection("search_spiral", { toolName: event.toolName, pattern: search.pattern ?? "", paths: search.pathCount });
			return { block: true, reason: message };
		}

		// Executed (non-blocked) calls enter detector-specific histories here —
		// blocked calls never reached the tool, so they never spend a budget.
		if (isReadTool(event.toolName)) {
			const path = pickToolPath((event.input ?? {}) as Record<string, unknown>) ?? "";
			recordRead(this.state, path, { reReadWindow: cfg.REREAD_WINDOW });
		}
		if (isSearchTool(event.toolName)) {
			const pattern = pickToolPath((event.input ?? {}) as Record<string, unknown>);
			if (pattern !== undefined) recordSearch(this.state, pattern, `${event.toolName}`);
		}
		if (isWriteTool(event.toolName)) {
			// A write invalidates any earlier read of the same path, so a
			// re-read after a real edit counts as fresh (upstream's guarantee).
			const path = pickToolPath((event.input ?? {}) as Record<string, unknown>) ?? "";
			recordWrite(this.state, path);
		}

		void pi;
		return undefined;
	}

	// ---- turn lifecycle ----

	/** turn_start: reset per-turn stream accumulation, record the index. */
	onTurnStart(index: number): void {
		this.turnIndex = index;
		this.streams.clear();
	}

	/** turn_end: collect thinking for stagnation, disarm cross-turn state. */
	onTurnEnd(thinkingText: string | undefined): void {
		if (thinkingText === undefined) return;
		const window = Math.max(this.config.numeric.STAGNATION_WINDOW, 2);
		this.state.turnThinking.push(thinkingText.slice(0, 4_000));
		if (this.state.turnThinking.length > window) {
			this.state.turnThinking.splice(0, this.state.turnThinking.length - window);
		}
	}

	/**
	 * before_agent_start: cross-turn stagnation check over the recorded
	 * thinking window. Fires the stagnation detection once when the last
	 * STAGNATION_WINDOW turns are all ≥ threshold word-similar.
	 */
	checkStagnation(): DetectionEventKind | undefined {
		const cfg = this.config.numeric;
		if (cfg.STAGNATION_WINDOW <= 0) return undefined;
		const recent = this.state.turnThinking.slice(-cfg.STAGNATION_WINDOW);
		if (recent.length < cfg.STAGNATION_WINDOW) return undefined;
		const current = wordTokens(recent[recent.length - 1] ?? "");
		if (current.size === 0) return undefined;
		for (let i = 0; i < recent.length - 1; i++) {
			if (textSimilarity(recent[i] ?? "", recent[recent.length - 1] ?? "") < cfg.STAGNATION_THRESHOLD) {
				return undefined;
			}
		}
		this.registerDetection("stagnation", {
			window: cfg.STAGNATION_WINDOW,
			threshold: cfg.STAGNATION_THRESHOLD,
		});
		return "stagnation";
	}

	/**
	 * message_end follow-up: after any detection, if the model's next
	 * thinking re-derives the same reasoning that led to the block (≥
	 * REDERIVE_THRESHOLD Jaccard-similar), trim the whole reasoning block.
	 */
	checkRederived(thinkingText: string, priorPlan: string): { event: DetectionEventKind; streak: number } | undefined {
		const cfg = this.config.numeric;
		if (cfg.REDERIVE_THRESHOLD <= 0 || priorPlan.length === 0) {
			return undefined;
		}
		const similar = textSimilarity(priorPlan, thinkingText) >= cfg.REDERIVE_THRESHOLD;
		if (!similar) {
			this.state.rederiveStreak = 0;
			return undefined;
		}
		this.state.rederiveStreak += 1;
		this.registerDetection("rederived_reasoning", { streak: this.state.rederiveStreak });
		return { event: "rederived_reasoning", streak: this.state.rederiveStreak };
	}

	// ---- detection bookkeeping ----

	/**
	 * Register a detection: escalate the consecutive counter, emit observers,
	 * and return the escalation status for the caller's recovery message.
	 */
	registerDetection(kind: DetectionEventKind, details: Record<string, unknown>): { escalated: boolean } {
		const cfg = this.config.numeric;
		const isTurnLoop =
			kind === "thinking_loop" ||
			kind === "semantic_loop" ||
			kind === "output_loop" ||
			kind === "output_semantic_loop" ||
			kind === "tool_loop" ||
			kind === "rederived_reasoning";
		if (isTurnLoop) {
			this.state.consecutiveLoops += 1;
		}
		const escalated =
			isTurnLoop &&
			cfg.CONSECUTIVE_LOOP_LIMIT > 0 &&
			this.state.consecutiveLoops >= cfg.CONSECUTIVE_LOOP_LIMIT;

		const payload = buildDetectionPayload({
			kind,
			cwd: process.cwd(),
			consecutiveLoops: this.state.consecutiveLoops,
			model: this.getModel(),
			turnIndex: this.turnIndex,
			details: { ...details, escalated },
		});
		void emitDetectionObservers(payload, this.observerContext);
		return { escalated };
	}

	/** Status text for /loop-police. */
	status(): string {
		const cfg = this.config.numeric;
		return [
			`consecutive looped turns: ${this.state.consecutiveLoops}`,
			`re-derive streak: ${this.state.rederiveStreak}`,
			`executed read totals: ${this.state.executedReadsByPath.size} paths`,
			`re-read window: ${this.state.readWindow.length}/${cfg.REREAD_WINDOW}`,
			`search patterns tracked: ${this.state.searchPathsByPattern.size}`,
			`thinking window: ${this.state.turnThinking.length}/${cfg.STAGNATION_WINDOW} turns`,
		].join("\n");
	}
}

// Re-export for the index wiring (single import surface).
export { createLoopPoliceState, defaultConfig, resetLoopPoliceState };
