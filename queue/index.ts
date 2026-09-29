import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isFrameEditorFactory,
	setQueuePanelLinesProvider,
} from "../frame/protocol.js";
import { QueueController } from "./controller.js";
import { buildQueueLines, firstLinePreview, MAX_QUEUE_ROWS } from "./lines.js";
import type { QueuedMessage } from "./mirror.js";
import { QueueEditor } from "./queue-editor.js";
import { plural } from "../ui/chrome.js";

const WIDGET_KEY = "aio-queue";

/**
 * True when a framed editor environment owns the editor (AIO's frame, or a
 * standalone Zentui install): the below-editor widget would clash with the
 * frame, so the queue renders inside the frame (AIO) or yields (Zentui).
 */
function isFramedEditor(ctx: ExtensionContext): boolean {
	try {
		const factory = ctx.ui.getEditorComponent?.();
		if (!factory || typeof factory !== "function") return false;
		// SAFETY: editor factories are branded with symbol properties by both
		// AIO's frame and standalone Zentui; the type system cannot see symbol
		// keys on a function, so a Record<symbol, unknown> view is required.
		const branded = factory as unknown as Record<symbol, unknown>;
		return (
			isFrameEditorFactory(factory) ||
			branded[Symbol.for("pi-zentui.editor-factory")] === true
		);
	} catch {
		return false;
	}
}

/** Matches AgentSession's _getUserMessageText (text blocks joined without separator). */
function extractUserText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Put texts back into the editor without ever duplicating: texts the editor
 * already holds (e.g. re-dumped by pi's abort paths) are skipped so a later
 * Enter sends each exactly once.
 */
export function restoreTextsToEditor(
	ctx: ExtensionContext,
	texts: string[],
	activeEditor?: { getText(): string } | null,
): void {
	if (!ctx.hasUI || texts.length === 0) return;
	const current = ctx.ui.getEditorText?.() ?? activeEditor?.getText() ?? "";
	const merged = texts.filter((text) => !current.includes(text));
	const combined = [merged.join("\n\n"), current]
		.filter((text) => text.trim())
		.join("\n\n");
	ctx.ui.setEditorText(combined);
}

export function registerQueue(pi: ExtensionAPI): void {
	let enabled = true;
	let controller: QueueController | null = null;
	let activeEditor: QueueEditor | null = null;

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const entries = enabled ? (controller?.mirror.entries() ?? []) : [];
		latestEntries = entries;
		if (entries.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		if (isFramedEditor(ctx)) {
			// The frame renders the queue as rows inside the editor; a widget
			// would duplicate it. Touch the (empty) widget anyway so the TUI
			// repaints with the new frame rows.
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return buildQueueLines({ entries, width, theme });
				},
			}),
			{ placement: "belowEditor" },
		);
	}

	// Feed the frame's in-editor queue panel: compact preview rows the frame
	// renders above its bottom border when it owns the editor.
	let latestEntries: QueuedMessage[] = [];
	setQueuePanelLinesProvider(() => {
		if (!enabled || latestEntries.length === 0) return [];
		const lines: string[] = [
			`queue · ${plural(latestEntries.length, "pending message")} · Enter sends next`,
		];
		for (const [index, entry] of latestEntries.slice(0, MAX_QUEUE_ROWS).entries()) {
			const preview = firstLinePreview(entry.text);
			const meta = entry.mode === "steer" ? " · steer" : "";
			lines.push(`${index + 1} ${preview.line}${preview.truncated ? " …" : ""}${meta}`);
		}
		return lines;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			controller = null;
			return;
		}
		controller = new QueueController({
			isIdle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
			abort: () => ctx.abort(),
			clearEditor: () => ctx.ui.setEditorText(""),
			restoreTextsToEditor: (texts) =>
				restoreTextsToEditor(ctx, texts, activeEditor),
			sendUserMessage: (text, mode) =>
				pi.sendUserMessage(text, { deliverAs: mode }),
			notify: (message, type) => ctx.ui.notify(message, type),
			updateWidget: () => updateWidget(ctx),
		});
		// Standalone Zentui (globally installed, separate from AIO) marks its
		// editor factory with a well-known symbol; never displace it. Otherwise
		// install our QueueEditor (extends the user-bash BashHintEditor).
		const existingEditor = ctx.ui.getEditorComponent?.();
		const standaloneZentui =
			typeof existingEditor === "function" &&
			(existingEditor as Record<symbol, unknown>)[Symbol.for("pi-zentui.editor-factory")] === true;
		if (!standaloneZentui) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = new QueueEditor(tui, theme, keybindings, ctx, {
					onEmptySubmit: () =>
						enabled ? (controller?.onEmptySubmit() ?? false) : false,
				});
				activeEditor = editor;
				return editor;
			});
		}
		updateWidget(ctx);
	});

	pi.on("input", async (event) => {
		// streamingBehavior is only set while the agent is busy, which is
		// exactly when the message is being queued rather than prompted.
		if (event.streamingBehavior) {
			controller?.handleQueuedInput(event.text, event.streamingBehavior);
		}
		return undefined;
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			controller?.handleUserMessageText(extractUserText(event.message));
		}
	});

	pi.on("agent_start", async () => {
		controller?.onAgentStart();
	});

	pi.on("agent_end", async () => {
		controller?.resync();
	});

	pi.on("agent_settled", async () => {
		controller?.onAgentSettled();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		controller = null;
		activeEditor = null;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("queue", {
		description:
			"Toggle or inspect the aio queue UI (on|off|status). Enter on an empty input interrupts the agent and sends the next queued message.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			switch (arg) {
				case "on":
				case "enable":
					enabled = true;
					updateWidget(ctx);
					ctx.ui.notify("Queue UI enabled", "info");
					return;
				case "off":
				case "disable":
					enabled = false;
					updateWidget(ctx);
					ctx.ui.notify(
						"Queue UI disabled (Enter-on-empty interrupt is off)",
						"info",
					);
					return;
				case "":
				case "status": {
					const entries = controller?.mirror.entries() ?? [];
					const state = enabled ? "on" : "off";
					if (entries.length === 0) {
						ctx.ui.notify(`Queue UI ${state} · no pending messages`, "info");
						return;
					}
					const preview = entries
						.map(
							(entry, index) => `${index + 1}. [${entry.mode}] ${entry.text}`,
						)
						.join("\n");
					ctx.ui.notify(`Queue UI ${state} · pending:\n${preview}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /queue [on|off|status]", "warning");
			}
		},
	});
}
