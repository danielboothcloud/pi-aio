import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_TRANSCRIPT_CHARS,
	MAX_TRANSCRIPT_ENTRIES,
	appendTranscriptLog,
	applyTranscriptEvent,
	clipMiddle,
	createTranscript,
	pushTranscriptNotice,
	type ChildTranscript,
} from "./transcript.ts";

function feed(transcript: ChildTranscript, events: Array<Record<string, unknown>>) {
	for (const event of events) applyTranscriptEvent(transcript, event, 1_000);
}

function update(type: string, extra: Record<string, unknown> = {}) {
	return {
		type: "message_update",
		assistantMessageEvent: { type, contentIndex: 0, ...extra },
	};
}

test("streams thinking and text, replacing deltas with authoritative content", () => {
	const transcript = createTranscript();
	feed(transcript, [
		{ type: "turn_start" },
		{ type: "message_end", message: { role: "user", content: "Task: review" } },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		update("thinking_start"),
		update("thinking_delta", { delta: "Let me \u001b[31mthink" }),
	]);
	const thinking = transcript.entries.at(-1);
	assert.equal(thinking?.kind, "thinking");
	assert.equal(thinking && "text" in thinking ? thinking.text : "", "Let me think");
	assert.equal(thinking?.kind === "thinking" && thinking.streaming, true);

	feed(transcript, [
		update("thinking_end", { content: "Let me think hard." }),
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		},
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Done" },
		},
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
		},
	]);
	assert.deepEqual(
		transcript.entries.map((entry) => entry.kind),
		["notice", "prompt", "thinking", "text"],
	);
	const [, prompt, done, text] = transcript.entries;
	assert.equal(prompt?.kind === "prompt" && prompt.text, "Task: review");
	assert.equal(done?.kind === "thinking" && done.text, "Let me think hard.");
	assert.equal(text?.kind === "text" && text.streaming, false);
});

test("reconciles unstreamed assistant messages and drops empty thinking", () => {
	const transcript = createTranscript();
	feed(transcript, [
		{ type: "message_start", message: { role: "assistant" } },
		update("thinking_start"),
		update("thinking_end", { content: "" }),
	]);
	assert.equal(transcript.entries.length, 0);
	feed(transcript, [
		{ type: "message_start", message: { role: "assistant" } },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "answer" },
				],
				errorMessage: "overloaded",
			},
		},
	]);
	assert.deepEqual(
		transcript.entries.map((entry) => entry.kind),
		["thinking", "text", "notice"],
	);
});

test("tracks tool lifecycle with args, partial and final output, and errors", () => {
	const transcript = createTranscript();
	feed(transcript, [
		{
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "bash",
			args: { command: "npm test" },
		},
		{
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "read",
			args: { path: "x.ts" },
		},
		{
			type: "tool_execution_update",
			toolCallId: "a",
			partialResult: { content: [{ type: "text", text: "running…" }] },
		},
		{
			type: "tool_execution_end",
			toolCallId: "b",
			result: { content: [{ type: "text", text: "nope" }] },
			isError: true,
			durationMs: 12,
		},
	]);
	const [bash, read] = transcript.entries;
	assert.equal(bash?.kind === "tool" && bash.status, "running");
	assert.equal(bash?.kind === "tool" && bash.output, "running…");
	assert.equal(bash?.kind === "tool" && bash.summary, "npm test");
	assert.match(bash?.kind === "tool" ? bash.args : "", /"command": "npm test"/);
	assert.equal(read?.kind === "tool" && read.status, "error");
	assert.equal(read?.kind === "tool" && read.durationMs, 12);
	feed(transcript, [
		{
			type: "tool_execution_end",
			toolCallId: "a",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		},
	]);
	assert.equal(bash?.kind === "tool" && bash.status, "done");
	assert.equal(bash?.kind === "tool" && bash.output, "ok");
	assert.equal(transcript.tools.size, 0);
});

test("records retries, compaction, settle, and coalesces stderr logs", () => {
	const transcript = createTranscript();
	feed(transcript, [
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529" },
		{ type: "compaction_start", reason: "threshold" },
		{ type: "compaction_end" },
		{ type: "agent_settled", aborted: false },
	]);
	appendTranscriptLog(transcript, "warn: a\n");
	appendTranscriptLog(transcript, "warn: b\n");
	appendTranscriptLog(transcript, "   ");
	pushTranscriptNotice(transcript, "completed", "success");
	assert.deepEqual(
		transcript.entries.map((entry) => entry.kind),
		["notice", "notice", "notice", "notice", "log", "notice"],
	);
	const log = transcript.entries[4];
	assert.equal(log?.kind === "log" && log.text, "warn: a\nwarn: b\n");
});

test("bounds entries and characters, evicting oldest first", () => {
	const transcript = createTranscript();
	for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES + 25; index++)
		pushTranscriptNotice(transcript, `n${index}`);
	assert.equal(transcript.entries.length, MAX_TRANSCRIPT_ENTRIES);
	assert.equal(transcript.dropped, 25);

	const big = createTranscript();
	for (let index = 0; index < 200; index++) {
		applyTranscriptEvent(big, {
			type: "tool_execution_start",
			toolCallId: `t${index}`,
			toolName: "bash",
			args: { command: "x" },
		});
		applyTranscriptEvent(big, {
			type: "tool_execution_end",
			toolCallId: `t${index}`,
			result: { content: [{ type: "text", text: "y".repeat(20_000) }] },
		});
	}
	assert.ok(big.chars <= MAX_TRANSCRIPT_CHARS);
	assert.ok(big.dropped > 0);
	// Evicted running tools are forgotten; late end events are ignored safely.
	applyTranscriptEvent(big, { type: "tool_execution_end", toolCallId: "t0" });
});

test("clipMiddle keeps head and tail", () => {
	assert.equal(clipMiddle("short", 100), "short");
	const clipped = clipMiddle(`HEAD${"x".repeat(1_000)}TAIL`, 100);
	assert.ok(clipped.startsWith("HEAD"));
	assert.ok(clipped.endsWith("TAIL"));
	assert.match(clipped, /chars omitted/);
	assert.ok(clipped.length < 140);
});
