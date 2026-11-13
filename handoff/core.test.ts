import assert from "node:assert/strict";
import test from "node:test";

import {
	HANDOFF_ENTRY_TYPE,
	appendPreviousConversationLink,
	boundConversation,
	carriedEntries,
	conversationBudget,
	getHandoffMessages,
	hasNoMessages,
	latestHandoffEntry,
	responseText,
	type BranchEntryLike,
} from "./core.ts";

const msg = (id: string, role: string, text: string): BranchEntryLike => ({
	type: "message",
	id,
	message: { role, content: text, timestamp: 1 },
});

test("without compaction: messages and branch summaries, custom entries dropped", () => {
	const branch: BranchEntryLike[] = [
		msg("1", "user", "hello"),
		{ type: "custom_message", id: "c", customType: "styles-context" },
		{ type: "custom", id: "s", customType: "styles", data: { style: "ste" } },
		{ type: "branch_summary", id: "b", summary: "tried X", fromId: "1", timestamp: "2026-01-01T00:00:00Z" },
		msg("2", "assistant", "hi"),
	];
	const roles = getHandoffMessages(branch).map((m) => m.role);
	assert.deepEqual(roles, ["user", "branchSummary", "assistant"]);
});

test("after compaction: latest summary, then kept entries, then newer entries", () => {
	const branch: BranchEntryLike[] = [
		msg("1", "user", "old"),
		msg("2", "assistant", "kept"),
		{ type: "compaction", id: "c1", summary: "S", tokensBefore: 9, firstKeptEntryId: "2", timestamp: "2026-01-01T00:00:00Z" },
		msg("3", "user", "new"),
	];
	const out = getHandoffMessages(branch);
	assert.deepEqual(out.map((m) => m.role), ["compactionSummary", "assistant", "user"]);
	assert.equal((out[0] as { summary: string }).summary, "S");
	assert.equal((out[0] as { tokensBefore: number }).tokensBefore, 9);
	// A firstKeptEntryId that is not on the branch keeps only summary + newer.
	const missing = getHandoffMessages([branch[0]!, { ...branch[2]!, firstKeptEntryId: "zz" }, branch[3]!]);
	assert.deepEqual(missing.map((m) => m.role), ["compactionSummary", "user"]);
	assert.deepEqual(getHandoffMessages([]), []);
});

test("conversation bound keeps the start and the newest part", () => {
	assert.equal(boundConversation("short", 100), "short");
	const text = `${"a".repeat(500)}${"b".repeat(500)}`;
	const bounded = boundConversation(text, 100);
	assert.ok(bounded.startsWith("a".repeat(20)));
	assert.ok(bounded.endsWith("b".repeat(80)));
	assert.match(bounded, /900 characters of the middle of the conversation omitted/);
	assert.equal(conversationBudget(undefined), Math.floor(128_000 * 0.6 * 3.5));
	assert.equal(conversationBudget(1000), 40_000);
	assert.equal(conversationBudget(10_000_000), 1_500_000);
});

test("previous conversation link: plain path plus file URL; none when ephemeral", () => {
	assert.equal(appendPreviousConversationLink("prompt", undefined), "prompt");
	const out = appendPreviousConversationLink("prompt\n\n", "/tmp/a b/s.jsonl");
	assert.equal(
		out,
		"prompt\n\n## Previous conversation\nFull pi transcript (JSONL): [`/tmp/a b/s.jsonl`](file:///tmp/a%20b/s.jsonl)\n\nUse `read` or `rg` on this file if the summary omits a detail.",
	);
});

test("response text joins text blocks only", () => {
	assert.equal(responseText([{ type: "thinking", thinking: "x" }, { type: "text", text: " a " }, { type: "text", text: "b" }]), "a \nb");
	assert.equal(responseText(undefined), "");
});

test("carried entries: newest of each type, in branch order, off pins included", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom", customType: "recipe-state", data: { name: "home" } },
		{ type: "custom", customType: "styles", data: { style: "ste" } },
		{ type: "custom", customType: "modes", data: { mode: "plan" } },
		{ type: "custom", customType: "recipe-state", data: { name: null } },
	];
	assert.deepEqual(carriedEntries(branch, ["recipe-state", "styles", "advisor-state"]), [
		{ customType: "styles", data: { style: "ste" } },
		{ customType: "recipe-state", data: { name: null } },
	]);
});

test("latest handoff entry and the empty-branch check", () => {
	const data = { version: 1, goal: "g", carried: [], createdAt: "now" };
	const branch: BranchEntryLike[] = [{ type: "custom", customType: HANDOFF_ENTRY_TYPE, data }];
	assert.deepEqual(latestHandoffEntry(branch), data);
	assert.equal(latestHandoffEntry([{ type: "custom", customType: HANDOFF_ENTRY_TYPE, data: { version: 2 } }]), undefined);
	assert.equal(hasNoMessages(branch), true);
	assert.equal(hasNoMessages([...branch, msg("1", "user", "go")]), false);
});
