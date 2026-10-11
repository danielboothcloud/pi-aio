import assert from "node:assert/strict";
import test from "node:test";
import { QueueController, type QueueControllerDeps } from "./controller.ts";
import type { QueueMode } from "./mirror.ts";

interface MockCall {
	name: string;
	text?: string;
	mode?: QueueMode;
	texts?: string[];
	type?: string;
}

function createDeps(overrides: Partial<QueueControllerDeps> = {}) {
	const calls: MockCall[] = [];
	const state = { idle: false, pending: 0 };
	const deps: QueueControllerDeps = {
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending > 0,
		abort: () => {
			calls.push({ name: "abort" });
			// Pi's TUI abort dumps the native queue into the editor.
			state.pending = 0;
		},
		clearEditor: () => calls.push({ name: "clearEditor" }),
		restoreTextsToEditor: (texts) =>
			calls.push({ name: "restore", texts: [...texts] }),
		sendUserMessage: (text, mode) => {
			calls.push({ name: "send", text, mode });
			state.pending += 1;
		},
		notify: (message, type) =>
			calls.push({ name: "notify", text: message, type }),
		updateWidget: () => calls.push({ name: "updateWidget" }),
		...overrides,
	};
	return { calls, state, deps };
}

function names(calls: MockCall[]): string[] {
	return calls.map((call) => call.name);
}

test("queued input is mirrored and repaints the widget", () => {
	const { calls, deps } = createDeps();
	const controller = new QueueController(deps);

	controller.handleQueuedInput("fix the bug", "steer");

	assert.deepEqual(controller.mirror.entries(), [
		{ text: "fix the bug", mode: "steer" },
	]);
	assert.ok(names(calls).includes("updateWidget"));
});

test("delivered user messages leave the mirror; empty native queue clears it", () => {
	const { state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("a", "steer");
	controller.handleQueuedInput("b", "followUp");
	state.pending = 2;

	controller.handleUserMessageText("a");
	assert.deepEqual(
		controller.mirror.entries().map((entry) => entry.text),
		["b"],
	);

	// Last delivery drains the native queue; resync drops anything stale.
	state.pending = 0;
	controller.handleUserMessageText("unrelated text");
	assert.equal(controller.mirror.isEmpty, true);
});

test("resync does not clear the mirror while an interrupt is in flight", () => {
	const { state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("next", "steer");
	controller.handleQueuedInput("later", "followUp");
	state.pending = 2;

	controller.onEmptySubmit();
	// abort() zeroed the native queue; nothing is re-sent until the run settles.
	assert.equal(state.pending, 0);
	// The flow keeps the mirror intact despite the drained native queue.
	controller.resync();
	assert.equal(controller.mirror.isEmpty, false);
});

test("empty submit is a no-op when idle or when nothing is queued", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);

	state.idle = true;
	assert.equal(controller.onEmptySubmit(), false);

	state.idle = false;
	state.pending = 0;
	assert.equal(controller.onEmptySubmit(), false);
	assert.ok(!names(calls).includes("abort"));
});

test("empty submit aborts and clears the editor but defers the send", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("steer me", "steer");
	controller.handleQueuedInput("follow one", "followUp");
	controller.handleQueuedInput("follow two", "followUp");
	state.pending = 3;

	assert.equal(controller.onEmptySubmit(), true);

	// No send races the abort unwind: the popped message is deferred until
	// the aborted run settles and pi is guaranteed idle.
	const sequence = names(calls);
	assert.deepEqual(
		sequence.filter((name) => name !== "updateWidget"),
		["abort", "clearEditor"],
	);
	assert.equal(controller.flowBusy, true);
	// The remainder stays mirrored and visible in the widget.
	assert.deepEqual(
		controller.mirror.entries().map((entry) => entry.text),
		["follow one", "follow two"],
	);

	// The aborted run settles: the deferred send becomes a direct prompt.
	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled();
	const sends = calls.filter((call) => call.name === "send");
	assert.equal(sends.length, 1);
	assert.deepEqual(
		{ text: sends[0]?.text, mode: sends[0]?.mode },
		{ text: "steer me", mode: "steer" },
	);
	// No restore: the send starts a run while idle, so nothing is orphaned.
	assert.ok(!names(calls).includes("restore"));
});

