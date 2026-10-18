/**
 * btw/context.ts — regression tests.
 *
 * Flow digest rendering and budgets, workspace snapshot walk + caps, and
 * prompt assembly. All fixtures are plain records; the snapshot tests use a
 * temp directory so no live workspace is read.
 */

import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";

import {
	BTW_SYSTEM_PROMPT,
	buildBtwPrompt,
	buildFlowDigest,
	buildProjectSnapshot,
	FLOW_EMPTY,
	MAX_QUESTION_CHARS,
	SNAPSHOT_UNAVAILABLE,
	SNAPSHOT_EXCLUDE_DIRS,
} from "./context.ts";

// Fixtures ---------------------------------------------------------------

function userEntry(content: string | Array<Record<string, unknown>>): unknown {
	return { type: "message", message: { role: "user", content } };
}

function assistantEntry(blocks: Array<Record<string, unknown>>): unknown {
	return { type: "message", message: { role: "assistant", content: blocks } };
}

function toolResultEntry(name: string, text: string, isError = false): unknown {
	return {
		type: "message",
		message: { role: "toolResult", toolName: name, isError, content: [{ type: "text", text }] },
	};
}

// Flow digest --------------------------------------------------------------

test("digest renders user, assistant, tool calls, and tool results chronologically", () => {
	const branch = [
		userEntry("why did it break"),
		assistantEntry([
			{ type: "thinking", text: "hidden reasoning" },
			{ type: "text", text: "Looking into it." },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } },
		]),
		toolResultEntry("bash", "total 4\nfile.ts"),
		assistantEntry([{ type: "text", text: "Because the schema changed." }]),
	];

	const digest = buildFlowDigest(branch as readonly unknown[]);
	assert.ok(digest.includes("USER: why did it break"), "user line rendered");
	assert.ok(digest.includes("ASSISTANT: Looking into it."), "assistant text rendered");
	assert.ok(digest.includes("→ bash("), "tool call rendered");
	assert.ok(digest.includes('"command":"ls -la"'), "tool call args rendered");
	assert.ok(digest.includes("TOOL bash: total 4"), "tool result rendered");
	assert.ok(digest.includes("ASSISTANT: Because the schema changed."), "latest assistant rendered");
	assert.ok(!digest.includes("hidden reasoning"), "thinking blocks are dropped");
});

test("digest flags failed tool results", () => {
	const digest = buildFlowDigest([toolResultEntry("bash", "boom", true)] as readonly unknown[]);
	assert.ok(digest.includes("TOOL bash (failed): boom"));
});

test("digest keeps the newest messages and trims older ones behind one marker", () => {
	const branch = [
		userEntry("first message rendered"),
		userEntry("second message rendered"),
		userEntry("third message rendered"),
	];
	const digest = buildFlowDigest(branch as readonly unknown[], { maxChars: 40 });
	assert.ok(digest.startsWith("…[2 messages trimmed]"), "trim marker leads");
	assert.ok(digest.includes("USER: third message rendered"), "newest message kept");
	assert.ok(!digest.includes("USER: second"), "overflowing message not rendered");
});

test("digest caps rendered order via maxMessages", () => {
	const branch = [userEntry("first"), userEntry("second"), userEntry("third")];
	const digest = buildFlowDigest(branch as readonly unknown[], { maxMessages: 1 });
	assert.ok(digest.includes("USER: third"), "only the newest message kept");
	assert.ok(digest.startsWith("…[2 messages trimmed]"), "older messages counted");
});

test("digest clips long messages per kind", () => {
	const branch = [
		assistantEntry([{ type: "text", text: "abcdefghij".repeat(20) }]),
		buildFlowDigest([] as readonly unknown[]), // placeholder to keep array shape
	];
	const digest = buildFlowDigest([branch[0]] as readonly unknown[], {
		perMessageChars: { assistant: 10 },
	});
	assert.ok(digest.includes("…[cut]"), "clip marker present");
	assert.ok(digest.replace("ASSISTANT: ", "").split("…[cut]")[0]?.length === 10, "clipped to cap");
});

test("non-message entries pass uncounted", () => {
	const branch = [
		{ type: "custom", customType: "whatever", data: {} },
		{ type: "compaction" },
		userEntry("hi"),
	];
	const digest = buildFlowDigest(branch as readonly unknown[]);
	assert.equal(digest, "USER: hi");
	assert.ok(!digest.includes("trimmed"), "no marker for skipped non-messages");
});

test("empty branch yields an empty digest", () => {
	assert.equal(buildFlowDigest([] as readonly unknown[]), "");
});

// Workspace snapshot --------------------------------------------------------

