import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitLine, padToWidth, plural } from "../ui/chrome.js";
import { firstLinePreview, MAX_QUEUE_ROWS, type QueueTheme } from "./lines.js";
import type { QueuedMessage } from "./mirror.js";

export interface BuildZentuiQueueLinesInput {
	entries: QueuedMessage[];
	width: number;
	theme: QueueTheme;
	maxRows?: number;
}

/** Border renderer in the minimalist frame's muted border tone. */
function borderRenderer(theme: QueueTheme): (text: string) => string {
	return (text: string) => theme.fg("borderMuted", text);
}

/**
 * A labeled rail segment like `├─ label ─────┤`, the border idiom Zentui's
 * minimalist frame uses for attached panels (see its framed autocomplete
 * rows). Every line fits `width` (ANSI-aware), per pi's component contract.
 */
function railLine(
	theme: QueueTheme,
	options: {
		width: number;
		label: string;
		leftCorner: string;
		rightCorner: string;
	},
): string {
	const border = borderRenderer(theme);
	const muted = (text: string) => theme.fg("muted", text);
	const inner = Math.max(0, options.width - 2);
	let core: string;
	if (options.label && inner >= visibleWidth(options.label) + 4) {
		core = `${border("─ ")}${muted(options.label)}${border(" ")}`;
	} else if (options.label && inner >= 6) {
		const truncated = truncateToWidth(options.label, inner - 4, "…");
		core = truncated
			? `${border("─ ")}${muted(truncated)}${border(" ")}`
			: border("─");
	} else {
		core = border("─");
	}
	const fill = Math.max(0, inner - visibleWidth(core));
	return fitLine(
		`${border(options.leftCorner)}${core}${border("─".repeat(fill))}${border(options.rightCorner)}`,
		options.width,
	);
}

/** One `│ n preview …            mode │` content row. */
function contentRow(
	theme: QueueTheme,
	options: { width: number; index: number; entry: QueuedMessage },
): string {
	const border = borderRenderer(theme);
	const muted = (text: string) => theme.fg("muted", text);
	const dim = (text: string) => theme.fg("dim", text);
	const contentWidth = Math.max(0, options.width - 4);
	const preview = firstLinePreview(options.entry.text);
	const left = `${dim(String(options.index))} ${preview.line}${preview.truncated ? " …" : ""}`;
	const meta = options.entry.mode === "steer" ? "steer" : "follow";
	const metaText = muted(meta);
	const metaWidth = visibleWidth(metaText);
	// Keep at least 8 columns for the preview before giving up the meta tag.
	const useMeta = contentWidth >= metaWidth + 8;
	const leftWidth = useMeta
		? Math.max(0, contentWidth - metaWidth - 1)
		: contentWidth;
	const leftText = truncateToWidth(left, leftWidth, "…");
	const row = useMeta
		? `${leftText}${" ".repeat(Math.max(0, contentWidth - visibleWidth(leftText) - metaWidth))}${metaText}`
		: leftText;
	return `${border("│")} ${padToWidth(row, contentWidth)} ${border("│")}`;
}

/**
 * Render the queue widget in Zentui's minimalist style: an attached panel
 * below the editor using the frame's border idiom and muted metadata labels,
 * matching the rounded editor box above it.
 */
export function buildZentuiQueueLines(input: BuildZentuiQueueLinesInput): string[] {
	const { entries, width, theme } = input;
	if (entries.length === 0 || width <= 0) return [];
	const maxRows = Math.max(1, input.maxRows ?? MAX_QUEUE_ROWS);

	if (width <= 4) {
		// Too narrow to frame: degrade to borderless muted lines.
		const lines = [
			theme.fg(
				"muted",
				`queue · ${plural(entries.length, "pending message")} · Enter sends next`,
			),
		];
		for (const [index, entry] of entries.slice(0, maxRows).entries()) {
			const preview = firstLinePreview(entry.text);
			lines.push(
				theme.fg(
					"muted",
					`${index + 1} ${preview.line}${preview.truncated ? " …" : ""}`,
				),
			);
		}
		return lines.map((line) => fitLine(line, width));
	}

	const lines: string[] = [];
	lines.push(
		railLine(theme, {
			width,
			label: `queue · ${plural(entries.length, "pending message")} · Enter sends next`,
			leftCorner: "├",
			rightCorner: "┤",
		}),
	);

	const visible = entries.slice(0, maxRows);
	for (const [index, entry] of visible.entries()) {
		lines.push(contentRow(theme, { width, index: index + 1, entry }));
	}

	const remaining = entries.length - visible.length;
	lines.push(
		railLine(theme, {
			width,
			label: remaining > 0 ? `+${remaining} more queued` : "",
			leftCorner: "╰",
			rightCorner: "╯",
		}),
	);

	return lines;
}
