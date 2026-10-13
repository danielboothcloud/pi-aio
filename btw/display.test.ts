/**
 * btw/display.ts — regression tests.
 *
 * Every rendered surface must fit its width (ANSI-aware), cards stay within
 * their row budgets, and the toast compresses to one line. The theme is a
 * passthrough stub so width math is exact; toChromeTheme gets its own test.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	BTW_ENTRY_TYPE,
	MAX_CARD_ROWS,
	buildBtwBoxRows,
	buildBtwCardRows,
	btwToastText,
	formatBtwSeconds,
	formatBtwTokens,
	frameAskingMeta,
	registerBtwRenderer,
	statusAskingLine,
	toChromeTheme,
	type BtwEntryData,
} from "./display.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

const data: BtwEntryData = {
	question: "why is this input not aligned with the synthetic variable?",
	answer: "The synthetic variable is built from the older payload schema. Rebuild the fixture against the v3 generator to align them.",
	model: "openai/gpt-test",
	answeredMidFlow: true,
	usage: { inputTokens: 950, outputTokens: 250, costTotal: 0.001 },
	latencyMs: 3400,
	timestamp: Date.now(),
};

function assertFits(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `row wider than ${width}: ${JSON.stringify(line)}`);
	}
}

test("the transcript box fits every width and keeps its frame", () => {
	for (const width of [20, 40, 80, 120]) {
		const rows = buildBtwBoxRows(theme, data, width);
		assert.ok(rows.length > 0, `rows at ${width}`);
		assertFits(rows, width);
		assert.ok(rows[0].includes("BY THE WAY"), "boxed label");
		assert.ok(rows.some((row) => row.includes("✦")), "question marker row");
		assert.ok(rows.some((row) => row.includes("synthetic")), "answer fragments present");
		assert.ok(rows.some((row) => row.includes("╰")), "bottom rule");
		assert.ok(rows.at(-1)?.includes("· "), "meta row present");
	}
});

test("a readable-width box shows the full question, answer, and provenance", () => {
	for (const width of [80, 120]) {
		const rows = buildBtwBoxRows(theme, data, width);
		assert.ok(rows.some((row) => row.includes("✦") && row.includes("why is this input")), `question row at ${width}`);
		assert.ok(rows.some((row) => row.includes("older payload schema")), "full answer phrase");
		assert.ok(rows.some((row) => row.includes("openai/gpt-test")), "model in meta");
		assert.ok(rows.some((row) => row.includes("mid-flow")), "mid-flow marker");
		assert.ok(rows.some((row) => row.includes("1.2k tok")), "token count in meta");
		assert.ok(rows.some((row) => row.includes("3.4s")), "latency in meta");
	}
});

test("box degenerates to nothing at unusable widths", () => {
	assert.deepEqual(buildBtwBoxRows(theme, data, 4), []);
	assert.deepEqual(buildBtwBoxRows(theme, data, 0), []);
});

test("the pending card shows the question and a live asking line", () => {
	const width = 60;
	const rows = buildBtwCardRows(
		theme,
		{ phase: "pending", question: data.question, model: "openai/gpt-test", startedAt: Date.now() - 4100 },
		width,
		Date.now(),
	);
	assertFits(rows, width);
	assert.ok(rows.length <= 6, "pending card stays compact");
	assert.ok(rows.some((row) => row.includes("✦") && row.includes("why is this input")), "question row");
	assert.ok(rows.some((row) => row.includes("↯ asking gpt-test · 4s")), "asking line with elapsed seconds");
});

test("the answered card caps its rows and announces the auto-hide countdown", () => {
	const width = 60;
	const longAnswer = `${"The answer spills well past the card budget. ".repeat(12)}Final line.`;
	const dismissAt = Date.now() + 60_000;
	const rows = buildBtwCardRows(
		theme,
		{
			phase: "answered",
			question: data.question,
			answer: longAnswer,
			answeredAt: Date.now(),
			dismissAt,
		},
		width,
		Date.now(),
	);
	assertFits(rows, width);
	assert.ok(rows.length <= MAX_CARD_ROWS, `card within row budget (${rows.length} rows)`);
	assert.ok(rows.some((row) => row.includes(" …") || row.includes("+")), "overflow collapsed to a more-lines row");
	assert.ok(rows.some((row) => row.includes("auto-hides in")), "countdown hint present");
});

test("a short answered card carries the full answer", () => {
	const rows = buildBtwCardRows(
		theme,
		{
			phase: "answered",
			question: "q",
			answer: "short answer",
			answeredAt: Date.now(),
			dismissAt: Date.now() + 60_000,
		},
		40,
		Date.now(),
	);
	assertFits(rows, 40);
	assert.ok(rows.some((row) => row.includes("short answer")), "full short answer rendered");
	assert.ok(!rows.some((row) => row.includes("more lines")), "no overflow row for short answers");
});

test("the toast compresses the answer to one line", () => {
	const toast = btwToastText({
		...data,
		answer: "first line of the answer goes on a bit\nsecond line\n\nthird",
	});
	assert.equal(toast.includes("\n"), false, "toast is a single line");
	assert.ok(toast.startsWith("btw — "), "btw prefix");
	assert.ok(toast.includes("first line of the answer"), "leads with the answer");
	assert.ok(toast.length <= 160, "headline stays short");
});

test("the toast angles on empty answers never thrown", () => {
	const toast = btwToastText({ ...data, answer: "" });
	assert.equal(toast, "btw — ");
});

test("frame pill and status fallback texts", () => {
	const meta = frameAskingMeta("gpt-test");
	assert.equal(meta.icon, "↯");
	assert.equal(meta.label, "btw asking · gpt-test");
	assert.equal(meta.role, "accent");
	assert.equal(frameAskingMeta().label, "btw asking");
	assert.equal(statusAskingLine("gpt-test"), "↯ btw asking · gpt-test");
	assert.equal(statusAskingLine(), "↯ btw asking");
});

test("usage and latency formatting", () => {
	assert.equal(formatBtwTokens({ inputTokens: 950, outputTokens: 250, costTotal: 0 }), "1.2k tok");
	assert.equal(formatBtwTokens({ inputTokens: 120, outputTokens: 80, costTotal: 0 }), "200 tok");
	assert.equal(formatBtwTokens(undefined), "");
	assert.equal(formatBtwSeconds(3400), "3.4s");
	assert.equal(formatBtwSeconds(0), "0.0s");
});

test("toChromeTheme forwards fg/bold through the adapter", () => {
	const calls: Array<[string, string]> = [];
	const adapted = toChromeTheme({
		fg: (role: string, text: string) => {
			calls.push([role, text]);
			return `<${role}:${text}>`;
		},
		bold: (text: string) => `*${text}*`,
	});
	assert.equal(adapted.fg("accent", "x"), "<accent:x>");
	assert.deepEqual(calls.at(-1), ["accent", "x"]);
	assert.equal(adapted.bold?.("y"), "*y*");
	assert.equal(adapted.bg, undefined, "bg optional");
});

test("the renderer registers under the by-the-way entry type", () => {
	let registered: { type: string; renderer: unknown } | undefined;
	registerBtwRenderer({
		registerEntryRenderer: (type: string, renderer: unknown) => {
			registered = { type, renderer };
		},
	} as never);
	assert.ok(registered);
	assert.equal(registered.type, BTW_ENTRY_TYPE);

	const renderer = registered.renderer as (
		entry: { data?: BtwEntryData },
		options: Record<string, never>,
		entryTheme: unknown,
	) => { render(width: number): string[]; invalidate(): void } | undefined;
	assert.equal(renderer({ data: undefined }, {}, theme), undefined, "no data → no component");
	const component = renderer({ data }, {}, theme);
	assert.ok(component, "component for valid entry");
	assert.ok(component.render(60).length > 0, "component renders rows");
	component.invalidate();
});
