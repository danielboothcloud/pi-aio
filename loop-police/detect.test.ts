// Detector regression tests: pure detection core, config parsing, state
// store, and recovery-message assembly. All seams injected — no SDK types,
// no I/O (mirrors the blocklist/yaml-hooks test patterns).

import assert from "node:assert/strict";
import test from "node:test";
import {
	detectCharTailLoop,
	detectSemanticLoop,
	detectStreamLoop,
	isReadTool,
	isSearchTool,
	isWriteTool,
	paragraphFingerprint,
	pickToolPath,
	toolCallKey,
	wordTokens,
	jaccardSimilarity,
	textSimilarity,
} from "./detect.js";
import {
	defaultConfig,
	parseConfigOver,
	parseConfigText,
	readLoopPoliceConfig,
	substitutePlaceholders,
	LOOP_POLICE_FILE_NAME,
} from "./config.js";
import {
	checkRead,
	checkSearch,
	checkToolCallSequence,
	clearReadWindow,
	createLoopPoliceState,
	recordRead,
	recordSearch,
	recordToolCall,
	resetLoopPoliceState,
} from "./state.js";
import {
	buildDetectionPayload,
	buildRecoveryMessage,
	msgKeyForEvent,
	eventKindForStreamLoop,
} from "./messages.js";

// ---- character-level tail detector ----

test("detectCharTailLoop: fires on verbatim tail repetition", () => {
	const unit = "Let me check the same file again and think about it. ";
	const loop = detectCharTailLoop(`${unit}${unit}`, { window: 10, maxWindow: 4000 });
	assert.ok(loop, "expected a loop for two adjacent copies");
	assert.equal(loop?.kind, "char_loop");
	assert.equal(loop?.count, 2);
	// Boundary sits at the start of the repeated copy.
	assert.ok(loop !== undefined && loop.boundary === unit.length);
	assert.equal(loop?.unit, unit);
});

test("detectCharTailLoop: respects window and maxWindow", () => {
	const short = "ab";
	// Unit shorter than window: not flagged.
	assert.equal(detectCharTailLoop(`${short}${short}`, { window: 10, maxWindow: 4000 }), undefined);

	// Unique filler before the copies so the filler itself never forms the
	// repeating unit. The text must END exactly at copy 2's end: the tail
	// detector compares two windows ending at the text end, so trailing
	// filler would break the alignment at the true copy boundary.
	const filler1 = "alpha ";

	// A 5000-char unit: two adjacent copies are 10000 chars; half is 5000 >
	// maxWindow 4000. The unit's interior must not self-repeat at any size
	// ≤ cap, so use a non-uniform token sequence (indices) rather than a
	// uniform x-run — an x-run legitimately repeats at any smaller size
	// inside itself.
	const longUnit = Array.from({ length: 500 }, (_, i) => `token${i}`).join(" ");
	assert.equal(
		detectCharTailLoop(`${filler1}${longUnit}${longUnit}`, { window: 10, maxWindow: 4000 }),
		undefined,
	);

	// A ~210-char unit with leading filler: within the cap, flagged at the
	// unit length.
	const mediumUnit = Array.from({ length: 30 }, (_, i) => `tok${i}`).join(" ");
	const loop = detectCharTailLoop(`${filler1}${mediumUnit}${mediumUnit}`, { window: 10, maxWindow: 4000 });
	assert.ok(loop !== undefined && loop.unit?.length === mediumUnit.length, `expected a ${mediumUnit.length}-char unit, got ${loop?.unit?.length}`);
});

test("detectCharTailLoop: plain non-looping text passes", () => {
	assert.equal(detectCharTailLoop("First I read the config, then I edited the handler, then I ran the tests.", { window: 20, maxWindow: 4000 }), undefined);
	assert.equal(detectCharTailLoop("", { window: 10, maxWindow: 4000 }), undefined);
});

// ---- semantic fingerprint detector ----

test("paragraphFingerprint: leading ordered-list counter normalized", () => {
	const options = { fingerprintLen: 60 };
	assert.equal(
		paragraphFingerprint("23. I need to check the config file before editing the handler", options),
		paragraphFingerprint("47. I need to check the config file before editing the handler", options),
		"renumbered list items must share a fingerprint",
	);
	assert.equal(
		paragraphFingerprint("I need to check the config file before editing the handler", options),
		paragraphFingerprint("23. I need to check the config file before editing the handler", options),
		"unnumbered matches numbered",
	);
});

