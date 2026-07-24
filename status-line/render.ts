import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { modeMetadata } from "../permission-modes/index.js";
import type { PermissionMode } from "../permission-modes/mode-access.js";
import { formatCount } from "../permission-modes/utils.js";
import type { PathDisplay, StatusLineConfig, StatusLineSegment, WorkingMessageMode } from "./config.js";

export interface PiTheme {
	fg(name: string, text: string): string;
}

export interface UsageStats {
	input: number;
	output: number;
	cost: number;
}

export interface StatusLineRenderInput {
	width: number;
	theme: PiTheme;
	config: StatusLineConfig;
	cwd: string;
	model: { provider?: string; id?: string } | null | undefined;
	mode: PermissionMode;
	gitBranch: string | null;
	contextPercent: number;
	extensionStatuses: ReadonlyMap<string, string>;
	usageStats: UsageStats;
}

const STATUS_KEY_ORDER = ["rtk", "effort", "user-bash", "fff"] as const;
const HIDDEN_STATUS_KEYS = new Set(["modes"]);

function formatPath(cwd: string, display: PathDisplay): string {
	if (!cwd) return "";
	if (display === "full") return cwd;
	const home = process.env.HOME;
	if (display === "abbreviated") {
		const normalized = home && cwd.startsWith(home)
			? `~${cwd.slice(home.length)}`
			: cwd;
		const parts = normalized.split(/[/\\]/).filter(Boolean);
		if (parts.length <= 2) return normalized;
		return `…/${parts.slice(-2).join("/")}`;
	}
	const parts = cwd.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

function contextRole(percent: number): "dim" | "warning" | "error" {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "dim";
}

function formatModel(model: StatusLineRenderInput["model"]): string {
	if (!model?.id) return "no-model";
	if (model.provider) return `${model.provider}/${model.id}`;
	return model.id;
}

function orderedStatusEntries(
	statuses: ReadonlyMap<string, string>,
	statusKeys: string[] | undefined,
): Array<[string, string]> {
	const entries = [...statuses.entries()].filter(
		([key, value]) =>
			!HIDDEN_STATUS_KEYS.has(key) && typeof value === "string" && value.length > 0,
	);
	if (statusKeys && statusKeys.length > 0) {
		const allow = new Set(statusKeys);
		return entries.filter(([key]) => allow.has(key));
	}

	const rank = new Map<string, number>(
		STATUS_KEY_ORDER.map((key, index) => [key, index]),
	);
	return entries.sort(([a], [b]) => {
		const ra = rank.get(a);
		const rb = rank.get(b);
		if (ra !== undefined && rb !== undefined) return ra - rb;
		if (ra !== undefined) return -1;
		if (rb !== undefined) return 1;
		return a.localeCompare(b);
	});
}

function renderSegment(
	segment: StatusLineSegment,
	input: StatusLineRenderInput,
): string | undefined {
	const { theme, config, mode, gitBranch, contextPercent, usageStats } = input;

	switch (segment) {
		case "mode": {
			const meta = modeMetadata(mode);
			return theme.fg(meta.role, meta.label);
		}
		case "path": {
			const path = formatPath(input.cwd, config.path);
			return path ? theme.fg("dim", path) : undefined;
		}
		case "git":
			return gitBranch ? theme.fg("dim", gitBranch) : undefined;
		case "context":
			return theme.fg(contextRole(contextPercent), `${contextPercent}%`);
		case "statuses": {
			const entries = orderedStatusEntries(
				input.extensionStatuses,
				config.statusKeys,
			);
			if (entries.length === 0) return undefined;
			return entries.map(([, value]) => value).join(" ");
		}
		case "model":
			return theme.fg("dim", formatModel(input.model));
		case "tokens":
			return theme.fg(
				"dim",
				`↑${formatCount(usageStats.input)} ↓${formatCount(usageStats.output)}`,
			);
		case "cost":
			return theme.fg("dim", `$${usageStats.cost.toFixed(3)}`);
		default:
			return undefined;
	}
}

/** Assemble footer segments into one dim-separated row, truncated to width. */
export function renderStatusLine(input: StatusLineRenderInput): string[] {
	const parts: string[] = [];
	for (const segment of input.config.segments) {
		const rendered = renderSegment(segment, input);
		if (rendered) parts.push(rendered);
	}
	if (parts.length === 0) return [""];

	const separator = input.theme.fg("dim", " · ");
	const line = parts.join(separator);
	return [truncateToWidth(line, input.width)];
}

export function computeContextPercent(ctx: {
	getContextUsage?: () => { tokens?: number; contextWindow?: number } | undefined;
}): number {
	const usage = ctx.getContextUsage?.();
	const tokens = usage?.tokens ?? 0;
	const contextWindow = usage?.contextWindow ?? 0;
	if (tokens <= 0 || contextWindow <= 0) return 0;
	return Math.round((tokens / contextWindow) * 100);
}

export function computeUsageStats(
	branch: Iterable<{ type?: string; message?: { role?: string; usage?: {
		input?: number;
		output?: number;
		cost?: { total?: number };
	} } }>,
): UsageStats {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage;
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
		cost += usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

export function formatWorkingMessage(
	mode: WorkingMessageMode,
	stats: UsageStats & { contextPercent: number; elapsedSec: number; tps: number },
): string | undefined {
	if (mode === "off") return undefined;
	if (mode === "minimal") return "Working…";
	return (
		`Working (${stats.elapsedSec.toFixed(1)}s  ↑${formatCount(stats.input)} ` +
		`↓${formatCount(stats.output)} ${stats.tps.toFixed(1)} tok/s  ${stats.contextPercent}% ctx)`
	);
}