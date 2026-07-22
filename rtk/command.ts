/* aio-rtk: /rtk slash command, status report, and footer indicator. */

import { spawnSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRtkEnabled, setRtkEnabled } from "./rewrite.js";

const REWRITE_TIMEOUT_MS = 5000;
const RTK_STATUS_KEY = "rtk";
const VALID_RTK_SUBCOMMANDS = ["enable", "disable", "status"] as const;

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
	return isRtkEnabled()
		? ctx.ui.theme.fg("success", "rtk ✓")
		: ctx.ui.theme.fg("error", "rtk ✗");
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
	const state = isRtkEnabled()
		? ctx.ui.theme.fg("success", "enabled")
		: ctx.ui.theme.fg("warning", "disabled");

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
		state: `Session toggle: ${state}`,
		binary: `Binary: ${binary}`,
		tip: "Tip: bypass rtk for one command with !RTK_DISABLED=1 <cmd>.",
	};
}

function showRtkStatus(ctx: ExtensionContext): void {
	const report = rtkStatusReport(ctx);
	ctx.ui.notify(`${report.state}\n${report.binary}\n${report.tip}`, "info");
}

async function showRtkOverlay(ctx: ExtensionContext): Promise<void> {
	const selected = await ctx.ui.select("aio-rtk", [
		"enable",
		"disable",
		"status",
	]);
	if (selected === undefined || !isRtkSubcommand(selected)) return;
	handleRtkSubcommand(selected, ctx);
}

export function handleRtkSubcommand(
	subcommand: RtkSubcommand,
	ctx: ExtensionContext,
): void {
	if (subcommand === "status") {
		showRtkStatus(ctx);
		return;
	}

	setRtkEnabled(subcommand === "enable");
	updateRtkFooter(ctx);
	ctx.ui.notify(`aio-rtk ${subcommand}d for this session`, "info");
}

export function registerRtkCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rtk", {
		description:
			"Control aio-rtk shell command rewriting (enable | disable | status)",
		getArgumentCompletions: (prefix: string) => {
			const completions = VALID_RTK_SUBCOMMANDS.filter((sub) =>
				sub.startsWith(prefix),
			).map((sub) => ({ label: sub, value: sub }));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subcommand = args.trim();

			if (subcommand.length === 0) {
				await showRtkOverlay(ctx);
				return;
			}

			if (!isRtkSubcommand(subcommand)) {
				ctx.ui.notify(
					"Unknown /rtk subcommand. Valid forms: /rtk enable, /rtk disable, /rtk status.",
					"error",
				);
				return;
			}

			handleRtkSubcommand(subcommand, ctx);
		},
	});
}
