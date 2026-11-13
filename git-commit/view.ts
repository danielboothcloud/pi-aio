/**
 * The /commit overlay: the suggested message, the staged files, and key
 * actions. The view only reports an action; the command handler owns the
 * loop (message editor, regenerate, push confirmation, commit) and reopens
 * the view.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import {
	chromeFrameRow,
	chromeFrameRule,
	chromeHeader,
	chromeHint,
	fitLine,
	plural,
	type ChromeTone,
} from "../ui/chrome.js";
import type { ChangedFile } from "./git.js";
import { fileLabel, isConventional, subjectOf } from "./message.js";

export type CommitAction =
	| { type: "commit" }
	| { type: "push" }
	| { type: "edit" }
	| { type: "regenerate" }
	| { type: "cancel" };

export interface CommitViewOptions {
	theme: Theme;
	branch: string;
	message: string;
	files: readonly ChangedFile[];
	/** Shown under the files, e.g. a failed suggestion. */
	notice?: string;
	unstagedCount: number;
	getMaxRows: () => number;
	done: (action: CommitAction) => void;
}

const STATUS_TONE: Record<string, ChromeTone> = { A: "success", D: "error", R: "accent", C: "accent", M: "warning" };

export const COMMIT_HINT = "c commit · e edit · p commit and push · r regenerate · esc cancel";

export class CommitView implements Component {
	constructor(private readonly options: CommitViewOptions) {}

	handleInput(data: string): void {
		const done = this.options.done;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") done({ type: "cancel" });
		else if (data === "c") done({ type: "commit" });
		else if (data === "p") done({ type: "push" });
		else if (data === "e" || matchesKey(data, Key.enter)) done({ type: "edit" });
		else if (data === "r") done({ type: "regenerate" });
	}

	private messageLines(width: number): string[] {
		const theme = this.options.theme;
		const subject = subjectOf(this.options.message) || "(empty message)";
		const body = this.options.message.split("\n").slice(1);
		while (body[0]?.trim() === "") body.shift();
		const lines = wrapTextWithAnsi(theme.fg("text", theme.bold(subject)), width - 1).map((line) => ` ${line}`);
		if (body.length > 0) {
			lines.push("");
			for (const line of body) {
				lines.push(...(line ? wrapTextWithAnsi(theme.fg("muted", line), width - 1).map((part) => ` ${part}`) : [""]));
			}
		}
		return lines.map((line) => fitLine(line, width));
	}

	private fileRow(file: ChangedFile, width: number): string {
		const theme = this.options.theme;
		const stat = file.binary ? "binary" : `+${file.added ?? 0} -${file.deleted ?? 0}`;
		return fitLine(
			`   ${theme.fg(STATUS_TONE[file.status] ?? "muted", file.status)} ${theme.fg("text", fileLabel(file))}${
				theme.fg("dim", `  ${stat}`)
			}`,
			width,
		);
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		if (width <= 4) return [truncateToWidth("commit", Math.max(0, width), "")];
		const inner = width - 4;
		const row = (content = ""): string => chromeFrameRow(theme, content, width);
		const files = this.options.files;

		const header = chromeHeader(theme, {
			title: "commit",
			meta: `${this.options.branch} · ${plural(files.length, "file")}`,
		}, inner);

		const footer: string[] = [];
		if (subjectOf(this.options.message) && !isConventional(this.options.message)) {
			footer.push(fitLine(` ${theme.fg("warning", "The subject is not type(scope): description")}`, inner));
		}
		if (this.options.notice) footer.push(fitLine(` ${theme.fg("warning", `⚠ ${this.options.notice}`)}`, inner));
		if (this.options.unstagedCount > 0) {
			footer.push(fitLine(` ${theme.fg("muted", `${plural(this.options.unstagedCount, "unstaged file")} not included`)}`, inner));
		}

		// top, header, blank, [message], blank, [files], blank?, footer..., divider, hint, bottom
		const fixed = 7 + (footer.length > 0 ? footer.length + 1 : 0);
		const maxRows = Math.max(1, this.options.getMaxRows());
		const budget = Math.max(2, maxRows - fixed);

		// Files get at least two rows (or all of them, when fewer); the message gets the rest.
		const fileFloor = Math.min(files.length, 2);
		let message = this.messageLines(inner);
		if (message.length > budget - fileFloor) {
			const keep = Math.max(1, budget - fileFloor - 1);
			message = [...message.slice(0, keep), chromeHint(theme, `… ${plural(message.length - keep, "more line")}`, inner, 1)];
		}
		const fileRoom = Math.max(1, budget - message.length);
		const fileRows = files.length <= fileRoom
			? files.map((file) => this.fileRow(file, inner))
			: [
				...files.slice(0, fileRoom - 1).map((file) => this.fileRow(file, inner)),
				chromeHint(theme, `… and ${plural(files.length - (fileRoom - 1), "more file")}`, inner, 3),
			];

		const lines = [
			chromeFrameRule(theme, width, "top"),
			row(header),
			row(),
			...message.map((line) => row(line)),
			row(),
			...fileRows.map((line) => row(line)),
			...(footer.length > 0 ? [row(), ...footer.map((line) => row(line))] : []),
			chromeFrameRule(theme, width, "divider"),
			row(chromeHint(theme, COMMIT_HINT, inner, 1)),
			chromeFrameRule(theme, width, "bottom"),
		];
		if (lines.length > maxRows) return lines.slice(0, Math.max(0, maxRows - 1)).concat(lines.at(-1)!);
		return lines;
	}

	invalidate(): void {}
}
