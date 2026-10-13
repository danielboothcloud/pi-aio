/**
 * you-should-know/auditor.ts — pure-core unit tests.
 *
 * Everything runs against injected seams (mock `complete()`, fixture
 * directories, injected settings files); no network, no agent runtime, and no
 * writes outside the process temp dir.
 */

import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendChildAuditRecord,
	buildAuditPrompt,
	childProcessInfo,
	childSessionFile,
	createFindingDedupe,
	DEFAULT_SETTINGS,
	extractChangedFiles,
	extractPathsFromPatch,
	isExcluded,
	normalizeYskSettings,
	parseFindings,
	parseFindingsResult,
	performAudit,
	readAndDropSidecar,
	readYskSettings,
	sanitizeForTerminal,
	saveYskSettings,
	sidecarPathFor,
	textBlockFromContent,
	currentTaskDigest,
	type ChildAuditRecord,
	type CompleteFn,
	type YskFinding,
} from "./auditor.ts";

// =====================================================================
// Settings
// =====================================================================

test("DEFAULT_SETTINGS: off by default, watches the diff-tools surface", () => {
	assert.equal(DEFAULT_SETTINGS.enabled, false);
	assert.deepEqual(DEFAULT_SETTINGS.auditTools, ["write", "edit", "apply_patch"]);
	assert.equal(DEFAULT_SETTINGS.minSeverity, "warning");
});

test("normalizeYskSettings drops malformed keys and keeps valid ones", () => {
	const merged = normalizeYskSettings({
		enabled: "yes",
		model: 42,
		minSeverity: "severe",
		auditTools: ["write", "", 3],
		batchWindowMs: -5,
	});
	assert.equal(merged.enabled, false);
	assert.equal(merged.model, null);
	assert.equal(merged.minSeverity, "warning");
	assert.deepEqual(merged.auditTools, ["write"]);
	assert.equal(merged.batchWindowMs, DEFAULT_SETTINGS.batchWindowMs);

	const good = normalizeYskSettings({
		enabled: true,
		model: "anthropic/claude-haiku-5-5",
		minSeverity: "info",
		exclude: ["custom/"],
		maxFindings: 9,
	});
	assert.equal(good.enabled, true);
	assert.equal(good.model, "anthropic/claude-haiku-5-5");
	assert.equal(good.minSeverity, "info");
	assert.deepEqual(good.exclude, ["custom/"]);
	assert.equal(good.maxFindings, 9);
});

test("settings round-trip through an injected file", () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ysk-auditor-"));
	const file = path.join(dir, "settings.json");
	const saved = saveYskSettings({ enabled: true, model: "openai/test-model", minSeverity: "critical" }, file);
	assert.equal(saved.enabled, true);
	const loaded = readYskSettings(file);
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.model, "openai/test-model");
	assert.equal(loaded.minSeverity, "critical");
});

test("corrupt settings files fall back to defaults", () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ysk-auditor-"));
	const file = path.join(dir, "settings.json");
	fsSync.writeFileSync(file, "{ not json", "utf8");
	assert.equal(readYskSettings(file).enabled, false);
});

// =====================================================================
// Change extraction
// =====================================================================

test("extractChangedFiles: write", () => {
	const out = extractChangedFiles("write", { path: "src/app.ts", content: "let a = 1;\n" });
	assert.ok(out);
	assert.equal(out.length, 1);
	assert.equal(out[0].rawPath, "src/app.ts");
	assert.match(out[0].changeDescription, /^full overwrite /);
});

test("extractChangedFiles: edit (edits array and legacy single edit)", () => {
	const modern = extractChangedFiles("edit", {
		path: "src/app.ts",
		edits: [
			{ oldText: "a", newText: "b" },
			{ oldText: "c", newText: "d" },
		],
	});
	assert.ok(modern);
	assert.match(modern[0].changeDescription, /2 targeted edit\(s\)/);

	const legacy = extractChangedFiles("edit", { path: "src/app.ts", oldText: "a", newText: "b" });
	assert.ok(legacy);
	assert.match(legacy[0].changeDescription, /1 targeted edit\(s\)/);

	assert.equal(extractChangedFiles("edit", { path: "src/app.ts", edits: [] }), undefined);
});

