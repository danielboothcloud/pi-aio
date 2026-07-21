/**
 * pi-pretty: utility helpers.
 */

import { relative } from "node:path";
import { getPermissionModeAccess } from "../permission-modes/mode-access.js";

// ---------------------------------------------------------------------------
// String / normalization
// ---------------------------------------------------------------------------

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function shortPath(cwd: string, home: string, p: string): string {
	if (!p) return "";
	const r = relative(cwd, p);
	if (!r.startsWith("..") && !r.startsWith("/")) return r;
	return p.replace(home, "~");
}

export function stripBashExitStatusLine(text: string): string {
	return normalizeLineEndings(text)
		.split("\n")
		.filter((line) => !/^Command exited with code \d+$/i.test(line.trim()))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Tool metrics
// ---------------------------------------------------------------------------

export function formatElapsedMs(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function formatCharCount(chars: number | undefined): string {
	if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return "";
	if (chars < 1000) return `${chars} chars`;
	if (chars < 10_000) return `${(chars / 1000).toFixed(1)}k chars`;
	return `${Math.round(chars / 1000)}k chars`;
}

export const ELAPSED_KEY = "__prettyElapsedMs";
export const CHARS_KEY = "__prettyOutputChars";

// ---------------------------------------------------------------------------
// Infer bash exit code
// ---------------------------------------------------------------------------

export function inferBashExitCode(text: string, fallback: number | null): number | null {
	const exitMatch = text.match(/(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i);
	if (exitMatch) return Number(exitMatch[1]);
	if (text.includes("command not found") || text.includes("No such file")) return 1;
	return fallback;
}

// ---------------------------------------------------------------------------
// Compact error lines
// ---------------------------------------------------------------------------

export function isPassiveExplorationMode(): boolean {
	const mode = getPermissionModeAccess()?.getMode();
	return mode === "plan" || mode === "ask";
}

/** Drop engine/debug footers; keep limits, partial index, and pagination hints. */
export function filterSearchNotices(notices: string[]): string[] {
	return notices.filter(
		(notice) =>
			!/^(Search engine:|FFF find unavailable|FFF glob returned no matches)/i.test(notice.trim()),
	);
}

export function countGrepMatchLines(text: string): number {
	return normalizeLineEndings(text)
		.split("\n")
		.filter((line) => /^.+:\d+:/.test(line.trim()))
		.length;
}

export function compactSearchSummary(
	tool: "grep" | "find",
	query: string,
	count: number,
	unit: "matches" | "files",
	expanded: boolean,
): string {
	const label = query ? `${tool} ${query}` : tool;
	const hint = expanded ? "" : " · ctrl+o";
	return `${label} · ${count} ${unit}${hint}`;
}

export function compactErrorLines(error: string): string[] {
	const compactedLines: string[] = [];
	let previousBlank = false;
	for (const line of normalizeLineEndings(error).trim().split("\n")) {
		const isBlank = line.trim() === "";
		if (isBlank && previousBlank) continue;
		compactedLines.push(line);
		previousBlank = isBlank;
	}
	return compactedLines;
}
