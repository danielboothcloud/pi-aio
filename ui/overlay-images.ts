// Terminal inline images (Kitty graphics and iTerm2 inline images) are drawn
// by the terminal on a layer above text. Pi composites overlays as text over
// the base lines and skips image lines, so an image in the transcript paints
// over any overlay rows it covers. While an AIO overlay asks for it, this
// module blanks every image whose rows reach into the visible viewport before
// pi composites the overlays. The image comes back on the first render after
// the overlay closes, because the base lines are rendered fresh each frame.

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
// Pi's Image component puts a cursor-up before multi-row iTerm2 images; the
// image then starts that many rows above the line that carries it.
const CURSOR_UP = /\x1b\[(\d+)A/;

type CompositeOverlays = (lines: string[], termWidth: number, termHeight: number) => string[];

/** The public pi TUI surface this module needs. */
export interface OverlayTui {
	requestRender(): void;
}

/** Protected pi TUI members this module patches; both may be absent. */
interface OverlayHost extends OverlayTui {
	compositeOverlays?: CompositeOverlays;
	overlayStack?: unknown[];
}

interface Suspension {
	count: number;
	hadOwn: boolean;
	ownValue: CompositeOverlays | undefined;
}

const suspensions = new WeakMap<OverlayHost, Suspension>();

/** Rows an image line covers, relative to the line itself, or undefined. */
export function imageRowSpan(line: string): { above: number; below: number } | undefined {
	const kitty = line.indexOf(KITTY_PREFIX);
	const iterm = line.indexOf(ITERM2_PREFIX);
	if (kitty === -1 && iterm === -1) return undefined;
	let above = 0;
	let below = 0;
	const starts = [kitty, iterm].filter((index) => index !== -1);
	const start = Math.min(...starts);
	const up = CURSOR_UP.exec(line.slice(0, start));
	if (up) above = Number(up[1]) || 0;
	if (kitty !== -1) {
		const paramsEnd = line.indexOf(";", kitty + KITTY_PREFIX.length);
		const params = paramsEnd === -1 ? "" : line.slice(kitty + KITTY_PREFIX.length, paramsEnd);
		for (const param of params.split(",")) {
			const [key, value] = param.split("=", 2);
			const rows = Number(value);
			if (key === "r" && Number.isInteger(rows) && rows > 1) below = rows - 1;
		}
	}
	return { above, below };
}

/**
 * Replace image lines whose rows overlap the visible viewport with empty
 * lines. Row count is preserved, so the layout under the overlay does not
 * move. Images fully in scrollback stay untouched.
 */
export function hideViewportImages(lines: string[], termHeight: number): string[] {
	const viewportStart = Math.max(0, Math.max(lines.length, termHeight) - termHeight);
	let result: string[] | undefined;
	for (let i = 0; i < lines.length; i++) {
		const span = imageRowSpan(lines[i] ?? "");
		if (!span || i + span.below < viewportStart) continue;
		result ??= [...lines];
		result[i] = "";
	}
	return result ?? lines;
}

/**
 * Hide transcript images under overlays on this TUI until the returned
 * function runs. Calls nest; the original renderer comes back after the
 * last release, which also requests a render so images show again.
 * Unknown TUI shapes make this a no-op.
 */
export function suspendImagesUnderOverlays(tui: OverlayTui): () => void {
	const host = tui as OverlayHost;
	const original = host.compositeOverlays;
	if (typeof original !== "function") return () => {};
	let suspension = suspensions.get(host);
	if (suspension) {
		suspension.count++;
	} else {
		const hadOwn = Object.prototype.hasOwnProperty.call(host, "compositeOverlays");
		suspension = { count: 1, hadOwn, ownValue: hadOwn ? original : undefined };
		suspensions.set(host, suspension);
		const patched: CompositeOverlays = function (this: OverlayHost, lines, termWidth, termHeight) {
			const hasOverlay = Array.isArray(this.overlayStack) ? this.overlayStack.length > 0 : true;
			const base = hasOverlay ? hideViewportImages(lines, termHeight) : lines;
			return original.call(this, base, termWidth, termHeight);
		};
		host.compositeOverlays = patched;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = suspensions.get(host);
		if (!current || --current.count > 0) return;
		suspensions.delete(host);
		if (current.hadOwn) host.compositeOverlays = current.ownValue;
		else Reflect.deleteProperty(host, "compositeOverlays");
		host.requestRender();
	};
}