test("extractChangedFiles: apply_patch (changes array and unified diff)", () => {
	const structured = extractChangedFiles("apply_patch", {
		changes: [
			{ path: "a.ts", action: "update" },
			{ path: "b.ts" },
		],
	});
	assert.ok(structured);
	assert.equal(structured.length, 2);
	assert.equal(structured[0].rawPath, "a.ts");

	const diffy = extractChangedFiles("apply_patch", {
		patch: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
	});
	assert.ok(diffy);
	assert.equal(diffy.length, 1);
	assert.equal(diffy[0].rawPath, "x.ts");

	assert.equal(extractChangedFiles("apply_patch", { patch: "no paths here" }), undefined);
});

test("extractPathsFromPatch: unified diff and Cursor-style markers", () => {
	const unified = extractPathsFromPatch("diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\ndiff --git a/two.ts b/two.ts");
	assert.deepEqual(
		unified.map((t) => t.path),
		["one.ts", "two.ts"],
	);
	assert.equal(
		extractPathsFromPatch("*** Update File: cursor.ts\n@@\n*** Add File: brand-new.ts\n*** Delete File: gone.ts")[2]?.action,
		"delete",
	);
});

test("extractChangedFiles: configured custom tools probe path-ish keys", () => {
	const out = extractChangedFiles("my_patch", { filePath: "z.ts", extra: 1 });
	assert.ok(out);
	assert.equal(out[0].rawPath, "z.ts");
	assert.match(out[0].changeDescription, /^arguments: /);

	assert.equal(extractChangedFiles("read", { contents: "…" }), undefined);
});

// =====================================================================
// Exclusion filtering
// =====================================================================

test("isExcluded: lockfiles, vendor dirs, minified assets (case-insensitive)", () => {
	const exclude = DEFAULT_SETTINGS.exclude;
	assert.equal(isExcluded("node_modules/pkg/index.js", exclude), true);
	assert.equal(isExcluded("src/package-lock.json", exclude), true);
	assert.equal(isExcluded("BUILD/x.js", exclude), true);
	assert.equal(isExcluded("public/app.min.js", exclude), true);
	assert.equal(isExcluded("src/dist-helper/index.ts", exclude), false);
	assert.equal(isExcluded("src/app.ts", exclude), false);
});

// =====================================================================
// Text hygiene
// =====================================================================

test("sanitizeForTerminal strips ANSI/OSC and control codes, keeps text", () => {
	assert.equal(sanitizeForTerminal("\u001b[31mred\u001b[0m", 100), "red");
	assert.equal(sanitizeForTerminal("\u001b]8;;http://x\u0007link\u001b]8;;\u0007", 100), "link");
	assert.equal(sanitizeForTerminal("a\rb\u0007c", 100), "abc");
	assert.equal(sanitizeForTerminal("a\tb\nc", 100), "a\tb\nc");
	const truncated = sanitizeForTerminal("x".repeat(1000), 100);
	assert.equal(truncated.length, 101);
	assert.ok(truncated.endsWith("…"));
	assert.equal(sanitizeForTerminal(42, 100), "");
});

// =====================================================================
// Findings parsing
// =====================================================================

test("parseFindingsResult distinguishes silence from garbage", () => {
	const silent = parseFindingsResult('{"findings": []}');
	assert.equal(silent.ok, true);
	assert.equal(silent.findings.length, 0);
	const garbage = parseFindingsResult("Looks good to me!");
	assert.equal(garbage.ok, false);
	const fenced = parseFindingsResult("```json\n{\"findings\":[{\"severity\":\"warning\",\"title\":\"T\",\"detail\":\"D\"}]}\n```");
	assert.equal(fenced.ok, true);
});

