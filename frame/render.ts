/**
 * Minimalist editor frame renderer — adapted from pi-zentui's
 * minimalist-editor.ts (MIT, see UPSTREAM.md). Configuration is code-owned:
 * pi theme tokens only, defaults matching upstream's minimalist preset.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	bashModeLabel,
	buildContextGauge,
	contextColorTier,
	formatCwdLabel,
	formatElapsedDuration,
	type ContextThresholds,
	type FramePathDisplayMode,
} from "./format.js";
import { renderThemeStyle, safeThemeFg, type ThemeLike } from "./style.js";

export interface FrameStyle {
	showSessionName: boolean;
	showTimer: boolean;
	showCost: boolean;
	showGit: boolean;
	pathDisplay: FramePathDisplayMode;
	contextThresholds: ContextThresholds;
	viewportIndicators: boolean;
	/** Gauge bars in the context label; upstream default is off. */
	contextGauge: boolean;
	/** ASCII gauge/connector glyphs instead of Nerd Font block glyphs. */
	ascii: boolean;
}

export const DEFAULT_FRAME_STYLE: FrameStyle = {
	showSessionName: true,
	showTimer: true,
	showCost: true,
	showGit: true,
	pathDisplay: "compact",
	contextThresholds: { warning: 70, error: 90 },
	viewportIndicators: true,
	contextGauge: false,
	ascii: false,
};

export interface FrameMetadata {
	cwd: string;
	projectRoot?: string;
	branch?: string;
	dirty?: boolean;
	ahead?: number;
	behind?: number;
	costLabel?: string;
	modelLabel?: string;
	thinkingLevel?: string;
	contextPercent?: number;
	sessionName?: string;
	agentDurationMs?: number;
	agentActive?: boolean;
}

// Upstream default palette (theme source): shared colors + minimalist fallbacks.
const COLORS = {
	border: "borderMuted",
	model: "syntaxKeyword",
	thinking: "warning",
	gitBranch: "bold syntaxKeyword",
	gitStatus: "bold red",
	cost: "bold green",
	sessionName: "bold green",
	sessionDuration: "yellow",
	contextNormal: "bright-black",
	contextWarning: "bold yellow",
	contextError: "bold red",
	cwd: "bold cyan",
} as const;

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
}

function joinStyled(parts: string[], separator: string): string {
	return parts.filter(Boolean).join(separator);
}

/** Framed autocomplete/panel rows: `├───┤` divider then `│ row │` lines. */
export function renderFramedPanelRows({
	width,
	lines,
	renderBorder,
}: {
	width: number;
	lines: string[];
	renderBorder: (text: string) => string;
}): string[] {
	if (width <= 4 || lines.length === 0) return clampLines(lines, width);
	const contentWidth = width - 4;
	return clampLines(
		[
			`${renderBorder("├")}${renderBorder("─".repeat(width - 2))}${renderBorder("┤")}`,
			...lines.map(
				(line) => `${renderBorder("│")} ${fillLine(line, contentWidth)} ${renderBorder("│")}`,
			),
		],
		width,
	);
}

function renderTopLeft(
	inputText: string,
	metadata: FrameMetadata,
	uiTheme: ThemeLike,
	style: FrameStyle,
): string {
	const muted = (text: string) => safeThemeFg(uiTheme, "muted", text);
	const parts: string[] = [];
	const bashMode = bashModeLabel(inputText);
	if (bashMode) {
		parts.push(
			bashMode === "no-context" ? muted("$") : safeThemeFg(uiTheme, "bashMode", "$"),
		);
	}
	if (style.showTimer && metadata.agentDurationMs !== undefined) {
		const duration = formatElapsedDuration(metadata.agentDurationMs);
		parts.push(
			metadata.agentActive
				? renderThemeStyle(
						uiTheme,
						COLORS.sessionDuration,
						duration,
					)
				: muted(duration),
		);
	}
	const sessionName = (metadata.sessionName ?? "").trim();
	if (style.showSessionName && sessionName) {
		parts.push(renderThemeStyle(uiTheme, COLORS.sessionName, sessionName));
	}
	return joinStyled(parts, muted(" · "));
}

