// ---------------------------------------------------------------------------
// aio blocklist — a hard, user-configurable command blocklist.
//
// Blocklisted agent shell commands NEVER run, regardless of permission mode
// (including auto). Explicit user `!`/`!!` commands are not evaluated.
//
// Registration order is load-bearing (see index.ts):
//  - the `tool_call` handler is registered BEFORE permission-modes' gate, so
//    the runner consults it first and its `{ block: true }` wins — even in
//    auto mode where the permission gate would otherwise approve everything.
// ---------------------------------------------------------------------------

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isShellTool } from "../permission-modes/utils.js";
import {
	blocklistSourceLabel,
	checkBlocklist,
	loadBlocklist,
	RECIPE_BLOCKLIST_ENV,
	type BlocklistHit,
	type BlocklistRule,
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

function buildContextContent(rules: BlocklistRule[]): string {
	const lines = rules.map((rule) => {
		const reason = rule.reason.replace(/^Blocked by aio blocklist: /, "");
		return `- ${rule.pattern} (${blocklistSourceLabel(rule)}, ${rule.match}): ${reason}`;
	});
	const notes = [
		"text = matched anywhere in the command text, including quoted arguments and heredoc bodies",
	];
	if (rules.some((rule) => rule.match === "command")) {
		notes.push(
			"command = matched against each command the shell would run (from its program name); commands that cannot be segmented reliably (unbalanced quotes, unterminated heredocs, `| sh`, `source`) are blocked outright",
		);
	}
	return `[BLOCKLIST ACTIVE — hard block]
The following agent-issued shell commands are blocked and fail with an error if attempted via the bash or hypa_shell tools. They cannot be approved, even in auto mode. Do not attempt them. Commands explicitly typed by the user with !/!! are outside this agent gate:

${lines.join("\n")}

Match modes: ${notes.join("; ")}.`;
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

	// ---- before_agent_start: tell the model which commands are blocked ----

	pi.on("before_agent_start", async (_event, ctx) => {
		const rules = loadBlocklist(ctx.cwd);
		if (rules.length === 0) return undefined;
		return {
			message: {
				customType: "blocklist-context",
				content: buildContextContent(rules),
				display: false,
			},
		};
	});

	// ---- context dedup: keep only the latest blocklist-context ----

	pi.on("context", async (event) => {
		const all = event.messages;
		let latestIdx = -1;
		for (let i = all.length - 1; i >= 0; i--) {
			const m = all[i] as AgentMessage & { customType?: string };
			if (m.customType === "blocklist-context") {
				latestIdx = i;
				break;
			}
		}
		const filtered = all.filter((m, i) => {
			const msg = m as AgentMessage & { customType?: string };
			if (msg.customType === "blocklist-context") return i === latestIdx;
			return true;
		});
		return { messages: filtered };
	});
}