test("parseFindings sanitizes and drops malformed entries", () => {
	const raw = JSON.stringify({
		findings: [
			{ severity: "critical", title: "T1", detail: "D1", file: "a.ts" },
			{ severity: "severe", title: "bad severity", detail: "dropped" },
			{ severity: "warning", title: "\u001b[1mbold\u001b[0m title", detail: "kept" },
			{ severity: "info", title: "x".repeat(200), detail: "capped" },
			{ severity: "warning", title: "", detail: "no title dropped" },
			42,
		],
	});
	const findings = parseFindings(raw);
	assert.equal(findings.length, 3);
	assert.equal(findings[0].severity, "critical");
	assert.ok(findings[0].file);
	assert.equal(findings[1].title, "bold title");
	assert.ok(findings[2].title.endsWith("…"));
	assert.equal(findings[2].title.length, 121);
});

test("textBlockFromContent joins only text blocks", () => {
	const joined = textBlockFromContent([
		{ type: "text", text: "a" },
		{ type: "thinking", thinking: "secret" },
		{ type: "text", text: "b" },
	]);
	assert.equal(joined, "a\nb");
});

// =====================================================================
// Task digest
// =====================================================================

test("currentTaskDigest finds the latest user message and caps it", () => {
	const branch = [
		{ type: "custom", data: {} },
		{ type: "message", message: { role: "user", content: "older task" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "update from agent" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] } },
	];
	assert.equal(currentTaskDigest(branch as unknown[]), "part1\npart2");

	const long = currentTaskDigest([{ type: "message", message: { role: "user", content: "t".repeat(5000) } }] as unknown[]);
	assert.equal(long.length, 1600);

	assert.equal(currentTaskDigest([]), "(not available)");
});

// =====================================================================
// Dedupe
// =====================================================================

test("createFindingDedupe suppresses repeats inside and across batches until TTL", () => {
	let now = 1_000;
	const dedupe = createFindingDedupe(50, () => now);
	const finding: YskFinding = { severity: "warning", title: "Same Issue", detail: "d", file: "src/a.ts" };

	const first = dedupe.filterRecent([finding, { ...finding }]);
	assert.equal(first.shown.length, 1);
	assert.equal(first.suppressed, 1);

	const second = dedupe.filterRecent([finding]);
	assert.equal(second.shown.length, 0);
	assert.equal(second.suppressed, 1);

	now = 2_000; // past the 50ms TTL
	const third = dedupe.filterRecent([finding]);
	assert.equal(third.shown.length, 1);
});

// =====================================================================
// Audit engine (injected complete)
// =====================================================================

function makeComplete(reply: {
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cost?: { total?: number } };
	throwError?: Error;
}): CompleteFn {
	return async (_model, context, options) => {
		if (options?.signal?.aborted) throw new Error("aborted");
		if (reply.throwError) throw reply.throwError;
		return {
			content: [{ type: "text", text: reply.text ?? "" }],
			stopReason: reply.stopReason ?? "stop",
			errorMessage: reply.errorMessage,
			usage: reply.usage,
		};
	};
}

test("performAudit returns threshold-filtered findings with usage", async () => {
	const settings = { ...DEFAULT_SETTINGS, minSeverity: "warning" };
	const outcome = await performAudit({
		settings,
		model: { provider: "openai", id: "test" },
		prompt: "PROMPT",
		complete: makeComplete({
			text: JSON.stringify({
				findings: [
					{ severity: "critical", title: "Broken", detail: "It will throw at runtime.", file: "src/a.ts" },
					{ severity: "info", title: "Below threshold", detail: "filtered out" },
					{ severity: "info", title: "Also below", detail: "filtered out too" },
				],
			}),
			usage: { input: 4100, output: 420, cost: { total: 0.003 } },
		}),
	});
	assert.equal(outcome.error, undefined);
	assert.equal(outcome.raised, 3);
	assert.equal(outcome.findings.length, 1);
	assert.equal(outcome.findings[0].severity, "critical");
	assert.deepEqual(outcome.usage, { inputTokens: 4100, outputTokens: 420, costTotal: 0.003 });
	assert.ok(outcome.latencyMs >= 0);
});

