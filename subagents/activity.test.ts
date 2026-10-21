import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ACTIVITY_STALE_MS,
	applyActivityEvent,
	createActivity,
	formatChildActivity,
	formatDuration,
	formatRunProgress,
	summarizeToolArgs,
} from "./activity.ts";
import { buildSubagentWidgetLines } from "./index.ts";
import type { ChildActivity, ChildRunStatus, SubagentRun } from "./types.ts";

const T0 = 1_000_000;

function runningChild(activity: ChildActivity, overrides: Partial<ChildRunStatus> = {}): ChildRunStatus {
	return {
		index: 0,
		agent: "worker",
		task: "do it",
		state: "running",
		startedAt: T0,
		attempts: 1,
		activity,
		...overrides,
	};
}

function feed(activity: ChildActivity, events: Array<[number, Record<string, unknown>]>): boolean[] {
	return events.map(([at, event]) => applyActivityEvent(activity, event, at));
}

test("formatDuration renders seconds, minutes, and hours compactly", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(61_000), "1m01s");
	assert.equal(formatDuration(3_725_000), "1h02m");
});

test("summarizeToolArgs picks the meaningful argument and clips it", () => {
	assert.equal(summarizeToolArgs("bash", { command: "npm\n  test --run" }), "npm test --run");
	assert.equal(summarizeToolArgs("read", { path: "src/a.ts", offset: 3 }), "src/a.ts");
	assert.equal(summarizeToolArgs("todo", { action: "toggle", step: 2 }), "toggle");
	const long = summarizeToolArgs("bash", { command: "x".repeat(200) });
	assert.equal(long.length, 60);
	assert.ok(long.endsWith("…"));
	assert.equal(summarizeToolArgs("custom", { flag: true, note: "hi" }), "hi");
	assert.equal(summarizeToolArgs("custom", undefined), "");
});

test("activity follows turns, streaming, and tool execution", () => {
	const activity = createActivity(T0);
	const significant = feed(activity, [
		[T0 + 1_000, { type: "turn_start" }],
		[T0 + 2_000, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }],
		[T0 + 2_100, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }],
		[T0 + 3_000, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }],
	]);
	// Repeated deltas in the same phase are not significant (callers throttle).
	assert.deepEqual(significant, [true, true, false, true]);
	assert.equal(activity.turns, 1);
	assert.equal(activity.toolCount, 1);
	const line = formatChildActivity(runningChild(activity), T0 + 43_000);
	assert.equal(line.text, "running 43s · bash: npm test (40s) · 1 tool");
	assert.equal(line.stale, false);

	feed(activity, [
		[T0 + 44_000, { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "a.ts" } }],
	]);
	assert.match(formatChildActivity(runningChild(activity), T0 + 45_000).text, /read: a\.ts \(1s\) \+1 more · 2 tools/);

	feed(activity, [
		[T0 + 46_000, { type: "tool_execution_end", toolCallId: "b" }],
		[T0 + 47_000, { type: "tool_execution_end", toolCallId: "a" }],
	]);
	assert.equal(activity.phase, "waiting");
	assert.equal(activity.runningTools.length, 0);
	assert.match(formatChildActivity(runningChild(activity), T0 + 48_000).text, /waiting for model/);
});

test("provider retries and compaction are visible", () => {
	const activity = createActivity(T0);
	feed(activity, [
		[T0 + 1_000, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "529 overloaded" }],
	]);
	assert.match(
		formatChildActivity(runningChild(activity), T0 + 2_000).text,
		/provider retry 2\/3: 529 overloaded/,
	);
	feed(activity, [[T0 + 3_000, { type: "auto_retry_end", success: true }]]);
	assert.equal(activity.retry, undefined);
	feed(activity, [[T0 + 4_000, { type: "compaction_start", reason: "threshold" }]]);
	assert.match(formatChildActivity(runningChild(activity), T0 + 5_000).text, /compacting context/);
});

