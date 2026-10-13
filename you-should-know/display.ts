/**
 * you-should-know (YSK) — display surfaces.
 *
 * One visual vocabulary for every YSK output, composed from ui/chrome.ts
 * primitives so it stays cohesive with the rest of AIO:
 *
 *  - the framed transcript box (a custom session entry rendered via
 *    registerEntryRenderer — custom entries never enter LLM context), and
 *  - the status-bar pill text (ctx.ui.setStatus under the `ysk` key, rendered
 *    by status-line's `statuses` segment), plus
 *  - the critical-finding toast text (shown by index.ts via ctx.ui.notify).
 *
 * Parent-originated and subagent-surfaced findings render identically; only
 * the attribution line differs ("via subagent '<agent>'").
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	chromeFrameRow,
	chromeFrameRule,
	fitLine,
	type ChromeTheme,
} from "../ui/chrome.js";
import type { AuditUsage, Severity, YskFinding } from "./auditor.js";

/** Custom entry type rendered as the box; never sent to the model. */
export const YSK_ENTRY_TYPE = "you-should-know";

/** Status-bar key; only ever set while YSK is enabled. */
export const YSK_STATUS_KEY = "ysk";

const BOX_LABEL = "YOU SHOULD KNOW (PI EDITION)";

const SEVERITY_GLYPH: Record<Severity, string> = { critical: "✖", warning: "▲", info: "ℹ" };
const SEVERITY_TONE: Record<Severity, "error" | "warning" | "accent"> = { critical: "error", warning: "warning", info: "accent" };

function severityGlyph(severity: Severity): string {
	return SEVERITY_GLYPH[severity];
}

function severityTone(severity: Severity): "error" | "warning" | "accent" {
	return SEVERITY_TONE[severity];
}

/**
 * Adaptive view of the Pi Theme for ui/chrome.ts primitives. Chrome call
 * sites pass literal role strings the theme contract accepts; only the
 * parameter types differ (theme tokens are a closed union in the SDK).
 */
export function toChromeTheme(theme: unknown): ChromeTheme {
	const t = theme as {
		fg(role: string, text: string): string;
		bold?(text: string): string;
		bg?(role: string, text: string): string;
	};
	const bold = t.bold;
	const bg = t.bg;
	return {
		fg: (role, text) => t.fg(role, text),
		bold: bold && ((text) => bold(text)),
		bg: bg && ((role, text) => bg(role, text)),
	};
}

/** Data persisted in the `you-should-know` custom entry and rendered as the box. */
export interface YskEntryData {
	/** Sub-agent model description (e.g. "anthropic/claude-haiku-5-5"). */
	model: string;
	/** Subagent attribution ("via subagent 'scout'") when findings were surfaced
	 * from a child run; null for parent-local audits. */
	origin: string | null;
	/** Audited files (display paths). */
	files: string[];
	/** Findings shown: threshold-filtered, capped, and deduped already. */
	findings: YskFinding[];
	shown: number;
	/** Total findings the sub-agent raised before filtering. */
	raised: number;
	minSeverity: Severity;
	usage?: AuditUsage;
	latencyMs: number;
	timestamp: number;
}

