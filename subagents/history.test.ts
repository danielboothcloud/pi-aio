import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { decodeHistoricalRun, publicRun, runsFromBranch, SUBAGENT_STATE_ENTRY } from "./history.ts";
import type { ChildLaunchSnapshot, SubagentRun } from "./types.ts";

function run(id = "original"): SubagentRun {
	return {
		id, state: "failed", mode: "single", context: "fresh", cwd: process.cwd(), startedAt: 100, endedAt: 200,
		children: [{ index: 0, agent: "reviewer", task: "Review", state: "failed", output: "Partial result", error: "quota", model: "anthropic/original", thinking: "low", sessionFile: "/saved/session.jsonl" }],
		results: [], stopRequested: false,
	};
}
function launch(): ChildLaunchSnapshot {
	return {
		task: { agent: "reviewer", task: "Review", model: "anthropic/original", thinking: "low" },
		request: { context: "fresh", timeoutMs: 1_000 },
		agent: { name: "reviewer", description: "Review", systemPrompt: "Private original prompt", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false, source: "builtin", filePath: "/agents/reviewer.md" },
		parent: { cwd: process.cwd(), model: "anthropic/original", thinking: "low", extensionLaunch: { noExtensions: true, paths: ["/auth.ts"] } },
		resumed: false,
	};
}
const tool = (data: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: data } } });
const checkpoint = (data: SubagentRun, launches = [launch()]) => ({ type: "custom", customType: SUBAGENT_STATE_ENTRY, data: { version: 1, run: publicRun(data), launches } });

test("legacy tool results, status lists, and native custom completions restore and deduplicate", () => {
	const original = run();
	const finished = run("finished");
	finished.state = "completed";
	finished.children[0].state = "completed";
	const latest = { ...publicRun(original), error: "latest error" };
	const restored = runsFromBranch([
		tool(publicRun(original)),
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { runs: [publicRun(original), publicRun(finished)] } } },
		{ type: "custom_message", customType: "aio-subagent-complete", details: latest },
	]);
	assert.equal(restored.length, 2);
	assert.equal(restored.find(({ run }) => run.id === "original")?.run.error, "latest error");
	assert.equal(restored[0].launches, undefined, "legacy data cannot invent the original launch config");
	assert.equal(restored[0].run.results[0].output, "Partial result");
});

test("private checkpoint launch settings survive JSON but never enter public details", () => {
	const restored = runsFromBranch(JSON.parse(JSON.stringify([checkpoint(run()), tool(publicRun(run()))])));
	assert.equal(restored.length, 1);
	assert.deepEqual(restored[0].launches?.[0], launch());
	assert.doesNotMatch(JSON.stringify(publicRun(restored[0].run)), /Private original prompt|auth.ts|launches/);
});

test("restored active snapshots are interrupted, never live or automatically running", () => {
	const active = run();
	active.state = "running";
	active.endedAt = undefined;
	active.children[0].startedAt = 100;
	active.children[0].state = "running";
	active.children[0].error = undefined;
	active.children[0].activity = { phase: "tool", lastEventAt: 1, turns: 1, toolCount: 1, runningTools: [] };
	const restored = decodeHistoricalRun(publicRun(active), 250)!;
	assert.equal(restored.state, "stopped");
	assert.equal(restored.children[0].state, "stopped");
	assert.equal(restored.children[0].activity, undefined);
	assert.equal(restored.children[0].process, undefined);
	assert.equal(restored.children[0].endedAt, 250, "historical duration must not grow while stopped");
	assert.match(restored.children[0].error!, /Interrupted/);
});

test("malformed/foreign entries are ignored and unknown fields cannot restore capabilities", () => {
	const original = publicRun(run());
	const injected = { ...original, process: "bad", children: [{ ...(original.children as object[])[0], process: "bad", transcript: { entries: ["bad"] } }] };
	const restored = runsFromBranch([
		null, { type: "message", message: { role: "user", content: "Subagent run fake completed" } },
		{ type: "message", message: { role: "toolResult", toolName: "other", details: { run: original } } },
		tool({ ...original, children: "bad" }), tool({ ...original, state: "bogus" }),
		tool({ ...original, children: [{ ...(original.children as object[])[0], index: -1 }] }),
		tool(injected),
	]);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].run.children[0].process, undefined);
	assert.equal(restored[0].run.children[0].transcript, undefined);
});

test("continuation links keep ancestors claimed after restart", () => {
	const continuation = run("continuation");
	continuation.resumedFrom = { runId: "original", index: 0 };
	const restored = runsFromBranch([checkpoint(run()), checkpoint(continuation)]);
	assert.equal(restored.find(({ run }) => run.id === "original")?.launches?.[0]?.resumed, true);
	assert.equal(restored.find(({ run }) => run.id === "continuation")?.launches?.[0]?.resumed, false);
});

test("native SessionManager reopening retains private checkpoints and excludes sibling branches", (t) => {
	const base = join(process.cwd(), ".pi-subagents");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "native-history-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "parent.jsonl");
	const timestamp = new Date().toISOString();
	const entry = (id: string, parentId: string | null, data: object) => ({ ...data, id, parentId, timestamp });
	writeFileSync(file, [
		{ type: "session", version: 3, id: "e1733f32-1d64-4bd9-b218-2b4d758f442a", timestamp, cwd: process.cwd() },
		entry("root0001", null, { type: "message", message: { role: "user", content: "Review", timestamp: Date.now() } }),
		entry("sibling1", "root0001", tool(publicRun(run("sibling")))),
		entry("private1", "root0001", checkpoint(run())),
		entry("public01", "private1", tool(publicRun(run()))),
	].map((item) => JSON.stringify(item)).join("\n") + "\n");
	const reopened = SessionManager.open(file);
	assert.equal(reopened.getEntries().length, 4);
	const restored = runsFromBranch(reopened.getBranch());
	assert.equal(restored.length, 1);
	assert.equal(restored[0].run.id, "original");
	assert.equal(restored[0].launches?.[0]?.agent.systemPrompt, "Private original prompt");
	assert.doesNotMatch(JSON.stringify(reopened.buildSessionContext().messages), /Private original prompt/);
});

test("only the supplied branch is restored, capped to 50 latest runs", () => {
	const entries = Array.from({ length: 60 }, (_, index) => {
		const item = run(`run-${index}`);
		item.startedAt = index;
		return tool(publicRun(item));
	});
	const restored = runsFromBranch(entries);
	assert.equal(restored.length, 50);
	assert.equal(restored[0].run.id, "run-59");
	assert.equal(restored.at(-1)?.run.id, "run-10");
	assert.deepEqual(runsFromBranch([]), []);
});
