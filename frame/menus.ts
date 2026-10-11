import * as host from "@earendil-works/pi-coding-agent";
import { chromeFrameRow, chromeFrameRule, type ChromeTheme } from "../ui/chrome.js";

// Pi exposes no selector factory hook. Limit the adapter to public selector
// classes; never patch Container, SelectList, or third-party custom screens.
const SELECTORS = [
	"ExtensionSelectorComponent",
	"ModelSelectorComponent",
	"SettingsSelectorComponent",
	"ThemeSelectorComponent",
	"ThinkingSelectorComponent",
	"SessionSelectorComponent",
	"TreeSelectorComponent",
	"OAuthSelectorComponent",
	"ShowImagesSelectorComponent",
	"UserMessageSelectorComponent",
] as const;

export function hostMenuComponents(): unknown[] {
	return SELECTORS.map((name) => host[name]);
}

type MenuPrototype = {
	render(width: number): string[];
	handleMouse?: (event: MenuMouseEvent) => MenuMouseResult | undefined;
};

// Mouse support is absent on older hosts. Use only the normalized coordinates
// needed here, rather than importing types not exported by those hosts.
interface MenuMouseEvent {
	x: number;
	y: number;
	width: number;
	height: number;
	type?: string;
	[key: string]: unknown;
}

interface MenuMouseResult {
	handled?: boolean;
	capture?: boolean;
	focus?: boolean;
	render?: boolean;
	target?: { component: object; originX: number; originY: number; width: number; height: number };
	focusTarget?: object;
}

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function isRule(line: string): boolean {
	return /^─+$/.test(plain(line));
}

function nativeFrameBounds(lines: string[]): { top: number; bottom: number } | undefined {
	const rules = lines.flatMap((line, index) => isRule(line) ? [index] : []);
	const first = rules[0];
	const bottom = rules.at(-1);
	if (first === undefined || bottom === undefined || first === bottom) return undefined;
	if (lines.slice(0, first).some((line) => /^[╭╰]/.test(plain(line)))) return undefined;
	if (lines.slice(bottom + 1).some((line) => plain(line) !== "")) return undefined;
	// /resume and /tree have a spacer before their top rule. /fork puts
	// its title above the first rule: reuse its leading spacer as the top
	// edge, keeping that title inside the frame and the first rule a divider.
	const hasHeader = lines.slice(0, first).some((line) => plain(line) !== "");
	const top = hasHeader ? 0 : first;
	if (hasHeader && plain(lines[0] ?? "") !== "") return undefined;
	if (bottom - top < 2) return undefined;
	return { top, bottom };
}

function restoreMethod(
	prototype: MenuPrototype,
	name: "render" | "handleMouse",
	installed: unknown,
	original: PropertyDescriptor | undefined,
): void {
	// Do not displace a wrapper installed by another extension after ours.
	if (prototype[name] !== installed) return;
	if (original) Object.defineProperty(prototype, name, original);
	else Reflect.deleteProperty(prototype, name);
}

/** TUI-session-scoped adapter; returns idempotent teardown for shutdown/reload. */
export function installMenuFrames(
	components: readonly unknown[],
	getTheme: () => ChromeTheme,
): () => void {
	let active = true;
	const restore: Array<() => void> = [];
	const seen = new Set<object>();
	for (const component of components) {
		if (typeof component !== "function" || !component.prototype) continue;
		const prototype = component.prototype as MenuPrototype;
		if (seen.has(prototype) || typeof prototype.render !== "function") continue;
		seen.add(prototype);
		const renderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
		const mouseDescriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
		const render = prototype.render;
		const mouse = prototype.handleMouse;
		const layouts = new WeakMap<object, { width: number; top: number; bottom: number }>();

		const framedRender = function (this: MenuPrototype, width: number): string[] {
			layouts.delete(this);
			if (!active || width <= 4) return render.call(this, width);
			const lines = render.call(this, width - 4);
			// Only re-frame the known native rule layout. Already-rounded or
			// future host layouts retain their original render and hit-testing.
			const bounds = nativeFrameBounds(lines);
			if (!bounds) return render.call(this, width);
			const theme = getTheme();
			layouts.set(this, { width, ...bounds });
			return lines.map((line, index) => {
				if (index < bounds.top || index > bounds.bottom) return line;
				if (index === bounds.top) return chromeFrameRule(theme, width, "top");
				if (index === bounds.bottom) return chromeFrameRule(theme, width, "bottom");
				if (isRule(line)) return chromeFrameRule(theme, width, "divider");
				return chromeFrameRow(theme, line, width);
			});
		};
		const framedMouse = mouse && function (this: MenuPrototype, event: MenuMouseEvent): MenuMouseResult | undefined {
			const layout = layouts.get(this);
			if (!active || !layout || event.width !== layout.width) return mouse.call(this, event);
			// Keep row indices unchanged (native rules were replaced, not added).
			// Container's cached child layout was rendered at the inner width.
			if (event.type !== "drag" && event.type !== "release" && (
				event.x < 2 || event.x >= layout.width - 2 ||
				event.y <= layout.top || event.y >= layout.bottom
			)) return undefined;
			return mouse.call(this, { ...event, x: event.x - 2, width: event.width - 4 });
		};

		try {
			Object.defineProperty(prototype, "render", {
				configurable: true, writable: true, ...renderDescriptor, value: framedRender,
			});
			if (framedMouse) Object.defineProperty(prototype, "handleMouse", {
				configurable: true, writable: true, ...mouseDescriptor, value: framedMouse,
			});
		} catch {
			// Frozen prototypes / incompatible hosts must not prevent loading.
			restoreMethod(prototype, "render", framedRender, renderDescriptor);
			continue;
		}
		restore.push(() => {
			restoreMethod(prototype, "render", framedRender, renderDescriptor);
			if (framedMouse) restoreMethod(prototype, "handleMouse", framedMouse, mouseDescriptor);
		});
	}
	return () => {
		if (!active) return;
		active = false;
		for (const cleanup of restore.reverse()) cleanup();
	};
}
