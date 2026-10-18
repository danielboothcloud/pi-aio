/**
 * you-should-know/display.ts — box/status/toast surface tests.
 *
 * The AGENTS.md renderer contract: every rendered line fits its supplied
 * width. All assertions run against plain themes (passthrough for width math,
 * role-recording for tone checks) — no TUI required.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	buildYskBoxRows,
	buildYskCardRows,
	buildYskMetaRows,
	criticalToastText,
	formatAuditTokens,
	MAX_CARD_ROWS,
	registerShouldKnowRenderer,
	statusAuditingLine,
	statusOnLine,
	toChromeTheme,
	type YskEntryData,
	YSK_CARD_KEY,
	YSK_ENTRY_TYPE,
	YskBoxComponent,
} from "./display.ts";
import type { ChromeTheme } from "../ui/chrome.ts";
import type { YskFinding } from "./auditor.ts";

/** Passthrough theme — styling becomes identity so width math is exact. */
const plainTheme: ChromeTheme = {
	fg: (_role, text) => text,
	bold: (text) => text,
	bg: (_role, text) => text,
};

/** Recording theme — wraps text in `<role>` tags to assert tone mapping. */
function recordingTheme(): { theme: ChromeTheme; roles: string[] } {
	const roles: string[] = [];
	return {
		theme: {
			fg: (role, text) => {
				roles.push(role);
				return `<${role}>${text}`;
			},
			bold: (text) => `<b>${text}</b>`,
			bg: (role, text) => `<${role}bg>${text}`,
		},
		roles,
	};
}

const FINDINGS: YskFinding[] = [
	{ severity: "critical", title: "Unawaited promise discarded", detail: "Errors pass silently.", file: "src/app.ts" },
	{ severity: "warning", title: "Router bound twice", detail: "Double binding can duplicate handlers." },
];

const ENTRY: YskEntryData = {
	model: "anthropic/claude-haiku-5-5",
	origin: "subagent 'scout'",
	files: ["src/app.ts", "src/router.ts"],
	findings: FINDINGS,
	shown: 2,
	raised: 3,
	minSeverity: "warning",
	usage: { inputTokens: 4100, outputTokens: 420, costTotal: 0.003 },
	latencyMs: 1200,
	timestamp: Date.now(),
};

// =====================================================================
// Box rendering
// =====================================================================

test("box rows match the btw frame shape and labels", () => {
	const rows = buildYskBoxRows(plainTheme, ENTRY, false, 80);
	assert.ok(rows.length > 0);
	assert.match(rows[0], /^╭─ YOU SHOULD KNOW ─*/);
	assert.ok(rows[0].endsWith("╮"));
	assert.ok(!rows[0].includes("PI EDITION"), "old label suffix retired");
	const bottom = rows.find((r) => r.startsWith("╰"));
	assert.ok(bottom, "bottom rail present");
	assert.ok(bottom!.endsWith("╯"));
	assert.ok(rows.some((r) => r.includes("✖ Unawaited promise discarded")));
	assert.ok(rows.some((r) => r.includes("▲ Router bound twice")));
	assert.ok(rows.some((r) => r.includes("Errors pass silently. — src/app.ts")));
	assert.ok(!rows.some((r) => r.includes("[critical]")), "severity tags dropped — glyphs carry them");
});
test("meta rows attribute the sub-agent and carry the audit stats", () => {
	const rows = buildYskMetaRows(plainTheme, ENTRY, false, 140);
	assert.ok(rows.some((r) => r.includes("sub-agent anthropic/claude-haiku-5-5")));
	assert.ok(rows.some((r) => r.includes("via subagent 'scout'")));
	assert.ok(rows.some((r) => r.includes("2 shown / 3 raised")));
	assert.ok(rows.some((r) => r.includes("4.5k tok")));
	assert.ok(rows.some((r) => r.includes("min warning")));
	assert.ok(rows.some((r) => r.includes("1.2s")));

	const collapsed = buildYskMetaRows(plainTheme, ENTRY, false, 140).join("\n");
	assert.ok(!collapsed.includes("src/router.ts"), "collapsed view hides the file list");

	const expanded = buildYskMetaRows(plainTheme, ENTRY, true, 140).join("\n");
	assert.ok(expanded.includes("src/router.ts"), "expanded view lists files");
	const local = buildYskMetaRows(plainTheme, { ...ENTRY, origin: null }, false, 140).join("\n");
	assert.ok(!local.includes("via "), "parent-local audits carry no origin");
});