function renderTopRight(
	metadata: FrameMetadata,
	uiTheme: ThemeLike,
	style: FrameStyle,
	availableWidth: number,
	renderBorder: (text: string) => string,
	renderThinking: (text: string) => string,
	fit = false,
): string {
	const parts: string[] = [];
	const joinParts = (values: string[]) =>
		values.map((part, index) => (index > 0 ? `${renderBorder(" – ")}${part}` : part)).join("");
	const cost = style.showCost ? (metadata.costLabel ?? "").trim() : "";
	if (cost) {
		parts.push(renderThemeStyle(uiTheme, COLORS.cost, cost));
	}
	const model = (metadata.modelLabel ?? "").trim();
	if (model) {
		parts.push(renderThemeStyle(uiTheme, COLORS.model, model));
	}
	const thinking = (metadata.thinkingLevel ?? "").trim();
	if (thinking && thinking.toLowerCase() !== "off") {
		parts.push(renderThinking(thinking));
	}
	if (metadata.contextPercent !== undefined && Number.isFinite(metadata.contextPercent)) {
		const percent = Math.round(Math.max(0, Math.min(999, metadata.contextPercent)));
		const tier = contextColorTier(percent, style.contextThresholds);
		const color =
			tier === "error"
				? COLORS.contextError
				: tier === "warning"
					? COLORS.contextWarning
					: COLORS.contextNormal;
		const text = `${percent}%`;
		let context = renderThemeStyle(uiTheme, color, text);
		if (style.contextGauge) {
			for (const gaugeWidth of [5, 3]) {
				const gauge = `[${buildContextGauge(percent, gaugeWidth, style.ascii)}] ${text}`;
				const styledGauge = renderThemeStyle(uiTheme, color, gauge);
				if (visibleWidth(joinParts([...parts, styledGauge])) <= availableWidth) {
					context = styledGauge;
					break;
				}
			}
		}
		if (fit && visibleWidth(joinParts([...parts, context])) > availableWidth) {
			// Descriptive adornments yield before the context percentage.
			context = renderThemeStyle(uiTheme, color, text);
			const contextWidth = visibleWidth(context);
			if (contextWidth > availableWidth) return "";
			const prefixBudget = Math.max(0, availableWidth - contextWidth - 3);
			const prefix = prefixBudget > 0 ? truncateToWidth(joinParts(parts), prefixBudget, "…") : "";
			return joinParts([...(prefix ? [prefix] : []), context]);
		}
		parts.push(context);
	}
	const joined = joinParts(parts);
	return fit ? truncateToWidth(joined, availableWidth, "…") : joined;
}

function renderBottomLeft(
	metadata: FrameMetadata,
	uiTheme: ThemeLike,
	style: FrameStyle,
): string {
	if (!style.showGit) return "";
	const parts: string[] = [];
	const branch = (metadata.branch ?? "").trim();
	if (branch) {
		parts.push(renderThemeStyle(uiTheme, COLORS.gitBranch, branch));
	}
	if (metadata.dirty) {
		parts.push(renderThemeStyle(uiTheme, COLORS.gitStatus, "*"));
	}
	if ((metadata.ahead ?? 0) > 0) {
		parts.push(safeThemeFg(uiTheme, "success", `↑${metadata.ahead}`));
	}
	if ((metadata.behind ?? 0) > 0) {
		parts.push(safeThemeFg(uiTheme, "error", `↓${metadata.behind}`));
	}
	return parts.join(" ");
}

function renderBottomRight(
	metadata: FrameMetadata,
	uiTheme: ThemeLike,
	style: FrameStyle,
): string {
	const cwd = formatCwdLabel(metadata.cwd, style.pathDisplay, metadata.projectRoot).trim();
	return cwd ? renderThemeStyle(uiTheme, COLORS.cwd, cwd) : "";
}

