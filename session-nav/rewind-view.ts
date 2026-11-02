// Double-Esc rewind picker: your prompts as checkpoints with a preview, then
// one plain-English action step.
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type ChromeTheme, plural } from "../ui/chrome.js";
import { type Checkpoint, type RewindAction, rewindOptions } from "./checkpoints.js";
import {
	type FrameSection,
	innerWidth,
	printableInput,
	renderFrame,
	splitRow,
	visibleWindow,
	wrapLimited,
} from "./frame.js";
import { cleanPromptTitle, matchesQuery, relativeAge, relativeAgeLong } from "./text.js";

export interface RewindResult {
	checkpoint: Checkpoint;
	action: RewindAction;
}

export interface RewindPickerOptions {
	theme: ChromeTheme;
	checkpoints: Checkpoint[];
	maxRows: () => number;
	done: (result: RewindResult | undefined) => void;
	requestRender: () => void;
	now?: () => number;
}

const AGE_WIDTH = 6;

export class RewindPicker {
	private readonly theme: ChromeTheme;
	private readonly checkpoints: Checkpoint[];
	private readonly maxRows: () => number;
	private readonly onDone: (result: RewindResult | undefined) => void;
	private readonly requestRender: () => void;
	private readonly now: () => number;
	private closed = false;

	view: "list" | "actions" = "list";
	query = "";
	private selectedId: string | undefined;
	private actionIndex = 0;

	constructor(options: RewindPickerOptions) {
		this.theme = options.theme;
		this.checkpoints = options.checkpoints;
		this.maxRows = options.maxRows;
		this.onDone = options.done;
		this.requestRender = options.requestRender;
		this.now = options.now ?? Date.now;
		this.selectedId = (this.checkpoints.find((checkpoint) => checkpoint.isCurrent) ?? this.checkpoints[0])?.id;
	}

	private filtered(): Checkpoint[] {
		if (!this.query) return this.checkpoints;
		return this.checkpoints.filter((checkpoint) =>
			matchesQuery(this.query, checkpoint.title, checkpoint.text, checkpoint.label));
	}

	private selectedIndex(items: Checkpoint[]): number {
		const index = items.findIndex((item) => item.id === this.selectedId);
		return index === -1 ? 0 : index;
	}

	selected(): Checkpoint | undefined {
		const items = this.filtered();
		return items[this.selectedIndex(items)];
	}

	private move(delta: number): void {
		const items = this.filtered();
		if (!items.length) return;
		const index = Math.max(0, Math.min(items.length - 1, this.selectedIndex(items) + delta));
		this.selectedId = items[index]!.id;
	}

