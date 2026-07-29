import type {
	AgentMessage,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { QueueController } from "./controller.js";
import { buildQueueLines } from "./lines.js";
import { QueueEditor } from "./queue-editor.js";

const WIDGET_KEY = "aio-queue";

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

export function registerQueue(pi: ExtensionAPI): void {
	let enabled = true;
	let controller: QueueController | null = null;
	let activeEditor: QueueEditor | null = null;

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const entries = enabled ? (controller?.mirror.entries() ?? []) : [];
		if (entries.length === 0) {
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

	function restoreTextsToEditor(ctx: ExtensionContext, texts: string[]): void {
		if (!ctx.hasUI || texts.length === 0) return;
		const current = activeEditor?.getText() ?? "";
		const combined = [texts.join("\n\n"), current]
			.filter((text) => text.trim())
			.join("\n\n");
		ctx.ui.setEditorText(combined);
	}

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
			restoreTextsToEditor: (texts) => restoreTextsToEditor(ctx, texts),
			sendUserMessage: (text, mode) =>
				pi.sendUserMessage(text, { deliverAs: mode }),
			notify: (message, type) => ctx.ui.notify(message, type),
			updateWidget: () => updateWidget(ctx),
		});
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new QueueEditor(tui, theme, keybindings, ctx, {
				onEmptySubmit: () =>
					enabled ? (controller?.onEmptySubmit() ?? false) : false,
			});
			activeEditor = editor;
			return editor;
		});
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
