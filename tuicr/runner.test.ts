// Regression tests for the tuicr foreground runner: TUI suspend/resume
// ordering, arg passthrough, and the null-status spawn-failure mapping.
// The spawn is a seam — never a real tuicr process.

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runTuicr, type ForegroundSpawn } from "./runner.js";

const CWD = "/tmp/aio-tuicr-runner-test";

interface Recorder {
	events: string[];
	spawned: Array<{ command: string; args: string[]; cwd: string }>;
}

function fakeCtx(recorder: Recorder): ExtensionContext {
	return {
		cwd: CWD,
		ui: {
			custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					const tui = {
						stop: () => recorder.events.push("stop"),
						start: () => recorder.events.push("start"),
						requestRender: (force: boolean) => recorder.events.push(`render:${force}`),
					};
					const done = (result: T) => resolve(result);
					const component = factory(tui, {}, {}, done) as { render: () => unknown; invalidate: () => unknown };
					assert.equal(typeof component.render, "function");
					assert.equal(typeof component.invalidate, "function");
				}),
		},
	} as unknown as ExtensionContext;
}

function spawnSeam(recorder: Recorder, result: { status: number | null; error?: Error }): ForegroundSpawn {
	return (command, args, cwd) => {
		recorder.events.push("spawn");
		recorder.spawned.push({ command, args, cwd });
		return result;
	};
}

test("runTuicr stops the TUI, spawns tuicr in the foreground, then restores it", async () => {
	const recorder: Recorder = { events: [], spawned: [] };
	const ctx = fakeCtx(recorder);
	const status = await runTuicr(ctx, ["-r", "main..HEAD", "-w"], spawnSeam(recorder, { status: 0 }));

	assert.equal(status, 0);
	assert.deepEqual(recorder.events, ["stop", "spawn", "start", "render:true"]);
	assert.deepEqual(recorder.spawned, [{ command: "tuicr", args: ["-r", "main..HEAD", "-w"], cwd: CWD }]);
});

test("runTuicr maps a spawn error to a null status (could not start)", async () => {
	const recorder: Recorder = { events: [], spawned: [] };
	const ctx = fakeCtx(recorder);
	const status = await runTuicr(ctx, ["-w"], spawnSeam(recorder, { status: null, error: new Error("ENOENT") }));

	assert.equal(status, null);
	assert.deepEqual(recorder.spawned, [{ command: "tuicr", args: ["-w"], cwd: CWD }]);
});

test("runTuicr passes a non-zero exit status through", async () => {
	const recorder: Recorder = { events: [], spawned: [] };
	const ctx = fakeCtx(recorder);
	const status = await runTuicr(ctx, [], spawnSeam(recorder, { status: 3 }));

	assert.equal(status, 3);
});
