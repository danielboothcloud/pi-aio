// Regression tests for the tuicr review flow: TUI gating, snapshot/fresh
// comment diffing, failure surfacing, and the editor prefill. ui, capture,
// and spawn are all fakes — never a live tuicr or git.

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { review, type ReviewDeps } from "./review.js";
import type { Capture } from "./core.js";

const CWD = "/tmp/aio-tuicr-review-test";

interface FakeState {
	notifies: Array<{ message: string; type?: string }>;
	editorTexts: string[];
	select: (options: string[]) => Promise<string | undefined>;
	input: (title: string, hint?: string) => Promise<string | undefined>;
	customResult: number | null;
	captureScript: Record<string, string | null>;
	spawnError?: Error;
}

function buildDeps(state: FakeState): { ctx: ExtensionContext; deps: ReviewDeps } {
	const ctx = {
		mode: "tui",
		cwd: CWD,
		ui: {
			notify: (message: string, type?: string) => state.notifies.push({ message, type }),
			setEditorText: (text: string) => state.editorTexts.push(text),
			select: (_title: string, options: string[]) => state.select(options),
			input: (title: string, hint?: string) => state.input(title, hint),
			custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					const tui = {
						stop: () => {},
						start: () => {},
						requestRender: () => {},
					};
					factory(tui, {}, {}, (result: T) => resolve(result));
				}),
		},
	} as unknown as ExtensionContext;

	const capture: Capture = (command, args) => {
		const key = [command, ...args].join(" ");
		// git probes (base-branch detection) answer "no" unless scripted;
		// tuicr keys stay strict so a wrong subcommand fails loudly.
		if (command === "git" && !(key in state.captureScript)) return null;
		if (!(key in state.captureScript)) throw new Error(`unexpected exec: ${key}`);
		const value = state.captureScript[key];
		return value === null ? null : value;
	};

	return {
		ctx,
		deps: {
			capture,
			spawn: () => ({ status: state.customResult, error: state.spawnError }),
		},
	};
}

test("review refuses non-TUI modes before touching tuicr", async () => {
	const state: FakeState = {
		notifies: [],
		editorTexts: [],
		select: async () => undefined,
		input: async () => undefined,
		customResult: 0,
		captureScript: {},
	};
	const { ctx, deps } = buildDeps(state);
	const rpcCtx = { ...ctx, mode: "rpc" } as unknown as ExtensionContext;

	await review(rpcCtx, deps);

	assert.deepEqual(state.notifies, [{ message: "tuicr needs an interactive terminal", type: "error" }]);
	assert.deepEqual(state.editorTexts, []);
});

test("review returns quietly when the picker is cancelled", async () => {
	const state: FakeState = {
		notifies: [],
		editorTexts: [],
		select: async () => undefined,
		input: async () => undefined,
		customResult: 0,
		captureScript: {},
	};
	const { ctx, deps } = buildDeps(state);

	await review(ctx, deps);

	assert.deepEqual(state.notifies, []);
	assert.deepEqual(state.editorTexts, []);
});

test("review reports a missing tuicr and never prefills", async () => {
	const state: FakeState = {
		notifies: [],
		editorTexts: [],
		select: async () => "Uncommitted changes",
		input: async () => undefined,
		customResult: 0,
		captureScript: { "tuicr review list --all": null },
		spawnError: new Error("ENOENT"),
	};
	const { ctx, deps } = buildDeps(state);

	await review(ctx, deps);

	assert.deepEqual(state.notifies, [{ message: "Could not start tuicr - is it on your PATH?", type: "error" }]);
	assert.deepEqual(state.editorTexts, []);
});

test("review reports a non-zero tuicr exit", async () => {
	const state: FakeState = {
		notifies: [],
		editorTexts: [],
		select: async () => "Uncommitted changes",
		input: async () => undefined,
		customResult: 3,
		captureScript: { "tuicr review list --all": null },
	};
	const { ctx, deps } = buildDeps(state);

	await review(ctx, deps);

	assert.deepEqual(state.notifies, [{ message: "tuicr exited with status 3", type: "error" }]);
	assert.deepEqual(state.editorTexts, []);
});

test("review reports when no new comments were left", async () => {
	const same = [{ id: "old", location: "src/a.ts:1", content: "existing" }];
	const state: FakeState = {
		notifies: [],
		editorTexts: [],
		select: async () => "Uncommitted changes",
		input: async () => undefined,
		customResult: 0,
		captureScript: {
			"tuicr review list --all": JSON.stringify([{ path: "/repo/.git/tuicr/s1", comment_count: 1 }]),
			"tuicr review comments --session /repo/.git/tuicr/s1": JSON.stringify(same),
		},
	};
	const { ctx, deps } = buildDeps(state);

	await review(ctx, deps);

	assert.deepEqual(state.notifies, [{ message: "No new review comments", type: "info" }]);
	assert.deepEqual(state.editorTexts, []);
});

test("review prefills only comments created during the session", async () => {
	// First allComments call (snapshot) sees the old comment; the second
	// (after tuicr ran) also sees the fresh one. Only the fresh one lands.
	let calls = 0;
	const state: FakeState = {
		notifies: [],
		editorTexts: [],
		select: async () => "Uncommitted changes",
		input: async () => undefined,
		customResult: 0,
		captureScript: {},
	};
	const { ctx, deps } = buildDeps(state);
	deps.capture = (command, args) => {
		const key = [command, ...args].join(" ");
		if (command === "git") return null; // no base branch in this fake checkout
		if (key === "tuicr review list --all") {
			calls += 1;
			return JSON.stringify([{ path: "/repo/.git/tuicr/s1", comment_count: calls === 1 ? 1 : 2 }]);
		}
		if (key === "tuicr review comments --session /repo/.git/tuicr/s1") {
			const comments =
				calls === 1
					? [{ id: "old", location: "src/a.ts:1", content: "existing" }]
					: [
							{ id: "old", location: "src/a.ts:1", content: "existing" },
							{ id: "new", path: "src/b.ts", comment_type: "bug", content: "fix this\nplease" },
						];
			return JSON.stringify(comments);
		}
		throw new Error(`unexpected exec: ${key}`);
	};

	await review(ctx, deps);

	assert.deepEqual(state.notifies, [{ message: "1 review comment ready - press enter to send", type: "info" }]);
	assert.deepEqual(state.editorTexts, [
		[
			"I reviewed your changes. Please address these comments:",
			"",
			"1. `src/b.ts` [BUG] - fix this please",
		].join("\n"),
	]);
});
