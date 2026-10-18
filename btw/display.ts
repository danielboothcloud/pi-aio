/**
 * btw — display surfaces.
 *
 * One visual vocabulary for every /btw output, composed from ui/chrome.ts
 * primitives so the side channel matches the AIO chrome (the
 * you-should-know display pattern):
 *
 *  - the framed transcript box (a custom session entry rendered via
 *    registerEntryRenderer — custom entries never enter LLM context),
 *  - the above-editor card widget (pending → answered; answered cards
 *    auto-hide; index.ts owns the timers),
 *  - the one-line arrival toast (index.ts fires ctx.ui.notify),
 *  - the frame-border asking pill + its footer-status fallback text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	chromeFrameRow,
	chromeFrameRule,
	fitLine,
	type ChromeTheme,
} from "../ui/chrome.js";
import type { BtwUsage } from "./engine.js";

/** Custom entry type rendered as the box; never sent to the model. */
export const BTW_ENTRY_TYPE = "by-the-way";

/** Above-editor widget key (ctx.ui.setWidget) — pending + answered cards. */
export const BTW_WIDGET_KEY = "aio-btw";

/** Footer status key (ctx.ui.setStatus) while no frame owns the surface. */
export const BTW_STATUS_KEY = "btw";

/** Frame metadata contributor key while the minimalist frame renders. */
export const BTW_FRAME_KEY = "btw";

/** FrameMetadata["btw"]: transient pill while a side question is in flight. */
export interface BtwFrameMeta {
	icon: string;
	label: string;
	role: string;
}

const BOX_LABEL = "BY THE WAY";
const GLYPH_QUESTION = "✦";
const GLYPH_ASKING = "↯";

/** Answer rows shown inside the card (incl. the "+N more lines" row, if any). */
export const MAX_CARD_ANSWER_ROWS = 4;
/** Ceiling for every card render (top/bottom rules and hint row included). */
export const MAX_CARD_ROWS = 9;

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

/** Data persisted in the `by-the-way` custom entry and rendered as the box. */
export interface BtwEntryData {
	/** The asked question (clipped to the prompt cap). */
	question: string;
	/** Sanitized answer text. */
	answer: string;
	/** Session model used for the side call ("provider/id"). */
	model: string;
	/** True when the main run was still streaming when the question was asked. */
	answeredMidFlow: boolean;
	usage?: BtwUsage;
	latencyMs: number;
	timestamp: number;
}

/** "1.2k tok" / "200 tok" / "" when no usage was reported. */
export function formatBtwTokens(usage: BtwUsage | undefined): string {
	if (!usage) return "";
	const tokens = usage.inputTokens + usage.outputTokens;
	if (tokens <= 0) return "";
	const fmt = (n: number) => (n > 0 && n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
	return `${fmt(tokens)} tok`;
}

export function formatBtwSeconds(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** One-line arrival ping shown while the main flow keeps streaming. */
export function btwToastText(data: BtwEntryData): string {
	const line = data.answer
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0) ?? "";
	return `btw — ${fitLine(line, 120, "…")}`;
}

function btwMetaParts(data: BtwEntryData): string {
	const focus = data.answeredMidFlow ? "answered mid-flow" : "answered";
	return [focus, data.model, formatBtwTokens(data.usage), formatBtwSeconds(data.latencyMs)]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The permanent transcript box:
 *
 *   ╭─ BY THE WAY ─────────────╮
 *   │ ✦ question                │
 *   │                            │
 *   │ answer…                    │
 *   ╰────────────────────────────╯
 *     · answered mid-flow · …
 *
 * Every row isANSI-fitted to `width` by the chrome primitives.
 */
export function buildBtwBoxRows(theme: ChromeTheme, data: BtwEntryData, width: number): string[] {
	if (width <= 4) return [];
	const framing = (text: string) => chromeFrameRow(theme, text, width);
	const innerWidth = width - 4;

	const rows: string[] = [chromeFrameRule(theme, width, "top", BOX_LABEL)];
	rows.push(
		framing(theme.fg("accent", `${GLYPH_QUESTION} ${fitLine(data.question, Math.max(1, innerWidth - 3), "…")}`)),
	);
	rows.push(framing(""));
	for (const line of wrapTextWithAnsi(data.answer, Math.max(1, innerWidth))) {
		rows.push(framing(theme.fg("text", line)));
	}
	rows.push(chromeFrameRule(theme, width, "bottom"));
	rows.push(fitLine(theme.fg("dim", `· ${btwMetaParts(data)}`), width));
	return rows;
}

/** Pi component wrapper so the box renders at whichever width the TUI asks for. */
export class BtwBoxComponent implements Component {
	constructor(
		private readonly data: BtwEntryData,
		private readonly theme: ChromeTheme,
	) {}

	render(width: number): string[] {
		return buildBtwBoxRows(this.theme, this.data, width);
	}

	/** Rows are rebuilt from immutable entry data on every render; no cached
	 * state. */
	invalidate(): void {}
}

/** Registers the transcript-box renderer (safe in parents and children). */
export function registerBtwRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<BtwEntryData>(BTW_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || !data.answer) return undefined;
		return new BtwBoxComponent(data, toChromeTheme(theme));
	});
}