	private finish(result: RewindResult | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.onDone(result);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}
		if (this.view === "actions") this.handleActionInput(data);
		else this.handleListInput(data);
		this.requestRender();
	}

	private handleListInput(data: string): void {
		const page = Math.max(1, this.listRows() - 1);
		if (matchesKey(data, Key.escape)) {
			if (this.query) this.query = "";
			else this.finish(undefined);
		} else if (matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.down)) this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-page);
		else if (matchesKey(data, Key.pageDown)) this.move(page);
		else if (matchesKey(data, Key.home)) this.move(-Infinity);
		else if (matchesKey(data, Key.end)) this.move(Infinity);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.selected()) {
				this.view = "actions";
				this.actionIndex = 0;
			}
		} else if (matchesKey(data, Key.backspace)) {
			this.query = this.query.slice(0, -1);
			this.keepSelectionVisible();
		} else {
			const char = printableInput(data);
			if (char !== undefined) {
				this.query += char;
				this.keepSelectionVisible();
			}
		}
	}

	private keepSelectionVisible(): void {
		const items = this.filtered();
		if (!items.some((item) => item.id === this.selectedId)) this.selectedId = items[0]?.id;
	}

	private handleActionInput(data: string): void {
		const checkpoint = this.selected();
		if (!checkpoint) {
			this.view = "list";
			return;
		}
		const options = rewindOptions(checkpoint);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			this.view = "list";
		} else if (matchesKey(data, Key.up)) {
			this.actionIndex = Math.max(0, this.actionIndex - 1);
		} else if (matchesKey(data, Key.down)) {
			this.actionIndex = Math.min(options.length - 1, this.actionIndex + 1);
		} else if (matchesKey(data, Key.enter)) {
			const option = options[this.actionIndex];
			if (option) this.finish({ checkpoint, action: option.action });
		} else if (/^[1-9]$/.test(data)) {
			const option = options[Number(data) - 1];
			if (option) this.finish({ checkpoint, action: option.action });
		}
	}

	private listRows(): number {
		// Frame (2) + intro (1) + 2 dividers + preview (4) + hint (1).
		return Math.max(3, this.maxRows() - 10 - (this.query ? 1 : 0));
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.view === "actions" ? this.renderActions(width) : this.renderList(width);
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const inner = innerWidth(width);
		const items = this.filtered();
		const title = `▎ REWIND · ${plural(this.checkpoints.length, "checkpoint")}`;
		const intro = [theme.fg("muted", "Go back to an earlier point. Files on disk are not changed.")];
		if (this.query) intro.push(`${theme.fg("accent", "filter")} ${this.query}${theme.fg("accent", "▏")}`);

		const rows: string[] = [];
		if (items.length === 0) {
			rows.push(theme.fg("dim", this.checkpoints.length ? "No prompts match the filter." : "No prompts in this session yet."));
		} else {
			const selectedIndex = this.selectedIndex(items);
			const { start, end } = visibleWindow(items.length, selectedIndex, this.listRows());
			if (start > 0) rows.push(theme.fg("dim", `  ↑ ${start} newer`));
			for (let index = start; index < end; index++) {
				rows.push(this.renderItem(items[index]!, index === selectedIndex, inner));
			}
			if (end < items.length) rows.push(theme.fg("dim", `  ↓ ${items.length - end} older`));
		}

		const sections: FrameSection[] = [
			{ lines: intro },
			{ label: "your prompts", lines: rows },
		];
		const checkpoint = items.length ? this.selected() : undefined;
		if (checkpoint) sections.push({ label: "preview", lines: this.renderPreview(checkpoint, inner) });
		sections.push({
			lines: [theme.fg("dim", "↑↓ choose · enter select · type to filter · esc close")],
		});
		return renderFrame(theme, width, title, sections);
	}

	private renderItem(checkpoint: Checkpoint, active: boolean, width: number): string {
		const theme = this.theme;
		const marker = active ? theme.fg("accent", "› ") : "  ";
		const age = theme.fg("muted", relativeAge(checkpoint.timestamp, this.now()).padEnd(AGE_WIDTH));
		const title = active
			? theme.fg("accent", theme.bold?.(checkpoint.title) ?? checkpoint.title)
			: checkpoint.onPath ? theme.fg("text", checkpoint.title) : theme.fg("muted", checkpoint.title);
		const meta: string[] = [];
		if (checkpoint.label) meta.push(theme.fg("accent", `#${checkpoint.label}`));
		if (checkpoint.isCurrent) meta.push(theme.fg("success", "you are here"));
		else if (!checkpoint.onPath) meta.push(theme.fg("warning", "⑂ alternate"));
		if (checkpoint.edits) meta.push(theme.fg("dim", plural(checkpoint.edits, "edit")));
		else if (checkpoint.tools) meta.push(theme.fg("dim", plural(checkpoint.tools, "tool")));
		return splitRow(`${marker}${age}${title}`, meta.join(theme.fg("dim", " · ")), width);
	}

	private renderPreview(checkpoint: Checkpoint, width: number): string[] {
		const theme = this.theme;
		const body = Math.max(1, width - 5);
		const you = wrapLimited(cleanPromptTitle(checkpoint.text) || "(empty prompt)", body, 2);
		const reply = wrapLimited(checkpoint.reply || "(no answer yet)", body, 2);
		const lines: string[] = [];
		you.forEach((line, index) => lines.push(`${theme.fg("accent", index ? "     " : "you  ")}${line}`));
		reply.forEach((line, index) => lines.push(`${theme.fg("muted", index ? "     " : "pi   ")}${theme.fg("muted", line)}`));
		return lines;
	}

	private renderActions(width: number): string[] {
		const theme = this.theme;
		const inner = innerWidth(width);
		const checkpoint = this.selected();
		if (!checkpoint) return this.renderList(width);
		const options = rewindOptions(checkpoint);
		this.actionIndex = Math.min(this.actionIndex, options.length - 1);
		const heading = `Rewind to “${checkpoint.title}”`;
		const when = relativeAgeLong(checkpoint.timestamp, this.now());
		const rows = options.map((option, index) => {
			const active = index === this.actionIndex;
			const marker = active ? theme.fg("accent", "› ") : "  ";
			const number = theme.fg("dim", `${index + 1} `);
			const label = active ? theme.fg("accent", theme.bold?.(option.label) ?? option.label) : option.label;
			return `${marker}${number}${label}`;
		});
		const description = wrapLimited(options[this.actionIndex]!.description, inner, 3)
			.map((line) => theme.fg("muted", line));
		return renderFrame(theme, width, "▎ REWIND", [
			{ lines: [splitRow(theme.fg("text", heading), theme.fg("dim", when), inner)] },
			{ label: "what to do", lines: rows },
			{ lines: description },
			{ lines: [theme.fg("dim", "↑↓ choose · enter confirm · esc back")] },
		]);
	}
}
