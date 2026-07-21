import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./parse.js";
import { THINKING_LEVELS } from "./parse.js";

export const EFFORT_STATUS_KEY = "effort";

export function safeCurrentLevel(pi: ExtensionAPI): ThinkingLevel | "unknown" {
	try {
		const level = pi.getThinkingLevel();
		return THINKING_LEVELS.includes(level) ? level : "unknown";
	} catch {
		return "unknown";
	}
}

export function formatEffortStatus(ctx: ExtensionContext, level: string): string {
	const theme = ctx.ui.theme;
	const text = `effort:${level}`;
	if (level === "off") return theme.fg("dim", text);
	if (level === "minimal" || level === "low") return theme.fg("muted", text);
	if (level === "high" || level === "xhigh") return theme.fg("accent", text);
	return text;
}

export function updateEffortStatus(pi: ExtensionAPI, ctx: ExtensionContext, level = safeCurrentLevel(pi)): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EFFORT_STATUS_KEY, formatEffortStatus(ctx, level));
}

export function clearEffortStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(EFFORT_STATUS_KEY, undefined);
}
