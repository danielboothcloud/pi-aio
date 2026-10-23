import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SubagentInspector,
	inspectorTargets,
	renderTranscriptLines,
} from "./inspector.ts";
import { applyTranscriptEvent, createTranscript } from "./transcript.ts";
import type { ChildRunStatus, SubagentRun } from "./types.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};
const NOW = 100_000;

function child(
	index: number,
	state: ChildRunStatus["state"],
	extra: Partial<ChildRunStatus> = {},
): ChildRunStatus {
	return {
		index,
		agent: `agent-${index}`,
		task: `Task number ${index} with a fairly long description`,
		state,
		startedAt: state === "queued" ? undefined : NOW - 5_000,
		...extra,
	};
}

function run(
	id: string,
	state: SubagentRun["state"],
	children: ChildRunStatus[],
	startedAt = NOW - 10_000,
): SubagentRun {
	return {
		id,
		state,
		mode: children.length > 1 ? "parallel" : "single",
		context: "fresh",
		cwd: "/tmp",
		startedAt,
		children,
		results: [],
		stopRequested: false,
	};
}

function busyTranscript() {
	const transcript = createTranscript();
	const events: Array<Record<string, unknown>> = [
		{ type: "turn_start" },
		{ type: "message_end", message: { role: "user", content: "Task: inspect" } },
		{ type: "message_start", message: { role: "assistant" } },
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Thinking about it ".repeat(20),
			},
		},
		{
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "npm test -- --reporter dot" },
		},
		{
			type: "tool_execution_end",
			toolCallId: "t1",
			result: {
				content: [
					{
						type: "text",
						text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
					},
				],
			},
			durationMs: 1_500,
		},
	];
	for (const event of events) applyTranscriptEvent(transcript, event, NOW - 1_000);
	return transcript;
}

/** Two concurrent runs plus a finished one: parallel, single, queued, failed. */
function fixtureRuns(): SubagentRun[] {
	return [
		run("done-run-0000", "failed", [child(0, "failed", { error: "boom", endedAt: NOW - 1_000 })], NOW - 50_000),
		run(
			"para-run-1111",
			"running",
			[
				child(0, "completed", { endedAt: NOW - 2_000, output: "ok" }),
				child(1, "running", { transcript: busyTranscript() }),
				child(2, "running", { transcript: createTranscript() }),
				child(3, "queued"),
			],
			NOW - 8_000,
		),
		run("solo-run-2222", "running", [child(0, "running", { transcript: busyTranscript() })], NOW - 3_000),
	];
}

function inspector(runs: SubagentRun[], maxRows = 30) {
	let closed = 0;
	const component = new SubagentInspector({
		theme,
		getRuns: () => runs,
		getMaxRows: () => maxRows,
		requestRender: () => {},
		done: () => closed++,
		now: () => NOW,
		tickMs: 0,
	});
	return { component, closed: () => closed };
}

function assertFits(lines: string[], width: number, maxRows: number) {
	assert.ok(lines.length <= maxRows, `${lines.length} rows > ${maxRows}`);
	for (const line of lines)
		assert.ok(visibleWidth(line) <= width, `line too wide (${visibleWidth(line)} > ${width}): ${line}`);
}

test("targets cover every child of every run, active runs first", () => {
	const targets = inspectorTargets(fixtureRuns());
	assert.deepEqual(
		targets.map((target) => target.key),
		[
			"solo-run-2222:0",
			"para-run-1111:0",
			"para-run-1111:1",
			"para-run-1111:2",
			"para-run-1111:3",
			"done-run-0000:0",
		],
	);
});

test("opens the list when several children run, with the cursor on a running one", () => {
	const { component } = inspector(fixtureRuns());
	assert.equal(component.view, "list");
	assert.equal(component.selectedKey, "solo-run-2222:0");
	const lines = component.render(80);
	assertFits(lines, 80, 30);
	const text = lines.join("\n");
	assert.match(text, /SUBAGENTS · 3 runs · 6 children · 3 running/);
	assert.match(text, /para-run/);
	assert.match(text, /agent-3 · queued/);
	assert.match(text, /failed · .*boom/);
});

test("opens straight to the transcript when exactly one child is running", () => {
	const single = [run("solo-run-2222", "running", [child(0, "running", { transcript: busyTranscript() })])];
	const { component } = inspector(single);
	assert.equal(component.view, "detail");
	const text = component.render(90).join("\n");
	assert.match(text, /SUBAGENT · agent-0 · run solo-run · 1\/1/);
	assert.match(text, /✻ thinking/);
	assert.match(text, /✓ bash npm test/);
	assert.match(text, /more lines · o expands/);
	assert.match(text, /following/);
});

