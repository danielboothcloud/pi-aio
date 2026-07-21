import assert from "node:assert/strict";
import test from "node:test";
import { ensureBashSpacing, parseBashInput } from "./parse-bash-input.js";

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

test("ensureBashSpacing inserts space after ! and !!", () => {
	assert.equal(ensureBashSpacing("!ls"), "! ls");
	assert.equal(ensureBashSpacing("!!npm test"), "!! npm test");
	assert.equal(ensureBashSpacing("  !echo hi"), "  ! echo hi");
	assert.equal(ensureBashSpacing("! ls"), null);
	assert.equal(ensureBashSpacing("!"), null);
	assert.equal(ensureBashSpacing("hello"), null);
});
