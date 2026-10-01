// ---------------------------------------------------------------------------
// aio nvim integration: open files from the agent's work in Neovim.
//
// When the agent edits or reads a file, you often want it in an editor
// immediately — /nvim <path> opens it in a Neovim buffer in a new otty
// pane beside this session (anchored to the agent's pane).
//
// Launcher chain: otty pane split (when
// $OTTY_PANE_ID is set) → tmux window → otty tab → macOS Terminal.app →
// print. Neovim itself owns the pane afterward (no shell takeover — nvim
// stays open until :q).
// ---------------------------------------------------------------------------

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath, relative } from "node:path";
import { applyPatchStructuredChanges, getToolFileChanges, getChangedPaths } from "../yaml-hooks/tool-paths.js";

export type NvimLaunchMode = "otty-split" | "otty-tab" | "tmux" | "macos" | "print";

export interface NvimLaunchAttempt {
	readonly mode: NvimLaunchMode;
	readonly reason: string;
}

export interface NvimExecLike {
	exec: (
		command: string,
		args: string[],
		options?: { timeout?: number; cwd?: string },
	) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface NvimOpenRequest {
	/** File to open (absolute, relative to cwd, or file:line shorthand). */
	path: string;
	/** Optional 1-based line to place the cursor on. */
	line?: number;
	/** Optional column (1-based). */
	column?: number;
	/** Read-only view when true (nvim -R). */
	readOnly?: boolean;
	/** Extra nvim arguments (e.g. -c commands). */
	extraArgs?: readonly string[];
}

export const NVIM_BINARY = "nvim";

/**
 * The ordered launch plan. Otty split is first because the session usually
 * runs inside otty ($OTTY_PANE_ID).
 */
export function planNvimLaunchAttempts(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
): NvimLaunchAttempt[] {
	const attempts: NvimLaunchAttempt[] = [];
	if (typeof env.OTTY_PANE_ID === "string" && env.OTTY_PANE_ID.length > 0) {
		attempts.push({
			mode: "otty-split",
			reason: "splitting the current Otty pane so the file opens beside this session",
		});
	}
	if (env.TMUX) {
		attempts.push({ mode: "tmux", reason: "opening in a new tmux window" });
	}
	attempts.push({ mode: "otty-tab", reason: "opening a new tab in the running Otty app" });
	if (platform === "darwin") {
		attempts.push({ mode: "macos", reason: "opening in Terminal.app" });
	}
	attempts.push({ mode: "print", reason: "no terminal launcher available; run this command yourself" });
	return attempts;
}

/** Build the nvim argv for a request. */
export function buildNvimArgs(request: NvimOpenRequest): string[] {
	const args: string[] = [];
	if (request.readOnly) args.push("-R");
	// +N places the cursor on line N; +N,M also sets the column.
	if (request.line !== undefined && Number.isInteger(request.line) && request.line >= 1) {
		args.push(request.column !== undefined && request.column >= 1 ? `+${request.line},${request.column}` : `+${request.line}`);
	}
	if (request.extraArgs) {
		args.push(...request.extraArgs);
	}
	args.push("--", request.path);
	return args;
}

/** Parse "path", "path:42", "path:42:7" into a request path/line/column. */
export function parseFileTarget(target: string): { path: string; line?: number; column?: number } {
	const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(target.trim());
	if (!match) {
		return { path: target.trim() };
	}
	const line = Number.parseInt(match[2] ?? "", 10);
	const column = match[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
	return {
		path: match[1] ?? target.trim(),
		...(Number.isFinite(line) && line >= 1 ? { line } : {}),
		...(column !== undefined && Number.isFinite(column) && column >= 1 ? { column } : {}),
	};
}

/**
 * Strip an @-reference wrapper. Pi's built-in @-file completion inserts
 * `@path` (and `@"path with spaces"` when quoting is needed); the /nvim
 * handler must remove the wrapper or nvim opens a nonexistent file.
 */
export function stripAtReference(token: string): string {
	const trimmed = token.trim();
	const quoted = /^@"([^"]*)"$/.exec(trimmed);
	if (quoted) return quoted[1] ?? "";
	return trimmed.replace(/^@/, "");
}

/**
 * Split /nvim arguments into targets. @-prefixed tokens (from pi's @-file
 * completion or typed by hand) mark list mode: each token is one target,
 * so /nvim @a.ts:12 @b.ts opens both. Without @ the whole argument string
 * stays a single target (paths may contain spaces).
 */
