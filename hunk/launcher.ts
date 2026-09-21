// ---------------------------------------------------------------------------
// External-terminal launcher for interactive Hunk commands.
//
// Hunk's review UI is interactive (OpenTUI fullscreen); it belongs in the
// user's own terminal, matching upstream's agent workflow: the user opens
// Hunk, the agent steers it with `hunk session *`. Pi owns the current TUI,
// so aio launches Hunk in a sibling terminal. Launch attempts run in order
// and the first success wins; failures fall through silently:
//
//   1. otty pane split — when Pi runs inside Otty ($OTTY_PANE_ID), the
//      review opens anchored right beside the agent pane
//   2. tmux window — when Pi runs inside tmux
//   3. otty tab — Otty installed with the app running (fails fast to the
//      next attempt when the app is not running or the binary is absent)
//   4. macOS Terminal.app — AppleScript (when on darwin)
//   5. print — always succeeds: hand the exact command to the user
// ---------------------------------------------------------------------------

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type LaunchMode = "otty-split" | "otty-tab" | "tmux" | "macos" | "print";

export interface LaunchAttempt {
	readonly mode: LaunchMode;
	/** What this attempt will do, for user-facing output. */
	readonly reason: string;
}

export interface HunkExecLike {
	exec: (
		command: string,
		args: string[],
		options?: { timeout?: number; cwd?: string },
	) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * The ordered launch plan for the current environment. `print` is always
 * last and always succeeds, so the chain terminates.
 */
export function planLaunchAttempts(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
): LaunchAttempt[] {
	const attempts: LaunchAttempt[] = [];

	const ottyPaneId = env.OTTY_PANE_ID;
	if (typeof ottyPaneId === "string" && ottyPaneId.length > 0) {
		attempts.push({
			mode: "otty-split",
			reason: "splitting the current Otty pane so the review opens beside this session",
		});
	}

	if (env.TMUX) {
		attempts.push({
			mode: "tmux",
			reason: "launching in a new tmux window (side-by-side with this session)",
		});
	}

	attempts.push({
		mode: "otty-tab",
		reason: "opening a new tab in the running Otty app",
	});

	if (platform === "darwin") {
		const program = env.TERM_PROGRAM;
		const hint = program === "iTerm.app"
			? " (launched from iTerm2; AppleScript opens a Terminal window — drag it beside iTerm if you prefer)"
			: "";
		attempts.push({
			mode: "macos",
			reason: `launching in Terminal.app${hint}`,
		});
	}

	attempts.push({
		mode: "print",
		reason: "no terminal launcher available; run this command yourself",
	});

	return attempts;
}

/**
 * Launch an interactive Hunk command in a sibling terminal by walking the
 * launch plan. Returns user-facing output describing what happened; never
 * throws for launcher failures — those fall through to the next attempt.
 */
export async function launchHunkInteractive(
	pi: HunkExecLike,
	ctx: ExtensionContext,
	args: string[],
): Promise<string> {
	const command = formatHunkCommand(args);

	for (const attempt of planLaunchAttempts()) {
		let launched = false;
		switch (attempt.mode) {
			case "otty-split":
				launched = await tryOtty(pi, ctx.cwd, args, {
					variant: "split",
					paneId: process.env.OTTY_PANE_ID,
				});
				if (launched) {
					return `Hunk opened in a new Otty pane beside this session: ${command}`;
				}
				break;
			case "otty-tab":
				launched = await tryOtty(pi, ctx.cwd, args, { variant: "tab" });
				if (launched) {
					return `Hunk opened in a new Otty tab: ${command}`;
				}
				break;
			case "tmux":
				launched = await tryTmux(pi, ctx.cwd, args);
				if (launched) {
					return `Hunk opened in a new tmux window: ${command}`;
				}
				break;
			case "macos":
				launched = await tryMacOS(pi, ctx.cwd, args);
				if (launched) {
					return `Hunk opened in a new terminal window: ${command}`;
				}
				break;
			case "print":
				return printFallback(command, attempt.reason);
		}
	}

	// Unreachable: the print attempt always succeeds.
	return printFallback(command, "no terminal launcher available; run this command yourself");
}

export function formatHunkCommand(args: string[]): string {
	const quoted = args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg));
	return `hunk ${quoted.join(" ")}`;
}

/**
 * Build the `--command` value for an Otty pane/tab: the hunk command runs,
 * and an interactive shell takes over only on failure so launch errors stay
 * visible instead of the pane silently disappearing. Otty's `--cwd` flag
 * handles the working directory, so no `cd` is needed in the script.
 */
export function buildOttyCommand(args: string[]): string {
	const script = `${formatHunkCommand(args)}; status=$?; if [ $status -ne 0 ]; then exec sh; fi`;
	return `sh -c ${shellSingleQuote(script)}`;
}

/** Single-quote a value for POSIX sh, escaping embedded single quotes. */
export function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface OttyOptions {
	readonly variant: "split" | "tab";
	/** Anchor pane for split (only when launching from inside Otty). */
	readonly paneId?: string;
}

function ottyArgs(options: OttyOptions, cwd: string, args: string[]): string[] {
	if (options.variant === "split") {
		const splitArgs = ["pane", "split", "--direction", "right", "--size", "50"];
		if (options.paneId) {
			// Anchor to the pane Pi runs in, not the currently focused pane,
			// so the review lands beside this session even if focus moved.
			splitArgs.push("--pane", options.paneId);
		}
		splitArgs.push("--cwd", cwd, "--command", buildOttyCommand(args), "--title", "hunk", "--quiet");
		return splitArgs;
	}
	return ["tab", "new", "--cwd", cwd, "--command", buildOttyCommand(args), "--title", "hunk", "--quiet"];
}

/**
 * Launch via the Otty CLI. Returns false when the binary is missing, the
 * app is not running, or the anchor pane no longer exists — every failure
 * falls through to the next launcher attempt.
 */
async function tryOtty(
	pi: HunkExecLike,
	cwd: string,
	args: string[],
	options: OttyOptions,
): Promise<boolean> {
	try {
		const result = await pi.exec("otty", ottyArgs(options, cwd, args), {
			cwd,
			timeout: 10_000,
		});
		return result.code === 0;
	} catch {
		return false;
	}
}

async function tryTmux(pi: HunkExecLike, cwd: string, args: string[]): Promise<boolean> {
	// A dedicated window keeps the fullscreen review UI beside the agent
	// session; `sh -c` survives quoted args through tmux's command string.
	const command = formatHunkCommand(args);
	const result = await pi.exec("tmux", ["new-window", "-c", cwd, `sh -c ${JSON.stringify(command)}; sh`], {
		cwd,
		timeout: 5_000,
	});
	return result.code === 0;
}

async function tryMacOS(pi: HunkExecLike, cwd: string, args: string[]): Promise<boolean> {
	// Terminal.app honors `do script`; the trailing `; exec sh` keeps the
	// window open after Hunk quits so the user sees any error text.
	const command = formatHunkCommand(args);
	const script =
		`tell application "Terminal"\n` +
		`\tactivate\n` +
		`\tdo script "cd ${escapeAppleScriptString(cwd)} && ${escapeAppleScriptString(command)}; exec sh"\n` +
		`end tell`;
	const result = await pi.exec("osascript", ["-e", script], {
		cwd,
		timeout: 5_000,
	});
	return result.code === 0;
}

function escapeAppleScriptString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function printFallback(command: string, reason: string): string {
	return `${reason}.\n  ${command}\nThen steer the review with the hunk tool (inspect, navigate, inline AI annotations).`;
}
