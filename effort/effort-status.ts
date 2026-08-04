import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./parse.js";
import { THINKING_LEVELS } from "./parse.js";

export const EFFORT_STATUS_KEY = "effort";

/**
 * The effort level pi-aio reports as active. This is the level that will be
 * sent on the wire after pi-aio's on-the-fly capability override, which may
 * differ from what pi's own `getThinkingLevel()` reports when pi clamped an
 * extended level down. It is the source of truth for the status line and the
 * `/effort` command.
 */
let activeEffort: ThinkingLevel | "unknown" = "unknown";

export function getEffectiveLevel(): ThinkingLevel | "unknown" {
	return activeEffort;
}

export function setEffectiveLevel(level: ThinkingLevel | "unknown"): void {
	activeEffort = level;
}

export function safeCurrentLevel(pi: ExtensionAPI): ThinkingLevel | "unknown" {
	try {
		const level = pi.getThinkingLevel();
		return THINKING_LEVELS.includes(level) ? level : "unknown";
	} catch {
		return "unknown";
	}
}

export function formatEffortStatus(
	ctx: ExtensionContext,
	level: string,
): string {
	const theme = ctx.ui.theme;
	const text = `effort:${level}`;
	if (level === "off") return theme.fg("dim", text);
	if (level === "minimal" || level === "low") return theme.fg("muted", text);
	if (level === "high" || level === "xhigh") return theme.fg("accent", text);
	return text;
}

export function updateEffortStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: string = getEffectiveLevel() === "unknown"
		? safeCurrentLevel(pi)
		: getEffectiveLevel(),
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EFFORT_STATUS_KEY, formatEffortStatus(ctx, level));
}

export function clearEffortStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(EFFORT_STATUS_KEY, undefined);
}
