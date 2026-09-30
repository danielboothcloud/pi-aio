// ---------------------------------------------------------------------------
// aio tuicr integration — registration.
//
//   /tuicr          pick a diff, review it in tuicr, load the comments
//   ctrl+shift+r    same, without typing
//
// The review runs in the foreground: pi's TUI suspends, tuicr takes the
// terminal, and when it exits every comment created during that session is
// collected, numbered, and prefilled into the editor — press enter to send
// them back to the agent.
//
// Ported from @joelazar/pi-tuicr 1.1.0 (MIT, joelazar — see UPSTREAM.md).
// tuicr is OPTIONAL: a missing binary only fails the run with a clear
// notify and never prevents the extension from loading.
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureSync } from "./core.js";
import { review, type ReviewDeps } from "./review.js";
import { spawnSyncForeground } from "./runner.js";

export { allComments, baseBranch, format } from "./core.js";
export { pickTarget, type ReviewTarget } from "./picker.js";
export { runTuicr, type ForegroundSpawn } from "./runner.js";
export type { TuicrComment, TuicrSession } from "./core.js";

export default function registerTuicr(pi: ExtensionAPI): void {
	const deps: ReviewDeps = { capture: captureSync, spawn: spawnSyncForeground };
	const start = async (ctx: ExtensionContext): Promise<void> => {
		await review(ctx, deps);
	};

	pi.registerCommand("tuicr", {
		description: "Review a diff in tuicr, then load comments",
		handler: async (_args, ctx) => {
			await start(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Review a diff in tuicr",
		handler: start,
	});
}
