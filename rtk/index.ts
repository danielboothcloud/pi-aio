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
} from "@earendil-works/pi-coding-agent";
import {
	buildRtkUserBashResult,
	cacheNotify,
	isRtkEnabled,
	probeRtkAvailability,
} from "./rewrite.js";
import { clearRtkFooter, registerRtkCommand, updateRtkFooter } from "./command.js";

export {
	rtkSpawnHook,
	rtkRewriteCommand,
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

	pi.on("user_bash", (event, ctx: ExtensionContext) => {
		cacheNotify((message, level) => ctx.ui.notify(message, level));

		// !!<cmd> is excluded from model context by design — do not intercept.
		if (event.excludeFromContext) return;

		// Session toggle off: fall through to Pi's normal user shell handling.
		if (!isRtkEnabled()) return;

		return buildRtkUserBashResult(event.command, localBashOperations);
	});
}
