import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { effectiveEffortLevel } from "./capability.js";
import {
	safeCurrentLevel,
	setEffectiveLevel,
	updateEffortStatus,
} from "./effort-status.js";
import { notify } from "./notify.js";
import type { ThinkingLevel } from "./parse.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatSetEffortFailure(level: ThinkingLevel, error: unknown): string {
	return `Could not set effort to ${level}: ${errorMessage(error)}`;
}

export function setThinkingEffort(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ThinkingLevel,
	options: { announce?: boolean } = {},
): ThinkingLevel | "unknown" {
	const before = safeCurrentLevel(pi);
	let actual: ThinkingLevel | "unknown";
	try {
		pi.setThinkingLevel(
			level as Parameters<ExtensionAPI["setThinkingLevel"]>[0],
		);
		actual = safeCurrentLevel(pi);
		if (level === "max" && actual === "off") {
			pi.setThinkingLevel("xhigh");
			actual = safeCurrentLevel(pi);
		}
	} catch (error) {
		notify(ctx, formatSetEffortFailure(level, error), "error");
		return before;
	}

	// Reconcile: when pi clamps xhigh/max down but pi-aio can still send the
	// requested level on the wire, report that requested level so the status
	// line and notification match what actually goes to the provider.
	const model = ctx.model;
	const effective =
		actual === "unknown" ? actual : effectiveEffortLevel(model, level, actual);

	setEffectiveLevel(effective);
	updateEffortStatus(pi, ctx, effective);
	if (options.announce !== false) {
		if (effective === level) {
			notify(ctx, `Thinking effort set to ${effective}.`, "info");
		} else {
			notify(
				ctx,
				`Requested effort ${level}; active effort is ${effective} (current model may limit thinking).`,
				"warning",
			);
		}
	}
	return effective;
}
