import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildQueueLines, firstLinePreview } from "./lines.ts";
import type { QueuedMessage } from "./mirror.ts";

const plainTheme = {
	fg: (_name: string, text: string) => text,
};

/** Theme that emits real ANSI sequences to exercise ANSI-aware truncation. */
const ansiTheme = {
	fg: (name: string, text: string) => {
		const code =
			name === "accent" ? 36 : name === "muted" ? 90 : name === "dim" ? 2 : 0;
		return `[${code}m${text}[0m`;
	},
};

function entries(
	...specs: Array<[string, QueuedMessage["mode"]]>
): QueuedMessage[] {
	return specs.map(([text, mode]) => ({ text, mode }));
}

test("firstLinePreview splits on the first newline", () => {
	assert.deepEqual(firstLinePreview("single"), {
		line: "single",
		truncated: false,
	});
	assert.deepEqual(firstLinePreview("one\ntwo\nthree"), {
		line: "one",
		truncated: true,
	});
});

test("buildQueueLines returns nothing for an empty queue", () => {
	assert.deepEqual(
		buildQueueLines({ entries: [], width: 80, theme: plainTheme }),
		[],
	);
});

test("header shows the pending count and the send-next hint", () => {
	const lines = buildQueueLines({
		entries: entries(["a", "steer"], ["b", "followUp"]),
		width: 80,
		theme: plainTheme,
	});
	assert.match(lines[0] ?? "", /queue/);
	assert.match(lines[0] ?? "", /\(2\)/);
	assert.match(lines[0] ?? "", /send next/);
});

test("entries are numbered and tagged by mode", () => {
	const lines = buildQueueLines({
		entries: entries(["fix the bug", "steer"], ["run tests", "followUp"]),
		width: 80,
		theme: plainTheme,
	});
	assert.match(lines[1] ?? "", /^ 1\. \[steer\] fix the bug$/);
	assert.match(lines[2] ?? "", /^ 2\. \[follow\] run tests$/);
});

test("multi-line messages render as a first-line preview with an ellipsis", () => {
	const lines = buildQueueLines({
		entries: entries(["first line\nsecond line", "steer"]),
		width: 80,
		theme: plainTheme,
	});
	assert.match(lines[1] ?? "", /first line …$/);
	assert.ok(!lines.some((line) => line.includes("second line")));
});

test("overflow collapses into a '+N more' line", () => {
	const many = Array.from({ length: 8 }, (_, index) => ({
		text: `message ${index + 1}`,
		mode: "followUp" as const,
	}));
	const lines = buildQueueLines({
		entries: many,
		width: 80,
		theme: plainTheme,
		maxRows: 5,
	});
	// header + 5 entries + overflow line
	assert.equal(lines.length, 7);
	assert.match(lines[6] ?? "", /\+3 more/);
});

test("every line fits the width, including with ANSI styling", () => {
	const queued = entries(
		[
			"a very long steering message that definitely needs truncation to fit",
			"steer",
		],
		["short", "followUp"],
	);
	for (const width of [12, 20, 37]) {
		for (const theme of [plainTheme, ansiTheme]) {
			const lines = buildQueueLines({ entries: queued, width, theme });
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

test("width of zero renders nothing", () => {
	assert.deepEqual(
		buildQueueLines({
			entries: entries(["a", "steer"]),
			width: 0,
			theme: plainTheme,
		}),
		[],
	);
});
