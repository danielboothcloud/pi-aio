import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearRuns, createRun, getRun, reconcileRuns, restoreRun } from "./registry.ts";
import type { SubagentRun } from "./types.ts";

afterEach(clearRuns);

function historical(state: "completed" | "stopped", output: string): SubagentRun {
	return {
		id: "historical", state, mode: "single", context: "fresh", cwd: process.cwd(), startedAt: 100,
		children: [{ index: 0, agent: "reviewer", task: "Review", state, output }],
		results: [], stopRequested: state === "stopped",
	};
}

test("tree reconciliation replaces decoded historical rows with the selected snapshot", () => {
	const partial = historical("stopped", "partial");
	restoreRun(partial);
	const final = historical("completed", "final");
	reconcileRuns([final]);
	assert.equal(getRun("historical"), final);
	assert.equal(getRun("historical")?.children[0].output, "final");
	const earlier = historical("stopped", "earlier");
	reconcileRuns([earlier]);
	assert.equal(getRun("historical"), earlier);
});

test("every pruning path protects dirty owned results until their branch can checkpoint them", () => {
	const dirty = createRun({ mode: "single", context: "fresh", cwd: process.cwd(), children: [{ index: 0, agent: "reviewer", task: "Review", state: "completed", output: "unsaved final" }] });
	dirty.state = "completed";
	dirty.startedAt = 0;
	dirty.endedAt = 100;
	const retained = new Set([dirty.id]);
	const newer = Array.from({ length: 50 }, (_, index) => ({ ...historical("completed", "newer"), id: `newer-${index}`, startedAt: 200 + index, endedAt: 300 + index }));
	reconcileRuns(newer, retained);
	assert.equal(getRun(dirty.id), dirty);
	createRun({ mode: "single", context: "fresh", cwd: process.cwd(), children: [] });
	assert.equal(getRun(dirty.id), dirty, "creating another run must also honor dirty retention");
	retained.delete(dirty.id);
	restoreRun({ ...historical("completed", "latest"), id: "latest", startedAt: 1_000 });
	assert.equal(getRun(dirty.id), undefined, "ordinary retention resumes after checkpointing");
});
