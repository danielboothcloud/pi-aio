import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import type { CopyableCodeBlock } from "./parse.js";

const MAX_VISIBLE_ITEMS = 6;
const MAX_PREVIEW_LINES = 8;

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

function asFencedMarkdown(block: CopyableCodeBlock): string {
	const backtickLength = Math.max(3, longestRun(block.code, "`") + 1);
	const tildeLength = Math.max(3, longestRun(block.code, "~") + 1);
	const marker = backtickLength <= tildeLength ? "`" : "~";
	const fenceLength = marker === "`" ? backtickLength : tildeLength;
	const fence = marker.repeat(fenceLength);
	const language = block.language ?? "";
	const code = block.code.endsWith("\n") ? block.code : `${block.code}\n`;
	return `${fence}${language}\n${code}${fence}`;
}

function blockLabel(block: CopyableCodeBlock): string {
	const language = block.language ?? "plain text";
	const lines = `${block.lineCount} ${block.lineCount === 1 ? "line" : "lines"}`;
	return `#${block.ordinal} · ${language} · ${lines}`;
}

export interface CodeBlockPickerOptions {
	blocks: readonly CopyableCodeBlock[];
	theme: Theme;
	requestRender: () => void;
	getMaxRows: () => number;
	done: (result: CopyableCodeBlock | undefined) => void;
}

export class CodeBlockPicker implements Component {
	private readonly blocks: readonly CopyableCodeBlock[];
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly getMaxRows: () => number;
	private readonly done: (result: CopyableCodeBlock | undefined) => void;
	private selectedIndex = 0;

	constructor(options: CodeBlockPickerOptions) {
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
			const fixedRows = 7 + (hasScrollInfo ? 1 : 0);
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
		if (width < 4) return [truncateToWidth("Copy code block", width, "")];

		const innerWidth = width - 2;
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content = "", selected = false): string => {
			const truncated = truncateToWidth(content, innerWidth, "");
			const padded = truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
			const body = selected ? this.theme.bg("selectedBg", padded) : padded;
			return `${border("│")}${body}${border("│")}`;
		};

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${this.theme.fg("accent", this.theme.bold("Copy code block"))}`));
		lines.push(row(` ${this.theme.fg("dim", `${this.blocks.length} block${this.blocks.length === 1 ? "" : "s"} in the last response`)}`));

		const maxRows = Math.max(1, this.getMaxRows());
		const visibleItems = this.getVisibleItemCount();
		const maxOffset = Math.max(0, this.blocks.length - visibleItems);
		const offset = Math.min(maxOffset, Math.max(0, this.selectedIndex - Math.floor(visibleItems / 2)));
		for (let index = offset; index < offset + visibleItems; index++) {
			const block = this.blocks[index];
			if (!block) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? " › " : "   ";
			const label = selected
				? this.theme.fg("accent", blockLabel(block))
				: this.theme.fg("text", blockLabel(block));
			lines.push(row(`${prefix}${label}`, selected));
		}

		if (this.blocks.length > visibleItems) {
			lines.push(row(` ${this.theme.fg("dim", `Showing ${offset + 1}-${offset + visibleItems} of ${this.blocks.length}`)}`));
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		const selectedBlock = this.blocks[this.selectedIndex];
		if (!selectedBlock) {
			lines.push(row(` ${this.theme.fg("warning", "No code block selected")}`));
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		}
		lines.push(row(` ${this.theme.fg("muted", `Preview · ${blockLabel(selectedBlock)}`)}`));

		const preview = new Markdown(asFencedMarkdown(selectedBlock), 1, 0, getMarkdownTheme()).render(innerWidth);
		const remainingRows = maxRows - lines.length - 2; // Help row and closing border.
		const previewCapacity = Math.max(0, Math.min(MAX_PREVIEW_LINES, remainingRows));
		const previewLines = preview.slice(0, previewCapacity);
		if (preview.length > previewCapacity && previewCapacity > 0) {
			previewLines[previewCapacity - 1] = ` ${this.theme.fg("dim", `… ${preview.length - previewCapacity + 1} more rendered lines`)}`;
		}
		for (const previewLine of previewLines) {
			lines.push(row(previewLine));
		}

		lines.push(row(` ${this.theme.fg("dim", "j/k move · Ctrl+u/d jump · g/G ends · Enter copy · q cancel")}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}
}
