// Foreground tuicr runner: suspend pi's TUI, hand the terminal to tuicr,
// then restore the TUI when the review session exits. Ported from
// @joelazar/pi-tuicr 1.1.0. The spawn goes through a seam so tests never
// launch a real tuicr process.

import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TUICR_COMMAND } from "./core.js";

/** The spawn seam: run a command in the foreground with inherited stdio. */
export type ForegroundSpawn = (
	command: string,
	args: string[],
	cwd: string,
) => { status: number | null; error?: Error };

/** Production seam: spawnSync inheriting stdio and the environment. */
export const spawnSyncForeground: ForegroundSpawn = (command, args, cwd) => {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: process.env,
		cwd,
	});
	return { status: result.status, error: result.error };
};

/**
 * Suspend the TUI, run tuicr inheriting stdio, then restore the TUI.
 * Returns the exit status, or null when tuicr could not start.
 */
export function runTuicr(
	ctx: ExtensionContext,
	args: string[],
	spawn: ForegroundSpawn = spawnSyncForeground,
): Promise<number | null> {
	return ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");

		const result = spawn(TUICR_COMMAND, args, ctx.cwd);

		tui.start();
		tui.requestRender(true);
		done(result.error ? null : result.status);
		return { render: () => [], invalidate: () => {} };
	});
}
