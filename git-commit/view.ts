/**
 * The /git plan overlay: commit groups with their files, a cursor over group
 * and file rows, and key actions. The view edits group membership locally
 * (merge, move, skip) and returns an action; the command handler owns the
 * loop (message editor, regenerate, commit) and reopens the view.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
	chromeFrameRow,
	chromeFrameRule,
	chromeHeader,
	chromeHint,
	fitLine,
	padToWidth,
	plural,
	type ChromeTone,
} from "../ui/chrome.js";
import type { ChangedFile } from "./git.js";
import { fileLabel, isConventional, mergeWithNext, moveFile, subjectOf, type CommitGroup } from "./plan.js";

export interface PlanCursor {
	group: number;
	/** Index into the group's files, or -1 for the group's message row. */
	file: number;
}

export type PlanAction =
	| { type: "commit"; groups: CommitGroup[] }
	| { type: "edit"; groups: CommitGroup[]; cursor: PlanCursor }
	| { type: "regenerate"; groups: CommitGroup[] }
	| { type: "cancel" };

export interface PlanViewOptions {
	theme: Theme;
	branch: string;
	groups: CommitGroup[];
	files: readonly ChangedFile[];
	cursor?: PlanCursor;
	/** Shown under the list, e.g. a failed suggestion. */
	notice?: string;
	unstagedCount: number;
	requestRender: () => void;
	getMaxRows: () => number;
	done: (action: PlanAction) => void;
}

interface Row {
	group: number;
	file: number;
}

const STATUS_TONE: Record<string, ChromeTone> = { A: "success", D: "error", R: "accent", C: "accent", M: "warning" };

export const PLAN_HINTS = [
	"↑↓ move · enter edit message · space skip · ←→ move file · m merge",
	"c commit · r regenerate · esc cancel",
];

export class CommitPlanView implements Component {
	private groups: CommitGroup[];
	private cursor: PlanCursor;
	private readonly byPath: Map<string, ChangedFile>;
	private scroll = 0;

	constructor(private readonly options: PlanViewOptions) {
		this.groups = options.groups.map((group) => ({ ...group, files: [...group.files] }));
		this.byPath = new Map(options.files.map((file) => [file.path, file]));
		this.cursor = options.cursor ?? { group: 0, file: -1 };
		this.clampCursor();
	}

	private rows(): Row[] {
		return this.groups.flatMap((group, index) => [
			{ group: index, file: -1 },
			...group.files.map((_path, file) => ({ group: index, file })),
		]);
	}

	private cursorRow(rows: readonly Row[]): number {
		const found = rows.findIndex((row) => row.group === this.cursor.group && row.file === this.cursor.file);
		return Math.max(0, found);
	}

	private clampCursor(): void {
		const group = Math.max(0, Math.min(this.groups.length - 1, this.cursor.group));
		const count = this.groups[group]?.files.length ?? 0;
		this.cursor = { group, file: Math.max(-1, Math.min(count - 1, this.cursor.file)) };
	}

	private snapshot(): CommitGroup[] {
		return this.groups.map((group) => ({ ...group, files: [...group.files] }));
	}

	handleInput(data: string): void {
		const done = this.options.done;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			done({ type: "cancel" });
			return;
		}
		if (matchesKey(data, Key.enter) || data === "e") {
			done({ type: "edit", groups: this.snapshot(), cursor: { ...this.cursor } });
			return;
		}
		if (data === "c") {
			done({ type: "commit", groups: this.snapshot() });
			return;
		}
		if (data === "r") {
			done({ type: "regenerate", groups: this.snapshot() });
			return;
		}

