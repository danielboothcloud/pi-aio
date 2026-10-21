import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";
import type { CopyableBlock } from "./parse.js";
import {
	chromeFrameRow,
	chromeFrameRule,
	chromeHeader,
	chromeHint,
	chromeItem,
	plural,
} from "../ui/chrome.js";

const MAX_VISIBLE_ITEMS = 6;
const MAX_PREVIEW_LINES = 8;
const QUOTE_SNIPPET_CHARS = 40;

function longestRun(text: string, character: "`" | "~"): number {
	let longest = 0;
	let current = 0;
	for (const value of text) {
		if (value === character) {
			current++;
			longest = Math.max(longest, current);
		} else {
			current = 0;
		}
	}
	return longest;
}

function asFencedMarkdown(block: CopyableBlock): string {
	const backtickLength = Math.max(3, longestRun(block.text, "`") + 1);
	const tildeLength = Math.max(3, longestRun(block.text, "~") + 1);
	const marker = backtickLength <= tildeLength ? "`" : "~";
	const fenceLength = marker === "`" ? backtickLength : tildeLength;
	const fence = marker.repeat(fenceLength);
	const language = block.language ?? "";
	const code = block.text.endsWith("\n") ? block.text : `${block.text}\n`;
	return `${fence}${language}\n${code}${fence}`;
}

function asQuotedMarkdown(block: CopyableBlock): string {
	return block.text
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}

function previewMarkdown(block: CopyableBlock): string {
	return block.kind === "quote" ? asQuotedMarkdown(block) : asFencedMarkdown(block);
}

function quoteSnippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > QUOTE_SNIPPET_CHARS
		? `${flat.slice(0, QUOTE_SNIPPET_CHARS - 1).trimEnd()}…`
		: flat;
}

export function blockLabel(block: CopyableBlock): string {
	if (block.kind === "quote") {
		const words = block.text.split(/\s+/).filter(Boolean).length;
		return `#${block.ordinal} · quote · ${plural(words, "word")} · ${quoteSnippet(block.text)}`;
	}
	const language = block.language ?? "plain text";
	const lines = `${block.lineCount} ${block.lineCount === 1 ? "line" : "lines"}`;
	return `#${block.ordinal} · ${language} · ${lines}`;
}

export interface CopyBlockPickerOptions {
	blocks: readonly CopyableBlock[];
	theme: Theme;
	requestRender: () => void;
	getMaxRows: () => number;
	done: (result: CopyableBlock | undefined) => void;
}

export class CopyBlockPicker implements Component {
	private readonly blocks: readonly CopyableBlock[];
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly getMaxRows: () => number;
	private readonly done: (result: CopyableBlock | undefined) => void;
	private selectedIndex = 0;

	constructor(options: CopyBlockPickerOptions) {
		this.blocks = options.blocks;
		this.theme = options.theme;
		this.requestRender = options.requestRender;
		this.getMaxRows = options.getMaxRows;
		this.done = options.done;
	}

	private getVisibleItemCount(): number {
		const maxRows = Math.max(1, this.getMaxRows());
		let visibleItems = Math.min(MAX_VISIBLE_ITEMS, this.blocks.length);
		while (visibleItems > 1) {
			const hasScrollInfo = this.blocks.length > visibleItems;
			const fixedRows = 6 + (hasScrollInfo ? 1 : 0);
			if (maxRows - fixedRows - visibleItems >= 1) break;
			visibleItems--;
		}
		return visibleItems;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.done(this.blocks[this.selectedIndex]);
			return;
		}

		const visibleItems = this.getVisibleItemCount();
		let nextIndex = this.selectedIndex;
		if (matchesKey(data, Key.up) || data === "k") {
			nextIndex--;
		} else if (matchesKey(data, Key.down) || data === "j") {
			nextIndex++;
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			nextIndex -= visibleItems;
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			nextIndex += visibleItems;
		} else if (data === "g") {
			nextIndex = 0;
		} else if (data === "G") {
			nextIndex = this.blocks.length - 1;
		} else {
			return;
		}

