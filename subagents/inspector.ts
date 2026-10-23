/**
 * Live subagent inspector overlay (`/subagents`, ctrl+s).
 *
 * A list view covers every shape a delegation can take: several runs at once
 * (foreground and background), parallel runs with up to 12 children, and
 * queued/running/retrying/failed/stopped/completed children. The detail view
 * streams one child's bounded transcript (thinking, responses, tool calls with
 * arguments and results, stderr logs, retry/compaction notices) with
 * follow-tail scrolling; tab/shift+tab cycles through every child across all
 * runs without leaving the detail view.
 *
 * Rendering is pure over the live registry state and repaints on a ticker, so
 * no runner event plumbing is needed. Every returned line fits the supplied
 * width and the overlay never exceeds `getMaxRows()` rows.
 */
import {
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import {
	chromeDivider,
	chromeFrameRow,
	chromeFrameRule,
	chromeHeader,
	chromeHint,
	chromeItem,
	fitLine,
	padToWidth,
	plural,
	type ChromeTheme,
	type ChromeTone,
} from "../ui/chrome.js";
import { formatChildActivity, formatDuration } from "./activity.js";
import type { TranscriptEntry } from "./transcript.js";
import type { ChildRunStatus, SubagentRun } from "./types.js";

const DEFAULT_TICK_MS = 500;
const COLLAPSED_TOOL_LINES = 6;
const COLLAPSED_PROMPT_LINES = 4;
const COLLAPSED_LOG_LINES = 3;
/** Rows outside the scrolling body in the framed layouts. */
const DETAIL_FIXED_ROWS = 9;
const LIST_FIXED_ROWS = 6;

export interface InspectorTarget {
	key: string;
	run: SubagentRun;
	child: ChildRunStatus;
}

export interface TranscriptRenderOptions {
	expandTools: boolean;
	showThinking: boolean;
	now: number;
}

function isActive(run: SubagentRun): boolean {
	return run.state === "running" || run.state === "queued";
}

export function targetKey(run: SubagentRun, child: ChildRunStatus): string {
	return `${run.id}:${child.index}`;
}

/** Every child of every run: active runs first, newest first, index order. */
export function inspectorTargets(runs: readonly SubagentRun[]): InspectorTarget[] {
	const ordered = [...runs].sort((a, b) => {
		const activeDelta = Number(isActive(b)) - Number(isActive(a));
		return activeDelta || b.startedAt - a.startedAt;
	});
	return ordered.flatMap((run) =>
		run.children.map((child) => ({ key: targetKey(run, child), run, child })),
	);
}

function childTone(child: ChildRunStatus, now: number): ChromeTone {
	switch (child.state) {
		case "failed":
			return "error";
		case "stopped":
			return "warning";
		case "completed":
			return "success";
		case "queued":
			return "muted";
		default:
			return formatChildActivity(child, now).stale ? "warning" : "accent";
	}
}

function stateGlyph(state: ChildRunStatus["state"] | SubagentRun["state"]): string {
	switch (state) {
		case "running":
			return "◐";
		case "queued":
			return "◌";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		default:
			return "■";
	}
}

function firstLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short state text for a child row or detail status line. */
export function describeChild(child: ChildRunStatus, now: number): string {
	if (child.state === "running") return formatChildActivity(child, now).text;
	if (child.state === "queued") return "queued · waiting for a worker slot";
	const parts: string[] = [child.state];
	if (child.startedAt !== undefined)
		parts.push(formatDuration((child.endedAt ?? now) - child.startedAt));
	if ((child.attempts ?? 1) > 1) parts.push(`${child.attempts} attempts`);
	if (child.error) parts.push(firstLine(child.error, 80));
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

function wrap(
	text: string,
	width: number,
	indent: number,
	color: (line: string) => string,
): string[] {
	const pad = " ".repeat(indent);
	const inner = Math.max(1, width - indent);
	return wrapTextWithAnsi(text, inner).map((line) =>
		fitLine(`${pad}${color(line)}`, width),
	);
}

function collapse(
	lines: string[],
	max: number,
	expanded: boolean,
	theme: ChromeTheme,
	width: number,
	indent: number,
): string[] {
	if (expanded || lines.length <= max) return lines;
	const hidden = lines.length - max;
	return [
		...lines.slice(0, max),
		chromeHint(theme, `… ${plural(hidden, "more line")} · o expands`, width, indent),
	];
}

const bodyCache = new WeakMap<TranscriptEntry, { key: string; lines: string[] }>();

function toolHeader(
	entry: Extract<TranscriptEntry, { kind: "tool" }>,
	theme: ChromeTheme,
	width: number,
	now: number,
): string {
	const icon =
		entry.status === "running"
			? theme.fg("accent", "◐")
			: entry.status === "error"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
	const name = theme.fg("toolTitle", theme.bold?.(entry.name) ?? entry.name);
	const summary = entry.summary ? ` ${theme.fg("muted", entry.summary)}` : "";
	const timing =
		entry.status === "running"
			? `running ${formatDuration(now - entry.at)}`
			: entry.durationMs !== undefined
				? formatDuration(entry.durationMs)
				: "";
	const meta = timing ? theme.fg("dim", ` · ${timing}`) : "";
	return fitLine(`${icon} ${name}${summary}${meta}`, width);
}

function entryBody(
	entry: TranscriptEntry,
	width: number,
	theme: ChromeTheme,
	options: TranscriptRenderOptions,
): string[] {
	const dim = (line: string) => theme.fg("dim", line);
	switch (entry.kind) {
		case "notice": {
			if (entry.tone === "muted") return [chromeDivider(theme, width, entry.text)];
			const glyph = entry.tone === "success" ? "✓" : entry.tone === "warning" ? "⚠" : "✗";
			return wrap(`${glyph} ${entry.text}`, width, 0, (line) => theme.fg(entry.tone, line));
		}
		case "prompt":
			return [
				fitLine(theme.fg("accent", "› prompt"), width),
				...collapse(
					wrap(entry.text, width, 2, dim),
					COLLAPSED_PROMPT_LINES,
					options.expandTools,
					theme,
					width,
					2,
				),
			];
		case "thinking": {
			if (!options.showThinking)
				return [
					fitLine(
						dim(`✻ thinking · ${plural(entry.text.length, "char")} hidden · t shows`),
						width,
					),
				];
			const lines = [
				fitLine(theme.fg("thinkingText", `✻ thinking${entry.streaming ? " …" : ""}`), width),
				...wrap(entry.text, width, 2, (line) => theme.fg("thinkingText", line)),
			];
			if (entry.clipped > 0)
				lines.push(chromeHint(theme, `… ${entry.clipped} more chars not captured`, width, 2));
			return lines;
		}
		case "text": {
			const lines = [
				fitLine(theme.fg("accent", `● response${entry.streaming ? " …" : ""}`), width),
				...wrap(entry.text, width, 2, (line) => theme.fg("text", line)),
			];
			if (entry.clipped > 0)
				lines.push(chromeHint(theme, `… ${entry.clipped} more chars not captured`, width, 2));
			return lines;
		}
		case "log":
			return [
				fitLine(dim("≡ stderr"), width),
				...collapse(
					wrap(entry.text.replace(/\n+$/, ""), width, 2, dim),
					COLLAPSED_LOG_LINES,
					options.expandTools,
					theme,
					width,
					2,
				),
			];
		case "tool": {
			const lines: string[] = [];
			if (options.expandTools && entry.args) {
				lines.push(chromeHint(theme, "args", width, 2));
				lines.push(...wrap(entry.args, width, 4, dim));
				lines.push(chromeHint(theme, "output", width, 2));
			}
			if (entry.output) {
				const color =
					entry.status === "error"
						? (line: string) => theme.fg("error", line)
						: (line: string) => theme.fg("toolOutput", line);
				lines.push(
					...collapse(
						wrap(entry.output.replace(/\n+$/, ""), width, 4, color),
						COLLAPSED_TOOL_LINES,
						options.expandTools,
						theme,
						width,
						4,
					),
				);
			} else if (entry.status !== "running") {
				lines.push(chromeHint(theme, "(no output)", width, 4));
			}
			return lines;
		}
	}
}

function renderEntry(
	entry: TranscriptEntry,
	width: number,
	theme: ChromeTheme,
	options: TranscriptRenderOptions,
): string[] {
	const key = `${entry.rev}|${width}|${options.expandTools}|${options.showThinking}`;
	let cached = bodyCache.get(entry);
	if (!cached || cached.key !== key) {
		cached = { key, lines: entryBody(entry, width, theme, options) };
		bodyCache.set(entry, cached);
	}
	// Running tools show a live elapsed time, so their header is never cached.
	return entry.kind === "tool"
		? [toolHeader(entry, theme, width, options.now), ...cached.lines]
		: cached.lines;
}

/** Scrollable body lines for one child; every line fits `width`. */
export function renderTranscriptLines(
	child: ChildRunStatus,
	width: number,
	theme: ChromeTheme,
	options: TranscriptRenderOptions,
): string[] {
	if (width <= 0) return [];
	const transcript = child.transcript;
	const lines: string[] = [];
	if (!transcript) {
		if (child.state === "queued")
			lines.push(chromeHint(theme, "Queued — no activity until a worker slot frees up.", width, 0));
		else
			lines.push(
				chromeHint(theme, "Transcript not retained for this run (only recent runs keep one).", width, 0),
			);
	} else {
		if (transcript.dropped > 0)
			lines.push(
				chromeHint(
					theme,
					`… ${plural(transcript.dropped, "earlier entry", "earlier entries")} dropped to bound memory`,
					width,
					0,
				),
			);
		let previous: TranscriptEntry | undefined;
		for (const entry of transcript.entries) {
			// Blank line between content blocks; notices act as separators.
			if (previous && entry.kind !== "notice" && previous.kind !== "notice") lines.push("");
			lines.push(...renderEntry(entry, width, theme, options));
			previous = entry;
		}
		if (transcript.entries.length === 0)
			lines.push(chromeHint(theme, "Waiting for the child's first event…", width, 0));
	}
	if (child.output && child.state !== "running" && child.state !== "queued") {
		const lastText = transcript?.entries.findLast((entry) => entry.kind === "text");
		if (!lastText) {
			lines.push("", fitLine(theme.fg("accent", "● result"), width));
			lines.push(...wrap(child.output, width, 2, (line) => theme.fg("text", line)));
		}
	}
	if (child.sessionFile)
		lines.push("", chromeHint(theme, `session: ${child.sessionFile}`, width, 0));
	return lines;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

export interface SubagentInspectorOptions {
	theme: ChromeTheme;
	getRuns: () => SubagentRun[];
	getMaxRows: () => number;
	requestRender: () => void;
	done: () => void;
	/** Explicit user action only; the owner handles launch errors/notifications. */
	resumeChild?: (target: InspectorTarget) => void;
	resumeUnavailable?: (target: InspectorTarget) => string | undefined;
	now?: () => number;
	/** Repaint interval for live updates; 0 disables the ticker (tests). */
	tickMs?: number;
}

type ListRow =
	| { type: "run"; run: SubagentRun }
	| { type: "child"; target: InspectorTarget };

export class SubagentInspector implements Component {
	private readonly theme: ChromeTheme;
	private readonly getRuns: () => SubagentRun[];
	private readonly getMaxRows: () => number;
	private readonly requestRender: () => void;
	private readonly onDone: () => void;
	private readonly now: () => number;
	private readonly resumeChild?: SubagentInspectorOptions["resumeChild"];
	private readonly resumeUnavailable?: SubagentInspectorOptions["resumeUnavailable"];
	private ticker: NodeJS.Timeout | undefined;
	private closed = false;

	view: "list" | "detail" = "list";
	selectedKey: string | undefined;
	expandTools = false;
	showThinking = true;
	private scroll = 0;
	private follow = true;
	private lastMaxScroll = 0;
	private lastBodyHeight = 1;
	private lastListHeight = 1;

	constructor(options: SubagentInspectorOptions) {
		this.theme = options.theme;
		this.getRuns = options.getRuns;
		this.getMaxRows = options.getMaxRows;
		this.requestRender = options.requestRender;
		this.onDone = options.done;
		this.now = options.now ?? Date.now;
		this.resumeChild = options.resumeChild;
		this.resumeUnavailable = options.resumeUnavailable;

		const targets = this.targets();
		const running = targets.filter((target) => target.child.state === "running");
		const initial = running[0] ?? targets[0];
		this.selectedKey = initial?.key;
		// Straight to the transcript when there is exactly one obvious child.
		if (targets.length === 1 || running.length === 1) this.view = "detail";

		const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		if (tickMs > 0) {
			this.ticker = setInterval(() => this.requestRender(), tickMs);
			this.ticker.unref?.();
		}
	}

	private targets(): InspectorTarget[] {
		return inspectorTargets(this.getRuns());
	}

	private selectedIndex(targets: InspectorTarget[]): number {
		const index = targets.findIndex((target) => target.key === this.selectedKey);
		return index === -1 ? 0 : index;
	}

	private select(targets: InspectorTarget[], index: number): void {
		if (!targets.length) return;
		const clamped = Math.max(0, Math.min(targets.length - 1, index));
		this.selectedKey = targets[clamped]?.key;
	}

	private cycle(delta: number): void {
		const targets = this.targets();
		if (!targets.length) return;
		const index = (this.selectedIndex(targets) + delta + targets.length) % targets.length;
		this.selectedKey = targets[index]?.key;
		this.scroll = 0;
		this.follow = true;
	}

	private scrollBy(delta: number): void {
		this.scroll = Math.max(0, Math.min(this.lastMaxScroll, this.scroll + delta));
		this.follow = this.scroll >= this.lastMaxScroll;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.onDone();
	}

	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	invalidate(): void {}

	/** Follow a newly launched continuation without closing the overlay. */
	inspectRun(run: SubagentRun): void {
		if (this.closed || !run.children[0]) return;
		this.selectedKey = targetKey(run, run.children[0]);
		this.view = "detail";
		this.scroll = 0;
		this.follow = true;
		this.requestRender();
	}

	private recoveryHint(target: InspectorTarget | undefined): string {
		if (
			!this.resumeChild || !target ||
			(target.child.state !== "failed" && target.child.state !== "stopped")
		) return "";
		const reason = this.resumeUnavailable?.(target);
		return reason ? `resume unavailable: ${reason}` : "r resume saved session";
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (data === "r" && this.resumeChild) {
			const targets = this.targets();
			const target = targets[this.selectedIndex(targets)];
			if (target && (target.child.state === "failed" || target.child.state === "stopped"))
				this.resumeChild(target);
		} else if (this.view === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
		this.requestRender();
	}

	private handleListInput(data: string): void {
		const targets = this.targets();
		const index = this.selectedIndex(targets);
		const page = Math.max(1, this.lastListHeight - 1);
		if (matchesKey(data, Key.escape)) this.close();
		else if (matchesKey(data, Key.up) || data === "k") this.select(targets, index - 1);
		else if (matchesKey(data, Key.down) || data === "j") this.select(targets, index + 1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u")))
			this.select(targets, index - page);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d")))
			this.select(targets, index + page);
		else if (data === "g") this.select(targets, 0);
		else if (data === "G") this.select(targets, targets.length - 1);
		else if (
			(matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === "l") &&
			targets.length
		) {
			this.selectedKey = targets[index]?.key;
			this.view = "detail";
			this.scroll = 0;
			this.follow = true;
		}
	}

	private handleDetailInput(data: string): void {
		const page = Math.max(1, this.lastBodyHeight - 1);
		const half = Math.max(1, Math.floor(this.lastBodyHeight / 2));
		if (matchesKey(data, Key.escape)) this.view = "list";
		else if (matchesKey(data, Key.down) || data === "j") this.scrollBy(1);
		else if (matchesKey(data, Key.up) || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, Key.ctrl("d"))) this.scrollBy(half);
		else if (matchesKey(data, Key.ctrl("u"))) this.scrollBy(-half);
		else if (matchesKey(data, Key.pageDown) || data === " ") this.scrollBy(page);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (data === "g") {
			this.scroll = 0;
			this.follow = this.lastMaxScroll === 0;
		} else if (data === "G") {
			this.follow = true;
		} else if (matchesKey(data, Key.tab) || data === "]" || data === "l" || matchesKey(data, Key.right))
			this.cycle(1);
		else if (
			matchesKey(data, Key.shift("tab")) ||
			data === "[" ||
			data === "h" ||
			matchesKey(data, Key.left)
		)
			this.cycle(-1);
		else if (data === "o") this.expandTools = !this.expandTools;
		else if (data === "t") this.showThinking = !this.showThinking;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const maxRows = Math.max(1, this.getMaxRows());
		const targets = this.targets();
		const target = targets[this.selectedIndex(targets)];
		if (this.view === "detail" && target) return this.renderDetail(width, maxRows, targets, target);
		return this.renderList(width, maxRows, targets);
	}

	private renderDetail(
		width: number,
		maxRows: number,
		targets: InspectorTarget[],
		target: InspectorTarget,
	): string[] {
		const theme = this.theme;
		const now = this.now();
		const { run, child } = target;
		const framed = width > 24 && maxRows >= DETAIL_FIXED_ROWS + 2;
		const inner = framed ? width - 4 : width;
		const row = (text: string) => (framed ? chromeFrameRow(theme, text, width) : fitLine(text, width));

		const position = `${this.selectedIndex(targets) + 1}/${targets.length}`;
		const runLabel =
			run.mode === "parallel"
				? `run ${run.id.slice(0, 8)} #${child.index + 1}/${run.children.length}`
				: `run ${run.id.slice(0, 8)}`;
		const header = chromeHeader(
			theme,
			{ title: "subagent", meta: `${child.agent} · ${runLabel} · ${position}` },
			inner,
		);
		const statusParts = [describeChild(child, now)];
		if (child.transcript?.turns) statusParts.push(plural(child.transcript.turns, "turn"));
		const tone = childTone(child, now);
		const status = fitLine(
			`${theme.fg(tone, stateGlyph(child.state))} ${theme.fg(tone, statusParts.join(" · "))}`,
			inner,
		);
		const effort = theme.fg("muted", `[effort ${child.thinking ?? "default"}]`);
		const modelWidth = Math.max(0, inner - visibleWidth(effort) - 1);
		const model = chromeHeader(
			theme,
			{ title: "model", meta: child.model ?? "default (not reported)" },
			modelWidth,
		);
		const configuration = fitLine(`${padToWidth(model, modelWidth)} ${effort}`, inner);
		const task = chromeHint(theme, `task: ${firstLine(child.task, 400)}`, inner, 0);
		const recovery = this.recoveryHint(target);
		const hint = chromeHint(
			theme,
			`${recovery ? `${recovery} · ` : ""}j/k scroll · ^u/^d page · g/G top/follow · tab/⇧tab child · o ${this.expandTools ? "collapse" : "expand"} · t thinking · esc list · q close`,
			inner,
			0,
		);

		const body = renderTranscriptLines(child, inner, theme, {
			expandTools: this.expandTools,
			showThinking: this.showThinking,
			now,
		});
		const fixed = framed ? DETAIL_FIXED_ROWS : 3;
		const height = Math.max(1, maxRows - fixed);
		this.lastBodyHeight = height;
		this.lastMaxScroll = Math.max(0, body.length - height);
		if (this.follow) this.scroll = this.lastMaxScroll;
		this.scroll = Math.max(0, Math.min(this.lastMaxScroll, this.scroll));
		const visible = body.slice(this.scroll, this.scroll + height);
		while (visible.length < height) visible.push("");

		if (!framed) {
			const lines = [header, configuration, ...visible, hint].map((line) => fitLine(line, width));
			return lines.slice(0, maxRows);
		}
		const range = body.length
			? `${this.scroll + 1}-${Math.min(body.length, this.scroll + height)}/${body.length}${this.follow ? " · following" : ""}`
			: undefined;
		return [
			chromeFrameRule(theme, width, "top"),
			row(header),
			row(configuration),
			row(status),
			row(task),
			chromeFrameRule(theme, width, "divider"),
			...visible.map(row),
			chromeFrameRule(theme, width, "divider", range),
			row(hint),
			chromeFrameRule(theme, width, "bottom"),
		];
	}

	private listRows(targets: InspectorTarget[]): ListRow[] {
		const rows: ListRow[] = [];
		let lastRun: SubagentRun | undefined;
		for (const target of targets) {
			if (target.run !== lastRun) {
				rows.push({ type: "run", run: target.run });
				lastRun = target.run;
			}
			rows.push({ type: "child", target });
		}
		return rows;
	}

	private renderListRow(row: ListRow, width: number, now: number): string {
		const theme = this.theme;
		if (row.type === "run") {
			const { run } = row;
			const done = run.children.filter((child) => child.state === "completed").length;
			const failed = run.children.filter((child) => child.state === "failed").length;
			const meta = [
				run.mode,
				`${run.context} context`,
				`${done}/${run.children.length} done`,
				...(failed ? [`${failed} failed`] : []),
				formatDuration((run.endedAt ?? now) - run.startedAt),
			].join(" · ");
			return chromeItem(
				theme,
				{
					label: run.id.slice(0, 8),
					meta,
					marker: stateGlyph(run.state),
					tone: run.state === "failed" ? "error" : isActive(run) ? "accent" : "muted",
					indent: 0,
				},
				width,
			);
		}
		const { child, key } = row.target;
		const active = key === this.selectedKey;
		return chromeItem(
			theme,
			{
				label: child.agent,
				meta: describeChild(child, now),
				marker: active ? "›" : stateGlyph(child.state),
				tone: active ? undefined : childTone(child, now),
				active,
				indent: 2,
			},
			width,
		);
	}

	private renderList(width: number, maxRows: number, targets: InspectorTarget[]): string[] {
		const theme = this.theme;
		const now = this.now();
		const framed = width > 24 && maxRows >= LIST_FIXED_ROWS + 1;
		const inner = framed ? width - 4 : width;
		const row = (text: string) => (framed ? chromeFrameRow(theme, text, width) : fitLine(text, width));
		const runs = this.getRuns();
		const running = targets.filter((target) => target.child.state === "running").length;
		const header = chromeHeader(
			theme,
			{
				title: "subagents",
				meta: `${plural(runs.length, "run")} · ${plural(targets.length, "child", "children")} · ${running} running`,
			},
			inner,
		);
		const recovery = this.recoveryHint(targets[this.selectedIndex(targets)]);
		const hint = chromeHint(theme, `${recovery ? `${recovery} · ` : ""}j/k move · enter inspect · g/G ends · esc/q close`, inner, 0);

		const height = Math.max(1, maxRows - (framed ? LIST_FIXED_ROWS : 2));
		this.lastListHeight = height;
		const rows = this.listRows(targets);
		const lines: string[] = [];
		let offset = 0;
		if (!rows.length) {
			lines.push(chromeHint(theme, "No subagent runs in this session.", inner, 0));
		} else {
			if (!targets.some((target) => target.key === this.selectedKey))
				this.selectedKey = targets[0]?.key;
			const cursor = rows.findIndex(
				(entry) => entry.type === "child" && entry.target.key === this.selectedKey,
			);
			// Keep the cursor visible, preferring to show its run header too.
			const anchor = Math.max(0, cursor - 1);
			offset = Math.max(0, Math.min(anchor, rows.length - height));
			if (cursor >= offset + height) offset = cursor - height + 1;
			for (const entry of rows.slice(offset, offset + height))
				lines.push(this.renderListRow(entry, inner, now));
		}
		while (lines.length < height) lines.push("");

		if (!framed) return [header, ...lines, hint].map((line) => fitLine(line, width)).slice(0, maxRows);
		const range =
			rows.length > height
				? `${offset + 1}-${Math.min(rows.length, offset + height)}/${rows.length}`
				: undefined;
		return [
			chromeFrameRule(theme, width, "top"),
			row(header),
			chromeFrameRule(theme, width, "divider"),
			...lines.map(row),
			chromeFrameRule(theme, width, "divider", range),
			row(hint),
			chromeFrameRule(theme, width, "bottom"),
		];
	}
}
