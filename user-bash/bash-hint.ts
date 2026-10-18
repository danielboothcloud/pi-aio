import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBashInput } from "./parse-bash-input.js";

export function syncBashHint(
	ctx: ExtensionContext,
	text: string,
	frameChrome = false,
): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	const state = parseBashInput(text);
	if (!state.active || frameChrome) {
		ctx.ui.setWidget("user-bash-hint", undefined);
		ctx.ui.setStatus("user-bash", undefined);
		return;
	}

	const theme = ctx.ui.theme;
	// Without AIO's frame, keep the below-editor region quiet and publish
	// one compact status alongside the native shell editor chrome.
	ctx.ui.setWidget("user-bash-hint", undefined);
	ctx.ui.setStatus(
		"user-bash",
		theme.fg("bashMode", state.hidden ? "!!bash" : "!bash"),
	);
}
