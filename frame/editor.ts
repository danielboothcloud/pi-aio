/**
 * MinimalistFrameEditor — wraps the active editor component and renders it
 * inside the AIO minimalist frame, adapted from pi-zentui's
 * WrappedPolishedEditor + ui.ts minimalist branch (MIT, see UPSTREAM.md).
 *
 * Deviations: mouse events forward unadjusted, and panel rows (autocomplete,
 * queue) are supplied by the registrar via `getPanelLines`.
 */

import type { EditorComponent } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FrameMetadata, FrameStyle } from "./render.js";
import { renderMinimalistFrame } from "./render.js";
import type { ThemeLike } from "./style.js";

type AutocompleteListInternals = { render(width: number): AutocompleteRenderResult };

/** The predecessor's render result — string rows in compatible editors. */
type AutocompleteRenderResult = string[];

type RenderMethod = (this: AutocompleteListInternals, width: number) => AutocompleteRenderResult;

type AutocompleteEditorInternals = {
	autocompleteList?: AutocompleteListInternals;
	isShowingAutocomplete?: () => boolean;
};

type AutocompleteCapture = { compatible: boolean; called: number; rows: string[] };

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stripNativeRightPadding(value: string): string {
	return value.replace(/ +$/, "");
}

/**
 * Capture the autocomplete dropdown's own render output while the base editor
 * renders, so the frame can re-frame those rows with its border idiom.
 */
export function renderWithAutocompleteCapture<T>(
	source: AutocompleteEditorInternals,
	render: () => T,
): { value: T; capture?: AutocompleteCapture } {
	let showing = false;
	try {
		showing =
			typeof source.isShowingAutocomplete === "function" &&
			source.isShowingAutocomplete.call(source);
	} catch {
		return { value: render() };
	}
	if (!showing) return { value: render(), capture: { compatible: true, called: 0, rows: [] } };

	let list: AutocompleteListInternals;
	let own: PropertyDescriptor | undefined;
	let predecessor: RenderMethod;
	try {
		const candidate = source.autocompleteList;
		if (!candidate) return { value: render() };
		own = Object.getOwnPropertyDescriptor(candidate, "render");
		const current: RenderMethod = candidate.render;
		if (typeof current !== "function") return { value: render() };
		if (own && (!("value" in own) || own.writable !== true)) return { value: render() };
		if (!own && !Object.isExtensible(candidate)) return { value: render() };
		list = candidate;
		predecessor = current;
	} catch {
		return { value: render() };
	}

	const capture: AutocompleteCapture = { compatible: true, called: 0, rows: [] };
	// SAFETY: the wrapper must return the predecessor's result unchanged —
	// base.render() consumes it. The annotation is a passthrough cast, not a
	// transform; incompatibility is tracked via capture.compatible.
	const wrapper = function (this: AutocompleteListInternals, width: number): string[] {
		const result = predecessor.call(this, width) as string[];
		capture.called++;
		if (!isStringArray(result)) {
			capture.compatible = false;
			return result;
		}
		capture.rows = [...result];
		return result;
	};
	const installedDescriptor: PropertyDescriptor = {
		...(own ?? { configurable: true, enumerable: false, writable: true }),
		value: wrapper,
	};
	try {
		Object.defineProperty(list, "render", installedDescriptor);
	} catch {
		return { value: render() };
	}
	try {
		return { value: render(), capture };
	} finally {
		if (own) Object.defineProperty(list, "render", own);
		else {
			try {
				delete (list as { render?: unknown }).render;
			} catch {
				// Non-configurable residue: leave the wrapper; capture is bounded
				// to this render call by `called === 1` checks downstream.
			}
		}
	}
}

function autocompleteCount(
	source: AutocompleteEditorInternals,
	capture: AutocompleteCapture | undefined,
	baseRendered: string[],
): { known: boolean; count: number } {
	try {
		const showing = source.isShowingAutocomplete;
		if (typeof showing !== "function" || !showing.call(source)) return { known: true, count: 0 };
		if (
			!capture?.compatible ||
			capture.called !== 1 ||
			capture.rows.length <= 0 ||
			capture.rows.length >= baseRendered.length
		) {
			return { known: false, count: 0 };
		}
		const suffix = baseRendered.slice(-capture.rows.length);
		const matches = suffix.every((line, index) => {
			const captured = capture.rows[index];
			return (
				captured !== undefined &&
				(line === captured || stripNativeRightPadding(line) === stripNativeRightPadding(captured))
			);
		});
		return matches ? { known: true, count: capture.rows.length } : { known: false, count: 0 };
	} catch {
		return { known: false, count: 0 };
	}
}

export interface MinimalistFrameEditorOptions {
	uiTheme: ThemeLike;
	style: FrameStyle;
	getMetadata: () => FrameMetadata;
	/** Extra framed rows (e.g. the queue panel) rendered above the bottom border. */
	getPanelLines?: () => string[];
}

/** The wrapped editor plus the optional extension surface Pi editors expose. */
export type FrameBaseEditor = EditorComponent &
	AutocompleteEditorInternals & {
		focused?: boolean;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onPasteImage?: () => void;
		onExtensionShortcut?: (data: string) => boolean;
		actionHandlers?: Map<unknown, () => void>;
		handleMouse?: (event: unknown) => void;
	};

export class MinimalistFrameEditor implements EditorComponent {
	private requestRender: (() => void) | undefined;