test("every box row fits its supplied width at 80/60/40/20 (renderer contract)", () => {
	for (const width of [80, 60, 40, 20]) {
		const rows = buildYskBoxRows(plainTheme, ENTRY, true, width);
		assert.ok(rows.length > 0, `rows exist at width ${width}`);
		for (const row of rows) {
			assert.ok(
				visibleWidth(row) <= width,
				`row overflow at width ${width}: "${row}" (${visibleWidth(row)})`,
			);
		}
	}
	assert.deepEqual(buildYskBoxRows(plainTheme, ENTRY, false, 0), []);
});

test("long finding details wrap inside the frame instead of truncating", () => {
	const long: YskEntryData = {
		...ENTRY,
		findings: [
			{
				severity: "critical",
				title: "Massive regression in the router setup",
				detail:
					"The registration path now re-creates middleware stacks on every request even when no new handlers were added. " +
					"This doubles latency under load and silently strips the auth middleware, a combination that only shows up " +
					"once concurrent traffic reaches the pool limit where the old stack was queued for teardown.",
				file: "src/router.ts",
			},
		],
	};
	const rows = buildYskBoxRows(plainTheme, long, false, 60);
	for (const row of rows) {
		assert.ok(visibleWidth(row) <= 60, `wrapped rows fit: "${row.slice(0, 40)}…"`);
	}
	// The full sentence survives wrapping across multiple framed rows.
	const joined = rows.join("\n");
	assert.ok(joined.includes("doubles latency under load"));
	assert.ok(joined.includes("queued for teardown"));
});

test("severity tones route through theme roles (error/warning + dim meta)", () => {
	const { theme, roles } = recordingTheme();
	buildYskBoxRows(theme, ENTRY, false, 80);
	assert.ok(roles.includes("error"), "critical finding uses the error role");
	assert.ok(roles.includes("warning"), "warning finding uses the warning role");
	assert.ok(roles.includes("dim"), "meta rows are dim");
	assert.ok(roles.includes("borderMuted"), "rails use the border role");
});

// =====================================================================
// Component + renderer registration
// =====================================================================


test("the findings card renders head rows and a countdown hint", () => {
	const dismissAt = Date.now() + 30_000;
	const rows = buildYskCardRows(plainTheme, ENTRY, 60, dismissAt, Date.now());
	assert.ok(rows[0].includes("YOU SHOULD KNOW"), "card label");
	assert.ok(rows.some((r) => r.includes("✖ Unawaited promise discarded")), "critical head row");
	assert.ok(rows.some((r) => r.includes("▲ Router bound twice")), "warning head row");
	assert.ok(rows.some((r) => r.includes("auto-hides in 30s")), "countdown hint");
	assert.ok(rows.some((r) => r.includes("full findings in the transcript")), "transcript pointer");
	assert.ok(rows.some((r) => r.startsWith("╰")), "bottom rail present");
});

test("the card caps its findings and points surplus rows at the transcript", () => {
	const many: YskEntryData = {
		...ENTRY,
		findings: Array.from({ length: 7 }, (_, index) => ({
			severity: "warning",
			title: `Overage ${index + 1}`,
			detail: "d",
		})),
	};
	const rows = buildYskCardRows(plainTheme, many, 60, Date.now() + 30_000, Date.now());
	assert.ok(rows.length <= MAX_CARD_ROWS, `card within row budget (${rows.length})`);
	assert.ok(rows.some((r) => r.includes("Overage 4")), "shows up to four findings");
	assert.ok(!rows.some((r) => r.includes("Overage 5")), "fifth finding not rendered");
	assert.ok(rows.some((r) => r.includes("…+3 more")), "overflow collapsed with a count");
});