// ============================================================
// Above-editor card (pending → answered)
// ============================================================

export interface BtwPendingCard {
	phase: "pending";
	question: string;
	/** Session model description ("provider/id"). */
	model: string;
	startedAt: number;
}

export interface BtwAnswerCard {
	phase: "answered";
	question: string;
	answer: string;
	answeredAt: number;
	/** When the owning registrar clears the widget. */
	dismissAt: number;
}

export type BtwCard = BtwPendingCard | BtwAnswerCard;

/**
 * The transient card: a `↯ asking` line while in flight, then question plus
 * wrapped answer rows with an auto-hide countdown. Self-capped to
 * MAX_CARD_ROWS total; the answer truncates into a "+N more lines" row.
 */
export function buildBtwCardRows(theme: ChromeTheme, card: BtwCard, width: number, now = Date.now()): string[] {
	if (width <= 4) return [];
	const framing = (text: string) => chromeFrameRow(theme, text, width);
	const innerWidth = width - 4;

	const rows: string[] = [chromeFrameRule(theme, width, "top", BOX_LABEL)];
	rows.push(
		framing(theme.fg("accent", `${GLYPH_QUESTION} ${fitLine(card.question, Math.max(1, innerWidth - 3), "…")}`)),
	);

	if (card.phase === "pending") {
		const elapsed = Math.max(0, Math.floor((now - card.startedAt) / 1000));
		const modelId = card.model.split("/").pop() ?? card.model;
		rows.push(framing(theme.fg("muted", `${GLYPH_ASKING} asking ${modelId} · ${elapsed}s`)));
		rows.push(chromeFrameRule(theme, width, "bottom"));
		return rows;
	}

	let answerLines = wrapTextWithAnsi(card.answer, Math.max(1, innerWidth));
	if (answerLines.length > MAX_CARD_ANSWER_ROWS) {
		const shown = answerLines.slice(0, MAX_CARD_ANSWER_ROWS - 1);
		rows.push(framing(""));
		for (const line of shown) {
			rows.push(framing(theme.fg("text", line)));
		}
		rows.push(framing(theme.fg("dim", `…+${answerLines.length - shown.length} more lines (full answer in the transcript)`)));
	} else {
		rows.push(framing(""));
		for (const line of answerLines) {
			rows.push(framing(theme.fg("text", line)));
		}
	}
	rows.push(chromeFrameRule(theme, width, "bottom"));

	const hideIn = Math.max(0, Math.ceil((card.dismissAt - now) / 1000));
	rows.push(fitLine(theme.fg("dim", `· auto-hides in ${hideIn}s`), width));
	return rows;
}

// ============================================================
// Transient "asking" pill (frame border) and footer fallback
// ============================================================

/** Accent flash while a side question is in flight; frame top-left cluster. */
export function frameAskingMeta(modelId?: string): BtwFrameMeta {
	return {
		icon: GLYPH_ASKING,
		label: modelId ? `btw asking · ${modelId}` : "btw asking",
		role: "accent",
	};
}

/** Footer status fallback while no frame owns the visual surface. */
export function statusAskingLine(modelId?: string): string {
	return modelId ? `${GLYPH_ASKING} btw asking · ${modelId}` : `${GLYPH_ASKING} btw asking`;
}
