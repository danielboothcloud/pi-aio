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
import { fetchProviderUsage, type ProviderUsage } from "./provider-usage.js";
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
	let providerUsage: ProviderUsage | undefined;
	let providerUsageFetchedAt = 0;
	let providerUsageRequest: Promise<void> | undefined;
	let providerUsageAbort: AbortController | undefined;
	let requestFooterRender: (() => void) | undefined;

	function resetProviderUsage(clearValue = false): void {
		providerUsageAbort?.abort();
		providerUsageAbort = undefined;
		providerUsageRequest = undefined;
		if (clearValue) {
			providerUsage = undefined;
			providerUsageFetchedAt = 0;
			requestFooterRender?.();
		}
	}

	function shouldFetchProviderUsage(ctx: ExtensionContext): boolean {
		return (
			ctx.mode === "tui" && config.enabled && config.segments.includes("quota")
		);
	}

	function refreshProviderUsage(
		ctx: ExtensionContext,
		force = false,
	): Promise<void> {
		const provider = ctx.model?.provider;
		const usageConfig = config.providerUsage;
		const endpointConfig = provider
			? usageConfig?.providers[provider]
			: undefined;
		if (!provider || !usageConfig || !endpointConfig) {
			providerUsage = undefined;
			providerUsageFetchedAt = 0;
			requestFooterRender?.();
			return Promise.resolve();
		}
		if (providerUsageRequest) return providerUsageRequest;
		if (
			!force &&
			providerUsage?.provider === provider &&
			Date.now() - providerUsageFetchedAt < usageConfig.refreshIntervalMs
		) {
			return Promise.resolve();
		}

		providerUsageAbort?.abort();
		const controller = new AbortController();
		providerUsageAbort = controller;
		providerUsageRequest = fetchProviderUsage(
			provider,
			endpointConfig,
			usageConfig.timeoutMs,
			fetch,
			controller.signal,
		)
			.then((usage) => {
				if (controller.signal.aborted || currentCtx?.model?.provider !== provider)
					return;
				providerUsage = usage;
				providerUsageFetchedAt = Date.now();
				requestFooterRender?.();
			})
			.catch(() => {
				// Quota display is best-effort. Keep stale data on transient failures.
			})
			.finally(() => {
				if (providerUsageAbort === controller) {
					providerUsageAbort = undefined;
					providerUsageRequest = undefined;
				}
			});
		return providerUsageRequest;
	}

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
			const renderRequest = () => _tui.requestRender();
			requestFooterRender = renderRequest;
			return {
				dispose() {
					if (typeof unsub === "function") unsub();
					if (requestFooterRender === renderRequest) requestFooterRender = undefined;
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
						providerUsage,
					});
				},
			};
		});
	}

	function setWorkingMessageMode(
		mode: WorkingMessageMode,
		ctx: ExtensionContext,
	): void {
		config = { ...config, workingMessage: mode };
		applyWorkingMessage(ctx);
		ctx.ui.notify(`Status line working message: ${mode}`, "info");
	}

	function setEnabled(enabled: boolean, ctx: ExtensionContext): void {
		config = { ...config, enabled };
		installFooter(ctx);
		if (enabled && shouldFetchProviderUsage(ctx)) {
			void refreshProviderUsage(ctx, true);
		} else if (!enabled) {
			resetProviderUsage();
		}
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
					ctx.ui.notify("Usage: /status-line [on|off|minimal|verbose]", "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadStatusLineConfig(ctx.cwd, {
			includeProject: ctx.isProjectTrusted(),
		});
		currentCtx = ctx;
		installFooter(ctx);
		if (shouldFetchProviderUsage(ctx)) void refreshProviderUsage(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		config = loadStatusLineConfig(ctx.cwd, {
			includeProject: ctx.isProjectTrusted(),
		});
		currentCtx = ctx;
		resetProviderUsage(true);
		installFooter(ctx);
		if (shouldFetchProviderUsage(ctx)) void refreshProviderUsage(ctx, true);
	});

	pi.on("session_shutdown", async () => {
		resetProviderUsage();
		requestFooterRender = undefined;
		currentCtx = null;
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		resetProviderUsage(true);
		if (shouldFetchProviderUsage(ctx)) void refreshProviderUsage(ctx, true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		streamStart = Date.now();
		outputAtTurnStart = computeUsageStats(ctx.sessionManager.getBranch()).output;
		applyWorkingMessage(ctx);
		if (shouldFetchProviderUsage(ctx)) void refreshProviderUsage(ctx);
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
		if (shouldFetchProviderUsage(ctx)) void refreshProviderUsage(ctx);
	});
}

export { DEFAULT_STATUS_LINE_CONFIG, loadStatusLineConfig };
