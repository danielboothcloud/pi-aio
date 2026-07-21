import type {
	ExtensionAPI,
	ExtensionContext,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { getPermissionModeAccess } from "../permission-modes/mode-access.js";
import { isSafeCommand } from "../permission-modes/utils.js";
import { BashHintEditor } from "./bash-hint-editor.js";

function blocked(reason: string): UserBashEventResult {
	return {
		result: {
			output: reason,
			exitCode: 1,
			cancelled: false,
			truncated: false,
		},
	};
}

async function gateUserBash(
	command: string,
	ctx: ExtensionContext,
): Promise<UserBashEventResult | undefined> {
	const access = getPermissionModeAccess();
	const mode = access?.getMode() ?? "default";

	if (mode === "auto" || isSafeCommand(command)) return undefined;

	if (mode === "ask" || mode === "plan") {
		const label = mode === "ask" ? "Ask" : "Plan";
		return blocked(
			`${label} mode: read-only commands only.\n  Command: ${command}`,
		);
	}

	if (!ctx.hasUI) {
		return blocked("Command blocked: no UI to confirm.");
	}

	const choice = await ctx.ui.select(`Allow !bash "${command}"?`, [
		"Allow",
		"Allow all (enable auto)",
		"Block",
	]);

	if (choice === "Allow all (enable auto)") {
		await access!.setMode("auto", ctx);
		return undefined;
	}
	if (choice !== "Allow") {
		return blocked(`Command blocked by user: ${command}`);
	}
	return undefined;
}

function clearBashHint(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("user-bash-hint", undefined);
	ctx.ui.setStatus("user-bash", undefined);
}

export function registerUserBash(pi: ExtensionAPI): void {
	pi.on("user_bash", async (event, ctx) => gateUserBash(event.command, ctx));

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
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