	constructor(
		private readonly base: FrameBaseEditor,
		private readonly options: MinimalistFrameEditorOptions,
	) {}

	invalidate(): void {
		this.base.invalidate?.();
	}

	/** Registrar hook: lets lifecycle events trigger a repaint. */
	setRequestRender(callback: () => void): void {
		this.requestRender = callback;
	}

	notifyChanged(): void {
		this.requestRender?.();
	}

	// --- EditorComponent forwarding -----------------------------------------

	get focused(): boolean {
		return Boolean(this.base.focused);
	}
	set focused(value: boolean) {
		this.base.focused = value;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.base.borderColor;
	}
	set borderColor(value: ((str: string) => string) | undefined) {
		this.base.borderColor = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}
	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}
	set onChange(value: ((text: string) => void) | undefined) {
		this.base.onChange = value;
	}

	get onEscape(): (() => void) | undefined {
		return this.base.onEscape;
	}
	set onEscape(value: (() => void) | undefined) {
		this.base.onEscape = value;
	}

	get onCtrlD(): (() => void) | undefined {
		return this.base.onCtrlD;
	}
	set onCtrlD(value: (() => void) | undefined) {
		this.base.onCtrlD = value;
	}

	get onPasteImage(): (() => void) | undefined {
		return this.base.onPasteImage;
	}
	set onPasteImage(value: (() => void) | undefined) {
		this.base.onPasteImage = value;
	}

	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return this.base.onExtensionShortcut;
	}
	set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
		this.base.onExtensionShortcut = value;
	}

	get actionHandlers(): Map<unknown, () => void> | undefined {
		return this.base.actionHandlers;
	}
	set actionHandlers(value: Map<unknown, () => void> | undefined) {
		this.base.actionHandlers = value;
	}

	get autocompleteList(): AutocompleteListInternals | undefined {
		return this.base.autocompleteList;
	}

	getText(): string {
		return this.base.getText();
	}
	setText(text: string): void {
		this.base.setText(text);
	}
	getExpandedText(): string {
		if (typeof this.base.getExpandedText === "function") return this.base.getExpandedText();
		return this.base.getText();
	}
	handleInput(data: string): void {
		this.base.handleInput(data);
	}
	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}
	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}
	setAutocompleteProvider(provider: unknown): void {
		this.base.setAutocompleteProvider?.(provider as never);
	}
	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}
	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}
	handleMouse?(event: unknown): void {
		// Forwarded unadjusted (see UPSTREAM.md deviations).
		this.base.handleMouse?.(event);
	}

	// --- Rendering -----------------------------------------------------------

	render(width: number): string[] {
		const { style, uiTheme } = this.options;
		if (width <= 4) return this.base.render(width);

		let captured: { value: string[]; capture?: AutocompleteCapture };
		try {
			captured = renderWithAutocompleteCapture(this.base, () => this.base.render(width - 4));
		} catch {
			return this.base.render(width);
		}
		const baseRendered = captured.value;
		if (baseRendered.length < 2) {
			return baseRendered.map((line) => truncateToWidth(line, width, ""));
		}

		const autocomplete = autocompleteCount(this.base, captured.capture, baseRendered);
		if (!autocomplete.known) return baseRendered.map((line) => truncateToWidth(line, width, ""));

		const autocompleteLines =
			autocomplete.count > 0 ? baseRendered.slice(-autocomplete.count) : [];
		const editorFrame = baseRendered.slice(0, baseRendered.length - autocomplete.count);
		if (editorFrame.length < 1) {
			return baseRendered.map((line) => truncateToWidth(line, width, ""));
		}

		// The base editor draws its own rule borders (plain `────` rows, with
		// optional `─── ↑ N more ──` viewport indicators). Strip them so the
		// frame does not double-border, and lift the viewport counts into the
		// frame's labeled borders.
		const top = parseBaseBorderRule(editorFrame[0] ?? "", "above");
		const bottom = parseBaseBorderRule(editorFrame.at(-1) ?? "", "below");
		const stripped = top !== undefined && bottom !== undefined;
		const editorLines = stripped ? editorFrame.slice(1, -1) : editorFrame;
		const viewport =
			stripped && style.viewportIndicators
				? { above: top?.count, below: bottom?.count }
				: undefined;

		const panelLines = [...autocompleteLines, ...(this.options.getPanelLines?.() ?? [])];
		const metadata = this.options.getMetadata();
		return renderMinimalistFrame({
			width,
			editorLines,
			panelLines,
			viewport,
			inputText: this.base.getText(),
			metadata,
			uiTheme,
			style,
			borderColor: this.base.borderColor,
		});
	}
}

function plainText(line: string): string {
	// eslint-disable-next-line no-control-regex -- SGR sequences only
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Recognize the base editor's border rows: a bare rule (`────`) or a rule
 * carrying a scroll indicator (`─── ↑ 3 more ──`). Returns the indicator
 * count when present, `{}` for a bare rule, undefined for non-border rows.
 * Mirrors upstream's parseEditorBorder.
 */
export function parseBaseBorderRule(
	line: string,
	direction: "above" | "below",
): { count?: string } | undefined {
	const plain = plainText(line).trim();
	if (/^─+$/.test(plain)) return {};
	const arrow = direction === "above" ? "↑" : "↓";
	const match = new RegExp(`^─{3,} ${arrow} ([1-9]\\d*) more ─*$`).exec(plain);
	return match?.[1] ? { count: match[1] } : undefined;
}