		const rows = this.rows();
		const at = this.cursorRow(rows);
		if (matchesKey(data, Key.up) || data === "k") {
			this.cursor = { ...(rows[Math.max(0, at - 1)] ?? this.cursor) };
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.cursor = { ...(rows[Math.min(rows.length - 1, at + 1)] ?? this.cursor) };
		} else if (data === " ") {
			const group = this.groups[this.cursor.group];
			if (group) group.include = !group.include;
		} else if (data === "m") {
			if (this.cursor.group >= this.groups.length - 1) return;
			this.groups = mergeWithNext(this.groups, this.cursor.group);
			this.cursor = { group: this.cursor.group, file: -1 };
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
			const path = this.groups[this.cursor.group]?.files[this.cursor.file];
			if (!path) return;
			const delta = matchesKey(data, Key.right) ? 1 : -1;
			const before = this.groups.length;
			const target = this.cursor.group + delta;
			this.groups = moveFile(this.groups, this.cursor.group, path, delta);
			// Follow the moved file: a removed source group shifts later indexes,
			// and a group created in front shifts every index by one.
			let group = target < 0 ? 0 : target;
			if (delta === 1 && this.groups.length < before) group -= 1;
			const index = this.groups[group]?.files.indexOf(path) ?? -1;
			this.cursor = { group, file: index };
		} else {
			return;
		}
		this.clampCursor();
		this.options.requestRender();
	}

	private groupRow(index: number, active: boolean, width: number): string {
		const theme = this.options.theme;
		const group = this.groups[index]!;
		const subject = subjectOf(group.message) || "(empty message)";
		const valid = isConventional(group.message);
		const tone: ChromeTone = !group.include ? "dim" : valid ? "text" : "warning";
		const box = group.include ? theme.fg("success", "●") : theme.fg("dim", "○");
		const number = theme.fg("muted", `${index + 1}`);
		const bodyLines = group.message.split("\n").slice(1).filter((line) => line.trim()).length;
		const meta = [
			bodyLines > 0 ? plural(bodyLines, "body line") : "",
			group.include ? "" : "skipped",
			valid || !group.include ? "" : "not type(scope): description",
		].filter(Boolean).join(" · ");
		const marker = theme.fg("accent", active ? "›" : " ");
		const text = `${marker} ${box} ${number} ${theme.fg(tone, active ? theme.bold(subject) : subject)}${
			meta ? theme.fg("dim", ` · ${meta}`) : ""
		}`;
		return this.highlight(text, active, width);
	}

	private fileRow(path: string, active: boolean, include: boolean, width: number): string {
		const theme = this.options.theme;
		const file = this.byPath.get(path);
		const status = file?.status ?? "M";
		const stat = !file ? "" : file.binary ? "binary" : `+${file.added ?? 0} -${file.deleted ?? 0}`;
		const label = file ? fileLabel(file) : path;
		const marker = theme.fg("accent", active ? "›" : " ");
		const text = `${marker}     ${theme.fg(include ? (STATUS_TONE[status] ?? "muted") : "dim", status)} ${
			theme.fg(include ? "text" : "dim", label)
		}${stat ? theme.fg("dim", `  ${stat}`) : ""}`;
		return this.highlight(text, active, width);
	}

	private highlight(text: string, active: boolean, width: number): string {
		const fitted = fitLine(text, width);
		return active ? this.options.theme.bg("selectedBg", padToWidth(fitted, width)) : fitted;
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		if (width <= 4) return [truncateToWidth("git commit", Math.max(0, width), "")];
		const inner = width - 4;
		const row = (content = ""): string => chromeFrameRow(theme, content, width);

		const included = this.groups.filter((group) => group.include);
		const fileCount = this.groups.reduce((sum, group) => sum + group.files.length, 0);
		const header = chromeHeader(theme, {
			title: "git commit",
			meta: `${this.options.branch} · ${plural(included.length, "commit")} · ${plural(fileCount, "file")}`,
		}, inner);

		const footer: string[] = [];
		if (this.options.notice) footer.push(fitLine(` ${theme.fg("warning", `⚠ ${this.options.notice}`)}`, inner));
		if (this.options.unstagedCount > 0) {
			footer.push(fitLine(` ${theme.fg("muted", `${plural(this.options.unstagedCount, "unstaged file")} not included`)}`, inner));
		}
		const hints = PLAN_HINTS.map((hint) => chromeHint(theme, hint, inner, 1));

		const rows = this.rows();
		const at = this.cursorRow(rows);
		// top, header, blank, [list], blank, footer..., divider, hints..., bottom
		const fixed = 6 + footer.length + hints.length;
		const maxRows = Math.max(1, this.options.getMaxRows());
		const visible = Math.max(1, Math.min(rows.length, maxRows - fixed));
		if (at < this.scroll) this.scroll = at;
		if (at >= this.scroll + visible) this.scroll = at - visible + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - visible)));

		const list = rows.slice(this.scroll, this.scroll + visible).map((entry, offset) => {
			const active = this.scroll + offset === at;
			const group = this.groups[entry.group]!;
			return entry.file < 0
				? this.groupRow(entry.group, active, inner)
				: this.fileRow(group.files[entry.file]!, active, group.include, inner);
		});
		const scrollInfo = rows.length > visible
			? `${this.scroll + 1}-${this.scroll + visible} of ${rows.length}`
			: undefined;

		const lines = [
			chromeFrameRule(theme, width, "top"),
			row(header),
			row(),
			...list.map((line) => row(line)),
			row(scrollInfo ? chromeHint(theme, scrollInfo, inner, 1) : ""),
			...footer.map((line) => row(line)),
			chromeFrameRule(theme, width, "divider"),
			...hints.map((line) => row(line)),
			chromeFrameRule(theme, width, "bottom"),
		];
		if (lines.length > maxRows) return lines.slice(0, maxRows - 1).concat(lines.at(-1)!);
		return lines;
	}

	invalidate(): void {}
}