test("performAudit treats a valid empty findings array as clean silence", async () => {
	const outcome = await performAudit({
		settings: { ...DEFAULT_SETTINGS },
		model: {},
		prompt: "PROMPT",
		complete: makeComplete({ text: '{"findings": []}' }),
	});
	assert.equal(outcome.error, undefined);
	assert.equal(outcome.findings.length, 0);
	assert.equal(outcome.raised, 0);
});

test("performAudit flags stream errors, unparseable replies, and thrown errors without throwing", async () => {
	const streamError = await performAudit({
		settings: { ...DEFAULT_SETTINGS },
		model: {},
		prompt: "PROMPT",
		complete: makeComplete({ stopReason: "error", errorMessage: "500 upstream" }),
	});
	assert.match(streamError.error ?? "", /500 upstream/);

	const garbage = await performAudit({
		settings: { ...DEFAULT_SETTINGS },
		model: {},
		prompt: "PROMPT",
		complete: makeComplete({ text: "no json here" }),
	});
	assert.equal(garbage.error, "sub-agent reply was not a JSON findings object");

	const thrown = await performAudit({
		settings: { ...DEFAULT_SETTINGS },
		model: {},
		prompt: "PROMPT",
		complete: makeComplete({ throwError: new Error("network down") }),
	});
	assert.equal(thrown.error, "network down");
});

test("performAudit passes the system prompt and cap wiring through the injected complete", async () => {
	const settings = { ...DEFAULT_SETTINGS, maxFindings: 1 };
	let seenContext: { systemPrompt?: string; messages?: Array<{ content: string }> } = {};
	const complete: CompleteFn = async (_model, context) => {
		seenContext = context as unknown as typeof seenContext;
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						findings: [
							{ severity: "warning", title: "One", detail: "d1" },
							{ severity: "warning", title: "Two", detail: "d2" },
						],
					}),
				},
			],
			stopReason: "stop",
		};
	};
	const outcome = await performAudit({ settings, model: {}, prompt: "USER-PROMPT", complete });
	assert.equal(seenContext.systemPrompt?.includes("You Should Know"), true);
	assert.equal(seenContext.messages?.[0].content, "USER-PROMPT");
	assert.equal(outcome.findings.length, 1);
	assert.equal(outcome.raised, 2);
});

// =====================================================================
// Prompt assembly (fixture project)
// =====================================================================

test("buildAuditPrompt embeds task, changes, file windows, and project context", async () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ysk-prompt-"));
	fsSync.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { express: "^4" } }));
	fsSync.mkdirSync(path.join(dir, "src"));
	fsSync.writeFileSync(path.join(dir, "src", "app.ts"), "export const app = 1;\n");

	const prompt = await buildAuditPrompt(
		dir,
		[
			{
				absPath: path.join(dir, "src", "app.ts"),
				displayPath: "src/app.ts",
				toolName: "write",
				changeDescription: "full overwrite (24 bytes, 1 lines)",
				capturedAt: Date.now(),
			},
		],
		DEFAULT_SETTINGS,
		"Fix the router bug",
	);

	assert.ok(prompt.includes("## The developer's current task"));
	assert.ok(prompt.includes("Fix the router bug"));
	assert.ok(prompt.includes("Tool `write`"));
	assert.ok(prompt.includes("### src/app.ts"));
	assert.ok(prompt.includes("export const app = 1;"));
	assert.ok(prompt.includes("package.json"));
	assert.ok(prompt.includes("Top level of"));
	assert.ok(prompt.includes("Same directory"));
	assert.ok(prompt.length <= DEFAULT_SETTINGS.maxPromptBytes + 200);
 });

