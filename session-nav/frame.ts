// Shared layout for the session pickers: a rounded frame built from the
// ui/chrome primitives, with labeled sections and a key-hint footer. Every
// returned line fits the supplied width.
import { decodeKittyPrintable, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type ChromeTheme,
	chromeFrameRow,
	chromeFrameRule,
	fitLine,
	padToWidth,
} from "../ui/chrome.js";

export interface FrameSection {
	label?: string;
	lines: string[];
}

export function renderFrame(
	theme: ChromeTheme,
	width: number,
	title: string,
	sections: FrameSection[],
): string[] {
	if (width <= 0) return [];
	const lines = [chromeFrameRule(theme, width, "top", title)];
	sections.forEach((section, index) => {
		if (index > 0) lines.push(chromeFrameRule(theme, width, "divider", section.label));
		for (const line of section.lines) lines.push(chromeFrameRow(theme, line, width));
	});
	lines.push(chromeFrameRule(theme, width, "bottom"));
	return lines.map((line) => fitLine(line, width, ""));
}

/** Usable text width inside chromeFrameRow. */
export function innerWidth(width: number): number {
	return width <= 4 ? Math.max(0, width) : width - 4;
}

/** Left text and right-aligned meta on one row; the left side truncates first. */
export function splitRow(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (!right || rightWidth + 4 > width) return fitLine(left, width);
	const leftFitted = fitLine(left, width - rightWidth - 2);
	return `${padToWidth(leftFitted, width - rightWidth)}${right}`;
}

/** Word-wrap plain text to at most maxLines rows, marking truncation. */
export function wrapLimited(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const wrapped = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), width);
	if (wrapped.length <= maxLines) return wrapped;
	const kept = wrapped.slice(0, maxLines);
	kept[maxLines - 1] = fitLine(`${kept[maxLines - 1]} …`, width);
	return kept;
}

/** The printable character typed, if any (plain bytes or kitty-encoded). */
export function printableInput(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data);
	if (decoded !== undefined) return decoded;
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	return undefined;
}

/** Window of `size` rows around `selected` within `total` items. */
export function visibleWindow(total: number, selected: number, size: number): { start: number; end: number } {
	if (total <= size) return { start: 0, end: total };
	const start = Math.max(0, Math.min(total - size, selected - Math.floor(size / 2)));
	return { start, end: start + size };
}
