import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildZentuiQueueLines } from "./zentui-lines.ts";
import type { QueuedMessage } from "./mirror.ts";

const plainTheme = {
	fg: (_name: string, text: string) => text,
};

/** Theme that emits real ANSI sequences to exercise ANSI-aware fitting. */
const ansiTheme = {
	fg: (name: string, text: string) => {
		const code =
			name === "borderMuted" ? 90 : name === "muted" ? 90 : name === "dim" ? 2 : 0;
		return `\x1b[${code}m${text}\x1b[0m`;
	},
};

function entries(
	...specs: Array<[string, QueuedMessage["mode"]]>
): QueuedMessage[] {
	return specs.map(([text, mode]) => ({ text, mode }));
}

test("an empty queue renders nothing", () => {
	assert.deepEqual(
		buildZentuiQueueLines({ entries: [], width: 80, theme: plainTheme }),
		[],
	);
});

test("the panel renders as a minimalist attached frame", () => {
	const lines = buildZentuiQueueLines({
		entries: entries(["fix the bug", "steer"], ["run tests", "followUp"]),
		width: 80,
		theme: plainTheme,
	});
	// Top rail attaches to the editor box with a muted lowercase label.
	assert.match(lines[0] ?? "", /^├─ queue · 2 pending messages · Enter sends next ─+┤$/);
	// Content rows use the frame's bordered row idiom, numbered, mode-tagged.
	assert.match(lines[1] ?? "", /^│ 1 fix the bug\s+steer │$/);
	assert.match(lines[2] ?? "", /^│ 2 run tests\s+follow │$/);
	// A plain closing rail when nothing is hidden.
	assert.match(lines[3] ?? "", /^╰─+╯$/);
});

test("multi-line messages render as a first-line preview with an ellipsis", () => {
	const lines = buildZentuiQueueLines({
		entries: entries(["first line\nsecond line", "steer"]),
		width: 80,
		theme: plainTheme,
	});
	assert.match(lines[1] ?? "", /first line …/);
	assert.ok(!lines.some((line) => line.includes("second line")));
});

test("overflow collapses into a labeled closing rail", () => {
	const many = Array.from({ length: 8 }, (_, index) => ({
		text: `message ${index + 1}`,
		mode: "followUp" as const,
	}));
	const lines = buildZentuiQueueLines({
		entries: many,
		width: 80,
		theme: plainTheme,
		maxRows: 5,
	});
	// top rail + 5 rows + closing rail
	assert.equal(lines.length, 7);
	assert.match(lines[6] ?? "", /^╰─ \+3 more queued ─+╯$/);
});

test("every line fits the width, including with ANSI styling", () => {
	const queued = entries(
		[
			"a very long steering message that definitely needs truncation to fit",
			"steer",
		],
		["short", "followUp"],
	);
	for (const width of [6, 8, 12, 20, 37, 80]) {
		for (const theme of [plainTheme, ansiTheme]) {
			const lines = buildZentuiQueueLines({ entries: queued, width, theme });
			assert.ok(lines.length > 0);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`line exceeds width ${width}: ${JSON.stringify(line)}`,
				);
			}
		}
	}
});

test("narrow widths degrade to borderless muted lines", () => {
	const lines = buildZentuiQueueLines({
		entries: entries(["one", "steer"]),
		width: 4,
		theme: plainTheme,
	});
	assert.equal(lines.length, 2);
	assert.ok(lines[0].includes("que"));
	assert.ok(lines[1].includes("1 o"));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 4);
	}
});

test("width of zero renders nothing", () => {
	assert.deepEqual(
		buildZentuiQueueLines({
			entries: entries(["a", "steer"]),
			width: 0,
			theme: plainTheme,
		}),
		[],
	);
});
