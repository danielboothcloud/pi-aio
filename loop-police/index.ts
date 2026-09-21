// ---------------------------------------------------------------------------
// loop-police — Pi extension wiring.
//
// Detects and breaks infinite reasoning/tool loops in real time, ported
// from pi-loop-police (MIT, sebaxzero) — see UPSTREAM.md.
//
// Registration order is load-bearing (see the root index.ts): the tool_call
// gate registers BEFORE permission-modes' mode gate and the user-bash gate,
// and AFTER the hard blocklist — the runner short-circuits on the first
// blocking tool_call handler, so blocklist wins over loop blocks (a blocked
// command stays blocked), while a loop block preempts mode checks. The
// context scrub composes with blocklist/permission-modes context handlers:
// only assistant thinking blocks in the stagnant window are replaced.
//
// Detectors stay ACTIVE in aio subagent child processes
// (AIO_SUBAGENT_CHILD=1) — children loop too and burn the same tokens.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LoopPoliceRuntime, SANITIZED_THINKING_MARKER } from "./runtime.js";
import { textSimilarity } from "./detect.js";
import { NUMERIC_DEFAULTS, NUMERIC_RANGES, defaultConfig, loopPoliceFilePath, type NumericKey } from "./config.js";

export type { LoopPoliceRuntime } from "./runtime.js";
export { SANITIZED_THINKING_MARKER };
export { DETECTION_EVENT } from "./messages.js";
export { NUMERIC_DEFAULTS, NUMERIC_RANGES, defaultConfig, loopPoliceFilePath };

const SET_HELP =
	"/loop-police set KEY=VAL [KEY=VAL …] — tune config values live. Numeric keys are range-checked; TOOL_LOOP_EXEMPT is a comma-separated tool-name list. MSG_* keys are edited in the JSON file only.";

