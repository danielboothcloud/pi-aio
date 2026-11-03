// Resume picker: sessions grouped by day with clean titles, labeled age and
// message counts, a this-folder/all toggle, search, and a preview.
import { basename } from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type ChromeTheme, plural } from "../ui/chrome.js";
import {
	type FrameSection,
	innerWidth,
	printableInput,
	renderFrame,
	splitRow,
	visibleWindow,
	wrapLimited,
} from "./frame.js";
import {
	filterSessions,
	groupSessions,
	type LastExchange,
	type SessionLike,
	sessionTitle,
} from "./sessions.js";
import { relativeAge, toMillis } from "./text.js";

export type ResumeScope = "folder" | "all";

export interface ResumePickerOptions {
	theme: ChromeTheme;
	cwd: string;
	currentPath?: string;
	loadSessions: (scope: ResumeScope) => Promise<SessionLike[]>;
	loadPreview: (path: string) => Promise<LastExchange>;
	maxRows: () => number;
	done: (path: string | undefined) => void;
	requestRender: () => void;
	now?: () => number;
	homeDir?: string;
}

type Row = { kind: "group"; label: string } | { kind: "session"; session: SessionLike };

export class ResumePicker {
	private readonly options: ResumePickerOptions;
	private readonly now: () => number;
	private closed = false;

	scope: ResumeScope = "folder";
	query = "";
	private readonly lists = new Map<ResumeScope, SessionLike[]>();
	private readonly errors = new Map<ResumeScope, string>();
	private readonly previews = new Map<string, LastExchange | "loading" | "error">();
	private selectedPath: string | undefined;

	constructor(options: ResumePickerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.load("folder");
	}

	private load(scope: ResumeScope): void {
		if (this.lists.has(scope) || this.errors.has(scope)) return;
		this.options.loadSessions(scope).then(
			(sessions) => {
				this.lists.set(scope, sessions);
				if (scope === this.scope) this.keepSelectionVisible();
				this.options.requestRender();
			},
			(error: unknown) => {
				this.errors.set(scope, error instanceof Error ? error.message : String(error));
				this.options.requestRender();
			},
		);
	}

	/** Sessions in display order (grouped, newest first). */
	private ordered(): SessionLike[] {
		const list = this.lists.get(this.scope);
		if (!list) return [];
		return groupSessions(filterSessions(list, this.query), this.now()).flatMap((group) => group.sessions);
	}

	private selectedIndex(items: SessionLike[]): number {
		const index = items.findIndex((item) => item.path === this.selectedPath);
		return index === -1 ? 0 : index;
	}

	selected(): SessionLike | undefined {
		const items = this.ordered();
		return items[this.selectedIndex(items)];
	}

	private keepSelectionVisible(): void {
		const items = this.ordered();
		if (!items.some((item) => item.path === this.selectedPath)) this.selectedPath = items[0]?.path;
	}

	private move(delta: number): void {
		const items = this.ordered();
		if (!items.length) return;
		const index = Math.max(0, Math.min(items.length - 1, this.selectedIndex(items) + delta));
		this.selectedPath = items[index]!.path;
	}

