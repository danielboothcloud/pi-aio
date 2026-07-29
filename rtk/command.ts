/* aio-rtk: /rtk slash command, status report, and footer indicator. */

import { spawnSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
const REWRITE_TIMEOUT_MS = 5000;
const RTK_STATUS_KEY = "rtk";
const VALID_RTK_SUBCOMMANDS = ["status"] as const;

type RtkSubcommand = (typeof VALID_RTK_SUBCOMMANDS)[number];

interface StatusReport {
	state: string;
	binary: string;
	tip: string;
}

function isRtkSubcommand(value: string): value is RtkSubcommand {
	return (VALID_RTK_SUBCOMMANDS as readonly string[]).includes(value);
}

function renderStatusText(ctx: ExtensionContext): string {
	return ctx.ui.theme.fg("success", "rtk ✓");
}

export function updateRtkFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(RTK_STATUS_KEY, renderStatusText(ctx));
}

export function clearRtkFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(RTK_STATUS_KEY, undefined);
}

function rtkStatusReport(ctx: ExtensionContext): StatusReport {
	const state = ctx.ui.theme.fg("success", "enforced");

	const version = spawnSync("rtk", ["--version"], {
		encoding: "utf-8",
		timeout: REWRITE_TIMEOUT_MS,
	});

	let binary = "rtk not detected on PATH";

	if (!version.error) {
		const path = spawnSync("sh", ["-c", "command -v rtk"], {
			encoding: "utf-8",
			timeout: REWRITE_TIMEOUT_MS,
		});
		const versionText = (version.stdout ?? "").trim() || "version unknown";
		const pathText = (path.stdout ?? "").trim();
		binary =
			pathText.length > 0 ? `${versionText} at ${pathText}` : versionText;
	}

	return {
		state: `Routing: ${state}`,
		binary: `Binary: ${binary}`,
		tip: "Native fallback is used only when RTK has no equivalent or cannot execute.",
	};
}

function showRtkStatus(ctx: ExtensionContext): void {
	const report = rtkStatusReport(ctx);
	ctx.ui.notify(`${report.state}\n${report.binary}\n${report.tip}`, "info");
}

export function handleRtkSubcommand(
	subcommand: RtkSubcommand,
	ctx: ExtensionContext,
): void {
	if (subcommand === "status") showRtkStatus(ctx);
}

export function registerRtkCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rtk", {
		description: "Show enforced aio-rtk routing status",
		getArgumentCompletions: (prefix: string) => {
			const completions = VALID_RTK_SUBCOMMANDS.filter((sub) =>
				sub.startsWith(prefix),
			).map((sub) => ({ label: sub, value: sub }));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subcommand = args.trim();

			if (subcommand.length === 0) {
				showRtkStatus(ctx);
				return;
			}

			if (!isRtkSubcommand(subcommand)) {
				ctx.ui.notify(
					"RTK routing is enforced. The only subcommand is /rtk status.",
					"error",
				);
				return;
			}

			handleRtkSubcommand(subcommand, ctx);
		},
	});
}
