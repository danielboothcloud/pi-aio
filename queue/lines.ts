import {
	chromeHeader,
	chromeHint,
	chromeItem,
	plural,
} from "../ui/chrome.js";
import type { QueuedMessage } from "./mirror.js";

/** Minimal theme surface, compatible with pi's Theme.fg (see status-line/render.ts). */
export interface QueueTheme {
	fg(name: string, text: string): string;
}

/** Maximum number of queue entries rendered before collapsing into "+N more". */
export const MAX_QUEUE_ROWS = 5;

export interface BuildQueueLinesInput {
	entries: QueuedMessage[];
	width: number;
	theme: QueueTheme;
	maxRows?: number;
}

/** First line of a message; flags whether more lines were dropped. */
export function firstLinePreview(text: string): {
	line: string;
	truncated: boolean;
} {
	const newlineIndex = text.indexOf("\n");
	if (newlineIndex === -1) return { line: text, truncated: false };
	return { line: text.slice(0, newlineIndex), truncated: true };
}

/**
 * Render the queue widget. Every returned line fits within `width`
 * (ANSI-aware truncation), per pi's component contract.
 */
export function buildQueueLines(input: BuildQueueLinesInput): string[] {
	const { entries, width, theme } = input;
	if (entries.length === 0 || width <= 0) return [];
	const maxRows = Math.max(1, input.maxRows ?? MAX_QUEUE_ROWS);

	const lines: string[] = [];
	lines.push(
		chromeHeader(
			theme,
			{
				title: "queue",
				meta: `${plural(entries.length, "pending message")} · Enter sends next`,
			},
			width,
		),
	);

	const visible = entries.slice(0, maxRows);
	for (const [index, entry] of visible.entries()) {
		const preview = firstLinePreview(entry.text);
		lines.push(
			chromeItem(
				theme,
				{
					label: `${preview.line}${preview.truncated ? " …" : ""}`,
					meta: entry.mode === "steer" ? "steer" : "follow",
					marker: `${index + 1}`,
					tone: entry.mode === "steer" ? "accent" : "muted",
					indent: 1,
				},
				width,
			),
		);
	}

	const remaining = entries.length - visible.length;
	if (remaining > 0) {
		lines.push(chromeHint(theme, `+${remaining} more queued`, width, 2));
	}

	return lines;
}
