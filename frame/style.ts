/**
 * Slim theme styling for the AIO frame — adapted from pi-zentui's style.ts
 * (MIT, see UPSTREAM.md). Theme tokens only; terminal-palette sources, hex
 * colors, and SGR-prefix safety machinery were dropped as unused here.
 */

type ThemeLike = {
	fg(color: string, text: string): string;
	bold?: (text: string) => string;
	italic?: (text: string) => string;
	underline?: (text: string) => string;
};

export type { ThemeLike };

export type ColorSpec = string;

const themeStyleModifiers = new Set(["bold", "italic", "underline"]);

const themeColorNameMap = new Map([
	["red", "error"],
	["bright-red", "error"],
	["green", "success"],
	["bright-green", "success"],
	["yellow", "warning"],
	["bright-yellow", "warning"],
	["blue", "syntaxFunction"],
	["bright-blue", "syntaxFunction"],
	["cyan", "syntaxFunction"],
	["bright-cyan", "syntaxFunction"],
	["purple", "syntaxKeyword"],
	["bright-purple", "syntaxKeyword"],
	["black", "muted"],
	["bright-black", "muted"],
	["white", "text"],
	["bright-white", "text"],
]);

function applyThemeModifiers(theme: ThemeLike, styleTokens: string[], text: string): string {
	let rendered = text;
	for (const token of styleTokens) {
		const normalized = token.toLowerCase();
		if (normalized === "bold") rendered = theme.bold?.(rendered) ?? rendered;
		if (normalized === "italic") rendered = theme.italic?.(rendered) ?? rendered;
		if (normalized === "underline") rendered = theme.underline?.(rendered) ?? rendered;
	}
	return rendered;
}

export function safeThemeFg(theme: ThemeLike, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function mapThemeColor(styleTokens: string[]): string | undefined {
	let fallback: string | undefined;
	for (const token of styleTokens) {
		const normalized = token.toLowerCase();
		if (themeStyleModifiers.has(normalized)) continue;
		if (normalized === "dim" || normalized === "dimmed") {
			fallback = "muted";
			continue;
		}
		const mapped = themeColorNameMap.get(normalized);
		if (mapped) return mapped;
		return token;
	}
	return fallback;
}

/** Render a Space-separated style spec ("bold green") through theme tokens. */
export function renderThemeStyle(theme: ThemeLike, style: ColorSpec, text: string): string {
	const trimmed = style.trim();
	if (trimmed === "") return text;
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const color = mapThemeColor(tokens) ?? "text";
	return safeThemeFg(theme, color, applyThemeModifiers(theme, tokens, text));
}

export function renderStyleForSourceOrFallback(
	theme: ThemeLike,
	style: ColorSpec | undefined,
	fallback: ColorSpec,
	text: string,
): string {
	return renderThemeStyle(theme, style ?? fallback, text);
}