export default function registerLoopPolice(pi: ExtensionAPI): void {
	const runtime = new LoopPoliceRuntime({
		bus: pi.events,
		getModel: () => {
			// Children run JSON mode without a bound model surface; the
			// payload's model field stays null there (metadata only).
			return null;
		},
	});

	// ---- tool_call gate: block looped calls in place ----

	pi.on("tool_call", async (event) => {
		return runtime.gateToolCall(event, pi);
	});

	// ---- streaming watchers: char + semantic loop detectors ----

	pi.on("message_update", async (event, ctx) => {
		runtime.watchMessageUpdate(event, ctx);
		// Notify-only event: return values are ignored by the runner.
		return undefined;
	});

	// ---- message_end: sanitize the just-aborted message ----

	pi.on("message_end", async (event) => {
		return runtime.sanitizeMessageEnd(event);
	});

	// ---- turn lifecycle: stagnation window bookkeeping ----

	pi.on("turn_start", async (event) => {
		runtime.onTurnStart(event.turnIndex);
	});

	pi.on("turn_end", async (event) => {
		// Thinking text comes from the assistant message's thinking blocks.
		const message = event.message;
		if (message.role !== "assistant") return;
		const thinking = (message.content as Array<{ type: string; thinking?: string }>)
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking ?? "")
			.join("\n");
		runtime.onTurnEnd(thinkingTextOf(thinking));
	});

	// ---- cross-turn stagnation + recovery at the next agent start ----

	pi.on("before_agent_start", async (event) => {
		const detected = runtime.checkStagnation();
		// Re-derived reasoning guard: after any detection, if the model's
		// thinking re-derives the same plan that led to the block, the
		// reasoning has already been trimmed by the stagnation/loop path.
		void event;
		if (detected === undefined) return undefined;

		// Recovery message as a same-turn system context injection.
		return {
			message: {
				customType: "loop-police-recovery",
				content: buildStagnationRecovery(runtime),
				display: false,
			},
		};
	});

	// ---- context scrub: remove stagnant reasoning from future requests ----

	pi.on("context", async (event) => {
		if (runtime.state.turnThinking.length === 0) return undefined;
		const threshold = runtime.config.numeric.STAGNATION_THRESHOLD;
		const stagnant = new Set<number>();
		const messages = event.messages;
		const thinkingIndexes: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			if (message?.role !== "assistant") continue;
			const blocks = (message.content as Array<{ type: string }>) ?? [];
			if (blocks.some((block) => block.type === "thinking")) {
				thinkingIndexes.push(i);
			}
		}
		if (thinkingIndexes.length < 2) return undefined;

		// Walk thinking pairs from the end; a pair ≥ threshold similar marks
		// both members stagnant, and the walk stops at the first dissimilar
		// pair (stagnation is a recent contiguous window, not session-wide).
		for (let k = thinkingIndexes.length - 1; k > 0; k--) {
			const current = thinkingTextOf(messages[thinkingIndexes[k]] as AgentMessage);
			const prior = thinkingTextOf(messages[thinkingIndexes[k - 1]] as AgentMessage);
			if (similarEnough(prior, current, threshold)) {
				stagnant.add(thinkingIndexes[k]);
				stagnant.add(thinkingIndexes[k - 1]);
			} else {
				break;
			}
		}
		if (stagnant.size === 0) return undefined;

		const filtered = messages.filter((_, i) => !stagnant.has(i) || !thinkingIndexes.includes(i));
		if (filtered.length === messages.length) return undefined;
		return { messages: filtered };
	});

	// ---- /loop-police command ----

	pi.registerCommand("loop-police", {
		description: "Show, reset, or tune loop detection state",
		getArgumentCompletions: (prefix: string) => {
			const bare = prefix.trim().length === 0;
			if (bare || prefix.startsWith("reset") || prefix.startsWith("set") || prefix.startsWith("save")) {
				return [
					{ value: "reset", label: "reset — clear all detection state" },
					{ value: "save", label: "save — write config to aio-loop-police.json" },
					{ value: `set ${prefix.replace(/^set\s*/, "")}`.trim(), label: "set KEY=VAL — tune live" },
				];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.length === 0) {
				const configLines = (Object.keys(NUMERIC_DEFAULTS) as NumericKey[])
					.map((key) => `${key}: ${runtime.config.numeric[key]}`)
					.join("\n");
				const status = `loop-police detection state\n${runtime.status()}\n\nconfig (${loopPoliceFilePath()}):\n${configLines}\n\n${SET_HELP}`;
				if (ctx.hasUI) {
					ctx.ui.notify(status, "info");
				} else {
					// eslint-disable-next-line no-console
					console.info(`[loop-police] ${status}`);
				}
				return;
			}

			if (trimmed === "reset") {
				runtime.reset();
				notify(ctx, "loop-police state cleared");
				return;
			}

			if (trimmed === "save") {
				notify(ctx, runtime.saveConfig());
				return;
			}

			if (trimmed.startsWith("set")) {
				const assignments = trimmed
					.replace(/^set\s*/, "")
					.match(/(?:[^\s=]+)=(?:"[^"]*"|[^\s]+)|(?:[^\s=]+)=(?:.*$)/g) ?? [];
				const errors = runtime.setConfigValues(assignments);
				if (errors.length > 0) {
					notify(ctx, `${errors.join("\n")}\n\n${SET_HELP}`, "warning");
					return;
				}
				notify(ctx, `Applied: ${assignments.join(", ")}. Use /loop-police save to persist.`);
				return;
			}

			notify(ctx, `Unknown argument: ${trimmed}. Use /loop-police, reset, set KEY=VAL, or save.`, "warning");
		},
	});
}

function buildStagnationRecovery(runtime: LoopPoliceRuntime): string {
	return runtime.config.messages.MSG_STAGNATION.replaceAll("{window}", String(runtime.config.numeric.STAGNATION_WINDOW))
		.replaceAll("{threshold}", String(runtime.config.numeric.STAGNATION_THRESHOLD));
}

/** Extract thinking text from an assistant message (empty for other roles). */
function thinkingTextOf(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const blocks = (message.content as Array<{ type: string; thinking?: string }>) ?? [];
	return blocks
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking ?? "")
		.join("\n");
}

/** Stagnant-pair predicate: ≥ threshold word-similar. */
function similarEnough(prior: string, current: string, threshold: number): boolean {
	return textSimilarity(prior, current) >= threshold;
}

function notify(
	ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		// eslint-disable-next-line no-console
		console.info(`[loop-police] ${message}`);
	}
}

void SANITIZED_THINKING_MARKER;
void defaultConfig;