test("a second empty submit mid-flight is swallowed without re-aborting", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("next", "steer");
	controller.handleQueuedInput("later", "followUp");
	state.pending = 2;

	assert.equal(controller.onEmptySubmit(), true);
	assert.equal(controller.onEmptySubmit(), true);

	assert.equal(calls.filter((call) => call.name === "abort").length, 1);
	// The deferred send only happens once the run settles.
	assert.equal(calls.filter((call) => call.name === "send").length, 0);

	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled();
	assert.equal(calls.filter((call) => call.name === "send").length, 1);
});

test("agent_start flushes the deferred messages with their original modes", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("next", "steer");
	controller.handleQueuedInput("s1", "steer");
	controller.handleQueuedInput("f1", "followUp");
	state.pending = 3;

	controller.onEmptySubmit();
	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled(); // deferred send of "next"
	// The deferred run starts: flush the deferred remainder.
	state.idle = false;
	calls.length = 0;
	controller.onAgentStart();

	const sends = calls.filter((call) => call.name === "send");
	assert.deepEqual(
		sends.map((call) => ({ text: call.text, mode: call.mode })),
		[
			{ text: "s1", mode: "steer" },
			{ text: "f1", mode: "followUp" },
		],
	);

	// Flushed items stay mirrored exactly once (re-mirrored by the input event).
	controller.handleQueuedInput("s1", "steer");
	controller.handleQueuedInput("f1", "followUp");
	assert.deepEqual(
		controller.mirror.entries().map((entry) => entry.text),
		["s1", "f1"],
	);
});

test("full happy path drains the mirror by delivery", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("next", "steer");
	controller.handleQueuedInput("later", "followUp");
	state.pending = 2;

	assert.equal(controller.onEmptySubmit(), true);
	// Aborted run settles: the deferred send starts a run (idle → direct prompt).
	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled();
	// The run starts; agent_start flushes the remainder while streaming.
	state.idle = false;
	controller.onAgentStart();
	controller.handleQueuedInput("later", "followUp"); // input event from the flush

	controller.handleUserMessageText("next"); // delivered as its own run
	controller.handleUserMessageText("later"); // follow-up delivered
	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled();

	assert.equal(controller.mirror.isEmpty, true);
	assert.equal(controller.flowBusy, false);
	// Nothing was orphaned at any point of the happy path.
	assert.ok(!calls.some((call) => call.name === "restore"));
	assert.ok(!calls.some((call) => call.name === "notify"));
	assert.equal(controller.onEmptySubmit(), false);
});

test("failed deferred send recovers on Enter without double sending", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("next", "steer");
	controller.handleQueuedInput("later", "followUp");
	state.pending = 2;

	assert.equal(controller.onEmptySubmit(), true);
	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled(); // deferred send fires but silently starts no run

	// No run started (e.g. auth error caught by pi): the user presses Enter
	// again on the still-empty editor while idle.
	state.idle = true;
	assert.equal(controller.onEmptySubmit(), true);

	const restore = calls.find((call) => call.name === "restore");
	assert.deepEqual(restore?.texts, ["next", "later"]);
	assert.ok(
		calls.some((call) => call.name === "notify" && call.type === "warning"),
	);
	assert.equal(controller.mirror.isEmpty, true);
	assert.equal(controller.flowBusy, false);
	// The deferred send happened exactly once; the restored texts live in
	// the editor now, so nothing can be sent a second time by the controller.
	assert.equal(calls.filter((call) => call.name === "send").length, 1);
	// A further Enter falls through to the normal submit path.
	assert.equal(controller.onEmptySubmit(), false);
});

test("a later settle retries the deferred send after a silent failure", () => {
	const { calls, state, deps } = createDeps();
	const controller = new QueueController(deps);
	controller.handleQueuedInput("next", "steer");
	state.pending = 1;

	assert.equal(controller.onEmptySubmit(), true);
	state.pending = 0;
	state.idle = true;
	controller.onAgentSettled(); // deferred send fails to start a run

	// Some later run (another prompt) settles: the flow retries the send.
	state.idle = true;
	controller.onAgentSettled();

	assert.equal(calls.filter((call) => call.name === "send").length, 2);
	assert.ok(!names(calls).includes("restore"));
});

test("settling without an in-flight interrupt does not touch the editor", () => {
	const { calls, deps } = createDeps();
	const controller = new QueueController(deps);

	controller.onAgentSettled();

	assert.ok(!names(calls).includes("restore"));
	assert.ok(!names(calls).includes("notify"));
});
