// The review flow: pick a target, snapshot existing tuicr comments, run the
// foreground review session, then feed comments created during that session
// back into the editor. Ported from @joelazar/pi-tuicr 1.1.0 — comments that
// already existed in tuicr before the run are ignored, so an old review
// never comes back a second time.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allComments, format, type Capture } from "./core.js";
import { pickTarget } from "./picker.js";
import { runTuicr, type ForegroundSpawn } from "./runner.js";

/** Seams for the review flow; production wires the child_process impls. */
export interface ReviewDeps {
	capture: Capture;
	spawn: ForegroundSpawn;
}

export async function review(ctx: ExtensionContext, deps: ReviewDeps): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("tuicr needs an interactive terminal", "error");
		return;
	}

	const args = await pickTarget(ctx, deps.capture);
	if (!args) return;

	// Snapshot existing comment ids, so only this session's feedback comes back.
	const seen = new Set(allComments(ctx.cwd, deps.capture).map((comment) => comment.id));

	const status = await runTuicr(ctx, args, deps.spawn);
	if (status === null) {
		ctx.ui.notify("Could not start tuicr - is it on your PATH?", "error");
		return;
	}
	if (status !== 0) {
		ctx.ui.notify(`tuicr exited with status ${status}`, "error");
		return;
	}

	const fresh = allComments(ctx.cwd, deps.capture).filter((comment) => !seen.has(comment.id));
	if (fresh.length === 0) {
		ctx.ui.notify("No new review comments", "info");
		return;
	}

	ctx.ui.setEditorText(format(fresh));
	ctx.ui.notify(
		`${fresh.length} review comment${fresh.length === 1 ? "" : "s"} ready - press enter to send`,
		"info",
	);
}
