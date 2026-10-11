import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FrameMetadata } from "./render.js";

/**
 * AIO frame capability protocol — mirrors the synchronous event-bus probe
 * pattern pi-zentui uses, on an AIO-owned channel so a standalone Zentui
 * install can never be confused with AIO's own frame.
 */
export const FRAME_CAPABILITY_EVENT = "aio:minimal-frame-capability";

export const AIO_UI_STATE_EVENT = "aio:ui-state";

export const FRAME_CAPABILITY_VERSION = 1;

export interface FrameCapability {
	supported: boolean;
	active: boolean;
	version?: number;
}

export interface AioUiStateUpdate {
	mode?: "default" | "ask" | "plan" | "auto";
	effort?: string;
}

export function isFrameEditorFactory(value: unknown): boolean {
	if (typeof value !== "function") return false;
	// SAFETY: JavaScript functions can own symbol properties; the type system
	// does not retain that object shape after the typeof-function narrowing.
	const factory = value as typeof value & Record<symbol, unknown>;
	return factory[Symbol.for("aio.frame-editor-factory")] === true;
}

/** Probe synchronously: the frame registrar mutates this shared object. */
export function probeFrameEditor(
	pi: Pick<ExtensionAPI, "events">,
): FrameCapability {
	const capability: FrameCapability = { supported: false, active: false };
	try {
		pi.events?.emit(FRAME_CAPABILITY_EVENT, capability);
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

// --- Queue panel rows -------------------------------------------------------

/**
 * The frame renders the pending queue as framed rows inside the editor
 * (above the bottom border). The queue feature owns the data and installs a
 * provider here; the frame only reads.
 */
let queuePanelProvider: (() => string[]) | undefined;

export function setQueuePanelLinesProvider(provider: (() => string[]) | undefined): void {
	queuePanelProvider = provider;
}

export function getQueuePanelLines(): string[] {
	try {
		return queuePanelProvider?.() ?? [];
	} catch {
		return [];
	}
}

// --- Frame metadata contributions -------------------------------------------

/**
 * Features embed their state directly into the frame's borders instead of
 * publishing duplicate footer statuses. Each feature registers under its own
 * key (e.g. "mode", "quota") and supplies a partial FrameMetadata; the frame
 * merges all contributions over its own computed metadata.
 */
const metadataContributors = new Map<
	string,
	() => Partial<FrameMetadata>
>();

export function setFrameMetadataContributor(
	key: string,
	contributor: (() => Partial<FrameMetadata>) | undefined,
): void {
	if (contributor) metadataContributors.set(key, contributor);
	else metadataContributors.delete(key);
}

export function contributedFrameMetadata(): Partial<FrameMetadata> {
	const merged: Partial<FrameMetadata> = {};
	for (const contributor of metadataContributors.values()) {
		try {
			Object.assign(merged, contributor());
		} catch {
			// A broken contributor must never break the frame render.
		}
	}
	return merged;
}

// --- Frame repaint hook -------------------------------------------------------

/**
 * Set by the registrar while a frame editor is installed; lets features that
 * refresh out-of-band (quota fetch, mode change) trigger a repaint.
 */
let repaintHook: (() => void) | undefined;

export function setFrameRepaintHook(hook: (() => void) | undefined): void {
	repaintHook = hook;
}

export function requestFrameRepaint(): void {
	try {
		repaintHook?.();
	} catch {
		// Repaints are best-effort.
	}
}
