// Runtime regression (vitest — the node:test suite cannot load runtime.ts,
// which is exactly how the eventKindForStreamLoop mis-import shipped
// unnoticed: runtime imported it from ./detect.js, where it is not exported,
// so every real loop detection threw before ctx.abort() and the error tore
// through the runner's streaming path as a hard extension error).
//
// Replays a thinking stream that trips the char-loop detector and asserts
// the full watch path: the watcher never throws, ctx.abort() fires, the
// detection payload is emitted with the right event kind, and message_end
// sanitizes the contaminated thinking block.

import { describe, expect, test } from "vitest";
import { LoopPoliceRuntime, SANITIZED_THINKING_MARKER } from "./runtime.js";
import { DETECTION_EVENT, eventKindForStreamLoop } from "./messages.js";
import { NUMERIC_DEFAULTS } from "./config.js";

describe("loop-police runtime watch", () => {
	test("thinking loop: never throws, aborts, emits thinking_loop payload, sanitizes on message_end", () => {
		const detectionEvents: Array<{ event: string; payload: { event: string } }> = [];
		const runtime = new LoopPoliceRuntime({
			bus: {
				emit: (event: string, payload: unknown) => {
					detectionEvents.push({ event, payload: payload as { event: string } });
				},
			},
		});

		let aborts = 0;
		const unit = "Let me check the same file again and think about it. ";
		const repeats = Math.ceil((NUMERIC_DEFAULTS.MAX_WINDOW as number) / unit.length) + 4;
		const text = unit.repeat(repeats);
		const chunk = Math.max(8, Math.floor((NUMERIC_DEFAULTS.STRIDE as number) / 2));

		for (let i = 0; i < text.length; i += chunk) {
			runtime.watchMessageUpdate(
				{ assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text.slice(i, i + chunk) } } as unknown as Parameters<
					LoopPoliceRuntime["watchMessageUpdate"]
				>[0],
				{ abort: () => { aborts += 1; } } as unknown as Parameters<LoopPoliceRuntime["watchMessageUpdate"]>[1],
			);
		}

		// The watcher must have broken the loop…
		expect(aborts).toBeGreaterThanOrEqual(1);
		// …emitted the detection with the corrected event kind…
		const detection = detectionEvents.find((entry) => entry.event === DETECTION_EVENT);
		expect(detection?.payload.event).toBe("thinking_loop");
		// …and recorded the pending sanitize for message_end.
		const result = runtime.sanitizeMessageEnd({
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: unit.repeat(3) }],
			},
		} as unknown as Parameters<LoopPoliceRuntime["sanitizeMessageEnd"]>[0]);
		const content = (result?.message as { content?: Array<{ type: string; thinking?: string }> } | undefined)?.content;
		expect(content?.[0]).toEqual({ type: "thinking", thinking: SANITIZED_THINKING_MARKER });
	});

	test("identical tool calls are allowed to run repeatedly", async () => {
		const detectionEvents: Array<{ event: string; payload: { event: string } }> = [];
		const runtime = new LoopPoliceRuntime({
			bus: {
				emit: (event: string, payload: unknown) => {
					detectionEvents.push({ event, payload: payload as { event: string } });
				},
			},
		});
		const event = { toolName: "edit", input: { path: "src/a.ts", oldText: "a", newText: "b" } } as unknown as Parameters<LoopPoliceRuntime["gateToolCall"]>[0];
		const pi = { sendMessage: () => undefined };

		// Repeating the exact same call back-to-back is legitimate work
		// (the identical-sequence detector was removed) — it must never block.
		expect(await runtime.gateToolCall(event, pi)).toBeUndefined();
		expect(await runtime.gateToolCall(event, pi)).toBeUndefined();
		expect(await runtime.gateToolCall(event, pi)).toBeUndefined();
		expect(detectionEvents.some((entry) => entry.payload.event === "tool_loop")).toBe(false);
	});

	test("eventKindForStreamLoop maps stream + loop kind (the mis-imported symbol)", () => {
		expect(eventKindForStreamLoop("thinking", { kind: "char_loop", boundary: 0, count: 2 })).toBe("thinking_loop");
		expect(eventKindForStreamLoop("thinking", { kind: "semantic_loop", boundary: 0, count: 3 })).toBe("semantic_loop");
		expect(eventKindForStreamLoop("output", { kind: "char_loop", boundary: 0, count: 2 })).toBe("output_loop");
		expect(eventKindForStreamLoop("output", { kind: "semantic_loop", boundary: 0, count: 3 })).toBe("output_semantic_loop");
	});
});
