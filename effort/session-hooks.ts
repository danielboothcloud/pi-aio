import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearEffortStatus, updateEffortStatus } from "./effort-status.js";

export function handleThinkingLevelSelect(pi: ExtensionAPI, ctx: ExtensionContext): void {
	updateEffortStatus(pi, ctx);
}

export function handleSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): void {
	updateEffortStatus(pi, ctx);
}

export function handleSessionShutdown(ctx: ExtensionContext): void {
	clearEffortStatus(ctx);
}
