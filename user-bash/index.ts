import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BashHintEditor } from "./bash-hint-editor.js";

function clearBashHint(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("user-bash-hint", undefined);
	ctx.ui.setStatus("user-bash", undefined);
}

export function registerUserBash(pi: ExtensionAPI): void {
	// Explicit !/!! commands are user-authorized. Leave execution to Pi;
	// permission modes apply only to agent-issued tool calls.

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (ctx.ui.getEditorComponent?.()) return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new BashHintEditor(tui, theme, keybindings, ctx),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearBashHint(ctx);
		ctx.ui.setEditorComponent(undefined);
	});
}
