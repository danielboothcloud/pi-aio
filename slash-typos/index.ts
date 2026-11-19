/**
 * slash-typos — stop a mistyped slash command (`/handof goal`) from reaching
 * the model as a prompt. Pi sends an unknown `/name` to the model as text,
 * so a near miss of a known command is held back with a "did you mean"
 * notice, and the corrected command is put in the editor.
 *
 * It must register before the queue: the first `handled` input result wins,
 * so the queue never records a held-back message as queued.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUILTIN_COMMANDS, parseSlashInput, suggestCommands, typoMessage } from "./core.js";

function knownCommands(pi: ExtensionAPI): string[] {
	const names: string[] = [...BUILTIN_COMMANDS];
	for (const command of pi.getCommands()) {
		names.push(command.name);
		// Duplicate registrations get a `:N` suffix; the bare name still runs one.
		const bare = command.name.replace(/:\d+$/, "");
		if (bare !== command.name) names.push(bare);
	}
	return names;
}

export function registerSlashTypos(pi: ExtensionAPI): void {
	// Subagent children are headless: there is no person to correct a typo.
	if (process.env.AIO_SUBAGENT_CHILD === "1") return;

	pi.on("input", (event, ctx) => {
		// Print mode has no visible notice, so holding the text back would hide it.
		if (event.source === "extension" || !ctx.hasUI) return undefined;
		const input = parseSlashInput(event.text);
		if (!input) return undefined;
		const suggestions = suggestCommands(input.name, knownCommands(pi));
		if (suggestions.length === 0) return undefined;

		ctx.ui.notify(typoMessage(input.name, suggestions), "warning");
		if (suggestions.length === 1) ctx.ui.setEditorText(`/${suggestions[0]}${input.rest}`);
		return { action: "handled" };
	});
}
