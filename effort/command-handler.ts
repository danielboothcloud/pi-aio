import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeCurrentLevel, updateEffortStatus } from "./effort-status.js";
import { setThinkingEffort } from "./effort-thinking.js";
import { enableUltracodeEffort } from "./effort-ultracode.js";
import { notify } from "./notify.js";
import type { EffortTarget } from "./parse.js";

function usage(current: string): string {
	return `Current effort: ${current}. Usage: /effort <off|minimal|low|medium|high|xhigh|max|ultracode>`;
}

export function handleEffortTarget(pi: ExtensionAPI, ctx: ExtensionContext, target: EffortTarget): void {
	if (target.kind === "status") {
		const current = safeCurrentLevel(pi);
		updateEffortStatus(pi, ctx, current);
		notify(ctx, usage(current), "info");
		return;
	}

	if (target.kind === "invalid") {
		const current = safeCurrentLevel(pi);
		notify(ctx, `Unknown effort "${target.value}". ${usage(current)}`, "warning");
		return;
	}

	if (target.kind === "level") {
		setThinkingEffort(pi, ctx, target.level);
		return;
	}

	enableUltracodeEffort(pi, ctx);
}
