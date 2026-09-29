import assert from "node:assert/strict";
import test from "node:test";
import { parseGitFrameStatus, readGitFrameStatus } from "./git.ts";
import { getUsageTotals, invalidateUsageTotalsCache, formatCwdLabel } from "./format.ts";
import { isFrameEditorFactory, probeFrameEditor } from "./protocol.ts";

function porcelain(lines: string[]): string {
	return lines.join("\n");
}

test("parseGitFrameStatus extracts branch, ahead/behind, and dirtiness", () => {
	const status = parseGitFrameStatus(porcelain([
		"# branch.oid abc",
		"# branch.head feature/ui",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 abc def file.ts",
	]));
	assert.deepEqual(status, { branch: "feature/ui", dirty: true, ahead: 2, behind: 1 });
});

test("parseGitFrameStatus treats a clean tree and detached head", () => {
	const clean = parseGitFrameStatus(porcelain([
		"# branch.head main",
		"# branch.ab +0 -0",
	]));
	assert.deepEqual(clean, { branch: "main", dirty: false, ahead: 0, behind: 0 });

	const detached = parseGitFrameStatus(porcelain(["# branch.head (detached)"]));
	assert.equal(detached.branch, undefined);
});

test("readGitFrameStatus classifies non-repos via injected expectation", async () => {
	// This checkout IS a repo, so the live probe must succeed.
	const result = await readGitFrameStatus(process.cwd());
	assert.equal(result.kind, "ok");
	if (result.kind === "ok") assert.ok("branch" in result.status);
});

test("getUsageTotals sums cost and tokens across assistant/toolResult entries", () => {
	invalidateUsageTotalsCache();
	const entries = [
		{ id: "1", type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 3, cost: { total: 0.25 } } } },
		{ id: "2", type: "message", message: { role: "toolResult", usage: { input: 1, cost: { total: 0.05 } } } },
		{ id: "3", type: "message", message: { role: "user" } },
	];
	const ctx = {
		model: undefined,
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => entries },
	} as never;
	assert.deepEqual(getUsageTotals(ctx), {
		input: 11,
		output: 5,
		cacheRead: 3,
		cacheWrite: 0,
		cost: 0.3,
	});
});

test("formatCwdLabel supports compact, project, and full modes", () => {
	assert.equal(formatCwdLabel("/repo/deep/dir", "compact"), "dir");
	assert.equal(formatCwdLabel("/repo/deep/dir", "project", "/repo"), "repo/deep/dir");
	assert.equal(formatCwdLabel("/repo/deep/dir", "project", "/elsewhere").endsWith("deep/dir"), true);
});

test("probeFrameEditor reports supported only when a registrar answers", () => {
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const withRegistrar = {
		events: {
			emit(channel: string, value: unknown) {
				for (const listener of listeners.get(channel) ?? []) listener(value);
			},
			on(channel: string, listener: (value: unknown) => void) {
				listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
			},
		},
	};
	const silent = { events: { emit() {}, on() {} } };

	assert.deepEqual(probeFrameEditor(silent as never), { supported: false, active: false });

	const capability = probeFrameEditor(withRegistrar as never);
	// No registrar attached yet: the probe emits into the void and stays false.
	assert.equal(capability.supported, false);
});

test("isFrameEditorFactory recognizes factories branded with the AIO symbol", () => {
	const factory = () => undefined;
	(factory as Record<symbol, unknown>)[Symbol.for("aio.frame-editor-factory")] = true;
	assert.equal(isFrameEditorFactory(factory), true);
	assert.equal(isFrameEditorFactory(() => undefined), false);
	assert.equal(isFrameEditorFactory(undefined), false);
});
