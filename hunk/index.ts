// ---------------------------------------------------------------------------
// aio hunk integration: /hunk command family + tool + skill registration.
//
// Two surfaces, matching upstream's agent workflow:
//   1. The `hunk` model tool wraps the non-interactive `hunk session *` CLI
//      (inspect / navigate / inline AI annotations / attention marks).
//   2. The `/hunk` user command opens an interactive review in a sibling
//      terminal — an Otty pane split beside this session when Pi runs
//      inside Otty, else a tmux window, else a new Otty tab, else macOS
//      Terminal.app, else printing the exact command for the user to run.
//
// The bundled hunk-review skill path is fed into resources_discover so the
// model loads Hunk's authoritative agent guidance natively. Everything
// degrades silently when hunk is not installed (optional integration per
// the aio house rules).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHunkTool } from "./tool.js";
import { formatHunkCommand, launchHunkInteractive, planLaunchAttempts } from "./launcher.js";
import { resolveHunkSkillPath, resetHunkSkillPathForTests } from "./skill.js";

export type { HunkToolParams, HunkToolDetails } from "./tool.js";
export type { HunkAction } from "./tool.js";
export type { LaunchMode, LaunchAttempt } from "./launcher.js";

const OPEN_HELP =
	"/hunk [args] — open an interactive Hunk review of this checkout in a sibling terminal.\n" +
	"Without args: hunk diff (working tree, including untracked files).\n" +
	"Examples:\n" +
	"  /hunk                    review the working tree\n" +
	"  /hunk diff               same as bare /hunk\n" +
	"  /hunk diff --staged      review staged changes\n" +
	"  /hunk show HEAD~1        review an earlier commit\n" +
	"  /hunk diff --watch       auto-reload as the working tree changes\n" +
	"Then use the hunk tool to inspect, navigate, annotate, and highlight.\n" +
	"Launcher: " +
	"tmux window, or macOS Terminal.app, or the printed command.";

export default function registerHunk(pi: ExtensionAPI): void {
	// The tool throws its own "no active sessions" guidance, so registration
	// is unconditional; hunk-not-installed degrades inside the tool's error
	// classification.
	pi.registerTool(createHunkTool(pi));

	pi.registerCommand("hunk", {
		description: "Open an interactive Hunk review in a sibling terminal",
		getArgumentCompletions: (prefix: string) =>
			prefix.startsWith("diff") || prefix.startsWith("show") || prefix.startsWith("log") || prefix.startsWith("stash")
				? [{ value: prefix, label: formatHunkCommand(prefix.trim().split(/\s+/)) }]
				: null,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const reviewArgs = trimmed.length > 0 ? trimmed.split(/\s+/) : ["diff"];
			const output = await launchHunkInteractive(pi, ctx, reviewArgs);
			if (ctx.hasUI) {
				ctx.ui.notify(output, "info");
			} else {
				// eslint-disable-next-line no-console
				console.info(`[aio hunk] ${output}`);
			}
		},
	});

	pi.registerCommand("hunk-open-help", {
		description: "Show /hunk usage and launcher behavior",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(OPEN_HELP, "info");
			} else {
				// eslint-disable-next-line no-console
				console.info(`[aio hunk] ${OPEN_HELP}`);
			}
		},
	});

	// Surface the bundled hunk-review skill natively (optional: missing or
	// broken hunk installs contribute nothing).
	pi.on("resources_discover", async () => {
		const skillPath = await resolveHunkSkillPath((command, args, options) => pi.exec(command, args, options));
		return skillPath ? { skillPaths: [skillPath] } : undefined;
	});
}

export { formatHunkCommand, planLaunchAttempts, resetHunkSkillPathForTests };
