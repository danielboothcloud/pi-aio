/**
 * aio-rtk — routes shell commands through `rtk rewrite` to reduce LLM token
 * usage. Integrated natively into aio, mirroring the @sherif-fanous/pi-rtk
 * extension's behavior.
 *
 * Registers after permission modes so only approved agent commands are
 * rewritten. Explicit user !/!! commands retain Pi's native execution path.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
	cacheNotify,
	probeRtkAvailability,
	rewriteAgentBashCommand,
} from "./rewrite.js";
import {
	registerRtkCommand,
} from "./command.js";

export {
	rtkRewriteCommand,
	rewriteAgentBashCommand,
	isRtkEnabled,
	setRtkEnabled,
	setRtkRewriteFn,
	resetRtkRewriteFn,
	resetRtkState,
} from "./rewrite.js";

export function registerRtk(pi: ExtensionAPI): void {
	registerRtkCommand(pi);

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cacheNotify((message, level) => ctx.ui.notify(message, level));
		probeRtkAvailability();
	});

	// No footer status: rtk routing is unconditional, so a permanent "rtk ✓"
	// segment only clutters Zentui's statuses-only row. `/rtk status` reports
	// routing and binary details on demand.

	// Permission modes register their tool_call gate before RTK, so they inspect
	// and approve the original command. RTK then rewrites only allowed commands,
	// independently of whichever extension owns the final bash renderer.
	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		if (typeof command !== "string" || command.trim() === "") return;

		const rewritten = await rewriteAgentBashCommand(pi, command, ctx.signal);
		if (rewritten) event.input.command = rewritten;
	});

}
