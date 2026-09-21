// ---------------------------------------------------------------------------
// aio nvim integration: open files from the agent's work in Neovim.
//
// When the agent edits or reads a file, you often want it in an editor
// immediately — /nvim <path> opens it in a Neovim buffer in a new otty
// pane beside this session (anchored to the agent's pane, like the hunk
// launcher). The open_nvim tool gives the agent the same power: after a
// write/edit it can hand you the file at the changed line.
//
// Launcher chain mirrors hunk/launcher.ts: otty pane split (when
// $OTTY_PANE_ID is set) → tmux window → otty tab → macOS Terminal.app →
// print. Neovim itself owns the pane afterward (no shell takeover — nvim
// stays open until :q).
// ---------------------------------------------------------------------------

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
 * The ordered launch plan. Same chain as the hunk launcher; otty split is
 * first because the session usually runs inside otty ($OTTY_PANE_ID).
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