test("buildAuditPrompt truncates huge files with a marker and stays under budget", async () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ysk-prompt-"));
	fsSync.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
	const big = "const x = 1;\n".repeat(5000); // ~75KB > maxFileBytes
	fsSync.writeFileSync(path.join(dir, "big.ts"), big);

	const prompt = await buildAuditPrompt(
		dir,
		[
			{
				absPath: path.join(dir, "big.ts"),
				displayPath: "big.ts",
				toolName: "write",
				changeDescription: "full overwrite (75000 bytes, 5000 lines)",
				capturedAt: Date.now(),
			},
		],
		DEFAULT_SETTINGS,
		"task",
	);
	assert.ok(prompt.includes("[You Should Know: middle of file truncated]"));
	assert.ok(prompt.length <= DEFAULT_SETTINGS.maxPromptBytes + 200);
});

// =====================================================================
// Subagent sidecar
// =====================================================================

test("sidecar: append, read-and-drop, missing file", async () => {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ysk-sidecar-"));
	const childSession = path.join(dir, "session.jsonl");

	assert.equal(path.basename(sidecarPathFor(childSession)), "you-should-know.jsonl");

	const record1: ChildAuditRecord = {
		agent: "scout",
		runId: "run-1",
		auditAt: 1,
		model: "openai/test",
		files: ["src/a.ts"],
		findings: [{ severity: "warning", title: "T", detail: "D" }],
		latencyMs: 10,
	};
	const record2: ChildAuditRecord = { ...record1, auditAt: 2, findings: [], latencyMs: 5 };

	await appendChildAuditRecord(record1, childSession);
	await appendChildAuditRecord(record2, childSession);

	const records = await readAndDropSidecar(childSession);
	assert.equal(records.length, 2);
	assert.equal(records[0].agent, "scout");
	assert.equal(records[1].findings.length, 0);

	// The sidecar is deleted on first read.
	const secondRead = await readAndDropSidecar(childSession);
	assert.equal(secondRead.length, 0);

	// Missing files are empty lists, not errors.
	assert.deepEqual(await readAndDropSidecar(path.join(dir, "missing-session.jsonl")), []);
});

// =====================================================================
// Child environment detection (env restored afterwards)
// =====================================================================

test("childProcessInfo reads the runner env and restores it", () => {
	// Keys are the real env names so the restore loop round-trips exactly.
	const previous: Record<string, string | undefined> = {
		AIO_SUBAGENT_CHILD: process.env.AIO_SUBAGENT_CHILD,
		AIO_SUBAGENT_RUN_ID: process.env.AIO_SUBAGENT_RUN_ID,
		AIO_SUBAGENT_AGENT: process.env.AIO_SUBAGENT_AGENT,
		PI_SESSION_FILE: process.env.PI_SESSION_FILE,
	};
	try {
		// The harness process itself often has PI_SESSION_FILE set (this very
		// test runs inside a pi session), so unset it before asserting the
		// null case; the finally block restores it.
		delete process.env.PI_SESSION_FILE;
		assert.equal(childProcessInfo().isChild, false);
		assert.equal(childSessionFile(), null);

		process.env.AIO_SUBAGENT_CHILD = "1";
		process.env.AIO_SUBAGENT_RUN_ID = "run-77";
		process.env.AIO_SUBAGENT_AGENT = "scout";
		process.env.PI_SESSION_FILE = "/tmp/ysk/child-session.jsonl";

		assert.deepEqual(childProcessInfo(), { isChild: true, runId: "run-77", agent: "scout" });
		assert.equal(childSessionFile(), "/tmp/ysk/child-session.jsonl");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
	assert.equal(childProcessInfo().isChild, false);
});
