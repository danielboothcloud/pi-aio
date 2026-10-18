/**
 * btw/engine.ts — regression tests.
 *
 * The complete seam is injected; no network. Every infrastructure path must
 * come back as `error` on the outcome — runSideQuestion never throws — and
 * answers must be terminal-sanitized and capped.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_ANSWER_CHARS,
	runSideQuestion,
	sanitizeForTerminal,
	textFromContent,
	type BtwCompleteFn,
} from "./engine.ts";
import { BTW_SYSTEM_PROMPT } from "./context.ts";

type Reply = Awaited<ReturnType<BtwCompleteFn>>;

/** Test-local reply shape: answer text plus the outcome surface fields. */
interface CompleteReply {
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Reply["usage"];
}

function makeComplete(
	reply?: CompleteReply,
	behavior?: { throw?: Error; hold?: Promise<void> },
): BtwCompleteFn {
	return async (_model, context, options) => {
		if (behavior?.hold) await behavior.hold;
		if (behavior?.throw) throw behavior.throw;
		void context;
		void options;
		return {
			content: [{ type: "text", text: reply?.text ?? "plain answer" }],
			stopReason: reply?.stopReason ?? "stop",
			errorMessage: reply?.errorMessage,
			usage: reply?.usage,
		};
	};
}

const SIGNAL = new AbortController().signal;

test("a successful side call returns a sanitized answer with usage and latency", async () => {
	const outcome = await runSideQuestion({
		model: { provider: "x", id: "y" },
		prompt: "q",
		complete: makeComplete({
			text: "\u001b[31mred\u001b[0m answer line",
			usage: { input: 1000, output: 250, cost: { total: 0.001 } },
		}),
		signal: SIGNAL,
	});
	assert.equal(outcome.error, undefined, "no error on success");
	assert.equal(outcome.answer, "red answer line", "ANSI stripped from the answer");
	assert.deepEqual(outcome.usage, { inputTokens: 1000, outputTokens: 250, costTotal: 0.001 });
	assert.ok(outcome.latencyMs >= 0);
});

test("the prompt carries the btw system prompt and the question", async () => {
	const calls: Array<{ context: { systemPrompt: string; messages: Array<{ content: string }> } }> = [];
	const complete: BtwCompleteFn = async (_model, context) => {
		calls.push({ context });
		return { content: [{ type: "text", text: "a" }], stopReason: "stop" };
	};
	await runSideQuestion({ model: null, prompt: "what is chunkiest?", complete, signal: SIGNAL });
	assert.ok(calls[0].context.systemPrompt.includes("By The Way"), "persona in system prompt");
	assert.ok(BTW_SYSTEM_PROMPT.includes("Never invent"), "grounding rule present");
	assert.ok(calls[0].context.messages[0].content.includes("what is chunkiest?"), "question in user message");
});

test("stopReason error carries the provider message as the outcome error", async () => {
	const outcome = await runSideQuestion({
		model: null,
		prompt: "q",
		complete: makeComplete({ stopReason: "error", errorMessage: "no API key \u001b[31mconfigured\u001b[0m" }),
		signal: SIGNAL,
	});
	assert.equal(outcome.answer, "");
	assert.ok(outcome.error?.includes("no API key configured"), "error sanitized and carried");
});

test("an aborted verbatim reply reports aborted", async () => {
	const outcome = await runSideQuestion({
		model: null,
		prompt: "q",
		complete: makeComplete({ stopReason: "aborted" }),
		signal: SIGNAL,
	});
	assert.equal(outcome.error, "aborted");
});

test("a pre-aborted signal wins before any answer is read", async () => {
	const abort = new AbortController();
	abort.abort();
	const outcome = await runSideQuestion({
		model: null,
		prompt: "q",
		complete: makeComplete(),
		signal: abort.signal,
	});
	assert.equal(outcome.error, "aborted");
	assert.equal(outcome.answer, "");
});

test("a blank reply is an error, not an empty answer", async () => {
	const outcome = await runSideQuestion({
		model: null,
		prompt: "q",
		complete: makeComplete({ text: "   \n  " }),
		signal: SIGNAL,
	});
	assert.equal(outcome.error, "the model returned an empty answer");
});

test("a rejected complete seam never throws out of the engine", async () => {
	const outcome = await runSideQuestion({
		model: null,
		prompt: "q",
		complete: makeComplete({}, { throw: new Error("socket exploded") }),
		signal: SIGNAL,
	});
	assert.equal(outcome.error, "socket exploded");
	assert.equal(outcome.answer, "");
});

test("answers cap at MAX_ANSWER_CHARS with an ellipsis", async () => {
	const outcome = await runSideQuestion({
		model: null,
		prompt: "q",
		complete: makeComplete({ text: "w".repeat(MAX_ANSWER_CHARS + 3000) }),
		signal: SIGNAL,
	});
	assert.ok(outcome.answer.length <= MAX_ANSWER_CHARS + 1, "capped length");
	assert.ok(outcome.answer.endsWith("…"), "ellipsis appended");
});

test("sanitizeForTerminal drops ANSI and control codes but keeps newlines", () => {
	const sanitized = sanitizeForTerminal("a\u0007b\u001b[31mred\u001b[0m\nc\td", 500);
	assert.equal(sanitized, "abred\nc\td");
	assert.equal(sanitizeForTerminal("x".repeat(20), 5), "xxxxx…");
	assert.equal(sanitizeForTerminal(undefined as unknown as string, 5), "");
});

test("textFromContent joins text blocks and ignores other block types", () => {
	const content = [
		{ type: "text", text: "one" },
		{ type: "thinking", text: "hidden" },
		{ type: "text", text: "two" },
	];
	assert.equal(textFromContent(content as Array<Record<string, unknown>>), "one\ntwo");
	assert.equal(textFromContent(undefined), "");
});