function renderLabeledBorder(options: {
	width: number;
	left: string;
	leftFallbacks?: string[];
	right: string;
	fitRight?: (width: number) => string;
	leftCorner: string;
	rightCorner: string;
	renderBorder: (text: string) => string;
}): string {
	const innerWidth = Math.max(0, options.width - 2);
	let left = options.left;
	let right = options.right;
	const fitLabels = () => {
		const overhead = (left ? 3 : 1) + (right ? 3 : 1);
		const budget = Math.max(0, innerWidth - overhead);
		const leftNatural = visibleWidth(left);
		const rightNatural = visibleWidth(right);
		if (leftNatural + rightNatural <= budget) return false;

		let leftBudget = left ? budget : 0;
		let rightBudget = right ? budget : 0;
		if (left && right) {
			leftBudget = Math.ceil(budget / 2);
			rightBudget = budget - leftBudget;
			if (leftNatural < leftBudget) {
				leftBudget = leftNatural;
				rightBudget = budget - leftBudget;
			} else if (rightNatural < rightBudget) {
				rightBudget = rightNatural;
				leftBudget = budget - rightBudget;
			}
		}
		left = leftBudget > 0 ? truncateToWidth(left, leftBudget, "…") : "";
		right =
			rightBudget > 0
				? (options.fitRight?.(rightBudget) ?? truncateToWidth(right, rightBudget, "…"))
				: "";
		return leftBudget < leftNatural;
	};
	let leftTruncated = fitLabels();
	for (const fallback of options.leftFallbacks ?? []) {
		if (!leftTruncated) break;
		left = fallback;
		right = options.right;
		leftTruncated = fitLabels();
	}
	const partWidth = (label: string) => (label ? visibleWidth(label) + 3 : 1);
	let leftWidth = partWidth(left);
	let rightWidth = partWidth(right);
	if (leftWidth + rightWidth > innerWidth) {
		left = "";
		right = "";
		leftWidth = 1;
		rightWidth = 1;
	}

	const fillWidth = Math.max(0, innerWidth - leftWidth - rightWidth);
	const leftPart = left
		? `${options.renderBorder("─ ")}${left}${options.renderBorder(" ")}`
		: options.renderBorder("─");
	const rightPart = right
		? `${options.renderBorder(" ")}${right}${options.renderBorder(" ─")}`
		: options.renderBorder("─");
	return `${options.renderBorder(options.leftCorner)}${leftPart}${options.renderBorder(
		"─".repeat(fillWidth),
	)}${rightPart}${options.renderBorder(options.rightCorner)}`;
}

export function renderMinimalistFrame({
	width,
	editorLines,
	panelLines = [],
	viewport,
	inputText,
	metadata,
	uiTheme,
	style,
	borderColor,
}: {
	width: number;
	editorLines: string[];
	/** Framed rows (autocomplete, queue panel) between content and bottom border. */
	panelLines?: string[];
	viewport?: { above?: string; below?: string };
	inputText: string;
	metadata: FrameMetadata;
	uiTheme: ThemeLike;
	style: FrameStyle;
	borderColor?: (text: string) => string;
}): string[] {
	if (width <= 4) return clampLines(editorLines, width);
	const contentWidth = Math.max(0, width - 4);
	const renderStaticBorder = (text: string) =>
		renderThemeStyle(uiTheme, COLORS.border, text);
	// Adaptive border coloring by thinking level was an upstream style option;
	// AIO keeps the static muted border.
	const renderBorder = renderStaticBorder;
	const renderThinking = (text: string) =>
		renderThemeStyle(uiTheme, COLORS.thinking, text);
	const separator = safeThemeFg(uiTheme, "muted", " · ");
	const viewportLabel = (direction: "above" | "below", count: string | undefined) => {
		if (!count || !/^[1-9]\d*$/.test(count)) return "";
		return safeThemeFg(uiTheme, "muted", `${direction === "above" ? "↑" : "↓"} ${count} more`);
	};
	const topMetadata = renderTopLeft(inputText, metadata, uiTheme, style);
	const topViewport = viewportLabel("above", viewport?.above);
	const topLeft = joinStyled([topViewport, topMetadata], separator);
	const topRightBudget = Math.max(0, width - 8 - visibleWidth(topLeft));
	const top = renderLabeledBorder({
		width,
		left: topLeft,
		right: renderTopRight(metadata, uiTheme, style, topRightBudget, renderBorder, renderThinking),
		fitRight: (budget) =>
			renderTopRight(metadata, uiTheme, style, budget, renderBorder, renderThinking, true),
		leftCorner: "╭",
		rightCorner: "╮",
		renderBorder,
	});
	const bottomMetadata = renderBottomLeft(metadata, uiTheme, style);
	const bottomViewport = viewportLabel("below", viewport?.below);
	const bottom = renderLabeledBorder({
		width,
		left: joinStyled([bottomViewport, bottomMetadata], separator),
		leftFallbacks: bottomViewport ? [bottomMetadata] : undefined,
		right: renderBottomRight(metadata, uiTheme, style),
		leftCorner: "╰",
		rightCorner: "╯",
		renderBorder,
	});
	const content = editorLines.map(
		(line) => `${renderBorder("│")} ${fillLine(line, contentWidth)} ${renderBorder("│")}`,
	);
	const panels = renderFramedPanelRows({ width, lines: panelLines, renderBorder });
	return clampLines([top, ...content, ...panels, bottom], width);
}
