import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_FRAME_STYLE,
	renderMinimalistFrame,
	renderFramedPanelRows,
	type FrameMetadata,
} from "./render.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const metadata: FrameMetadata = {
	cwd: "/repo",
	branch: "main",
	costLabel: "$0.100",
	modelLabel: "test-model",
	thinkingLevel: "high",
	contextPercent: 42,
	sessionName: "session",
};

function frame(lines: string[], overrides: Partial<FrameMetadata> = {}, width = 60) {
	return renderMinimalistFrame({
		width,
		editorLines: lines,
		inputText: "",
		metadata: { ...metadata, ...overrides },
		uiTheme: theme,
		style: DEFAULT_FRAME_STYLE,
	});
}

test("the frame wraps editor content with labeled borders", () => {
	const lines = frame(["hello", "world"]);
	assert.equal(lines.length, 4);
	// Top-left: effort · context. Top-right: cost · model.
	// Bottom-left: branch · session name; bottom-right: cwd.
	assert.match(lines[0]!, /^╭─ high · 42% ─/);
	assert.match(lines[0]!, /\$0\.100 – test-model ─╮$/);
	assert.doesNotMatch(lines[0]!, /session/);
	assert.match(lines[1]!, /^│ hello\s+│$/);
	assert.match(lines[2]!, /^│ world\s+│$/);
	assert.match(lines[3]!, /^╰─ main · session ─/);
	assert.match(lines[3]!, /repo ─╯$/);
});

test("effort renders directly to the right of the mode, left of the fill", () => {
	const lines = renderMinimalistFrame({
		width: 90,
		editorLines: ["x"],
		inputText: "",
		metadata: {
			...metadata,
			mode: { icon: "▶", label: "Auto", role: "accent" },
			thinkingLevel: "max",
		},
		uiTheme: theme,
		style: DEFAULT_FRAME_STYLE,
	});
	assert.match(lines[0]!, /^╭─ ▶ Auto · max · 42% ─/, "mode · effort · context, top-left");
	// The right side must no longer carry the effort level or context.
	assert.doesNotMatch(lines[0]!, /test-model – max/);
	assert.doesNotMatch(lines[0]!, /– 42% – /);
});

test("panel rows render between content and the bottom border", () => {
	const lines = renderMinimalistFrame({
		width: 60,
		editorLines: ["input"],
		panelLines: ["queue · 1 pending message · Enter sends next", "1 hello … · steer"],
		inputText: "",
		metadata,
		uiTheme: theme,
		style: DEFAULT_FRAME_STYLE,
	});
	// top + content + divider + 2 rows + bottom
	assert.equal(lines.length, 6);
	assert.match(lines[2]!, /^├─+┤$/);
	assert.match(lines[3]!, /^│ queue · 1 pending message · Enter sends next\s+│$/);
	assert.match(lines[4]!, /^│ 1 hello … · steer\s+│$/);
	assert.match(lines[5]!, /^╰/);
});

test("renderFramedPanelRows degrades to plain lines when too narrow", () => {
	const lines = renderFramedPanelRows({
		width: 3,
		lines: ["abc"],
		renderBorder: (text) => text,
	});
	assert.deepEqual(lines, ["abc"]);
});

test("labels truncate instead of overflowing the width", () => {
	const lines = frame(["x"], { sessionName: "a-very-long-session-name-that-keeps-going" }, 40);
	for (const line of lines) {
		assert.ok(
			line.replace(/\x1b\[[0-9;]*m/g, "").length <= 40,
			`line too wide: ${line}`,
		);
	}
});

test("git metadata renders ahead/behind arrows and dirty marker", () => {
	const lines = frame(["x"], { ahead: 2, behind: 1, dirty: true });
	assert.match(lines.at(-1)!, /main \* ↑2 ↓1/);
});

test("thinking level off and missing cost/model are omitted", () => {
	const lines = frame(["x"], { thinkingLevel: "off", costLabel: undefined, modelLabel: undefined });
	assert.doesNotMatch(lines[0]!, /off/);
	assert.doesNotMatch(lines[0]!, /no-model/);
});

test("context percent is tier-colored: green < 50, yellow 50-74, red >= 75", () => {
	const seen: string[] = [];
	const capturingTheme = {
		fg: (name: string, text: string) => {
			seen.push(name);
			return text;
		},
		bold: (text: string) => text,
	};
	const render = (percent: number) =>
		renderMinimalistFrame({
			width: 60,
			editorLines: ["x"],
			inputText: "",
			metadata: { ...metadata, contextPercent: percent },
			uiTheme: capturingTheme,
			style: DEFAULT_FRAME_STYLE,
		})[0] ?? "";

	seen.length = 0;
	assert.match(render(40), /40%/);
	assert.ok(seen.includes("success"), `green below 50, saw: ${seen.join(",")}`);

	seen.length = 0;
	assert.match(render(60), /60%/);
	assert.ok(seen.includes("warning"), `yellow at 50-74, saw: ${seen.join(",")}`);

	seen.length = 0;
	assert.match(render(80), /80%/);
	assert.ok(seen.includes("error"), `red at >= 75, saw: ${seen.join(",")}`);
});

test("effort level is tinted with its native thinking role", () => {
	const seen: string[] = [];
	const capturingTheme = {
		fg: (name: string, text: string) => {
			seen.push(name);
			return text;
		},
		bold: (text: string) => text,
	};
	const render = (thinkingLevel: string) =>
		renderMinimalistFrame({
			width: 60,
			editorLines: ["x"],
			inputText: "",
			metadata: { ...metadata, thinkingLevel },
			uiTheme: capturingTheme,
			style: DEFAULT_FRAME_STYLE,
		})[0] ?? "";

	seen.length = 0;
	assert.match(render("max"), /max/);
	assert.ok(seen.includes("thinkingMax"), `max → thinkingMax, saw: ${seen.join(",")}`);

	seen.length = 0;
	assert.match(render("low"), /low/);
	assert.ok(seen.includes("thinkingLow"), `low → thinkingLow, saw: ${seen.join(",")}`);

	// Unknown levels fall back to the generic thinking color.
	seen.length = 0;
	assert.match(render("turbo"), /turbo/);
	assert.ok(seen.includes("warning"), `unknown → warning, saw: ${seen.join(",")}`);
});
