import assert from "node:assert/strict";
import test from "node:test";
import { BLOCKED_MESSAGE_MAX, blockedMessage } from "./protocol.ts";

test("blockedMessage keeps a short message on one line", () => {
	assert.equal(blockedMessage("Allow edit on src/x.ts?", "fallback"), "Allow edit on src/x.ts?");
	assert.equal(blockedMessage("  Which\n\tdatabase?  ", "fallback"), "Which database?");
});

test("blockedMessage uses the fallback for an empty message", () => {
	assert.equal(blockedMessage(undefined, "The agent has a question"), "The agent has a question");
	assert.equal(blockedMessage(" \n ", "The agent has a question"), "The agent has a question");
});

test("blockedMessage cuts a long message to the limit", () => {
	const message = blockedMessage("x".repeat(500), "fallback");
	assert.equal(message.length, BLOCKED_MESSAGE_MAX);
	assert.ok(message.endsWith("…"));
});
