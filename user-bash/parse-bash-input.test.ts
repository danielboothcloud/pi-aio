import assert from "node:assert/strict";
import test from "node:test";
import { parseBashInput } from "./parse-bash-input.js";

test("parseBashInput ignores normal prompts", () => {
	assert.deepEqual(parseBashInput("hello"), {
		active: false,
		hidden: false,
		command: "",
	});
});

test("parseBashInput detects ! prefix", () => {
	assert.deepEqual(parseBashInput("!ls -la"), {
		active: true,
		hidden: false,
		command: "ls -la",
	});
	assert.deepEqual(parseBashInput("  !"), {
		active: true,
		hidden: false,
		command: "",
	});
});

test("parseBashInput detects !! hidden prefix", () => {
	assert.deepEqual(parseBashInput("!!npm test"), {
		active: true,
		hidden: true,
		command: "npm test",
	});
});