/** "4.5k tok" / "200 tok" / "" when no usage was reported. */
export function formatAuditTokens(usage: AuditUsage | undefined): string {
	if (!usage) return "";
	const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	const fmt = (n: number) => (n > 0 && n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
	return `${fmt(tokens)} tok`;
}

/** Attribution + summary rows printed dim below the frame (inside the transcript entry). */
export function buildYskMetaRows(
	theme: ChromeTheme,
	data: YskEntryData,
	expanded: boolean,
	width: number,
): string[] {
	const who = [`sub-agent: ${data.model}`, data.origin ? `via ${data.origin}` : ""]
		.filter(Boolean)
		.join(" · ");
	const stats = [
		`${data.shown} shown / ${data.raised} raised`,
		`min ${data.minSeverity}`,
		formatAuditTokens(data.usage),
		`${(data.latencyMs / 1000).toFixed(1)}s`,
	]
		.filter(Boolean)
		.join(" · ");
	const rows = [`· ${who}`, `· ${stats}`];
	if (expanded && data.files.length > 1) {
		rows.push(...data.files.map((f) => `· ${f}`));
	}
	return rows.map((row) => fitLine(theme.fg("dim", row), width));
}

/**
 * Builds the framed box rows for one audit, per the agreed preview:
 *
 *   ╭─ YOU SHOULD KNOW (PI EDITION) ────────╮
 *   │ ✖ [critical] Unawaited promise        │
 *   │   detail …                            │
 *   │ ▲ [warning] Router bound twice        │
 *   ╰───────────────────────────────────────╯
 *     · sub-agent: … · 2 shown / 3 raised …
 *
 * Every row is fitted to `width` by the chrome primitives (the AGENTS.md
 * renderer contract).
 */
export function buildYskBoxRows(
	theme: ChromeTheme,
	data: YskEntryData,
	expanded: boolean,
	width: number,
): string[] {
	if (width <= 0) return [];
	const rows: string[] = [chromeFrameRule(theme, width, "top", BOX_LABEL)];

	const framing = (text: string): string => chromeFrameRow(theme, text, width);
	const innerWidth = width - 4;

	for (const [index, finding] of data.findings.entries()) {
		const tone = severityTone(finding.severity);
		const head = `${severityGlyph(finding.severity)} [${finding.severity}] ${finding.title}`;
		rows.push(framing(theme.fg(tone, head)));

		const detailWithFile = finding.file
			? `${finding.detail} — ${finding.file}`
			: finding.detail;
		for (const line of wrapTextWithAnsi(detailWithFile, Math.max(innerWidth, 1))) {
			rows.push(framing(theme.fg("text", line)));
		}

		if (index < data.findings.length - 1) {
			rows.push(framing(""));
		}
	}

	rows.push(chromeFrameRule(theme, width, "bottom"));
	rows.push(...buildYskMetaRows(theme, data, expanded, width));
	return rows;
}

/** Pi component wrapper so the box renders at whichever width the TUI asks for. */
export class YskBoxComponent implements Component {
	constructor(
		private readonly data: YskEntryData,
		private readonly expanded: boolean,
		private readonly theme: ChromeTheme,
	) {}

	render(width: number): string[] {
		return buildYskBoxRows(this.theme, this.data, this.expanded, width);
	}

	/** Rows are rebuilt from immutable entry data on every render; no cached state. */
	invalidate(): void {}
}

/**
 * Registers the entry renderer. Parent and child processes both call this so a
 * surfacing parent and the child's own retained session render identically.
 */
export function registerShouldKnowRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<YskEntryData>(YSK_ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		if (!data || data.findings.length === 0) return undefined;
		return new YskBoxComponent(data, options?.expanded ?? false, toChromeTheme(theme));
	});
}

// ============================================================
// Status pill (ctx.ui.setStatus("ysk", …); rendered by status-line)
// ============================================================

/** Single-cell glyph consistent with status-line's compact icon set. */
const STATUS_GLYPH = "◉";

/** Idle pill while enabled: "◉ YSK on · <model>". */
export function statusOnLine(model: string | undefined): string {
	return model ? `${STATUS_GLYPH} YSK on · ${model}` : `${STATUS_GLYPH} YSK on`;
}

/** In-flight pill while an audit batch runs. */
export function statusAuditingLine(files: number): string {
	const noun = files === 1 ? "file" : "files";
	return `${STATUS_GLYPH} YSK auditing (${files} ${noun})`;
}

// ============================================================
// Critical toast (index.ts fires ctx.ui.notify with this text)
// ============================================================

/**
 * Toast text for the most severe finding in an entry, or undefined when the
 * entry holds only warnings/info (the approved surface: toast only on
 * critical). The full sentence lives in the box; the toast is the headline.
 */
export function criticalToastText(data: YskEntryData): string | undefined {
	const critical = data.findings.find((f) => f.severity === "critical");
	if (!critical) return undefined;
	const place = critical.file ? ` (${critical.file})` : "";
	return `You Should Know (Pi Edition) — ✖ ${critical.title}${place}: ${critical.detail.slice(0, 200)}`;
}
