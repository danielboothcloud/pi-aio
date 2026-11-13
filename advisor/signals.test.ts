import assert from "node:assert/strict";
import test from "node:test";

import { buildAdvisorMessages, buildAdvisorSystemPrompt, clampText, MAX_SYSTEM_PROMPT_CHARS } from "./messages.ts";
import {
	buildExecutorSignals,
	detectStage,
	isVerificationCommand,
	summarizeToolResult,
	type RunToolEvent,
} from "./signals.ts";

const event = (toolName: string, extra: Partial<RunToolEvent> = {}): RunToolEvent => ({
	toolName,
	summary: toolName,
	isError: false,
	timestamp: 0,
	...extra,
});

test("summaries cover AIO tool names: apply_patch, hypa_shell, hypa_read", () => {
	assert.equal(
		summarizeToolResult({ toolName: "apply_patch", input: { changes: [{ path: "a.ts" }, { path: "b.ts" }] }, isError: false }, 0).summary,
		"apply_patch 2 files",
	);
	assert.equal(
		summarizeToolResult({ toolName: "edit", input: { path: "a.ts" }, isError: false, details: { diff: "+x\n-y\n+z" } }, 0).summary,
		"edit a.ts (+2/-1)",
	);
	const shell = summarizeToolResult(
		{ toolName: "hypa_shell", input: { command: "npm   test" }, content: [{ type: "text", text: "Command exited with code 1" }], isError: false },
		0,
	);
	assert.equal(shell.summary, "$ npm test (exit 1)");
	assert.equal(shell.isError, true);
	assert.equal(shell.command, "npm test");
	assert.equal(summarizeToolResult({ toolName: "hypa_read", input: { path: "x" }, isError: false }, 0).summary, "read x");
	assert.equal(
		summarizeToolResult({ toolName: "grep", content: [{ type: "text", text: "a\n  b" }], isError: false }, 0).summary,
		"grep: a b",
	);
});

test("verification commands match per segment, not by path", () => {
	assert.equal(isVerificationCommand("cd app && npm run test:node"), true);
	assert.equal(isVerificationCommand("CI=1 npx vitest run"), true);
	assert.equal(isVerificationCommand("npx tsx --test a.test.ts"), true);
	assert.equal(isVerificationCommand("cat tests/foo.test.ts"), false);
	assert.equal(isVerificationCommand(undefined), false);
});

test("stage detection: initial → recovery → final-check", () => {
	assert.equal(detectStage([], 1).stage, "initial");
	assert.equal(detectStage([event("read"), event("bash")], 1).stage, "initial");
	assert.equal(detectStage([event("read"), event("bash", { isError: true })], 1).stage, "recovery");
	assert.equal(detectStage([event("apply_patch")], 1).stage, "recovery");
	assert.equal(
		detectStage([event("write"), event("hypa_shell", { command: "npm test" })], 1).stage,
		"final-check",
	);
	const signals = buildExecutorSignals([event("edit"), event("bash", { command: "go test ./..." })]);
	assert.deepEqual(signals, { phase: "verifying", mutationsCount: 1, verificationCommands: ["go test ./..."], recentFailures: [] });
});

test("advisor transcript: text only, tool results dropped, closing evidence last", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the router" }, { type: "image", data: "x" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: "looking" }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret output" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } },
		{ type: "custom", customType: "x" },
	];
	const messages = buildAdvisorMessages(
		branch,
		{ stage: "initial", reason: "why", directive: "do" },
		"- read a.ts",
		18,
		buildExecutorSignals([]),
		5,
	);
	assert.equal(messages.length, 3);
	assert.deepEqual(messages[0]?.content, [{ type: "text", text: "fix the router" }]);
	assert.deepEqual(messages[1]?.content, [{ type: "text", text: "looking" }]);
	const closing = String(messages[2]?.content);
	assert.match(closing, /Current advisory stage: initial/);
	assert.match(closing, /Recent tool activity:\n- read a\.ts/);
	assert.doesNotMatch(JSON.stringify(messages), /secret output/);
	assert.deepEqual(buildAdvisorMessages([], { stage: "initial", reason: "", directive: "" }, "", 18), []);
});

test("long transcripts keep the first two and the latest messages", () => {
	const branch = Array.from({ length: 30 }, (_, i) => ({
		type: "message",
		message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: `a${i}` }] : `u${i}` },
	}));
	const messages = buildAdvisorMessages(branch, { stage: "recovery", reason: "", directive: "" }, "", 8, undefined, 1);
	assert.equal(messages.length, 8);
	assert.equal(messages[0]?.content, "u0");
	assert.match(String(messages[2]?.content), /24 earlier transcript messages omitted/);
	assert.deepEqual(messages[6]?.content, [{ type: "text", text: "a29" }]);
});

test("text and system prompt are bounded", () => {
	assert.match(clampText("x\n".repeat(100)), /\[truncated for advisor context\]$/);
	const prompt = buildAdvisorSystemPrompt("p".repeat(MAX_SYSTEM_PROMPT_CHARS + 50), "- read: reads");
	assert.match(prompt, /executor system prompt truncated/);
	assert.match(prompt, /Active tools available to the executor:\n- read: reads$/);
});
