import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ZENTUI_WORKING_LINE_SEGMENT_CAPABILITY_EVENT =
	"zentui:working-line-segment-capability";
export const ZENTUI_WORKING_LINE_SEGMENT_EVENT =
	"zentui:working-line-segment";
export const ZENTUI_WORKING_LINE_SEGMENT_PROTOCOL_VERSION = 1;

export const AIO_UI_STATE_EVENT = "aio:ui-state";

const ZENTUI_EDITOR_FACTORY = Symbol.for("pi-zentui.editor-factory");

export interface ZentuiWorkingLineCapability {
	supported: boolean;
	active: boolean;
	version?: number;
}

export interface AioUiStateUpdate {
	mode?: "default" | "ask" | "plan" | "auto";
	effort?: string;
}

export function isZentuiEditorFactory(value: unknown): boolean {
	if (typeof value !== "function") return false;
	// SAFETY: JavaScript functions can own symbol properties; the type system
	// does not retain that object shape after the typeof-function narrowing.
	const factory = value as typeof value & Record<symbol, unknown>;
	return factory[ZENTUI_EDITOR_FACTORY] === true;
}

/** Probe synchronously: Zentui mutates this shared object through Pi's event bus. */
export function probeZentuiWorkingLine(
	pi: Pick<ExtensionAPI, "events">,
): ZentuiWorkingLineCapability {
	const capability: ZentuiWorkingLineCapability = {
		supported: false,
		active: false,
	};
	try {
		pi.events?.emit(ZENTUI_WORKING_LINE_SEGMENT_CAPABILITY_EVENT, capability);
	} catch {
		// Older hosts and deliberately minimal test harnesses have no event bus.
	}
	return capability;
}

export function emitAioUiState(
	pi: Pick<ExtensionAPI, "events">,
	update: AioUiStateUpdate,
): void {
	try {
		pi.events?.emit(AIO_UI_STATE_EVENT, update);
	} catch {
		// UI integration is best-effort and must never block mode changes.
	}
}

export function publishZentuiWorkingLineSegment(
	pi: Pick<ExtensionAPI, "events">,
	key: string,
	text?: string,
): void {
	try {
		pi.events?.emit(ZENTUI_WORKING_LINE_SEGMENT_EVENT, { key, text });
	} catch {
		// UI integration is best-effort and must never block agent progress.
	}
}