test("detectSemanticLoop: third fingerprint fires with drift between passes", () => {
	const a = "Let me analyze the configuration structure to understand what options exist.";
	const b = "Now I will examine how the runtime wires those options into the handlers.";
	const drift1 = "28. Let me analyze the configuration structure to understand what options exist.";
	const drift2 = "47. Now I will examine how the runtime wires those options into the handlers.";
	const text = [a, b, drift1, drift2, "Some unrelated observation sits in between.", drift1].join("\n\n");
	const loop = detectSemanticLoop(text, { paraMinLen: 40, fingerprintLen: 60, threshold: 3 });
	assert.ok(loop, "expected a semantic loop on the third fingerprint");
	assert.equal(loop?.kind, "semantic_loop");
	assert.equal(loop?.count, 3);
	assert.ok(loop !== undefined && loop.fingerprint?.startsWith("Let me analyze"));
});

test("detectSemanticLoop: code fences skipped, short paragraphs ignored", () => {
	const options = { paraMinLen: 40, fingerprintLen: 60, threshold: 3 };
	// Repeated fenced code structure is legitimate; never flagged.
	const code = ["```ts", "const a = 1;", "const a = 1;", "const a = 1;", "```"].join("\n");
	assert.equal(detectSemanticLoop(`${code}\n\n${code}`, options), undefined);

	// Short paragraphs (< paraMinLen) never count.
	const short = "short para";
	assert.equal(detectSemanticLoop([short, short, short].join("\n\n"), options), undefined);
});

test("detectStreamLoop: semantic fires before char-level", () => {
	const para = "First I will read the config file, then I will edit the handler carefully.";
	const text = [para, para, para].join("\n\n");
	const loop = detectStreamLoop(
		text,
		{ window: 20, maxWindow: 4000 },
		{ paraMinLen: 40, fingerprintLen: 60, threshold: 3 },
	);
	assert.equal(loop?.kind, "semantic_loop", "semantic detection catches loops earlier");
});

// ---- similarity (stagnation + re-derived) ----

