// Shared style vocabulary and a narrow cross-feature channel. Recipes register
// before styles, so a recipe publishes its starting style here and styles uses
// it when a session has no saved /style choice; a mid-session /recipe switch
// sets the style directly through the access handle.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STYLES = [
	"none",
	"collaborate",
	"tutor",
	"concise",
	"ste",
] as const;
export type Style = (typeof STYLES)[number];

export function isStyle(value: unknown): value is Style {
	return (
		typeof value === "string" && (STYLES as readonly string[]).includes(value)
	);
}

/** Accepts `off` and the former `mentor` and `humanised` style names. */
export function parseStyle(value: unknown): Style | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "off") return "none";
	if (normalized === "mentor") return "tutor";
	if (normalized === "humanised") return "ste";
	return isStyle(normalized) ? normalized : undefined;
}

export interface StyleAccess {
	getStyle: () => Style;
	setStyle: (style: Style, ctx: ExtensionContext, options?: { quiet?: boolean }) => Promise<void>;
}

let access: StyleAccess | undefined;
let recipeStyle: Style | undefined;

export function setStyleAccess(next: StyleAccess | undefined): void {
	access = next;
}

export function getStyleAccess(): StyleAccess | undefined {
	return access;
}

export function setRecipeStyle(style: Style | undefined): void {
	recipeStyle = style;
}

export function getRecipeStyle(): Style | undefined {
	return recipeStyle;
}
