// Regression tests for the tuicr target picker: label → tuicr-args
// translation, base-branch entries, and the input follow-ups. ui is faked;
// exec goes through an injected Capture seam.

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickTarget } from "./picker.js";
import type { Capture } from "./core.js";

const CWD = "/tmp/aio-tuicr-picker-test";

interface FakeUi {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
}

function fakeCtx(ui: FakeUi): ExtensionContext {
	return { cwd: CWD, ui } as unknown as ExtensionContext;
}

function baseCapture(): Capture {
	return (_command, args) => {
		const key = args.join(" ");
		if (key === "symbolic-ref --short refs/remotes/origin/HEAD") return "origin/main";
		if (key === "rev-parse --abbrev-ref HEAD") return "feature/x";
		if (key === "rev-parse --verify --quiet origin/main") return "abc123";
		throw new Error(`unexpected git: ${key}`);
	};
}

function noBaseCapture(): Capture {
	return (_command, args) => {
		const key = args.join(" ");
		if (key === "symbolic-ref --short refs/remotes/origin/HEAD") return null;
		if (key === "rev-parse --abbrev-ref HEAD") return "feature/x";
		if (key.startsWith("rev-parse --verify --quiet")) return null;
		throw new Error(`unexpected git: ${key}`);
	};
}

test("picker offers upstream's choice list", async () => {
	const offered: string[] = [];
	const ctx = fakeCtx({
		select: async (_title, options) => {
			offered.push(...options);
			return undefined;
		},
		input: async () => undefined,
	});
	assert.equal(await pickTarget(ctx, baseCapture()), null);
	assert.deepEqual(offered, [
		"Uncommitted changes",
		"Branch vs origin/main (+ uncommitted)",
		"Branch vs origin/main",
		"Last commit",
		"Pick commits",
		"Every tracked file",
		"Custom revset...",
		"Pull request...",
	]);
});

test("picker maps every choice to its tuicr invocation", async () => {
	for (const [label, expected] of [
		["Uncommitted changes", ["-w"]],
		["Branch vs origin/main (+ uncommitted)", ["-r", "origin/main..HEAD", "-w"]],
		["Branch vs origin/main", ["-r", "origin/main..HEAD"]],
		["Last commit", ["-r", "HEAD~1..HEAD"]],
		["Pick commits", []],
		["Every tracked file", ["-A"]],
	] as const) {
		const ctx = fakeCtx({
			select: async () => label,
			input: async () => undefined,
		});
		assert.deepEqual(await pickTarget(ctx, baseCapture()), expected, label);
	}
});

test("picker hides base-branch entries when no base branch verifies", async () => {
	const ctx = fakeCtx({
		select: async (_title, options) => {
			assert.ok(!options.some((option) => option.includes("Branch vs")));
			return "Every tracked file";
		},
		input: async () => undefined,
	});
	assert.deepEqual(await pickTarget(ctx, noBaseCapture()), ["-A"]);
});

test("picker asks for a revset and trims it", async () => {
	const ctx = fakeCtx({
		select: async () => "Custom revset...",
		input: async (title, hint) => {
			assert.equal(title, "Revset:");
			assert.equal(hint, "e.g. HEAD~3..HEAD");
			return "  HEAD~3..HEAD  ";
		},
	});
	assert.deepEqual(await pickTarget(ctx, baseCapture()), ["-r", "HEAD~3..HEAD"]);
});

test("picker asks for the PR target", async () => {
	const ctx = fakeCtx({
		select: async () => "Pull request...",
		input: async (title, hint) => {
			assert.equal(title, "PR:");
			assert.equal(hint, "number, owner/repo#N, or URL");
			return "42";
		},
	});
	assert.deepEqual(await pickTarget(ctx, baseCapture()), ["pr", "42"]);
});

test("picker returns null on an empty follow-up answer and on cancel", async () => {
	const cancelled = fakeCtx({ select: async () => undefined, input: async () => undefined });
	assert.equal(await pickTarget(cancelled, baseCapture()), null);

	const blankRevset = fakeCtx({ select: async () => "Custom revset...", input: async () => "   " });
	assert.equal(await pickTarget(blankRevset, baseCapture()), null);
});
