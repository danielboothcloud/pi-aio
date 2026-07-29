import assert from "node:assert/strict";
import test from "node:test";
import { QueueMirror } from "./mirror.ts";

test("add and entries preserve steering-then-follow-up FIFO order", () => {
	const mirror = new QueueMirror();
	mirror.add("first follow", "followUp");
	mirror.add("first steer", "steer");
	mirror.add("second steer", "steer");
	mirror.add("second follow", "followUp");

	assert.deepEqual(mirror.entries(), [
		{ text: "first steer", mode: "steer" },
		{ text: "second steer", mode: "steer" },
		{ text: "first follow", mode: "followUp" },
		{ text: "second follow", mode: "followUp" },
	]);
	assert.equal(mirror.size, 4);
	assert.equal(mirror.isEmpty, false);
});

test("next prefers steering over follow-up", () => {
	const mirror = new QueueMirror();
	assert.equal(mirror.next(), undefined);

	mirror.add("follow", "followUp");
	assert.deepEqual(mirror.next(), { text: "follow", mode: "followUp" });

	mirror.add("steer", "steer");
	assert.deepEqual(mirror.next(), { text: "steer", mode: "steer" });
});

test("removeNext pops in delivery order", () => {
	const mirror = new QueueMirror();
	mirror.add("a", "steer");
	mirror.add("b", "followUp");

	assert.deepEqual(mirror.removeNext(), { text: "a", mode: "steer" });
	assert.deepEqual(mirror.removeNext(), { text: "b", mode: "followUp" });
	assert.equal(mirror.removeNext(), undefined);
	assert.equal(mirror.isEmpty, true);
});

test("removeDelivered checks steering first, like AgentSession", () => {
	const mirror = new QueueMirror();
	mirror.add("same text", "followUp");
	mirror.add("same text", "steer");

	assert.equal(mirror.removeDelivered("same text"), "steer");
	assert.deepEqual(mirror.entries(), [{ text: "same text", mode: "followUp" }]);

	assert.equal(mirror.removeDelivered("same text"), "followUp");
	assert.equal(mirror.isEmpty, true);
	assert.equal(mirror.removeDelivered("same text"), undefined);
});

test("removeDelivered removes only the first duplicate", () => {
	const mirror = new QueueMirror();
	mirror.add("dup", "steer");
	mirror.add("other", "steer");
	mirror.add("dup", "steer");

	mirror.removeDelivered("dup");
	assert.deepEqual(
		mirror.entries().map((entry) => entry.text),
		["other", "dup"],
	);
});

test("remove only touches the entry's own mode queue", () => {
	const mirror = new QueueMirror();
	mirror.add("x", "followUp");

	assert.equal(mirror.remove({ text: "x", mode: "steer" }), false);
	assert.equal(mirror.size, 1);
	assert.equal(mirror.remove({ text: "x", mode: "followUp" }), true);
	assert.equal(mirror.isEmpty, true);
});

test("clear returns pending entries and empties the mirror", () => {
	const mirror = new QueueMirror();
	mirror.add("a", "steer");
	mirror.add("b", "followUp");

	const cleared = mirror.clear();
	assert.deepEqual(cleared, [
		{ text: "a", mode: "steer" },
		{ text: "b", mode: "followUp" },
	]);
	assert.equal(mirror.isEmpty, true);
});
