/**
 * aio-rtk — routes shell commands through `rtk rewrite` to reduce LLM token
 * usage. Integrated natively into aio, mirroring the @sherif-fanous/pi-rtk
 * extension's behavior.
 *
 * Registration order matters: {@link registerRtk} must be called *after*
 * {@link registerUserBash} so the permission-mode gate runs first on the
 * `user_bash` event. Pi dispatches `user_bash` handlers in registration order and
 * short-circuits on the first non-undefined result, so a blocked command never
 * reaches rtk, and an allowed command falls through to rtk for rewriting.
 */

import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
	buildRtkUserBashResult,
	cacheNotify,
	probeRtkAvailability,
	rewriteAgentBashCommand,
} from "./rewrite.js";
import {
	clearRtkFooter,
	registerRtkCommand,
	updateRtkFooter,
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
	const localBashOperations = createLocalBashOperations();

	registerRtkCommand(pi);

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cacheNotify((message, level) => ctx.ui.notify(message, level));
		updateRtkFooter(ctx);
		probeRtkAvailability();
	});

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		clearRtkFooter(ctx);
	});

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

	pi.on("user_bash", (event, ctx: ExtensionContext) => {
		cacheNotify((message, level) => ctx.ui.notify(message, level));
		// !! still controls model-context inclusion; it no longer bypasses RTK.
		return buildRtkUserBashResult(event.command, localBashOperations);
	});
}
