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
import {
	checkBlocklist,
	loadBlocklist,
	type BlocklistHit,
	type BlocklistRule,
} from "./config.js";

// pi-cursor-sdk replay calls only display work Cursor's host already
// completed; blocking the replay card cannot undo the mutation and would be
// misleading. Same skip as permission-modes' gate.
const CURSOR_REPLAY_TOOL_CALL_PREFIX = "cursor-replay-";

function blockReason(hit: BlocklistHit, command: string): string {
	return `${hit.reason} (${hit.source})\n  Command: ${command}`;
}

function buildContextContent(rules: BlocklistRule[]): string {
	const lines = rules.map((rule) => {
		const origin = rule.source === "global" ? "global" : "project";
		const reason = rule.reason.replace(/^Blocked by aio blocklist: /, "");
		return `- ${rule.pattern} (${origin}): ${reason}`;
	});
	return `[BLOCKLIST ACTIVE — hard block]
The following agent-issued shell commands are blocked and fail with an error if attempted via the bash tool. They cannot be approved, even in auto mode. Do not attempt them. Commands explicitly typed by the user with !/!! are outside this agent gate:

${lines.join("\n")}`;
}

export function registerBlocklist(pi: ExtensionAPI): void {
	// ---- tool_call gate: hard-block bash in every permission mode ----

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		if (event.toolCallId.startsWith(CURSOR_REPLAY_TOOL_CALL_PREFIX)) {
			return undefined;
		}
		const command = event.input.command;
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
