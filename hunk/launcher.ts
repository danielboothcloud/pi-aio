// ---------------------------------------------------------------------------
// External-terminal launcher for interactive Hunk commands.
//
// Hunk's review UI is interactive (OpenTUI fullscreen); it belongs in the
// user's own terminal, matching upstream's agent workflow: the user opens
// Hunk, the agent steers it with `hunk session *`. Pi owns the current TUI,
// so aio launches Hunk in a sibling terminal instead:
//
//   1. inside tmux — a horizontal split keeps review beside the agent
//   2. macOS — AppleScript into Terminal.app (or the terminal that launched
//      Pi, when recognizable)
//   3. otherwise — print the exact command for the user to run
// ---------------------------------------------------------------------------

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type LaunchMode = "tmux" | "macos" | "print";

export interface LaunchDecision {
	readonly mode: LaunchMode;
	/** Human explanation included in command output. */
	readonly reason: string;
}

export function detectLaunchMode(env: NodeJS.ProcessEnv = process.env): LaunchDecision {
	if (env.TMUX) {
		return {
			mode: "tmux",
			reason: "launching in a new tmux window (side-by-side with this session)",
		};
	}
	if (process.platform === "darwin") {
		return {
			mode: "macos",
			reason: `launching in Terminal.app${terminalHint(env)}`,
		};
	}
	return {
		mode: "print",
		reason: "no supported terminal launcher detected; run this command yourself",
	};
}

function terminalHint(env: NodeJS.ProcessEnv): string {
	const program = env.TERM_PROGRAM;
	if (program === "iTerm.app") {
		return " (launched from iTerm2; AppleScript opens a Terminal window — drag it beside iTerm if you prefer)";
	}
	return "";
}

/**
 * Launch an interactive Hunk command in a sibling terminal.
 * Returns user-facing output describing what happened; never throws for
 * launcher failures — those degrade to the print fallback.
 */
export async function launchHunkInteractive(
	pi: { exec: (command: string, args: string[], options?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }> },
	ctx: ExtensionContext,
	args: string[],
): Promise<string> {
	const decision = detectLaunchMode();
	const command = formatHunkCommand(args);

	if (decision.mode === "tmux") {
		const ok = await tryTmux(pi, ctx.cwd, args);
		if (ok) {
			return `Hunk opened in a new tmux window: ${command}`;
		}
		return tmuxFailureOutput(command, decision.reason);
	}

	if (decision.mode === "macos") {
		const ok = await tryMacOS(pi, ctx.cwd, args);
		if (ok) {
			return `Hunk opened in a new terminal window: ${command}`;
		}
		return macosFailureOutput(command, decision.reason);
	}

	return printFallback(command, decision.reason);
}

function tmuxFailureOutput(command: string, reason: string): string {
	return `tmux launch failed. ${reason.replace("launching", "attempted launching")}.\nRun it yourself:\n  ${command}`;
}

function macosFailureOutput(command: string, reason: string): string {
	return `macOS Terminal launch failed (Automation permission may be required the first time). ${reason.replace("launching", "attempted launching")}.\nRun it yourself:\n  ${command}`;
}

function printFallback(command: string, reason: string): string {
	return `${reason}.\n  ${command}\nThen steer the review with the hunk tool (inspect, navigate, inline AI annotations).`;
}

export function formatHunkCommand(args: string[]): string {
	const quoted = args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg));
	return `hunk ${quoted.join(" ")}`;
}

async function tryTmux(
	pi: { exec: (command: string, args: string[], options?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }> },
	cwd: string,
	args: string[],
): Promise<boolean> {
	// A dedicated window keeps the fullscreen review UI beside the agent
	// session; `sh -c` survives quoted args through tmux's command string.
	const command = formatHunkCommand(args);
	const result = await pi.exec("tmux", ["new-window", "-c", cwd, `sh -c ${JSON.stringify(command)}; sh`], {
		cwd,
		timeout: 5_000,
	});
	return result.code === 0;
}

async function tryMacOS(
	pi: { exec: (command: string, args: string[], options?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }> },
	cwd: string,
	args: string[],
): Promise<boolean> {
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