test("a settled child reads as finishing, and later events cannot reopen it", () => {
	const activity = createActivity(T0);
	feed(activity, [
		[T0 + 1_000, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls" } }],
		[T0 + 2_000, { type: "agent_settled", aborted: false }],
		[T0 + 2_500, { type: "message_update", assistantMessageEvent: { type: "text_delta" } }],
	]);
	assert.equal(activity.phase, "finishing");
	assert.equal(activity.runningTools.length, 0);
	assert.match(
		formatChildActivity(runningChild(activity), T0 + 9_000).text,
		/finished · waiting for exit \(7s\)/,
	);
});

test("quiet streams show a hint, then a stall warning; long tools are not stalls", () => {
	const activity = createActivity(T0);
	feed(activity, [[T0, { type: "turn_start" }]]);
	const quiet = formatChildActivity(runningChild(activity), T0 + 10_000);
	assert.match(quiet.text, /last event 10s ago/);
	assert.equal(quiet.stale, false);

	const stalled = formatChildActivity(runningChild(activity), T0 + ACTIVITY_STALE_MS + 60_000);
	assert.equal(stalled.stale, true);
	assert.match(stalled.text, /no events for 3m00s \(possible stall\)/);

	feed(activity, [[T0, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm run build" } }]]);
	const longTool = formatChildActivity(runningChild(activity), T0 + 10 * 60_000);
	assert.equal(longTool.stale, false);
	assert.match(longTool.text, /bash: npm run build \(10m00s\)/);
});

test("retries and non-running states are reflected", () => {
	const activity = createActivity(T0);
	assert.match(formatChildActivity(runningChild(activity, { attempts: 2 }), T0).text, /attempt 2/);
	assert.equal(formatChildActivity(runningChild(activity, { state: "completed" }), T0).text, "completed");
});

function run(id: string, children: ChildRunStatus[]): SubagentRun {
	return {
		id,
		state: "running",
		mode: children.length === 1 ? "single" : "parallel",
		context: "fresh",
		cwd: "/work",
		startedAt: T0,
		children,
		results: [],
		stopRequested: false,
	};
}

test("progress text lists every child with its activity", () => {
	const activity = createActivity(T0);
	feed(activity, [[T0 + 1_000, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }]]);
	const text = formatRunProgress(run("41dd969b-4044", [runningChild(activity)]), T0 + 5_000);
	assert.equal(text, "Subagent run 41dd969b running\n· worker · running 5s · bash: npm test (4s) · 1 tool");
});

test("widget rows carry live activity, warn on stalls, and stay width-safe", () => {
	const tones: string[] = [];
	const theme = {
		fg: (role: string, text: string) => {
			tones.push(role);
			return text;
		},
		bold: (text: string) => text,
	};
	const stalled = createActivity(T0);
	feed(stalled, [[T0, { type: "turn_start" }]]);
	const busy = createActivity(T0);
	feed(busy, [[T0, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }]]);
	const now = T0 + ACTIVITY_STALE_MS + 1_000;

	const single = buildSubagentWidgetLines([run("aaaaaaaa-1", [runningChild(stalled)])], 120, theme, 4, now);
	assert.match(single[1] ?? "", /aaaaaaaa worker · running 2m01s · waiting for model · no events for 2m01s/);
	assert.ok(tones.includes("warning"), "a stalled child renders with the warning tone");

	const parallel = run(
		"bbbbbbbb-2",
		Array.from({ length: 5 }, (_, index) => runningChild(busy, { index, agent: `w${index}` })),
	);
	const lines = buildSubagentWidgetLines([parallel], 120, theme, 4, now);
	assert.match(lines[1] ?? "", /bbbbbbbb · 0\/5 done/);
	assert.match(lines[2] ?? "", /↳ w0 · running 2m01s · bash: npm test/);
	assert.match(lines.at(-1) ?? "", /\+2 more running/);
	assert.equal(lines.length, 1 + 1 + 3 + 1);

	for (const width of [12, 28, 60]) {
		for (const line of buildSubagentWidgetLines([parallel, run("cccccccc-3", [runningChild(busy)])], width, theme, 4, now)) {
			assert.ok(visibleWidth(line) <= width, `line fits ${width}: ${line}`);
		}
	}
});
