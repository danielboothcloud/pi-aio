// ---------------------------------------------------------------------------
// aio blocklist — a hard, user-configurable command blocklist.
//
// Blocklisted agent shell commands NEVER run, regardless of permission mode
// (including auto). Explicit user `!`/`!!` commands are not evaluated.
// The configured reason is returned only when a shell tool is blocked.
// Rules are not listed in model context.
//
// Registration order is load-bearing (see index.ts):
//  - the `tool_call` handler is registered BEFORE permission-modes' gate, so
//    the runner consults it first and its `{ block: true }` wins — even in
//    auto mode where the permission gate would otherwise approve everything.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isShellTool } from "../permission-modes/utils.js";
import {
	blocklistSourceLabel,
	checkBlocklist,
	RECIPE_BLOCKLIST_ENV,
	type BlocklistHit,
} from "./config.js";

// pi-cursor-sdk replay calls only display work Cursor's host already
// completed; blocking the replay card cannot undo the mutation and would be
// misleading. Same skip as permission-modes' gate.
const CURSOR_REPLAY_TOOL_CALL_PREFIX = "cursor-replay-";

/** Segment previews in block reasons stay short enough to read at a glance. */
export const SEGMENT_PREVIEW_CHARS = 120;

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SEGMENT_PREVIEW_CHARS
		? `${flat.slice(0, SEGMENT_PREVIEW_CHARS - 1)}…`
		: flat;
}

function blockReason(hit: BlocklistHit, command: string): string {
	const lines = [`${hit.reason} (${blocklistSourceLabel(hit)})`];
	if (hit.segment !== undefined) lines.push(`  Matched command: ${preview(hit.segment)}`);
	lines.push(`  Command: ${command}`);
	return lines.join("\n");
}

export function registerBlocklist(pi: ExtensionAPI): void {
	// A top-level pi must not enforce (or pass to its children) a recipe
	// blocklist leaked from an enclosing pi's environment; the recipes feature
	// republishes the active recipe's entries at session_start. Children keep
	// the inherited value — it is their only copy.
	if (process.env.AIO_SUBAGENT_CHILD !== "1") delete process.env[RECIPE_BLOCKLIST_ENV];
	// ---- tool_call gate: hard-block shell tools in every permission mode ----

	pi.on("tool_call", async (event, ctx) => {
		if (!isShellTool(event.toolName)) return undefined;
		if (event.toolCallId.startsWith(CURSOR_REPLAY_TOOL_CALL_PREFIX)) {
			return undefined;
		}
		const command = "command" in event.input ? event.input.command : undefined;
		if (typeof command !== "string") return undefined;
		const hit = checkBlocklist(command, ctx.cwd);
		if (!hit) return undefined;
		return { block: true, reason: blockReason(hit, command) };
	});
}