function writeWorkspace(dir: string): void {
	fsSync.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
	fsSync.writeFileSync(path.join(dir, "big.txt"), "x".repeat(3000));
	fsSync.writeFileSync(path.join(dir, "moderate.ts"), "y".repeat(400));
	fsSync.mkdirSync(path.join(dir, "sub"), { recursive: true });
	fsSync.writeFileSync(path.join(dir, "sub", "small.txt"), "z".repeat(10));
	fsSync.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
	fsSync.writeFileSync(path.join(dir, "node_modules", "dep", "huge.js"), "w".repeat(5000));
}

test("snapshot lists largest files and skips excluded directories", async () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "btw-snapshot-"));
	try {
		writeWorkspace(dir);
		const snapshot = await buildProjectSnapshot(dir, { topFiles: 2 });
		assert.ok(snapshot.includes("WORKSPACE:"), "workspace header");
		assert.ok(snapshot.includes("package.json"), "root listing");
		assert.ok(snapshot.includes("sub/"), "root marks directories");
		assert.ok(snapshot.includes("LARGEST FILES (bytes):"), "largest files section");
		assert.ok(snapshot.includes("big.txt — 3000"), "size ordered first");
		assert.ok(snapshot.includes("moderate.ts — 400"), "second largest listed");
		assert.ok(!snapshot.includes("node_modules"), "excluded dirs never listed");
		assert.ok(snapshot.includes("FILES WALKED: 4"), "package.json + big + moderate + small");
		assert.ok(!snapshot.includes("partial"), "no partial marker at this size");
	} finally {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshot caps the walk and marks it partial", async () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "btw-snapshot-"));
	try {
		writeWorkspace(dir);
		const snapshot = await buildProjectSnapshot(dir, { maxFiles: 2 });
		assert.ok(snapshot.includes("FILES WALKED: 2"), "walk capped");
		assert.ok(snapshot.includes("partial"), "partial marker set");
	} finally {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshot degrades to the unavailable note when the root fails", async () => {
	const missing = path.join(os.tmpdir(), `btw-missing-${Date.now()}`);
	assert.equal(await buildProjectSnapshot(missing), SNAPSHOT_UNAVAILABLE);
});

test("excluded dir set contains the usual generated trees", () => {
	for (const name of ["node_modules", ".git", "dist", "__pycache__"]) {
		assert.ok(SNAPSHOT_EXCLUDE_DIRS.has(name), `${name} excluded`);
	}
});

// Prompt assembly -----------------------------------------------------------

test("prompt packages sections, question, and digest", () => {
	const prompt = buildBtwPrompt({
		question: "what is chunkiest in this repo???",
		flowDigest: "USER: keep the router safe",
		projectSnapshot: "WORKSPACE: /repo\nLARGEST FILES (bytes):\n  big.ts — 9001",
	});
	assert.ok(prompt.includes("CONTEXT — WORKSPACE SNAPSHOT"), "snapshot section");
	assert.ok(prompt.includes("big.ts — 9001"), "snapshot body");
	assert.ok(prompt.includes("CONTEXT — RECENT SESSION FLOW"), "flow section");
	assert.ok(prompt.includes("USER: keep the router safe"), "digest body");
	assert.ok(prompt.endsWith("QUESTION\nwhat is chunkiest in this repo???"), "question last");
	assert.ok(BTW_SYSTEM_PROMPT.includes("By The Way"), "system prompt persona");
});

test("missing context sections fall back to explicit notes", () => {
	const prompt = buildBtwPrompt({ question: "fresh?" });
	assert.ok(prompt.includes(FLOW_EMPTY), "fresh-session note");
	assert.ok(prompt.includes(SNAPSHOT_UNAVAILABLE), "unavailable snapshot note");
});

test("the question clips to its cap", () => {
	const long = "a".repeat(MAX_QUESTION_CHARS + 50);
	const prompt = buildBtwPrompt({ question: long });
	assert.ok(prompt.includes("a".repeat(MAX_QUESTION_CHARS)), "capped question included");
	assert.ok(!prompt.includes("a".repeat(MAX_QUESTION_CHARS + 1)), "question never exceeds the cap");
});

test("the whole prompt truncates under its byte cap", () => {
	const prompt = buildBtwPrompt({
		question: "q",
		flowDigest: "f".repeat(4000),
		projectSnapshot: "p".repeat(4000),
		maxPromptBytes: 500,
	});
	assert.ok(prompt.endsWith("…[truncated to fit the budget]"), "truncation marker");
	assert.ok(Buffer.byteLength(prompt, "utf8") <= 500, "byte cap enforced");
});
