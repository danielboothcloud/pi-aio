// Regression tests for the loop-police context scrub: removing a stagnant
// assistant message must also remove the toolResults paired to its tool
// calls. Otherwise the rewritten request carries a function_call_output
// whose function_call is gone, and Responses-API providers (OpenAI Codex)
// reject the whole request with "No tool call found for function call
// output with call_id …" — the sticky failure class seen 2026-09-30.
// Pure data in/out, no SDK runtime — mirrors detect.test.ts conventions.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { scrubStagnantContext } from "./scrub.js";

function assistant(content: unknown[]): AgentMessage {
	return { role: "assistant", content, timestamp: 0 } as unknown as AgentMessage;
}

function toolResult(id: string, text = "ok"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp: 0,
	} as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

test("removes the paired toolResult when a stagnant assistant message is scrubbed", () => {
	const messages = [
		user("start"),
		assistant([
			{ type: "thinking", thinking: "plan A" },
			{ type: "toolCall", id: "call_1|fc_a", name: "bash", arguments: {} },
		]),
		toolResult("call_1|fc_a"),
		user("continue"),
	];
	const scrubbed = scrubStagnantContext(messages, new Set([1]), [1]);
	assert.ok(scrubbed, "expected a scrubbed list");
	// assistant (index 1) and its toolResult (index 2) are both gone
	assert.equal(scrubbed.length, 2);
	assert.equal(scrubbed[0]?.role, "user");
	assert.equal(scrubbed[1]?.role, "user");
});

test("removes every parallel toolResult of a scrubbed assistant message", () => {
	const messages = [
		assistant([
			{ type: "thinking", thinking: "again" },
			{ type: "toolCall", id: "call_1|fc_a", name: "read", arguments: {} },
			{ type: "toolCall", id: "call_2|fc_b", name: "read", arguments: {} },
		]),
		toolResult("call_1|fc_a"),
		toolResult("call_2|fc_b"),
		assistant([{ type: "thinking", thinking: "again" }]),
		user("next"),
	];
	const scrubbed = scrubStagnantContext(messages, new Set([0, 3]), [0, 3]);
	assert.ok(scrubbed, "expected a scrubbed list");
	assert.equal(scrubbed.length, 1);
	assert.equal(scrubbed[0]?.role, "user");
});

test("keeps toolResults whose tool call survives", () => {
	const messages = [
		assistant([
			{ type: "thinking", thinking: "stale" },
			{ type: "toolCall", id: "call_old|fc_x", name: "bash", arguments: {} },
		]),
		toolResult("call_old|fc_x"),
		assistant([
			{ type: "thinking", thinking: "fresh" },
			{ type: "toolCall", id: "call_new|fc_y", name: "bash", arguments: {} },
		]),
		toolResult("call_new|fc_y"),
	];
	const scrubbed = scrubStagnantContext(messages, new Set([0]), [0]);
	assert.ok(scrubbed, "expected a scrubbed list");
	// first assistant + its result removed; second pair untouched
	assert.equal(scrubbed.length, 2);
	assert.equal(scrubbed[0]?.role, "assistant");
	const kept = scrubbed[1] as { role: string; toolCallId: string };
	assert.equal(kept.toolCallId, "call_new|fc_y");
});

test("matches bare call ids without the fc_ suffix", () => {
	const messages = [
		assistant([
			{ type: "thinking", thinking: "loop" },
			{ type: "toolCall", id: "call_z", name: "bash", arguments: {} },
		]),
		toolResult("call_z"),
		user("go on"),
	];
	const scrubbed = scrubStagnantContext(messages, new Set([0]), [0]);
	assert.ok(scrubbed, "expected a scrubbed list");
	assert.equal(scrubbed.length, 1);
	assert.equal(scrubbed[0]?.role, "user");
});

test("returns undefined when nothing is stagnant", () => {
	const messages = [
		user("hi"),
		assistant([{ type: "thinking", thinking: "fine" }]),
		toolResult("call_1|fc_a"),
	];
	assert.equal(scrubStagnantContext(messages, new Set(), []), undefined);
});

test("bails instead of emptying the context entirely", () => {
	const messages = [
		assistant([
			{ type: "thinking", thinking: "loop" },
			{ type: "toolCall", id: "call_1|fc_a", name: "bash", arguments: {} },
		]),
		toolResult("call_1|fc_a"),
	];
	assert.equal(scrubStagnantContext(messages, new Set([0]), [0]), undefined);
});
