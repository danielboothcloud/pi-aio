// Pure context-scrub core for loop-police: removes stagnant assistant
// messages from the request context together with every toolResult paired
// to their tool calls. No SDK runtime imports (type-only, erased by tsx) —
// mirrors the detect.ts/state.ts test seams.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Remove stagnant assistant messages from the request context, together with
 * every toolResult paired to their tool calls.
 *
 * Dropping the assistant message alone orphans its tool results: Responses-API
 * providers (OpenAI Codex) reject any request containing a
 * `function_call_output` whose matching `function_call` is absent —
 * "No tool call found for function call output with call_id …" — and the
 * failure is sticky, because the poisoned pairing is rebuilt on every later
 * request. The assistant message is removed whole (reasoning item, text, tool
 * calls) rather than having only its thinking stripped: keeping the tool calls
 * while dropping the thinking would drop the reasoning item the calls must
 * stay paired with, which Codex also rejects. Bails (returns undefined) if
 * nothing would change or if the scrub would empty the context entirely, so
 * the handler can skip rewriting the request.
 */
export function scrubStagnantContext(
	messages: readonly AgentMessage[],
	stagnant: ReadonlySet<number>,
	thinkingIndexes: readonly number[],
): AgentMessage[] | undefined {
	if (stagnant.size === 0) return undefined;
	const thinkingSet = new Set<number>(thinkingIndexes);

	// Collect the tool call ids living in removed assistant messages, in both
	// full ("call_x|fc_y") and bare ("call_x") form — tool results may carry
	// either spelling depending on the provider that produced them.
	const removedToolCallIds = new Set<string>();
	for (const i of stagnant) {
		if (!thinkingSet.has(i)) continue;
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = (message.content as Array<{ type: string; id?: string }> | undefined) ?? [];
		for (const block of blocks) {
			if (block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0) {
				removedToolCallIds.add(block.id);
				removedToolCallIds.add(block.id.split("|", 1)[0] ?? block.id);
			}
		}
	}

	let removed = 0;
	const filtered = messages.filter((message, i) => {
		if (stagnant.has(i) && thinkingSet.has(i)) {
			removed++;
			return false;
		}
		if (removedToolCallIds.size > 0 && message?.role === "toolResult") {
			const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
			if (
				typeof toolCallId === "string" &&
				(removedToolCallIds.has(toolCallId) ||
					removedToolCallIds.has(toolCallId.split("|", 1)[0] ?? toolCallId))
			) {
				removed++;
				return false;
			}
		}
		return true;
	});
	if (removed === 0 || filtered.length === 0) return undefined;
	return filtered;
}
