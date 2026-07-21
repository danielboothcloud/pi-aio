import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleEffortTarget } from "./command-handler.js";
import { getEffortArgumentCompletions, resolveEffortCommandValue } from "./command-menu.js";
import { parseEffortTarget } from "./parse.js";
import { handleSessionShutdown, handleSessionStart, handleThinkingLevelSelect } from "./session-hooks.js";

export function registerEffort(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: "Set thinking effort: off|minimal|low|medium|high|xhigh|max|ultracode",
		getArgumentCompletions: getEffortArgumentCompletions,
		handler: async (args, ctx) => {
			const value = await resolveEffortCommandValue(args, ctx);
			handleEffortTarget(pi, ctx, parseEffortTarget(value));
		},
	});

	pi.on("thinking_level_select", async (_event, ctx) => handleThinkingLevelSelect(pi, ctx));
	pi.on("session_start", async (_event, ctx) => handleSessionStart(pi, ctx));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(ctx));
}