		this.selectedIndex = Math.max(0, Math.min(this.blocks.length - 1, nextIndex));
		this.requestRender();
	}

	render(width: number): string[] {
		if (width <= 4) return [truncateToWidth("Copy block", Math.max(0, width), "")];

		const innerWidth = width - 4;
		const row = (content = ""): string => chromeFrameRow(this.theme, content, width);

		const maxRows = Math.max(1, this.getMaxRows());
		const selectedBlock = this.blocks[this.selectedIndex];
		if (maxRows < 9) {
			const top = chromeFrameRule(this.theme, width, "top");
			const bottom = chromeFrameRule(this.theme, width, "bottom");
			const header = row(
				chromeHeader(
					this.theme,
					{ title: "copy", meta: plural(this.blocks.length, "block") },
					innerWidth,
				),
			);
			const item = selectedBlock
				? row(
						chromeItem(
							this.theme,
							{
								label: blockLabel(selectedBlock),
								active: true,
								marker: "›",
								indent: 0,
							},
							innerWidth,
						),
					)
				: row(` ${this.theme.fg("warning", "No block selected")}`);
			const help = row(
				chromeHint(this.theme, "j/k move · Enter copy · q cancel", innerWidth, 0),
			);
			if (maxRows === 1) return [item];
			if (maxRows === 2) return [item, help];
			if (maxRows === 3) return [item, help, bottom];
			if (maxRows === 4) return [header, item, help, bottom];
			return [top, header, item, help, bottom];
		}

		const lines: string[] = [];
		lines.push(chromeFrameRule(this.theme, width, "top"));
		lines.push(
			row(
				chromeHeader(
					this.theme,
					{
						title: "copy",
						meta: `${plural(this.blocks.length, "block")} in last response`,
					},
					innerWidth,
				),
			),
		);

		const visibleItems = this.getVisibleItemCount();
		const maxOffset = Math.max(0, this.blocks.length - visibleItems);
		const offset = Math.min(maxOffset, Math.max(0, this.selectedIndex - Math.floor(visibleItems / 2)));
		for (let index = offset; index < offset + visibleItems; index++) {
			const block = this.blocks[index];
			if (!block) continue;
			const selected = index === this.selectedIndex;
			lines.push(
				row(
					chromeItem(
						this.theme,
						{
							label: blockLabel(block),
							active: selected,
							marker: selected ? "›" : "·",
							indent: 0,
						},
						innerWidth,
					),
				),
			);
		}

		if (this.blocks.length > visibleItems) {
			lines.push(row(` ${this.theme.fg("dim", `Showing ${offset + 1}-${offset + visibleItems} of ${this.blocks.length}`)}`));
		}

		lines.push(chromeFrameRule(this.theme, width, "divider"));
		if (!selectedBlock) {
			lines.push(row(` ${this.theme.fg("warning", "No block selected")}`));
			lines.push(chromeFrameRule(this.theme, width, "bottom"));
			return lines;
		}
		lines.push(
			row(
				chromeHeader(
					this.theme,
					{ title: "preview", meta: blockLabel(selectedBlock), tone: "muted" },
					innerWidth,
				),
			),
		);

		const preview = new Markdown(previewMarkdown(selectedBlock), 1, 0, getMarkdownTheme()).render(innerWidth);
		const remainingRows = maxRows - lines.length - 2; // Help row and closing border.
		const previewCapacity = Math.max(0, Math.min(MAX_PREVIEW_LINES, remainingRows));
		const previewLines = preview.slice(0, previewCapacity);
		if (preview.length > previewCapacity && previewCapacity > 0) {
			previewLines[previewCapacity - 1] = ` ${this.theme.fg("dim", `… ${preview.length - previewCapacity + 1} more rendered lines`)}`;
		}
		for (const previewLine of previewLines) {
			lines.push(row(previewLine));
		}

		lines.push(
			row(
				chromeHint(
					this.theme,
					"j/k move · Ctrl+u/d jump · g/G ends · Enter copy · q cancel",
					innerWidth,
					0,
				),
			),
		);
		lines.push(chromeFrameRule(this.theme, width, "bottom"));
		return lines;
	}

	invalidate(): void {}
}
