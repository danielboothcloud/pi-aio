/**
 * Formatting helpers and session usage totals for the AIO frame — adapted
 * from pi-zentui's format.ts (MIT, see UPSTREAM.md). Only the surfaces the
 * Minimalist frame renders are retained.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Classify input: normal (""), `!` shell, or `!!` no-context shell. */
export function bashModeLabel(text: string): "" | "shell" | "no-context" {
	const trimmed = text.trimStart();
	return trimmed.startsWith("!!") ? "no-context" : trimmed.startsWith("!") ? "shell" : "";
}

export function formatCount(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 1_000_000) {
		return value < 10_000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value / 1000)}k`;
	}
	return value < 10_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1_000_000)}M`;
}

/** Human-readable whole-second duration used by the minimalist frame timer. */
export function formatElapsedDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export type ContextThresholds = { warning: number; error: number };
export type ContextColorTier = "normal" | "warning" | "error";

export function contextColorTier(
	percent: number | null | undefined,
	thresholds: ContextThresholds = { warning: 70, error: 90 },
): ContextColorTier {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return "normal";
	if (percent >= thresholds.error) return "error";
	if (percent >= thresholds.warning) return "warning";
	return "normal";
}

export function buildContextGauge(percent: number, width = 10, ascii = false): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const on = ascii ? "#" : "█";
	const off = ascii ? "-" : "░";
	return `${on.repeat(filled)}${off.repeat(Math.max(0, width - filled))}`;
}

// --- Session usage totals -------------------------------------------------

const MAX_USAGE_TOTAL = Number.MAX_SAFE_INTEGER;

interface SessionUsage {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown } | unknown;
}

interface SessionEntryLike {
	id?: unknown;
	timestamp?: unknown;
	type?: string;
	message?: { role?: string; usage?: SessionUsage };
	usage?: SessionUsage;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function normalizeUsageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageCostTotal(usage: SessionUsage | undefined): number {
	if (typeof usage?.cost !== "object" || usage.cost === null) return 0;
	return normalizeUsageNumber((usage.cost as { total?: unknown }).total);
}

function addUsageTotal(total: number, value: number): number {
	const sum = total + value;
	return Number.isFinite(sum) ? sum : MAX_USAGE_TOTAL;
}

function usageForEntry(entry: SessionEntryLike): { usage: SessionUsage | undefined } | undefined {
	if (entry.type === "message") {
		const role = entry.message?.role;
		if (role !== "assistant" && role !== "toolResult") return undefined;
		return { usage: entry.message?.usage };
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { usage: entry.usage };
	}
	return undefined;
}

function entryIdentity(entry: SessionEntryLike): string {
	const selected = usageForEntry(entry);
	if (!selected) return "unsupported";
	const usage = selected.usage;
	return JSON.stringify([
		entry.id ?? null,
		entry.timestamp ?? null,
		entry.type ?? null,
		entry.message?.role ?? null,
		normalizeUsageNumber(usage?.input),
		normalizeUsageNumber(usage?.output),
		normalizeUsageNumber(usage?.cacheRead),
		normalizeUsageNumber(usage?.cacheWrite),
		usageCostTotal(usage),
	]);
}

function computeUsageTotals(entries: readonly SessionEntryLike[]): UsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	for (const entry of entries) {
		const selected = usageForEntry(entry);
		if (!selected) continue;
		const usage = selected.usage;
		input = addUsageTotal(input, normalizeUsageNumber(usage?.input));
		output = addUsageTotal(output, normalizeUsageNumber(usage?.output));
		cacheRead = addUsageTotal(cacheRead, normalizeUsageNumber(usage?.cacheRead));
		cacheWrite = addUsageTotal(cacheWrite, normalizeUsageNumber(usage?.cacheWrite));
		cost = addUsageTotal(cost, usageCostTotal(usage));
	}
	return { input, output, cacheRead, cacheWrite, cost };
}

let usageTotalsCache: { key: string; totals: UsageTotals } | undefined;

export function invalidateUsageTotalsCache(): void {
	usageTotalsCache = undefined;
}

/** Fingerprint-cached token/cost totals over the current session branch. */
export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const sessionManager = ctx.sessionManager as {
		getEntries?: () => readonly SessionEntryLike[];
		getBranch: () => readonly SessionEntryLike[];
	};
	const entries =
		typeof sessionManager.getEntries === "function"
			? sessionManager.getEntries()
			: sessionManager.getBranch();
	const key = entries.map(entryIdentity).join("\0");
	if (usageTotalsCache?.key === key) return usageTotalsCache.totals;
	const totals = computeUsageTotals(entries);
	usageTotalsCache = { key, totals };
	return totals;
}

export function buildCostLabel(totals: UsageTotals): string {
	return `$${totals.cost.toFixed(3)}`;
}

// --- Context and cwd ------------------------------------------------------

export interface ContextUsageSnapshot {
	percent?: number;
	contextWindow?: number;
}

export function resolveContextUsage(
	ctx: Pick<ExtensionContext, "model" | "getContextUsage">,
): ContextUsageSnapshot {
	const modelWindow = ctx.model?.contextWindow;
	const usage = ctx.getContextUsage();
	const contextWindow = modelWindow ?? usage?.contextWindow;
	return { percent: usage?.percent ?? undefined, contextWindow };
}

function toHomePath(path: string, home: string): string {
	if (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}${sep}`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export type FramePathDisplayMode = "compact" | "project" | "full";

/** `compact` = basename, `project` = root-relative, `full` = home-abbreviated. */
export function formatCwdLabel(
	cwd: string,
	mode: FramePathDisplayMode,
	projectRoot?: string,
): string {
	const home = (() => {
		try {
			return homedir();
		} catch {
			return "";
		}
	})();
	const full = () => toHomePath(cwd, home);
	if (mode === "full") return full();
	if (mode === "compact") {
		const parts = cwd.split("/").filter(Boolean);
		return parts[parts.length - 1] ?? cwd;
	}
	if (!projectRoot) return full();
	const pathFromRoot = relative(projectRoot, cwd);
	if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
		return full();
	}
	const project = projectRoot.split("/").filter(Boolean).at(-1) ?? projectRoot;
	return pathFromRoot ? `${project}/${pathFromRoot}` : project;
}
