import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getPermissionModeAccess } from "../permission-modes/mode-access.js";
import {
	DEFAULT_STATUS_LINE_CONFIG,
	loadStatusLineConfig,
	type StatusLineConfig,
	type WorkingMessageMode,
} from "./config.js";
import {
	computeContextPercent,
	computeUsageStats,
	formatWorkingMessage,
	renderStatusLine,
} from "./render.js";

export function registerStatusLine(pi: ExtensionAPI): void {
	let config: StatusLineConfig = loadStatusLineConfig();
	let streamStart = 0;
	let outputAtTurnStart = 0;
	let currentCtx: ExtensionContext | null = null;

	function applyWorkingMessage(ctx: ExtensionContext): void {
		if (!ctx.hasUI || config.workingMessage === "off") {
			ctx.ui.setWorkingMessage();
			return;
		}
		if (streamStart === 0) {
			ctx.ui.setWorkingMessage();
			return;
		}
		const stats = computeUsageStats(ctx.sessionManager.getBranch());
		const elapsedSec = Math.max(0.001, (Date.now() - streamStart) / 1000);
		const outDelta = Math.max(0, stats.output - outputAtTurnStart);
		const message = formatWorkingMessage(config.workingMessage, {
			...stats,
			contextPercent: computeContextPercent(ctx),
			elapsedSec,
			tps: outDelta / elapsedSec,
		});
		ctx.ui.setWorkingMessage(message);
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		currentCtx = ctx;

		if (!config.enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((_tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => _tui.requestRender());
			return {
				dispose() {
					if (typeof unsub === "function") unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					const liveCtx = currentCtx ?? ctx;
					const mode = getPermissionModeAccess()?.getMode() ?? "default";
					return renderStatusLine({
						width,
						theme,
						config,
						cwd: liveCtx.cwd,
						model: liveCtx.model,
						mode,
						gitBranch: footerData.getGitBranch(),
						contextPercent: computeContextPercent(liveCtx),
						extensionStatuses: footerData.getExtensionStatuses(),
						usageStats: computeUsageStats(liveCtx.sessionManager.getBranch()),
					});
				},
			};
		});
	}

	function setWorkingMessageMode(mode: WorkingMessageMode, ctx: ExtensionContext): void {
		config = { ...config, workingMessage: mode };
		applyWorkingMessage(ctx);
		ctx.ui.notify(`Status line working message: ${mode}`, "info");
	}

	function setEnabled(enabled: boolean, ctx: ExtensionContext): void {
		config = { ...config, enabled };
		installFooter(ctx);
		ctx.ui.notify(`Status line ${enabled ? "enabled" : "disabled"}`, "info");
	}

	pi.registerCommand("status-line", {
		description: "Toggle or configure aio status line (on|off|minimal|verbose)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Status line requires TUI mode", "warning");
				return;
			}
			const arg = args.trim().toLowerCase();
			switch (arg) {
				case "":
				case "toggle":
					setEnabled(!config.enabled, ctx);
					return;
				case "on":
				case "enable":
					setEnabled(true, ctx);
					return;
				case "off":
				case "disable":
					setEnabled(false, ctx);
					return;
				case "minimal":
					setWorkingMessageMode("minimal", ctx);
					return;
				case "verbose":
					setWorkingMessageMode("verbose", ctx);
					return;
				default:
					ctx.ui.notify(
						"Usage: /status-line [on|off|minimal|verbose]",
						"warning",
					);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadStatusLineConfig(ctx.cwd);
		currentCtx = ctx;
		installFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		config = loadStatusLineConfig(ctx.cwd);
		currentCtx = ctx;
		installFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		currentCtx = null;
	});

	pi.on("turn_start", async (_event, ctx) => {
		streamStart = Date.now();
		outputAtTurnStart = computeUsageStats(ctx.sessionManager.getBranch()).output;
		applyWorkingMessage(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		applyWorkingMessage(ctx);
	});

	pi.on("message_update", async (_event, ctx) => {
		currentCtx = ctx;
		applyWorkingMessage(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		streamStart = 0;
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}

export { DEFAULT_STATUS_LINE_CONFIG, loadStatusLineConfig };
