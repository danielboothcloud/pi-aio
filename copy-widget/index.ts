import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CopyBlockPicker } from "./picker.js";
import { extractCopyableBlocks } from "./parse.js";

function getLastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant")
			continue;

		const message = entry.message as AssistantMessage;
		const text: string[] = [];
		for (const block of message.content) {
			if (block.type === "text") text.push(block.text);
		}
		return text.join("\n");
	}
	return undefined;
}

export function registerCopyWidget(pi: ExtensionAPI): void {
	async function openPicker(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				"/pick is only available in interactive TUI mode",
				"warning",
			);
			return;
		}

		const assistantText = getLastAssistantText(ctx);
		if (!assistantText) {
			ctx.ui.notify(
				"No assistant response is available to copy from",
				"warning",
			);
			return;
		}

		const blocks = extractCopyableBlocks(assistantText);
		if (blocks.length === 0) {
			ctx.ui.notify(
				"The last assistant response has no fenced code blocks or quotes",
				"warning",
			);
			return;
		}

		const selected = await ctx.ui.custom<(typeof blocks)[number] | undefined>(
			(tui, theme, _keybindings, done) =>
				new CopyBlockPicker({
					blocks,
					theme,
					requestRender: () => tui.requestRender(),
					getMaxRows: () => Math.floor(tui.terminal.rows * 0.9),
					done,
				}),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					margin: 1,
					maxHeight: "90%",
					minWidth: 50,
					width: "85%",
				},
			},
		);
		if (!selected) return;

		const noun = selected.kind === "quote" ? "quote" : "code block";
		try {
			await copyToClipboard(selected.text);
			ctx.ui.notify(`Copied ${noun} #${selected.ordinal} to the clipboard`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not copy ${noun}: ${message}`, "error");
		}
	}

	pi.registerCommand("pick", {
		description:
			"Select a fenced code block or quote from the last assistant response and copy it",
		handler: async (_args, ctx) => openPicker(ctx),
	});

	pi.registerShortcut("ctrl+p", {
		description: "Open the code block and quote picker",
		handler: openPicker,
	});
}
