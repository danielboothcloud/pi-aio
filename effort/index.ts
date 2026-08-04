import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyEffortOverride } from "./capability.js";
import { handleEffortTarget } from "./command-handler.js";
import {
	getEffortArgumentCompletions,
	resolveEffortCommandValue,
} from "./command-menu.js";
import { getEffectiveLevel } from "./effort-status.js";
import { parseEffortTarget } from "./parse.js";
import {
	handleModelSelect,
	handleSessionShutdown,
	handleSessionStart,
	handleThinkingLevelSelect,
} from "./session-hooks.js";

export function registerEffort(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description:
			"Set thinking effort: off|minimal|low|medium|high|xhigh|max|ultracode",
		getArgumentCompletions: getEffortArgumentCompletions,
		handler: async (args, ctx) => {
			const value = await resolveEffortCommandValue(args, ctx);
			handleEffortTarget(pi, ctx, parseEffortTarget(value));
		},
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		handleThinkingLevelSelect(pi, ctx, event.level);
	});

	pi.on("model_select", async (_event, ctx) => handleModelSelect(pi, ctx));
	pi.on("session_start", async (_event, ctx) => handleSessionStart(pi, ctx));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(ctx));

	// On-the-fly capability override: when pi clamped a requested xhigh/max
	// down because the model has no explicit thinkingLevelMap entry, re-inject
	// the requested effort value into the outgoing provider payload so the
	// level actually reaches the model.
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const desired =
			getEffectiveLevel() === "unknown" ? undefined : getEffectiveLevel();
		return applyEffortOverride(model, desired, event.payload);
	});
}
