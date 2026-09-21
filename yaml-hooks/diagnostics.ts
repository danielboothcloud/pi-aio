// Diagnostics surface: /hooks-* command output persists as context-free
// custom messages (never sent to the LLM) rendered by a themed renderer.
// Ported from pi-yaml-hooks (MIT), simplified to Pi's message surface.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

export const HOOK_DIAGNOSTICS_MESSAGE_TYPE = "aio-yaml-hooks-diagnostics";

export interface HookDiagnosticsDetails {
	readonly title: string;
	readonly level: "info" | "warning" | "error";
	readonly sections?: Array<{
		readonly label: string;
		readonly lines: string[];
	}>;
}

/** Register the themed renderer for hook-diagnostics messages. */
export function registerHookDiagnostics(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<HookDiagnosticsDetails>(
		HOOK_DIAGNOSTICS_MESSAGE_TYPE,
		(message, options, theme) => {
			const details = message.details as HookDiagnosticsDetails | undefined;
			const level = details?.level ?? "info";
			const title = details?.title ?? "aio yaml hooks diagnostics";
			const badgeColor = level === "error" ? "error" : level === "warning" ? "warning" : "dim";

			const rows: string[] = [
				`${theme.fg(badgeColor, `[${level.toUpperCase()}]`)} ${theme.bold(title)}`,
				contentText(message.content),
			];

			if (options.expanded && details?.sections) {
				for (const section of details.sections) {
					rows.push("");
					rows.push(theme.fg("dim", section.label));
					rows.push(...section.lines);
				}
			}

				const text = new Text();
				text.setText(rows.join("\n"));
				return text;
			},
	);
}

/** Diagnostics content is always written as a string; narrow defensively. */
function contentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

export function sendHookDiagnostics(
	pi: ExtensionAPI,
	message: {
		readonly content: string;
		readonly title: string;
		readonly level: "info" | "warning" | "error";
		readonly sections?: HookDiagnosticsDetails["sections"];
	},
): void {
	pi.sendMessage<HookDiagnosticsDetails>({
		customType: HOOK_DIAGNOSTICS_MESSAGE_TYPE,
		content: message.content,
		display: true,
		details: {
			title: message.title,
			level: message.level,
			...(message.sections ? { sections: message.sections } : {}),
		},
	});
}
