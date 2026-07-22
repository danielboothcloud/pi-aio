import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInitPrompt } from "./prompt.js";

export function registerInit(pi: ExtensionAPI): void {
	pi.registerCommand("init", {
		description:
			"Analyze the codebase and create or update AGENTS.md (optional: force, dry-run)",
		handler: async (args, ctx) => {
			const prompt = buildInitPrompt({ cwd: ctx.cwd, args });

			if (!ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Queued /init for after the current turn", "info");
				return;
			}

			pi.sendUserMessage(prompt);
		},
	});
}
