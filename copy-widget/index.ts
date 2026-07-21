import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { CodeBlockPicker } from "./picker.js";
import { extractFencedCodeBlocks } from "./parse.js";

function getLastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

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
	pi.registerCommand("pick", {
		description: "Select a fenced code block from the last assistant response and copy it",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/pick is only available in interactive TUI mode", "warning");
				return;
			}

			const assistantText = getLastAssistantText(ctx);
			if (!assistantText) {
				ctx.ui.notify("No assistant response is available to copy from", "warning");
				return;
			}

			const blocks = extractFencedCodeBlocks(assistantText);
			if (blocks.length === 0) {
				ctx.ui.notify("The last assistant response has no fenced code blocks", "warning");
				return;
			}

			const selected = await ctx.ui.custom<(typeof blocks)[number] | undefined>(
				(tui, theme, _keybindings, done) =>
					new CodeBlockPicker({
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

			try {
				await copyToClipboard(selected.code);
				ctx.ui.notify(`Copied code block #${selected.ordinal} to the clipboard`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not copy code block: ${message}`, "error");
			}
		},
	});
}
