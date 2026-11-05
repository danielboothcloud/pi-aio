import assert from "node:assert/strict";
import test from "node:test";

import {
	continuationPrompt,
	describeGoal,
	GOAL_STATE_ENTRY,
	latestGoal,
	MAX_CONTINUATIONS,
	newGoal,
	parseGoalArgs,
	parseReview,
	statusText,
} from "./core.ts";

test("parseGoalArgs routes exact subcommands and treats other text as a new goal", () => {
	assert.deepEqual(parseGoalArgs(""), { kind: "status" });
	assert.deepEqual(parseGoalArgs("  status "), { kind: "status" });
	assert.deepEqual(parseGoalArgs("PAUSE"), { kind: "pause" });
	assert.deepEqual(parseGoalArgs("resume"), { kind: "resume" });
	assert.deepEqual(parseGoalArgs("cancel"), { kind: "cancel" });
	assert.deepEqual(parseGoalArgs("clear"), { kind: "cancel" });
	assert.deepEqual(parseGoalArgs("pause the music player on blur"), { kind: "start", text: "pause the music player on blur" });
});

test("latestGoal reads the newest goal entry, and a cleared entry wins", () => {
	const goal = newGoal("Add dark mode", "Toggle works and tests pass");
	const entry = (data: unknown) => ({ type: "custom", customType: GOAL_STATE_ENTRY, data });
	assert.equal(latestGoal([]), null);
	assert.deepEqual(latestGoal([entry({ goal }), { type: "message" }]), goal);
	assert.equal(latestGoal([entry({ goal }), entry({ goal: null })]), null);
	assert.equal(latestGoal([entry({ goal: { id: "broken" } })]), null);
	assert.equal(latestGoal([{ type: "custom", customType: "other", data: { goal } }]), null);
});

test("parseReview reads the verdict from the first non-empty line", () => {
	assert.deepEqual(parseReview("\nAPPROVED\nAll criteria are met."), { approved: true, reason: "All criteria are met." });
	assert.deepEqual(parseReview("**REJECTED**: tests were not run"), { approved: false, reason: "tests were not run" });
	assert.deepEqual(parseReview("Approved."), { approved: true, reason: "Approved." });
	assert.equal(parseReview("I think it looks fine"), null);
	assert.equal(parseReview(""), null);
});

test("continuation prompt carries the goal and the last rejection", () => {
	const goal = { ...newGoal("Ship it", "npm test passes"), continuations: 3, rejections: 1, lastReview: "tests not run" };
	const prompt = continuationPrompt(goal);
	assert.match(prompt, new RegExp(`3/${MAX_CONTINUATIONS}`));
	assert.match(prompt, /Objective: Ship it/);
	assert.match(prompt, /Done when: npm test passes/);
	assert.match(prompt, /tests not run/);
	assert.match(prompt, /goal_done/);
});

test("statusText and describeGoal reflect the goal state", () => {
	const goal = newGoal("Ship it", "tests pass");
	assert.equal(statusText(null, { drafting: false, reviewing: false }), undefined);
	assert.equal(statusText(null, { drafting: true, reviewing: false }), "◎ goal · draft");
	assert.equal(statusText(goal, { drafting: false, reviewing: false }), `◎ goal · 0/${MAX_CONTINUATIONS}`);
	assert.equal(statusText(goal, { drafting: false, reviewing: true }), "◎ goal · reviewing");
	assert.equal(statusText({ ...goal, status: "paused" }, { drafting: false, reviewing: false }), "◎ goal · paused");
	assert.equal(statusText({ ...goal, status: "done" }, { drafting: false, reviewing: false }), undefined);
	assert.match(describeGoal({ ...goal, status: "paused", pauseReason: "blocked" }), /paused: blocked[\s\S]*\/goal resume/);
});
