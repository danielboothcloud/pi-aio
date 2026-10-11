import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBashInput } from "./parse-bash-input.js";

export function syncBashHint(ctx: ExtensionContext, text: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	const state = parseBashInput(text);
	if (!state.active) {
		ctx.ui.setWidget("user-bash-hint", undefined);
		ctx.ui.setStatus("user-bash", undefined);
		return;
	}

	const theme = ctx.ui.theme;
	// The command and mode already live in the Zentui/BashHint editor chrome.
	// Keep the below-editor region quiet and publish only one compact status.
	ctx.ui.setWidget("user-bash-hint", undefined);
	ctx.ui.setStatus(
		"user-bash",
		theme.fg("bashMode", state.hidden ? "!!bash" : "!bash"),
	);
}