	private finish(path: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.options.done(path);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed) return;
		const page = Math.max(1, this.listRows() - 2);
		if (matchesKey(data, Key.ctrl("c"))) this.finish(undefined);
		else if (matchesKey(data, Key.escape)) {
			if (this.query) {
				this.query = "";
				this.keepSelectionVisible();
			} else this.finish(undefined);
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.scope = this.scope === "folder" ? "all" : "folder";
			this.load(this.scope);
			this.keepSelectionVisible();
		} else if (matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.down)) this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-page);
		else if (matchesKey(data, Key.pageDown)) this.move(page);
		else if (matchesKey(data, Key.enter)) {
			const session = this.selected();
			if (session) this.finish(session.path);
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
		this.options.requestRender();
	}

	private listRows(): number {
		// Frame (2) + search (1) + dividers (2) + preview (3) + hint (1).
		return Math.max(4, this.options.maxRows() - 9);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.options.theme;
		const inner = innerWidth(width);
		const folder = basename(this.options.cwd) || this.options.cwd;
		const scopeLabel = this.scope === "folder"
			? `${theme.fg("accent", "◉ this folder")}  ${theme.fg("dim", "○ all")}`
			: `${theme.fg("dim", "○ this folder")}  ${theme.fg("accent", "◉ all")}`;
		const search = this.query
			? `${theme.fg("accent", "search")} ${this.query}${theme.fg("accent", "▏")}`
			: theme.fg("dim", "type to search");

		const sections: FrameSection[] = [{ lines: [splitRow(search, scopeLabel, inner)] }];
		const list = this.lists.get(this.scope);
		const error = this.errors.get(this.scope);
		const session = this.selected();
		if (error) {
			sections.push({ lines: [theme.fg("error", `Could not list sessions: ${error}`)] });
		} else if (!list) {
			sections.push({ lines: [theme.fg("dim", "Loading sessions…")] });
		} else {
			sections.push({ lines: this.renderRows(inner) });
			if (session) sections.push({ label: "preview", lines: this.renderPreview(session, inner) });
		}
		sections.push({ lines: [theme.fg("dim", "↑↓ choose · enter open · tab this folder/all · esc close")] });
		return renderFrame(theme, width, `▎ RESUME · ${folder}`, sections);
	}

	private renderRows(width: number): string[] {
		const theme = this.options.theme;
		const groups = groupSessions(filterSessions(this.lists.get(this.scope) ?? [], this.query), this.now());
		if (groups.length === 0) {
			return [theme.fg("dim", this.query ? "No sessions match the search." : "No saved sessions here yet. Press tab to see all folders.")];
		}
		const rows: Row[] = [];
		for (const group of groups) {
			rows.push({ kind: "group", label: group.group });
			for (const session of group.sessions) rows.push({ kind: "session", session });
		}
		const selected = this.selected();
		const selectedRow = Math.max(0, rows.findIndex((row) => row.kind === "session" && row.session === selected));
		const { start, end } = visibleWindow(rows.length, selectedRow, this.listRows());
		const lines: string[] = [];
		// Keep the group heading of the first visible session in view.
		if (start > 0 && rows[start]?.kind === "session") {
			for (let index = start - 1; index >= 0; index--) {
				const row = rows[index]!;
				if (row.kind === "group") {
					lines.push(theme.fg("muted", row.label));
					break;
				}
			}
		}
		for (let index = start; index < end; index++) {
			const row = rows[index]!;
			if (row.kind === "group") lines.push(theme.fg("muted", row.label));
			else lines.push(this.renderSession(row.session, row.session === selected, width));
		}
		const sessionsBelow = rows.slice(end).filter((row) => row.kind === "session").length;
		if (sessionsBelow) lines.push(theme.fg("dim", `  ↓ ${plural(sessionsBelow, "more session")}`));
		return lines;
	}

	private renderSession(session: SessionLike, active: boolean, width: number): string {
		const theme = this.options.theme;
		const title = sessionTitle(session);
		const marker = active ? theme.fg("accent", "› ") : "  ";
		const label = active ? theme.fg("accent", theme.bold?.(title) ?? title) : theme.fg("text", title);
		const meta: string[] = [];
		if (session.path === this.options.currentPath) meta.push(theme.fg("success", "open now"));
		if (this.scope === "all" && session.cwd) meta.push(theme.fg("muted", basename(session.cwd)));
		meta.push(theme.fg("dim", relativeAge(toMillis(session.modified), this.now())));
		meta.push(theme.fg("dim", plural(session.messageCount, "msg")));
		return splitRow(`${marker}${label}`, meta.join(theme.fg("dim", " · ")), width);
	}

	private renderPreview(session: SessionLike, width: number): string[] {
		const theme = this.options.theme;
		const body = Math.max(1, width - 9);
		let preview = this.previews.get(session.path);
		if (preview === undefined) {
			preview = "loading";
			this.previews.set(session.path, preview);
			this.options.loadPreview(session.path).then(
				(result) => {
					this.previews.set(session.path, result);
					this.options.requestRender();
				},
				() => {
					this.previews.set(session.path, "error");
					this.options.requestRender();
				},
			);
		}
		const started = sessionTitle({ ...session, name: undefined });
		const last = preview === "loading" ? "…" : preview === "error" ? "(could not read)" :
			preview.lastReply ?? preview.lastPrompt ?? "(nothing yet)";
		const lines = [
			`${theme.fg("accent", "started  ")}${wrapLimited(started, body, 1)[0] ?? ""}`,
			`${theme.fg("muted", "last     ")}${theme.fg("muted", wrapLimited(last, body, 1)[0] ?? "")}`,
		];
		if (this.scope === "all" && session.cwd) {
			const home = this.options.homeDir;
			const where = home && session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd;
			lines.push(`${theme.fg("muted", "folder   ")}${theme.fg("dim", where)}`);
		}
		return lines;
	}
}
