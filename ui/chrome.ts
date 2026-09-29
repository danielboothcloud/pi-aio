import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ChromeTone =
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "dim"
	| "text";

export interface ChromeTheme {
	fg(role: string, text: string): string;
	bold?(text: string): string;
	bg?(role: string, text: string): string;
}

export interface HeaderOptions {
	title: string;
	meta?: string;
	tone?: ChromeTone;
	icon?: string;
	indent?: number;
}

export interface ItemOptions {
	label: string;
	meta?: string;
	marker?: string;
	tone?: ChromeTone;
	active?: boolean;
	indent?: number;
}

export function fitLine(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, ellipsis, false);
}

export function padToWidth(text: string, width: number): string {
	const fitted = fitLine(text, width, "");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

export function chromeHeader(
	theme: ChromeTheme,
	options: HeaderOptions,
	width: number,
): string {
	const tone = options.tone ?? "accent";
	const indent = " ".repeat(Math.max(0, options.indent ?? 0));
	const icon = theme.fg(tone, options.icon ?? "▎");
	const titleText = options.title.toUpperCase();
	const title = theme.fg(tone, theme.bold?.(titleText) ?? titleText);
	const meta = options.meta
		? `${theme.fg("dim", " · ")}${theme.fg("muted", options.meta)}`
		: "";
	return fitLine(`${indent}${icon} ${title}${meta}`, width);
}

export function chromeItem(
	theme: ChromeTheme,
	options: ItemOptions,
	width: number,
): string {
	const tone = options.tone ?? (options.active ? "accent" : "text");
	const indent = " ".repeat(Math.max(0, options.indent ?? 1));
	const marker = theme.fg(tone, options.marker ?? (options.active ? "›" : "·"));
	const label = theme.fg(tone, options.active ? (theme.bold?.(options.label) ?? options.label) : options.label);
	const meta = options.meta
		? `${theme.fg("dim", " · ")}${theme.fg("muted", options.meta)}`
		: "";
	const fitted = fitLine(`${indent}${marker} ${label}${meta}`, width);
	return options.active && theme.bg
		? theme.bg("selectedBg", padToWidth(fitted, width))
		: fitted;
}

export function chromeHint(
	theme: ChromeTheme,
	text: string,
	width: number,
	indent = 2,
): string {
	return fitLine(`${" ".repeat(Math.max(0, indent))}${theme.fg("dim", text)}`, width);
}

export function chromeDivider(
	theme: ChromeTheme,
	width: number,
	label?: string,
): string {
	if (width <= 0) return "";
	if (!label) return theme.fg("borderMuted", "─".repeat(width));
	const decorated = `─ ${label} `;
	const suffix = "─".repeat(Math.max(0, width - decorated.length));
	return fitLine(theme.fg("borderMuted", decorated + suffix), width, "");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}