test("navigates list → detail, cycles all children across runs, and backs out", () => {
	const { component, closed } = inspector(fixtureRuns());
	component.handleInput("j");
	component.handleInput("\r");
	assert.equal(component.view, "detail");
	assert.equal(component.selectedKey, "para-run-1111:0");
	assert.match(component.render(80).join("\n"), /#1\/4 · 2\/6/);
	for (const expected of ["para-run-1111:1", "para-run-1111:2", "para-run-1111:3", "done-run-0000:0", "solo-run-2222:0"]) {
		component.handleInput("\t");
		assert.equal(component.selectedKey, expected);
		assertFits(component.render(80), 80, 30);
	}
	component.handleInput("[");
	assert.equal(component.selectedKey, "done-run-0000:0");
	component.handleInput("\u001b");
	assert.equal(component.view, "list");
	component.handleInput("\u001b");
	assert.equal(closed(), 1);
});

test("toggles tool expansion and thinking visibility", () => {
	const single = [run("solo-run-2222", "running", [child(0, "running", { transcript: busyTranscript() })])];
	const { component } = inspector(single, 80);
	component.handleInput("o");
	let text = component.render(100).join("\n");
	assert.match(text, /args/);
	assert.match(text, /line 19/);
	assert.doesNotMatch(text, /o expands/);
	component.handleInput("t");
	text = component.render(100).join("\n");
	assert.match(text, /thinking · \d+ chars hidden/);
});

test("scrolling up stops following; G resumes", () => {
	const single = [run("solo-run-2222", "running", [child(0, "running", { transcript: busyTranscript() })])];
	const { component } = inspector(single, 14);
	assert.match(component.render(60).join("\n"), /following/);
	component.handleInput("k");
	assert.doesNotMatch(component.render(60).join("\n"), /following/);
	component.handleInput("G");
	assert.match(component.render(60).join("\n"), /following/);
});

test("queued and pruned children explain the missing transcript", () => {
	assert.match(
		renderTranscriptLines(child(3, "queued"), 60, theme, { expandTools: false, showThinking: true, now: NOW }).join("\n"),
		/Queued/,
	);
	const pruned = renderTranscriptLines(
		child(0, "completed", { output: "final answer", sessionFile: "/x/session.jsonl" }),
		60,
		theme,
		{ expandTools: false, showThinking: true, now: NOW },
	).join("\n");
	assert.match(pruned, /not retained/);
	assert.match(pruned, /final answer/);
	assert.match(pruned, /session: \/x\/session.jsonl/);
});

test("every view stays within width and height at narrow and tiny sizes", () => {
	for (const [width, rows] of [
		[20, 5],
		[30, 9],
		[50, 12],
		[120, 40],
		[8, 3],
	] as const) {
		const { component } = inspector(fixtureRuns(), rows);
		assertFits(component.render(width), width, rows);
		component.handleInput("\r");
		component.handleInput("o");
		assertFits(component.render(width), width, rows);
	}
});

test("an emptied registry renders a placeholder and stays usable", () => {
	const runs = fixtureRuns();
	const { component } = inspector(runs);
	runs.length = 0;
	const text = component.render(60).join("\n");
	assert.match(text, /No subagent runs/);
	component.handleInput("\r");
	assert.equal(component.view, "list");
});

test("model and effort have a dedicated header, independent of long failure errors", () => {
	const failed = child(0, "failed", { model: "anthropic/claude-example", thinking: "high", error: "429 ".repeat(200) });
	const { component } = inspector([run("failed-run", "failed", [failed])]);
	const lines = component.render(90);
	assert.match(lines[2], /MODEL · anthropic\/claude-example/);
	assert.match(lines[2], /\[effort high\]/);
	assert.doesNotMatch(lines[2], /429/);
	for (const width of [8, 20, 30, 50, 90]) assertFits(component.render(width), width, 30);
	failed.model = "provider/" + "long-model-".repeat(30);
	assert.match(component.render(50)[2], /\[effort high\]/);
});

test("r resumes selected failed/stopped children from either view and follows the continuation", () => {
	const runs = [run("failed-run", "failed", [child(0, "failed"), child(1, "stopped"), child(2, "completed")])];
	const requests: string[] = [];
	const component = new SubagentInspector({
		theme, getRuns: () => runs, getMaxRows: () => 30, requestRender() {}, done() {}, tickMs: 0,
		resumeChild: (target) => requests.push(target.key),
	});
	assert.match(component.render(90).join("\n"), /r resume saved session/);
	component.handleInput("r");
	component.handleInput("j");
	component.handleInput("\r");
	component.handleInput("r");
	component.handleInput("\t");
	component.handleInput("r");
	assert.deepEqual(requests, ["failed-run:0", "failed-run:1"]);
	assert.doesNotMatch(component.render(90).join("\n"), /r resume saved session/);
	const continuation = run("resumed-run", "running", [child(0, "running")]);
	runs.push(continuation);
	component.inspectRun(continuation);
	assert.equal(component.selectedKey, "resumed-run:0");
	assert.equal(component.view, "detail");
	component.handleInput("r");
	assert.equal(requests.length, 2);
	component.close();
	component.handleInput("r");
	assert.equal(requests.length, 2);
});

test("unavailable recovery explains why instead of advertising an actionable resume", () => {
	const component = new SubagentInspector({
		theme, getRuns: () => [run("failed", "failed", [child(0, "failed")])],
		getMaxRows: () => 20, requestRender() {}, done() {}, tickMs: 0,
		resumeChild() {}, resumeUnavailable: () => "No saved child session is available to resume.",
	});
	const text = component.render(100).join("\n");
	assert.match(text, /resume unavailable: No saved child session/);
	assert.doesNotMatch(text, /r resume saved session/);
});