test("the card fits narrow widths and drops to nothing without findings", () => {
	for (const width of [80, 60, 40, 20]) {
		const rows = buildYskCardRows(plainTheme, ENTRY, width, Date.now() + 30_000, Date.now());
		assert.ok(rows.length > 0, `rows at width ${width}`);
		for (const row of rows) {
			assert.ok(visibleWidth(row) <= width, `row overflow at width ${width}: "${row}"`);
		}
	}
	assert.deepEqual(buildYskCardRows(plainTheme, { ...ENTRY, findings: [] }, 80, Date.now()), []);
	assert.deepEqual(buildYskCardRows(plainTheme, ENTRY, 0, Date.now() + 30_000, Date.now()), []);
});

test("YskBoxComponent renders identical rows for a width", () => {
	const component = new YskBoxComponent(ENTRY, false, plainTheme);
	assert.deepEqual(component.render(72), buildYskBoxRows(plainTheme, ENTRY, false, 72));
});

test("registerShouldKnowRenderer wires the entry type and guards empty data", () => {
	type EntryRendererFn = (
		entry: { data?: YskEntryData },
		options: { expanded: boolean },
		theme: unknown,
	) => unknown;
	const renderers = new Map<string, EntryRendererFn>();
	const pi = {
		registerEntryRenderer: (type: string, renderer: EntryRendererFn) => {
			renderers.set(type, renderer);
		},
	} as Parameters<typeof registerShouldKnowRenderer>[0];

	registerShouldKnowRenderer(pi);
	assert.ok(renderers.has(YSK_ENTRY_TYPE));

	const renderer = renderers.get(YSK_ENTRY_TYPE)!;
	assert.equal(renderer({ data: undefined }, { expanded: false }, plainTheme), undefined);
	assert.equal(
		renderer({ data: { ...ENTRY, findings: [] } }, { expanded: false }, plainTheme),
		undefined,
		"empty-finding entries render nothing",
	);

	const component = renderer({ data: ENTRY }, { expanded: false }, plainTheme) as YskBoxComponent;
	const rows = component.render(80);
	assert.ok(rows.length > 0);
	for (const row of rows) {
		assert.ok(visibleWidth(row) <= 80);
	}
});

// =====================================================================
// Pill + toast + token formatting
// =====================================================================

test("status pill text is compact and model-aware", () => {
	assert.equal(statusOnLine("openai/gpt-6.1-sol"), "◉ YSK on · openai/gpt-6.1-sol");
	assert.equal(statusOnLine(undefined), "◉ YSK on");
	assert.equal(statusAuditingLine(1), "◉ YSK auditing (1 file)");
	assert.equal(statusAuditingLine(3), "◉ YSK auditing (3 files)");
});

test("formatAuditTokens summarizes usage compactly", () => {
	assert.equal(formatAuditTokens({ inputTokens: 4100, outputTokens: 420, costTotal: 0.003 }), "4.5k tok");
	assert.equal(formatAuditTokens({ inputTokens: 150, outputTokens: 50, costTotal: 0 }), "200 tok");
	assert.equal(formatAuditTokens(undefined), "");
});

test("criticalToastText fires only for critical findings", () => {
	const toast = criticalToastText(ENTRY);
	assert.ok(toast);
	assert.ok(toast!.startsWith("You Should Know (Pi Edition) — ✖ Unawaited promise discarded (src/app.ts):"));

	const warningOnly = criticalToastText({ ...ENTRY, findings: [FINDINGS[1]] });
	assert.equal(warningOnly, undefined);
});

test("toChromeTheme forwards fg/bold/bg through the adapter", () => {
	const calls: string[] = [];
	const theme = toChromeTheme({
		fg: (role, text) => {
			calls.push(role);
			return text;
		},
		bold: (text) => text.toUpperCase(),
		bg: () => "",
	});
	assert.equal(theme.fg("dim", "x"), "x");
	assert.equal(theme.bold!("x"), "X");
	assert.equal(theme.bg!("dim", "x"), "");
	assert.deepEqual(calls, ["dim"]);
});
