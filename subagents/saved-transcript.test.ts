import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSavedTranscript, MAX_SAVED_TRANSCRIPT_BYTES } from "./saved-transcript.ts";
import { MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_ENTRIES } from "./transcript.ts";

function fixture(t: { after: (fn: () => void) => void }): string {
	const base = join(process.cwd(), ".pi-subagents");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "saved-transcript-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "session.jsonl");
}
const entry = (id: string, parentId: string | null, message: object) => ({ type: "message", id, parentId, message });

test("saved transcript restores thinking, responses, tool arguments/results on the selected branch", (t) => {
	const path = fixture(t);
	writeFileSync(path, [
		{ type: "session", version: 3 },
		entry("u", null, { role: "user", content: "Original assignment" }),
		entry("old", "u", { role: "assistant", content: [{ type: "text", text: "Abandoned branch" }] }),
		entry("a", "u", { role: "assistant", content: [{ type: "thinking", thinking: "Saved reasoning" }, { type: "text", text: "Saved response" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } }] }),
		entry("r", "a", { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Saved file output" }], isError: false }),
	].map((item) => JSON.stringify(item)).join("\n") + '\n{"partial":');
	const transcript = loadSavedTranscript(path)!;
	const text = JSON.stringify(transcript.entries);
	assert.match(text, /Original assignment|Saved reasoning|Saved response/);
	assert.doesNotMatch(text, /Abandoned branch/);
	const tool = transcript.entries.find((item) => item.kind === "tool");
	assert.equal(tool?.kind === "tool" && tool.status, "done");
	assert.equal(tool?.kind === "tool" && tool.output, "Saved file output");
	assert.match(tool?.kind === "tool" ? tool.args : "", /README.md/);
});

test("file reads and transcript retention are bounded for oversized sessions", (t) => {
	const path = fixture(t);
	const lines = [{ message: { role: "user", content: "x".repeat(MAX_SAVED_TRANSCRIPT_BYTES + 100) } }, ...Array.from({ length: 600 }, (_, index) => ({ message: { role: "assistant", content: [{ type: "text", text: `response ${index} ` + "z".repeat(1_000) }] } }))];
	writeFileSync(path, lines.map((item) => JSON.stringify(item)).join("\n"));
	const transcript = loadSavedTranscript(path)!;
	assert.ok(transcript.entries.length <= MAX_TRANSCRIPT_ENTRIES);
	assert.ok(transcript.chars <= MAX_TRANSCRIPT_CHARS);
	assert.match(JSON.stringify(transcript.entries), /bounded tail/);
	assert.match(JSON.stringify(transcript.entries), /response 599/);
});

test("missing, empty, and malformed child files degrade to historical output", (t) => {
	const path = fixture(t);
	assert.equal(loadSavedTranscript(path), undefined);
	writeFileSync(path, "");
	assert.equal(loadSavedTranscript(path), undefined);
	writeFileSync(path, "not json\n{partial");
	assert.equal(loadSavedTranscript(path), undefined);
});
