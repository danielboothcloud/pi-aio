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
	const modeLabel = state.hidden
		? theme.fg("muted", "bash (hidden from model)")
		: theme.fg("bashMode", "bash");
	const commandPreview = state.command || theme.fg("dim", "type a command…");
	const hint = theme.fg("dim", "Enter to run");

	ctx.ui.setWidget(
		"user-bash-hint",
		[
			`${theme.fg("bashMode", "$")} ${modeLabel} ${theme.fg("dim", "·")} ${commandPreview} ${theme.fg("dim", `(${hint})`)}`,
		],
		{ placement: "belowEditor" },
	);
	ctx.ui.setStatus("user-bash", theme.fg("bashMode", "!bash"));
}