export function splitNvimTargets(args: string): string[] {
	const trimmed = args.trim();
	if (trimmed.length === 0) return [];
	if (!trimmed.includes("@")) return [trimmed];
	return trimmed.split(/\s+/).filter((token) => token.length > 0);
}

/** Single-quote a value for POSIX sh. */
export function shellSingleQuoteNvim(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Format the full nvim command line (for tmux/AppleScript/print fallbacks). */
export function formatNvimCommand(request: NvimOpenRequest): string {
	const parts = [NVIM_BINARY, ...buildNvimArgs(request)];
	const quoted = parts.map((arg) => (/^[A-Za-z0-9@._/+:=,-]+$/.test(arg) ? arg : shellSingleQuoteNvim(arg)));
	return quoted.join(" ");
}

/** Build the --command value for an Otty pane/tab (exec nvim keeps the pane alive in nvim). */
export function buildOttyNvimCommand(request: NvimOpenRequest): string {
	return `exec ${formatNvimCommand(request)}`;
}

interface OttyOptions {
	readonly variant: "split" | "tab";
	readonly paneId?: string;
}

function ottyArgs(options: OttyOptions, cwd: string, request: NvimOpenRequest): string[] {
	const command = buildOttyNvimCommand(request);
	const title = nvimTitle(request);
	if (options.variant === "split") {
		const splitArgs = ["pane", "split", "--direction", "right", "--size", "50"];
		if (options.paneId) {
			splitArgs.push("--pane", options.paneId);
		}
		splitArgs.push("--cwd", cwd, "--command", command, "--title", title, "--quiet");
		return splitArgs;
	}
	return ["tab", "new", "--cwd", cwd, "--command", command, "--title", title, "--quiet"];
}

/** Short pane title: the file basename (with :line when anchored). */
export function nvimTitle(request: NvimOpenRequest): string {
	const base = request.path.split("/").pop() ?? request.path;
	return request.line !== undefined ? `nvim ${base}:${request.line}` : `nvim ${base}`;
}

/** Launch via the Otty CLI; false falls through to the next attempt. */
async function tryOtty(pi: NvimExecLike, cwd: string, request: NvimOpenRequest, options: OttyOptions): Promise<boolean> {
	try {
		const result = await pi.exec("otty", ottyArgs(options, cwd, request), { cwd, timeout: 10_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

async function tryTmuxNvim(pi: NvimExecLike, cwd: string, request: NvimOpenRequest): Promise<boolean> {
	const command = formatNvimCommand(request);
	const result = await pi.exec("tmux", ["new-window", "-c", cwd, command], { cwd, timeout: 5_000 });
	return result.code === 0;
}

async function tryMacOSNvim(pi: NvimExecLike, cwd: string, request: NvimOpenRequest): Promise<boolean> {
	const command = formatNvimCommand(request);
	const script =
		`tell application "Terminal"\n` +
		`\tactivate\n` +
		`\tdo script "cd ${escapeAppleScriptNvim(cwd)} && ${escapeAppleScriptNvim(command)}"\n` +
		`end tell`;
	const result = await pi.exec("osascript", ["-e", script], { cwd, timeout: 5_000 });
	return result.code === 0;
}

function escapeAppleScriptNvim(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function printFallbackNvim(command: string, reason: string): string {
	return `${reason}.\n  ${command}`;
}

/**
 * Open a file in Neovim by walking the launch plan; the first success wins
 * and failures fall through silently. Returns user-facing output.
 */
export async function openInNvim(
	pi: NvimExecLike,
	ctx: ExtensionContext,
	request: NvimOpenRequest,
): Promise<string> {
	const command = formatNvimCommand(request);
	for (const attempt of planNvimLaunchAttempts()) {
		let launched = false;
		switch (attempt.mode) {
			case "otty-split":
				launched = await tryOtty(pi, ctx.cwd, request, { variant: "split", paneId: process.env.OTTY_PANE_ID });
				if (launched) {
					return `Opened ${describeTarget(request)} in Neovim in a new Otty pane beside this session`;
				}
				break;
			case "tmux":
				launched = await tryTmuxNvim(pi, ctx.cwd, request);
				if (launched) {
					return `Opened ${describeTarget(request)} in Neovim in a new tmux window`;
				}
				break;
			case "otty-tab":
				launched = await tryOtty(pi, ctx.cwd, request, { variant: "tab" });
				if (launched) {
					return `Opened ${describeTarget(request)} in Neovim in a new Otty tab`;
				}
				break;
			case "macos":
				launched = await tryMacOSNvim(pi, ctx.cwd, request);
				if (launched) {
					return `Opened ${describeTarget(request)} in Neovim in a new terminal window`;
				}
				break;
			case "print":
				return printFallbackNvim(command, attempt.reason);
			default:
				// Exhaustive over NvimLaunchMode today; an unknown future mode
				// falls through to the next attempt like any failed launcher.
				break;
		}
	}
	return printFallbackNvim(command, "no terminal launcher available; run this command yourself");
}

function describeTarget(request: NvimOpenRequest): string {
	const label = request.readOnly ? `${request.path} (read-only)` : request.path;
	return request.line !== undefined ? `${label}:${request.line}` : label;
}

/** Resolve a request path against ctx.cwd (absolute paths pass through). */
export function resolveNvimPath(path: string, cwd: string): string {
	if (path.startsWith("/")) return path;
	return `${cwd}/${path}`;
}

// ---- session file tracking (the /nvim suggestion source) ----
//
// Pure helpers so the node:test suite can exercise them without the SDK
// value-import chain; index.ts wires them to tool_result events and the
// command completions.

/** How many session-touched files the MRU remembers. */
export const SESSION_FILE_LIMIT = 40;

export interface SessionFileEntry {
	/** Absolute path. */
	readonly path: string;
	/** True when a mutation tool touched it (vs read-only). */
	readonly edited: boolean;
	/** Recency stamp (Date.now() at the tool_result). */
	readonly touchedAt: number;
}

/** One tool_result's file footprint: touched paths + whether any was a mutation. */
export function filePathsFromToolResult(event: ToolResultEvent): { paths: string[]; edited: boolean } {
	if (event.isError) return { paths: [], edited: false };
	const args = (event.input ?? {}) as Record<string, unknown>;
	if (event.toolName === "read") {
		const path = [args.path, args.file_path].find(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		return path !== undefined ? { paths: [path], edited: false } : { paths: [], edited: false };
	}
	const structured =
		event.toolName === "apply_patch" || event.toolName === "patch" ? applyPatchStructuredChanges(args) : [];
	const changes = structured.length > 0 ? structured : getToolFileChanges(event.toolName, args);
	if (changes.length === 0) return { paths: [], edited: false };
	return { paths: getChangedPaths(changes), edited: true };
}

/** Pure MRU merge: newest first, deduped, edited-ness sticky, bounded. */
export function touchSessionFiles(
	entries: readonly SessionFileEntry[],
	paths: readonly string[],
	edited: boolean,
	now: number,
	limit: number = SESSION_FILE_LIMIT,
): SessionFileEntry[] {
	const result = entries.filter((entry) => !paths.includes(entry.path));
	for (const path of [...paths].reverse()) {
		const previous = entries.find((entry) => entry.path === path);
		result.unshift({ path, edited: (previous?.edited ?? false) || edited, touchedAt: now });
	}
	return result.slice(0, limit);
}

export interface NvimCompletion {
	value: string;
	label: string;
	description: string;
}

/**
 * Pure completion builder: session files first (MRU order), then project
 * files. Values are @-prefixed so selection reads naturally and the
 * handler strips the wrapper; matching runs on the whole absolute path so
 * both "src" and "@src" prefixes behave the same.
 */
export function buildNvimCompletions(
	prefix: string,
	sessionEntries: readonly SessionFileEntry[],
	projectPaths: readonly string[],
	cwd: string,
	limit = 12,
): NvimCompletion[] {
	const raw = (prefix.startsWith("@") ? prefix.slice(1) : prefix).trim().toLowerCase();
	const matches = (absolute: string): boolean => raw.length === 0 || absolute.toLowerCase().includes(raw);
	const items: NvimCompletion[] = [];
	const seen = new Set<string>();
	const push = (absolute: string, description: string): void => {
		if (items.length >= limit || seen.has(absolute) || !matches(absolute)) return;
		seen.add(absolute);
		const rel = relative(cwd, absolute);
		const display = rel.length > 0 && !rel.startsWith("..") ? rel : absolute;
		items.push({ value: `@${display}`, label: display, description });
	};
	for (const entry of sessionEntries) {
		push(entry.path, entry.edited ? "edited this session" : "read this session");
	}
	for (const projectPath of projectPaths) {
		push(resolvePath(cwd, projectPath), "project file");
	}
	return items;
}