test("wordTokens + jaccard + textSimilarity", () => {
	assert.deepEqual([...wordTokens("I read the config file")].sort(), ["config", "file", "read", "the"]);
	assert.equal(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
	assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
	assert.ok(textSimilarity("I will read the config file now", "I will read the config file again") > 0.6);
	assert.ok(textSimilarity("completely unrelated words here", "totally different vocabulary used") < 0.2);
});

// ---- tool classification + keys ----

test("tool classification and path picking", () => {
	assert.ok(isReadTool("read"));
	assert.ok(isReadTool("hypa_read"));
	assert.ok(isSearchTool("grep"));
	assert.ok(isSearchTool("hypa_find"));
	assert.ok(isWriteTool("edit"));
	assert.ok(isWriteTool("apply_patch"));
	assert.ok(!isReadTool("bash"));

	assert.equal(pickToolPath({ path: "src/a.ts", pattern: "p" }), "src/a.ts");
	assert.equal(pickToolPath({ pattern: "needle" }), "needle");
	assert.equal(pickToolPath({ command: "npm test" }), undefined);
});

test("toolCallKey: name + sorted-args JSON", () => {
	assert.equal(toolCallKey("read", { path: "a.ts", offset: 1 }), toolCallKey("read", { offset: 1, path: "a.ts" }));
	assert.notEqual(toolCallKey("read", { path: "a.ts" }), toolCallKey("read", { path: "b.ts" }));
	assert.notEqual(toolCallKey("read", { path: "a.ts" }), toolCallKey("grep", { path: "a.ts" }));
});

// ---- config ----

test("defaultConfig matches upstream defaults", () => {
	const config = defaultConfig();
	assert.equal(config.numeric.THINKING_WINDOW, 80);
	assert.equal(config.numeric.OUTPUT_WINDOW, 100);
	assert.equal(config.numeric.MAX_WINDOW, 4000);
	assert.equal(config.numeric.STRIDE, 50);
	assert.equal(config.numeric.SEMANTIC_THRESHOLD, 3);
	assert.equal(config.numeric.STAGNATION_WINDOW, 4);
	assert.equal(config.numeric.STAGNATION_THRESHOLD, 0.85);
	assert.equal(config.numeric.FILE_SCAN_LIMIT, 20);
	assert.equal(config.numeric.SEARCH_EXPAND_LIMIT, 3);
	assert.equal(config.numeric.REREAD_WINDOW, 10);
	assert.equal(config.numeric.REREAD_RATIO, 0.4);
	assert.equal(config.numeric.TOOL_LOOP_BAN, 1);
	assert.equal(config.numeric.REDERIVE_THRESHOLD, 0.85);
	assert.equal(config.strings.TOOL_LOOP_EXEMPT, "");
	assert.equal(config.messages.MSG_SUFFIX, "");
});

test("parseConfigOver: valid values applied, invalid fall back, unknown ignored", () => {
	const base = defaultConfig();
	const parsed = parseConfigOver(base, {
		FILE_SCAN_LIMIT: 30,
		REREAD_RATIO: 0.6,
		TOOL_LOOP_EXEMPT: "bash,run_tests",
		FILE_SCAN_LIMIT_BAD: 9999, // unknown key ignored
		SEMANTIC_THRESHOLD: 99, // out of range → falls back
		THINKING_WINDOW: "not a number", // wrong type → falls back
		MSG_SUFFIX: "consult the advisor",
	});
	assert.equal(parsed.numeric.FILE_SCAN_LIMIT, 30);
	assert.equal(parsed.numeric.REREAD_RATIO, 0.6);
	assert.equal(parsed.strings.TOOL_LOOP_EXEMPT, "bash,run_tests");
	assert.equal(parsed.numeric.SEMANTIC_THRESHOLD, 3, "out-of-range falls back");
	assert.equal(parsed.numeric.THINKING_WINDOW, 80, "wrong-type falls back");
	assert.equal(parsed.messages.MSG_SUFFIX, "consult the advisor");
	// Base is not mutated.
	assert.equal(base.numeric.FILE_SCAN_LIMIT, 20);
});

test("parseConfigText: tolerant on garbage", () => {
	const base = defaultConfig();
	assert.deepEqual(parseConfigText(base, "not json"), base);
	assert.deepEqual(parseConfigText(base, "[1,2,3]"), base);
	assert.equal(parseConfigText(base, `{"FILE_SCAN_LIMIT": 25}`).numeric.FILE_SCAN_LIMIT, 25);
});

test("readLoopPoliceConfig: missing file yields defaults", () => {
	const config = readLoopPoliceConfig("/nonexistent/aio-loop-police.json");
	assert.equal(config.numeric.FILE_SCAN_LIMIT, 20);
});

test("substitutePlaceholders: unknown tokens stay visible", () => {
	assert.equal(
		substitutePlaceholders("already read {path} {count} times", { path: "x.ts", count: 3 }),
		"already read x.ts 3 times",
	);
	assert.equal(
		substitutePlaceholders("a {typo} b", {}),
		"a {typo} b",
	);
});

test("LOOP_POLICE_FILE_NAME follows the aio agent-file pattern", () => {
	assert.equal(LOOP_POLICE_FILE_NAME, "aio-loop-police.json");
});

// ---- state: tool-call sequence loop ----

test("checkToolCallSequence: back-to-back repeat blocked (ban=1)", () => {
	const state = createLoopPoliceState();

	// read → edit → read → edit: cycle length 2 on the second read.
	const read = { path: "a.ts" };
	const edit = { path: "a.ts" };
	recordToolCall(state, "read", read);
	recordToolCall(state, "edit", edit);
	assert.equal(checkToolCallSequence(state, "read", read, 1).looped, false, "first read of the cycle is fine");
	// The gate records the call after a non-block; simulate the executed read.
	recordToolCall(state, "read", read);
	assert.equal(checkToolCallSequence(state, "edit", edit, 1).looped, true, "second edit completes the cycle");
});

test("checkToolCallSequence: interleaved different action breaks adjacency", () => {
	const state = createLoopPoliceState();
	// Upstream's guarantee: build → edit → build never trips. History
	// [build, edit] + pending build: the last 1 call (edit) does not repeat
	// the 1 before it (build) → legal.
	recordToolCall(state, "bash", { command: "npm test" });
	recordToolCall(state, "edit", { path: "a.ts" });
	assert.equal(checkToolCallSequence(state, "bash", { command: "npm test" }, 1).looped, false);

	// But build → edit → build → edit → build IS a [build,edit]×3 cycle:
	// the last 2 calls (edit, build) repeat the 2 before them — blocked.
	recordToolCall(state, "bash", { command: "npm test" });
	recordToolCall(state, "edit", { path: "a.ts" });
	assert.equal(checkToolCallSequence(state, "bash", { command: "npm test" }, 1).looped, true);
});

test("checkToolCallSequence: ban=2 permanently bans a looping call", () => {
	const state = createLoopPoliceState();
	const args = { command: "kubectl delete pod x" };
	// Two back-to-back identical calls complete a length-1 cycle; the gate
	// bans the exact call (TOOL_LOOP_BAN=2) and blocks it.
	recordToolCall(state, "bash", args);
	assert.equal(checkToolCallSequence(state, "bash", args, 2).looped, true);
	state.bannedToolCalls.add(toolCallKey("bash", args));

	// Even with a different action in between, the exact call stays blocked.
	recordToolCall(state, "edit", { path: "a.ts" });
	const banned = checkToolCallSequence(state, "bash", args, 2);
	assert.equal(banned.looped, true);
	assert.equal(banned.banned, true);
});

test("checkToolCallSequence: ban=0 disables the detector", () => {
	const state = createLoopPoliceState();
	const args = { command: "npm test" };
	recordToolCall(state, "bash", args);
	recordToolCall(state, "bash", args);
	assert.equal(checkToolCallSequence(state, "bash", args, 0).looped, false);
});

// ---- state: file ceiling + re-read window ----

test("checkRead: ceiling counts only executed reads", () => {
	const state = createLoopPoliceState();
	const options = { fileScanLimit: 3, reReadWindow: 0, reReadRatio: 0 };
	const args = { path: "big.ts" };

	assert.equal(checkRead(state, "read", args, options).ceilingBlocked, false);
	recordRead(state, "big.ts", { reReadWindow: 10 });
	recordRead(state, "big.ts", { reReadWindow: 10 });
	recordRead(state, "big.ts", { reReadWindow: 10 });
	const decision = checkRead(state, "read", args, options);
	assert.equal(decision.ceilingBlocked, true);
	assert.equal(decision.executedCount, 3);
	// Blocked calls never reach the tool: ceiling stays at 3, never inflates.
});

test("checkRead: re-read window fires at the ratio on unchanged files", () => {
	const state = createLoopPoliceState();
	const options = { fileScanLimit: 0, reReadWindow: 4, reReadRatio: 0.5 };

	// Sweep with interleaved fresh reads so no per-path total climbs toward
	// the ceiling; the window fills with 2 re-reads of unchanged a.ts among
	// 4 reads → 50% redundant.
	recordRead(state, "a.ts", { reReadWindow: 10 });
	recordRead(state, "b.ts", { reReadWindow: 10 });
	recordRead(state, "a.ts", { reReadWindow: 10 });
	recordRead(state, "a.ts", { reReadWindow: 10 });

	const decision = checkRead(state, "read", { path: "a.ts" }, options);
	assert.equal(decision.reReadBlocked, true, "≥ ratio of redundant reads blocks");
	assert.equal(decision.redundantCount, 2);
});

test("checkRead: read → edit → re-read counts as fresh", () => {
	const state = createLoopPoliceState();
	const options = { fileScanLimit: 0, reReadWindow: 4, reReadRatio: 0.5 };

	recordRead(state, "a.ts", { reReadWindow: 10 });
	// A write invalidates the earlier read: what was in context no longer holds.
	state.readWindow[0].invalidated = true;
	const decision = checkRead(state, "read", { path: "a.ts" }, options);
	assert.equal(decision.reReadBlocked, false, "edit invalidated the earlier read");
});

test("clearReadWindow prevents chained blocks", () => {
	const state = createLoopPoliceState();
	recordRead(state, "a.ts", { reReadWindow: 10 });
	recordRead(state, "a.ts", { reReadWindow: 10 });
	clearReadWindow(state);
	const decision = checkRead(state, "read", { path: "a.ts" }, { fileScanLimit: 0, reReadWindow: 4, reReadRatio: 0 });
	assert.equal(decision.reReadBlocked, false, "cleared window never chains");
});

test("resetLoopPoliceState clears everything", () => {
	const state = createLoopPoliceState();
	recordRead(state, "a.ts", { reReadWindow: 10 });
	recordToolCall(state, "read", { path: "a.ts" });
	recordSearch(state, "needle", "read");
	state.consecutiveLoops = 5;
	state.rederiveStreak = 3;
	resetLoopPoliceState(state);
	assert.equal(state.readWindow.length, 0);
	assert.equal(state.toolCallHistory.length, 0);
	assert.equal(state.searchPathsByPattern.size, 0);
	assert.equal(state.consecutiveLoops, 0);
	assert.equal(state.rederiveStreak, 0);
});

// ---- state: search spiral ----

test("checkSearch: same pattern across distinct locations blocked at limit", () => {
	const state = createLoopPoliceState();

	assert.equal(checkSearch(state, "grep", { pattern: "needle" }, 3).blocked, false, "first location fine");
	recordSearch(state, "needle", "grep");
	assert.equal(checkSearch(state, "grep", { pattern: "needle" }, 3).blocked, false, "second location fine");
	recordSearch(state, "needle", "hypa_grep");
	assert.equal(checkSearch(state, "grep", { pattern: "needle" }, 3).blocked, true, "third location blocked");

	// A different pattern is unaffected.
	assert.equal(checkSearch(state, "grep", { pattern: "other" }, 3).blocked, false);
	// Non-search tools never blocked.
	assert.equal(checkSearch(state, "read", { path: "needle" }, 3).blocked, false);
});

// ---- recovery messages ----

test("msgKeyForEvent maps every event kind", () => {
	assert.equal(msgKeyForEvent("thinking_loop"), "MSG_THINKING_LOOP");
	assert.equal(msgKeyForEvent("semantic_loop"), "MSG_SEMANTIC_LOOP");
	assert.equal(msgKeyForEvent("output_loop"), "MSG_OUTPUT_LOOP");
	assert.equal(msgKeyForEvent("output_semantic_loop"), "MSG_OUTPUT_SEMANTIC_LOOP");
	assert.equal(msgKeyForEvent("stagnation"), "MSG_STAGNATION");
	assert.equal(msgKeyForEvent("file_scan_loop"), "MSG_FILE_SCAN_LOOP");
	assert.equal(msgKeyForEvent("search_spiral"), "MSG_SEARCH_SPIRAL");
	assert.equal(msgKeyForEvent("redundant_reread"), "MSG_REREAD");
	assert.equal(msgKeyForEvent("tool_loop"), "MSG_TOOL_LOOP");
	assert.equal(msgKeyForEvent("rederived_reasoning"), "MSG_REDERIVED");
});

test("eventKindForStreamLoop maps stream + kind", () => {
	assert.equal(eventKindForStreamLoop("thinking", { kind: "char_loop", boundary: 0, count: 2 }), "thinking_loop");
	assert.equal(eventKindForStreamLoop("thinking", { kind: "semantic_loop", boundary: 0, count: 3 }), "semantic_loop");
	assert.equal(eventKindForStreamLoop("output", { kind: "char_loop", boundary: 0, count: 2 }), "output_loop");
	assert.equal(eventKindForStreamLoop("output", { kind: "semantic_loop", boundary: 0, count: 3 }), "output_semantic_loop");
});

test("buildRecoveryMessage: template, tokens, suffix", () => {
	const config = defaultConfig();
	const message = buildRecoveryMessage(config, "file_scan_loop", { path: "src/a.ts", count: 7 });
	assert.match(message, /src\/a\.ts/);
	assert.match(message, /7/);

	const withSuffix = { ...config, messages: { ...config.messages, MSG_SUFFIX: "consult the advisor once." } };
	const suffixed = buildRecoveryMessage(withSuffix, "tool_loop", { windowSize: 2 });
	assert.match(suffixed, /consult the advisor once\./);
});

test("buildDetectionPayload: metadata only, model null when absent", () => {
	const payload = buildDetectionPayload({
		kind: "tool_loop",
		cwd: "/repo",
		consecutiveLoops: 2,
		details: { toolName: "bash", windowSize: 2 },
	});
	assert.equal(payload.event, "tool_loop");
	assert.equal(payload.model, null);
	assert.equal(payload.consecutiveLoops, 2);
	assert.deepEqual(payload.details, { toolName: "bash", windowSize: 2 });
	// No thinking text or tool arguments ever enter the payload.
	assert.ok(!JSON.stringify(payload).includes("thinking"));
});
