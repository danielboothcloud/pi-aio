import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { effectiveEffortLevel } from "./capability.js";
import {
	clearEffortStatus,
	safeCurrentLevel,
	setEffectiveLevel,
	updateEffortStatus,
} from "./effort-status.js";
import type { ThinkingLevel } from "./parse.js";

export function handleThinkingLevelSelect(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ThinkingLevel,
): void {
	const clamped = safeCurrentLevel(pi);
	const model = ctx.model;
	const effective =
		clamped === "unknown"
			? clamped
			: effectiveEffortLevel(model, level, clamped);
	setEffectiveLevel(effective);
	updateEffortStatus(pi, ctx, effective);
}

export function handleModelSelect(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	// Recompute for the new model: pi reports the clamped level for its map, so
	// reset pi-aio's effective level to match until the user requests a level.
	setEffectiveLevel(safeCurrentLevel(pi));
	updateEffortStatus(pi, ctx);
}

export function handleSessionStart(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	updateEffortStatus(pi, ctx);
}

export function handleSessionShutdown(ctx: ExtensionContext): void {
	clearEffortStatus(ctx);
}
