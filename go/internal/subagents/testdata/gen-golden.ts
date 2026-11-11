// Regenerate golden.json from the TypeScript subagents feature (the reference):
//   npx tsx go/internal/subagents/testdata/gen-golden.ts [--check]
// It runs agent discovery, the child extension launch, activity, transcript,
// history restore, saved transcripts, spawn specs, result and progress text,
// the widget, and the inspector (key sequences, renders) on fixed inputs,
// and real runner scenarios with subagents/test-fixture-child.mjs. Fixture
// paths, run ids, and wall-clock durations are written as placeholders; the
// Go test normalizes its own output the same way.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const root = join(here, `.fixture-${process.pid}`);
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS;
delete process.env.AIO_SUBAGENT_CURSOR_EXTENSION;
const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const agents = await import(join(repo, "subagents", "agents.ts"));
const extensions = await import(join(repo, "subagents", "extensions.ts"));
const activity = await import(join(repo, "subagents", "activity.ts"));
const transcriptMod = await import(join(repo, "subagents", "transcript.ts"));
const history = await import(join(repo, "subagents", "history.ts"));
const saved = await import(join(repo, "subagents", "saved-transcript.ts"));
const runner = await import(join(repo, "subagents", "runner.ts"));
const registry = await import(join(repo, "subagents", "registry.ts"));
const inspectorMod = await import(join(repo, "subagents", "inspector.ts"));
const index = await import(join(repo, "subagents", "index.ts"));
function readRoleCodes(): Record<string, number> {
	const path = join(repo, "go", "internal", "chrome", "testdata", "golden.json");
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { roleCodes: Record<string, number> }).roleCodes;
	} catch (error) {
		throw new Error(`cannot read the chrome role codes from ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const ROLE_CODES = readRoleCodes();

const BUILTIN = join(repo, "subagents", "agents");
const code = (role: string) => ROLE_CODES[role] ?? 37;
const theme = {
	fg: (role: string, text: string) => `\x1b[${code(role)}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	bg: (role: string, text: string) => `\x1b[${code(role) + 10}m${text}\x1b[49m`,
};

function placeholders<T>(value: T): T {
	const text = JSON.stringify(value ?? null)
		.split(BUILTIN).join("aio/subagents/agents")
		.split(extensions.AIO_EXTENSION_PATH).join("@@AIO@@")
		.split(root).join("@@ROOT@@");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`placeholder substitution broke the JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const fixtureFiles: Array<{ path: string; content: string }> = [];
const write = (path: string, content: string, record = true) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	if (record) fixtureFiles.push({ path: path.slice(root.length + 1), content });
};

try {
	// ---- agents ----
	const project = join(root, "project");
	mkdirSync(join(project, ".git"), { recursive: true });
	write(join(project, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Project override\ntools: read\n---\nProject prompt");
	write(join(project, ".agents", "agents", "nested", "zeta.md"), "---\nname: Zeta\ndescription: Nested\ntools:\n  - read\n  - ' bash '\nmodel: inherit\nthinking: low\ntimeoutMs: 5000\nsystemPromptMode: append\ninheritProjectContext: false\ninheritSkills: true\n---\n\nBody  \n");
	write(join(agentDir, "agents", "custom.md"), "---\nname: custom\ndescription: '  User agent  '\nmodel: ' openai/gpt '\ntools: 'read, , grep'\n---\nUser prompt");
	const discovery = [
		{ cwd: project, includeProject: true },
		{ cwd: project, includeProject: false },
		{ cwd: join(project, "sub"), includeProject: true },
	].map(({ cwd, includeProject }) => ({
		cwd,
		includeProject,
		agents: agents.discoverAgents(cwd, { includeProject }),
	}));
	const invalid: Array<{ name: string; content: string; error: string }> = [];
	const bad: Record<string, string> = {
		noFrontmatter: "name: x\n",
		unterminated: "---\nname: x\n",
		notObject: "---\n- a\n- b\n---\nbody",
		scalar: "---\njust text\n---\nbody",
		noName: "---\ndescription: d\n---\nbody",
		blankName: "---\nname: '  '\ndescription: d\n---\nbody",
		noDescription: "---\nname: x\n---\nbody",
		noBody: "---\nname: x\ndescription: d\n---\n   \n",
		badThinking: "---\nname: x\ndescription: d\nthinking: huge\n---\nbody",
		numericThinking: "---\nname: x\ndescription: d\nthinking: 3\n---\nbody",
		lowTimeout: "---\nname: x\ndescription: d\ntimeoutMs: 999\n---\nbody",
		floatTimeout: "---\nname: x\ndescription: d\ntimeoutMs: 1500.5\n---\nbody",
		stringTimeout: "---\nname: x\ndescription: d\ntimeoutMs: '2000'\n---\nbody",
		badMode: "---\nname: x\ndescription: d\nsystemPromptMode: merge\n---\nbody",
		badTools: "---\nname: x\ndescription: d\ntools: 3\n---\nbody",
		badToolList: "---\nname: x\ndescription: d\ntools: [read, 3]\n---\nbody",
	};
	for (const [name, content] of Object.entries(bad)) {
		const dir = join(root, `bad-${name}`);
		write(join(dir, ".git", "HEAD"), "");
		write(join(dir, ".pi", "agents", "bad.md"), content);
		let error = "";
		try {
			agents.discoverAgents(dir, { includeProject: true });
		} catch (e) {
			error = (e as Error).message;
		}
		invalid.push({ name, content, error });
	}
	let findError = "";
	try {
		agents.findAgent([], "ghost");
	} catch (e) {
		findError = (e as Error).message;
	}
	let findError2 = "";
	try {
		agents.findAgent(discovery[0].agents, "ghost");
	} catch (e) {
		findError2 = (e as Error).message;
	}

	// ---- extension launch ----
	const cursorFile = join(root, "cursor", "index.ts");
	write(cursorFile, "");
	const extraFile = join(root, "extra", "ext.ts");
	write(extraFile, "");
	const launchCases = [
		{ args: [], provider: "anthropic", extra: "" },
		{ args: ["-ne", "-e", "./local.ts", "--extension", "npm:pkg", "-e", "builtin:mcp"], provider: "anthropic", extra: "" },
		{ args: ["-ne", "-e", extensions.AIO_EXTENSION_PATH, "-e", "git:github.com/a/b"], provider: "anthropic", extra: "" },
		{ args: ["-e", "../up.ts"], provider: "anthropic", extra: `${extraFile}, /missing/ext.ts ,,` },
		{ args: ["-ne"], provider: "cursor", extra: "" },
		{ args: ["--no-extensions", "-e", "a.ts", "-e", "a.ts"], provider: "cursor", extra: extraFile },
		{ args: ["--model", "-e", "-e", "x.ts"], provider: "", extra: "" },
	].map(({ args, provider, extra }) => {
		process.env.AIO_SUBAGENT_CURSOR_EXTENSION = cursorFile;
		if (extra) process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS = extra;
		else delete process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS;
		const launch = extensions.resolveChildExtensionLaunch({ modelProvider: provider || undefined, argv: ["node", "pi", ...args], cwd: project });
		const supports = ["cursor/fast", "anthropic/x", ""].map((model) => extensions.childSupportsModel(launch, model || undefined));
		return { args, provider, extra, launch, supports };
	});
	delete process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS;
	delete process.env.AIO_SUBAGENT_CURSOR_EXTENSION;
	const enforced = [
		{ noExtensions: false, paths: ["a"] },
		{ noExtensions: true, paths: [] },
		{ noExtensions: true, paths: ["b", extensions.AIO_EXTENSION_PATH] },
	].map((launch) => ({ launch, result: extensions.enforceChildExtensions(launch) }));

	// ---- activity ----
	const durations = [-5, 0, 999, 1000, 59_999, 60_000, 61_000, 3_599_999, 3_600_000, 7_265_000, 90_061_000].map((ms) => ({ ms, out: activity.formatDuration(ms) }));
	const summaries = [
		["bash", { command: "  npm   test\n--watch  " }],
		["bash", { other: "x" }],
		["todo", { action: "toggle", step: 2 }],
		["read", { path: "src/a.ts", pattern: "p" }],
		["grep", { pattern: "" + "x".repeat(80) }],
		["fetch", { url: "https://example.com" }],
		["custom", { count: 3, label: " first ", other: "second" }],
		["custom", { flag: true }],
		["custom", "not an object"],
		["custom", null],
		["custom", ["array", "values"]],
		["read", { path: "   " , query: "q" }],
		["x", { text: "emoji 🙂".repeat(12) }],
	].map(([name, args]) => ({ name, args, out: activity.summarizeToolArgs(name as string, args) }));
	const activityEvents: Array<[number, Record<string, unknown>]> = [
		[1000, { type: "agent_start" }],
		[2000, { type: "turn_start" }],
		[2500, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }],
		[2600, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }],
		[3000, { type: "message_update", assistantMessageEvent: { type: "text_start" } }],
		[3100, { type: "message_update", assistantMessageEvent: { type: "unknown" } }],
		[3200, { type: "message_update" }],
		[4000, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 10" } }],
		[4500, { type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } }],
		[5000, { type: "tool_execution_end", toolCallId: "t1" }],
		[5500, { type: "tool_execution_end", toolCallId: "tool-1" }],
		[6000, { type: "auto_retry_start", attempt: 2, maxAttempts: "3", errorMessage: `overloaded ${"x".repeat(100)}` }],
		[6100, { type: "message_update", assistantMessageEvent: { type: "text_delta" } }],
		[6200, { type: "auto_retry_start", attempt: "bad", maxAttempts: 0 }],
		[6300, { type: "auto_retry_end" }],
		[7000, { type: "compaction_start" }],
		[8000, { type: "compaction_end" }],
		[9000, { type: "turn_start" }],
		[9500, { type: "tool_execution_start", toolCallId: 42, toolName: 7 }],
		[10_000, { type: "agent_settled", aborted: false }],
		[11_000, { type: "turn_start" }],
		[12_000, { type: "message_update", assistantMessageEvent: { type: "text_delta" } }],
		[13_000, { type: "weird" }],
	];
	const act = activity.createActivity(0);
	const activitySteps = activityEvents.map(([now, event]) => {
		const significant = activity.applyActivityEvent(act, event, now);
		return { now, event, significant, activity: structuredClone(act) };
	});
	const formatStates = [
		{ state: "running", startedAt: 0, attempts: 1 },
		{ state: "running", startedAt: 0, attempts: 3 },
		{ state: "running" },
		{ state: "queued" },
		{ state: "failed" },
	];
	const formatPhases: Array<Record<string, unknown>> = [
		{ phase: "starting", lastEventAt: 0, turns: 0, toolCount: 0, runningTools: [] },
		{ phase: "waiting", lastEventAt: 0, turns: 1, toolCount: 1, runningTools: [] },
		{ phase: "thinking", lastEventAt: 0, turns: 1, toolCount: 2, runningTools: [] },
		{ phase: "writing", lastEventAt: 0, turns: 1, toolCount: 0, runningTools: [] },
		{ phase: "tool", lastEventAt: 0, turns: 1, toolCount: 3, runningTools: [] },
		{ phase: "tool", lastEventAt: 0, turns: 1, toolCount: 3, runningTools: [{ id: "a", name: "bash", summary: "", startedAt: 0 }, { id: "b", name: "read", summary: "a.ts", startedAt: 10_000 }] },
		{ phase: "retrying", lastEventAt: 0, turns: 1, toolCount: 0, runningTools: [], retry: { attempt: 2, maxAttempts: 5, error: "busy" } },
		{ phase: "retrying", lastEventAt: 0, turns: 1, toolCount: 0, runningTools: [] },
		{ phase: "compacting", lastEventAt: 0, turns: 1, toolCount: 0, runningTools: [] },
		{ phase: "finishing", lastEventAt: 0, turns: 1, toolCount: 0, runningTools: [], settledAt: 20_000 },
		{ phase: "finishing", lastEventAt: 0, turns: 1, toolCount: 0, runningTools: [] },
	];
	const nows = [0, 4_999, 5_000, 30_000, 119_999, 120_000, 400_000];
	const formats: unknown[] = [];
	for (const base of formatStates) {
		for (const phase of [undefined, ...formatPhases]) {
			for (const now of nows) {
				const child = { ...base, activity: phase };
				formats.push({ child, now, out: activity.formatChildActivity(child, now) });
			}
		}
	}

	// ---- transcript ----
	const transcriptScripts: Record<string, Array<Record<string, unknown>>> = {
		streaming: [
			{ type: "turn_start" },
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task:\tdo \x1b[31mit\x1b[0m\r\n" }, { type: "image" }] } },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan " } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "more\u0007" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "final plan" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " world" } },
			{ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{" } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "   " } },
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: "1" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: "1", delta: "x".repeat(8_100) } },
			{ type: "message_end", message: { role: "assistant", content: [], errorMessage: "boom" } },
		],
		unstreamed: [
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "deep" }, { type: "thinking", thinking: "  " }, { type: "text", text: "answer" }, { type: "toolCall", id: "c" }, "junk"] } },
			{ type: "message_end", message: { role: "assistant", content: "plain string" } },
			{ type: "message_end", message: { role: "system", content: "x" } },
			{ type: "message_end" },
		],
		tools: [
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test", timeout: 30, nested: { a: [1, 2.5, "é"], empty: {}, list: [] } } },
			{ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "partial" }] } },
			{ type: "tool_execution_update", toolCallId: "missing", partialResult: "x" },
			{ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "done\n\n" }] }, durationMs: 1234 },
			{ type: "tool_execution_start", toolCallId: "t2", toolName: "read" },
			{ type: "tool_execution_update", toolCallId: "t2", partialResult: "streamed" },
			{ type: "tool_execution_end", toolCallId: "t2", result: { content: [] }, isError: true },
			{ type: "tool_execution_start", toolName: "write", args: { path: "a.txt", content: "y".repeat(3_000) } },
			{ type: "tool_execution_end", toolCallId: "tool-0", result: "text result" },
			{ type: "tool_execution_start", toolCallId: "t3", toolName: "edit", args: null },
			{ type: "tool_execution_end", toolCallId: "t3", result: { content: [{ type: "text", text: "z".repeat(7_000) }] } },
		],
		notices: [
			{ type: "auto_retry_start", attempt: 2, maxAttempts: 4, errorMessage: "529" },
			{ type: "auto_retry_start" },
			{ type: "auto_retry_end", success: true },
			{ type: "auto_retry_end", success: false, finalError: "gave up" },
			{ type: "auto_retry_end", success: false },
			{ type: "compaction_start", reason: "threshold" },
			{ type: "compaction_start" },
			{ type: "compaction_end", errorMessage: "too big" },
			{ type: "compaction_end" },
			{ type: "agent_settled", aborted: true },
			{ type: "agent_settled" },
			{ type: "turn_start" },
		],
	};
	const transcriptView = (t: ReturnType<typeof transcriptMod.createTranscript>) => ({
		entries: t.entries.map((entry: Record<string, unknown>) => ({ ...entry })),
		dropped: t.dropped,
		chars: t.chars,
		turns: t.turns,
		revision: t.revision,
	});
	const transcripts: Record<string, unknown> = {};
	for (const [name, events] of Object.entries(transcriptScripts)) {
		const t = transcriptMod.createTranscript();
		events.forEach((event, i) => transcriptMod.applyTranscriptEvent(t, event, 1000 + i * 10));
		transcripts[name] = transcriptView(t);
	}
	{
		const t = transcriptMod.createTranscript();
		transcriptMod.appendTranscriptLog(t, "warn: one\n", 1);
		transcriptMod.appendTranscriptLog(t, "  \n", 2);
		transcriptMod.appendTranscriptLog(t, "\x1b[33mwarn: two\x1b[0m\n", 3);
		transcriptMod.pushTranscriptNotice(t, "between", "warning", 4);
		transcriptMod.appendTranscriptLog(t, "l".repeat(5_000), 5);
		transcriptMod.appendTranscriptLog(t, "tail", 6);
		transcripts.logs = transcriptView(t);
	}
	{
		const t = transcriptMod.createTranscript();
		for (let i = 0; i < 620; i++) transcriptMod.pushTranscriptNotice(t, `notice ${i}`, "muted", i);
		const big = transcriptMod.createTranscript();
		for (let i = 0; i < 70; i++) transcriptMod.applyTranscriptEvent(big, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${i}`.padEnd(4_000, "b") }] } }, i);
		transcripts.budget = { count: { dropped: t.dropped, chars: t.chars, first: t.entries[0], last: t.entries.at(-1), length: t.entries.length }, chars: { dropped: big.dropped, chars: big.chars, length: big.entries.length, first: big.entries[0].text.slice(0, 8) } };
	}
	const clips = [["short", 10], ["0123456789abcdefghijklmnopqrstuvwxyz".repeat(3), 50], ["x".repeat(100), 41], ["y".repeat(100), 40], ["🙂".repeat(60), 60]].map(([text, max]) => ({ text, max, out: transcriptMod.clipMiddle(text, max) }));
	const sanitize = ["a\tb\r\nc\rd", "\x1b[1;31mred\x1b[0m\u0007\u0000x", "\u009b31mC1\x1b]0;title\u0007", "keep\nnewlines"].map((text) => ({ text, out: transcriptMod.sanitizeText(text) }));

	// ---- history ----
	const launch = (agent: string, task: string, cwd: string, extra: Record<string, unknown> = {}) => ({
		task: { agent, task, model: "anthropic/claude", thinking: "high" },
		request: { context: "fresh", timeoutMs: 60_000 },
		agent: { name: agent, description: "d", systemPrompt: "p", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false, tools: ["read"], source: "builtin", filePath: "/a.md" },
		parent: { cwd, model: "anthropic/claude", modelProvider: "anthropic", thinking: "high", parentSessionFile: "/s.jsonl", extensionLaunch: { noExtensions: false, paths: [] } },
		resumed: false,
		sessionDir: "/runs/r/child-0",
		...extra,
	});
	const publicChild = (index: number, state: string, extra: Record<string, unknown> = {}) => ({ index, agent: `agent${index}`, task: `task ${index}`, state, ...extra });
	const publicRunData = (id: string, state: string, children: unknown[], extra: Record<string, unknown> = {}) => ({ id, state, mode: children.length > 1 ? "parallel" : "single", context: "fresh", cwd: "/work", startedAt: 1000, children, ...extra });
	const historyEntries: unknown[] = [
		{ type: "session", id: "h" },
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("run-a", "running", [publicChild(0, "running", { startedAt: 1100, output: "partial" }), publicChild(1, "queued")]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { runs: [publicRunData("run-b", "completed", [publicChild(0, "completed", { output: "", attempts: 2, reapedAfterSettle: true, endedAt: 1500, model: "m", thinking: "low", sessionFile: "/s/b.jsonl" })], { endedAt: 1600 })] } } },
		{ type: "custom", customType: "aio-subagent-state", timestamp: "2026-01-01T00:00:05.000Z", data: { version: 1, run: publicRunData("run-c", "failed", [publicChild(0, "failed", { error: "boom", startedAt: 2000 })], { startedAt: 2000, error: "1 subagent task(s) failed." }), launches: [launch("agent0", "task 0", "/work")] } },
		{ type: "custom", customType: "aio-subagent-state", data: { version: 1, run: publicRunData("run-c", "failed", [publicChild(0, "failed", { error: "boom", startedAt: 2000 })], { startedAt: 2000 }) } },
		{ type: "custom", customType: "aio-subagent-state", data: { version: 1, run: publicRunData("run-d", "stopped", [publicChild(0, "stopped")], { startedAt: 3000, resumedFrom: { runId: "run-c", index: 0 } }), launches: [launch("agent0", "task 0", "/other"), "junk"] } },
		{ type: "custom", customType: "aio-subagent-state", data: { version: 2, run: publicRunData("run-x", "completed", [publicChild(0, "completed")]) } },
		{ type: "custom_message", customType: "aio-subagent-complete", details: publicRunData("run-e", "completed", [publicChild(0, "completed", { output: "done" })], { startedAt: 500 }) },
		{ type: "message", message: { role: "custom", customType: "aio-subagent-complete", details: publicRunData("run-f", "completed", [publicChild(3, "completed")], { startedAt: 600, resumedFrom: { runId: "run-c", index: 0 } }) } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("", "completed", [publicChild(0, "completed")]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("dup", "completed", [publicChild(0, "completed"), publicChild(0, "completed")]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("bad-index", "completed", [publicChild(12, "completed")]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("bad-thinking", "completed", [publicChild(0, "completed", { thinking: "huge" })]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("float-attempts", "completed", [publicChild(0, "completed", { attempts: 1.5 })]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "other", details: { run: publicRunData("other-tool", "completed", [publicChild(0, "completed")]) } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: { ...publicRunData("extra-fields", "completed", [publicChild(0, "completed", { process: { pid: 1 }, transcript: {} })]), stopRequested: false, capability: "x" } } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData("many", "completed", Array.from({ length: 13 }, (_, i) => publicChild(i % 12, "completed"))) } } },
		"not an object",
		null,
	];
	const restoredView = (list: Array<{ run: Record<string, unknown>; launches?: unknown }>) =>
		list.map(({ run, launches }) => ({ run: history.publicRun(run), results: run.results, stopRequested: run.stopRequested, launches: launches === undefined ? null : launches }));
	const historyResult = restoredView(history.runsFromBranch(historyEntries));
	const manyEntries = Array.from({ length: 55 }, (_, i) => ({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { run: publicRunData(`r${i}`, "completed", [publicChild(0, "completed")], { startedAt: i }) } } }));
	const historyCap = history.runsFromBranch(manyEntries).map(({ run }: { run: { id: string } }) => run.id);

	// ---- saved transcripts ----
	const sessionLines = (entries: unknown[]) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const savedFiles: Record<string, string> = {
		branch: sessionLines([
			{ type: "session", id: "s" },
			{ id: "1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Task: inspect" } },
			{ id: "2", parentId: "1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
			{ id: "3", parentId: "2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.ts" }], isError: false } },
			{ id: "x", parentId: "2", timestamp: "2026-01-01T00:00:02.500Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned branch" }] } },
			{ id: "4", parentId: "3", timestamp: "bad", message: { role: "toolResult", toolCallId: "orphan", toolName: "read", content: [], isError: true } },
			{ id: "5", parentId: "4", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
		]) + "{partial",
		legacy: sessionLines([{ type: "session" }, { message: { role: "user", content: "Task: legacy" } }, { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }]),
		empty: "",
		malformed: "not json\n{\n",
		noMessages: sessionLines([{ type: "session", id: "a" }, { id: "b", parentId: "a", type: "model_change" }]),
		cycle: sessionLines([{ id: "a", parentId: "b", message: { role: "user", content: "A" } }, { id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "B" }] } }]),
	};
	const big = [JSON.stringify({ type: "session", id: "s" }), ...Array.from({ length: 400 }, (_, i) => JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: `${i}`.padEnd(3_000, "q") }] } }))].join("\n");
	const savedInputs = { ...savedFiles };
	savedFiles.bounded = `${big}\n`;
	const savedResults: Record<string, unknown> = {};
	for (const [name, content] of Object.entries(savedFiles)) {
		const file = join(root, "saved", `${name}.jsonl`);
		write(file, content, false);
		const t = saved.loadSavedTranscript(file);
		savedResults[name] = t ? (name === "bounded" ? { length: t.entries.length, dropped: t.dropped, chars: t.chars, last: t.entries.at(-1), first: t.entries[0] } : transcriptView(t)) : null;
	}
	savedResults.missing = saved.loadSavedTranscript(join(root, "saved", "missing.jsonl")) ?? null;
	savedResults.directory = saved.loadSavedTranscript(join(root, "saved")) ?? null;

	// ---- spawn specs ----
	const runsBaseDir = join(root, "runs");
	const agentFixture = (extra: Record<string, unknown> = {}) => ({ name: "worker", description: "d", systemPrompt: "Do work.", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false, source: "builtin", filePath: "/a.md", ...extra });
	const parentFixture = (extra: Record<string, unknown> = {}) => ({ cwd: project, model: "anthropic/claude", modelProvider: "anthropic", thinking: "high", parentSessionFile: join(root, "parent.jsonl"), extensionLaunch: { noExtensions: false, paths: [] }, ...extra });
	const specCases = [
		{ name: "fresh", task: { agent: "worker", task: "Build it" }, request: {}, agent: agentFixture(), parent: parentFixture() },
		{ name: "append-tools", task: { agent: "worker", task: "Review", model: "openai/gpt", thinking: "low" }, request: { model: "x/y", thinking: "max" }, agent: agentFixture({ systemPromptMode: "append", inheritProjectContext: false, inheritSkills: true, tools: ["read", "subagent", "bash"] }), parent: parentFixture({ extensionLaunch: { noExtensions: true, paths: ["/ext/a.ts"] } }) },
		{ name: "fork", task: { agent: "worker", task: "Fork" }, request: { context: "fork", model: "req/model" }, agent: agentFixture({ model: "agent/model", thinking: "minimal" }), parent: parentFixture({ model: undefined, thinking: undefined }) },
		{ name: "fork-missing", task: { agent: "worker", task: "Fork" }, request: { context: "fork" }, agent: agentFixture(), parent: parentFixture({ parentSessionFile: undefined }) },
		{ name: "resume", task: { agent: "worker", task: "Resume" }, request: { context: "fork" }, agent: agentFixture({ tools: ["subagent"] }), parent: parentFixture(), resumeSessionFile: join(root, "child.jsonl"), promptOverride: runner.childAgentBinary ? "continue please" : "" },
		{ name: "large", task: { agent: "worker", task: "L".repeat(8_000) }, request: {}, agent: agentFixture(), parent: parentFixture({ model: "", thinking: "" }) },
		{ name: "cursor-unsupported", task: { agent: "worker", task: "C" }, request: {}, agent: agentFixture(), parent: parentFixture({ model: "cursor/fast", extensionLaunch: { noExtensions: true, paths: [] } }) },
	].map((input, i) => {
		const runId = `run-${i}`;
		try {
			const spec = runner.buildSpawnSpec({ runId, index: i % 2, task: input.task, request: input.request, agent: input.agent, parent: input.parent, deps: { runsBaseDir, piBinary: "pig" }, resumeSessionFile: input.resumeSessionFile, promptOverride: input.promptOverride });
			const files: Record<string, string> = {};
			for (const name of ["system-prompt.md", "task.md"]) {
				try { files[name] = readFileSync(join(spec.sessionDir, name), "utf8"); } catch { /* absent */ }
			}
			const env = Object.fromEntries(Object.entries(spec.env).filter(([key]) => key.startsWith("AIO_SUBAGENT_")));
			return { ...input, runId, spec: { command: spec.command, args: spec.args, cwd: spec.cwd, env, sessionDir: spec.sessionDir, requestedSessionFile: spec.requestedSessionFile ?? null }, files };
		} catch (e) {
			return { ...input, runId, error: (e as Error).message };
		}
	});
	const binaries = [
		{},
		{ AIO_SUBAGENT_PI_BINARY: "  /custom/pi  " },
		{ AI_AGENT: "pig", PIG_HARNESS_BINARY: "/go/bin/pig" },
		{ AI_AGENT: "pi", PIG_HARNESS_BINARY: "/go/bin/pig" },
		{ AI_AGENT: "pig", PIG_HARNESS_BINARY: "  " },
		{ AIO_SUBAGENT_PI_BINARY: " ", AI_AGENT: "pig", PIG_HARNESS_BINARY: "/go/bin/pig" },
	].map((env) => ({ env, out: runner.childAgentBinary(env) }));
	const baseEnv = runner.childBaseEnv({ PATH: "/bin", PIG_EXT_SOCKET: "s", PIG_HARNESS_ARGV_FILE: "f", PIG_HOME: "h", AI_AGENT: "pig" });

	// ---- runs, results, progress, widget ----
	const T0 = NOW - 100_000;
	const mkChild = (i: number, state: string, extra: Record<string, unknown> = {}) => ({ index: i, agent: `agent-${i}`, task: `Task number ${i} with a fairly long description`, state, startedAt: state === "queued" ? undefined : T0 + 1_000, ...extra });
	const mkRun = (id: string, state: string, children: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ id, state, mode: children.length > 1 ? "parallel" : "single", context: "fresh", cwd: "/w", startedAt: T0, children, results: [], stopRequested: false, ...extra });
	const result = (i: number, state: string, extra: Record<string, unknown> = {}) => ({ index: i, agent: `agent-${i}`, task: "t", state, output: `output ${i}`, exitCode: state === "completed" ? 0 : 1, startedAt: T0, endedAt: NOW, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, attempts: 1, ...extra });
	/** A sparse results array, as the runner leaves for children that never ran. */
	const sparseResults = (items: unknown[], positions: number[]) => {
		const out: unknown[] = [];
		positions.forEach((position, i) => { out[position] = items[i]; });
		return out;
	};
	const resultsRuns = [
		mkRun("aaaaaaaa-1111", "completed", [mkChild(0, "completed")], { results: [result(0, "completed")] }),
		mkRun("bbbbbbbb-2222", "failed", [mkChild(0, "completed"), mkChild(1, "failed")], { mode: "parallel", context: "fork", results: [result(0, "completed", { reapedAfterSettle: true }), result(1, "failed", { error: "boom (attempt 2 of 2).", attempts: 2 })] }),
		mkRun("cccccccc-3333", "stopped", [mkChild(0, "completed"), mkChild(1, "stopped"), mkChild(2, "stopped")], { results: sparseResults([result(0, "completed", { output: "" }), result(2, "failed", { output: "", error: "e" })], [0, 2]), resumedFrom: { runId: "zzzz", index: 1 } }),
	];
	const runResults = resultsRuns.map((run) => runner.formatRunResult(run));
	const busy = transcriptMod.createTranscript();
	const busyEvents: Array<Record<string, unknown>> = [
		{ type: "turn_start" },
		{ type: "message_end", message: { role: "user", content: "Task: inspect the repository and report\nwith several lines\nof prompt\ntext\nhere\nand more" } },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Thinking about it ".repeat(20) } },
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test -- --reporter dot" } },
		{ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n") }] }, durationMs: 2_500 },
		{ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "src/index.ts" } },
		{ type: "tool_execution_end", toolCallId: "t2", result: { content: [] }, isError: true },
		{ type: "tool_execution_start", toolCallId: "t3", toolName: "grep", args: { pattern: "TODO" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "The answer is 42. ".repeat(10) } },
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "overloaded" },
	];
	for (const [i, event] of busyEvents.entries()) transcriptMod.applyTranscriptEvent(busy, event, T0 + 2_000 + i * 1_000);
	transcriptMod.appendTranscriptLog(busy, "warn: a\nwarn: b\nwarn: c\nwarn: d\n", T0 + 20_000);
	transcriptMod.pushTranscriptNotice(busy, "attempt 2/2", "warning", T0 + 21_000);
	const dropped = transcriptMod.createTranscript();
	for (let i = 0; i < 505; i++) transcriptMod.pushTranscriptNotice(dropped, `n${i}`, "success", T0);
	const runningActivity = (phase: string, extra: Record<string, unknown> = {}) => ({ phase, lastEventAt: NOW - 1_000, turns: 2, toolCount: 3, runningTools: [], ...extra });
	const viewRuns = () => [
		mkRun("run-active-1", "running", [
			mkChild(0, "running", { activity: runningActivity("tool", { runningTools: [{ id: "x", name: "bash", summary: "npm test", startedAt: NOW - 4_000 }] }), transcript: busy, model: "anthropic/claude-sonnet", thinking: "high", attempts: 2 }),
			mkChild(1, "running", { activity: runningActivity("thinking", { lastEventAt: NOW - 200_000 }) }),
			mkChild(2, "completed", { endedAt: NOW - 500, output: "All good", sessionFile: "/runs/r/child-2/session.jsonl", transcript: dropped }),
			mkChild(3, "running", { activity: runningActivity("writing") }),
			mkChild(4, "running"),
			mkChild(5, "queued"),
		], { startedAt: NOW - 50_000 }),
		mkRun("run-old-2", "failed", [mkChild(0, "failed", { endedAt: NOW - 60_000, error: `Provider error ${"x".repeat(200)}\nsecond line`, attempts: 2, output: "partial result" })], { startedAt: NOW - 90_000, endedAt: NOW - 60_000 }),
		mkRun("run-old-3", "stopped", [mkChild(0, "stopped", { endedAt: NOW - 70_000, sessionFile: "/runs/s.jsonl" })], { startedAt: NOW - 95_000, endedAt: NOW - 70_000 }),
		mkRun("run-bg-4", "queued", [mkChild(0, "queued")], { startedAt: NOW - 1_000 }),
	];
	const empty = transcriptMod.createTranscript();
	const transcriptName = (t: unknown) => (t === busy ? "busy" : t === dropped ? "dropped" : t === empty ? "empty" : undefined);
	const runSpec = (run: Record<string, unknown>) => ({ ...run, children: (run.children as Array<Record<string, unknown>>).map((c) => ({ ...c, transcript: transcriptName(c.transcript) })) });
	const progress = viewRuns().map((run) => activity.formatRunProgress(run, NOW));
	const active = viewRuns().filter((run) => run.state === "running" || run.state === "queued");
	const widgets: unknown[] = [];
	for (const width of [0, 10, 28, 60, 100]) {
		for (const maxRows of [0, 1, 4]) widgets.push({ width, maxRows, lines: index.buildSubagentWidgetLines(active, width, theme, maxRows, NOW) });
	}
	const manyActive = Array.from({ length: 6 }, (_, i) => mkRun(`run-${i}-abcdefgh`, "running", [mkChild(0, "completed"), mkChild(1, "running")]));
	widgets.push({ width: 28, maxRows: 3, many: true, runs: manyActive.map(runSpec), lines: index.buildSubagentWidgetLines(manyActive, 28, theme, 3, NOW) });

	// ---- inspector ----
	const KEYS: Record<string, string> = { escape: "\x1b", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", tab: "\t", "shift+tab": "\x1b[Z", pageUp: "\x1b[5~", pageDown: "\x1b[6~", "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+u": "\x15" };
	const soloRuns = () => [mkRun("run-solo", "completed", [mkChild(0, "completed", { endedAt: NOW, transcript: busy, output: "x" })])];
	const inspectorScripts: Array<{ name: string; runs: string; width: number; maxRows: number; keys: string[]; resume?: boolean; unavailable?: string }> = [
		{ name: "list-wide", runs: "all", width: 100, maxRows: 30, keys: ["", "j", "j", "down", "k", "G", "g", "pageDown", "ctrl+u"] },
		{ name: "detail-cycle", runs: "all", width: 90, maxRows: 24, keys: ["enter", "", "tab", "tab", "shift+tab", "]", "[", "h", "l", "right", "left", "escape", "up", "enter"] },
		{ name: "detail-scroll", runs: "all", width: 80, maxRows: 20, keys: ["enter", "k", "k", "ctrl+u", "g", "j", "space", "pageDown", "pageUp", "ctrl+d", "G", "o", "t", "o", "t"] },
		{ name: "narrow", runs: "all", width: 24, maxRows: 10, keys: ["", "enter", "tab", "escape", "j"] },
		{ name: "tiny", runs: "all", width: 8, maxRows: 3, keys: ["", "enter", "tab"] },
		{ name: "short-frame", runs: "all", width: 40, maxRows: 7, keys: ["", "enter"] },
		{ name: "one-child", runs: "single", width: 70, maxRows: 16, keys: ["", "o", "escape", "q", "j"] },
		{ name: "empty", runs: "none", width: 50, maxRows: 12, keys: ["", "j", "enter", "escape"] },
		{ name: "resume", runs: "all", width: 90, maxRows: 18, keys: ["j", "j", "j", "j", "j", "j", "j", "r", "j", "r", "ctrl+c", "j"], resume: true },
		{ name: "resume-blocked", runs: "all", width: 90, maxRows: 18, keys: ["G", "r", "enter"], resume: true, unavailable: "The child is still stopping; try again shortly." },
	];
	const inspectors = inspectorScripts.map((script) => {
		const runs = script.runs === "all" ? viewRuns() : script.runs === "single" ? soloRuns() : [];
		const events: string[] = [];
		const inspector = new inspectorMod.SubagentInspector({
			theme,
			getRuns: () => runs,
			getMaxRows: () => script.maxRows,
			requestRender: () => {},
			done: () => events.push("done"),
			now: () => NOW,
			tickMs: 0,
			resumeChild: script.resume ? (target: { key: string }) => events.push(`resume ${target.key}`) : undefined,
			resumeUnavailable: script.unavailable ? () => script.unavailable : undefined,
			loadTranscript: (file: string) => { events.push(`load ${file}`); return file === "/runs/s.jsonl" ? dropped : undefined; },
		});
		const frames = script.keys.map((key) => {
			if (key) inspector.handleInput(key === "space" ? " " : KEYS[key] ?? key);
			return { key, view: inspector.view, selected: inspector.selectedKey ?? null, lines: inspector.render(script.width) };
		});
		return { ...script, initialView: frames.length ? undefined : inspector.view, frames, events };
	});
	const transcriptRenders: unknown[] = [];
	for (const width of [0, 12, 40, 72]) {
		for (const [expandTools, showThinking] of [[false, true], [true, false]]) {
			for (const [name, child] of Object.entries({
				busy: mkChild(0, "running", { transcript: busy }),
				queued: mkChild(1, "queued"),
				pruned: mkChild(2, "completed", { output: "Final answer text", sessionFile: "/s.jsonl" }),
				empty: mkChild(3, "running", { transcript: empty }),
				dropped: mkChild(4, "failed", { transcript: dropped, output: "out" }),
			})) transcriptRenders.push({ name, child: runSpec({ children: [child] }).children[0], width, expandTools, showThinking, lines: inspectorMod.renderTranscriptLines(child, width, theme, { expandTools, showThinking, now: NOW }) });
		}
	}
	const targets = inspectorMod.inspectorTargets(viewRuns()).map((target: { key: string }) => target.key);
	const describes = viewRuns().flatMap((run) => run.children.map((child) => inspectorMod.describeChild(child, NOW)));

	// ---- runner scenarios ----
	const fixtureChild = join(repo, "subagents", "test-fixture-child.mjs");
	const scenarioRuns = join(root, "scenario-runs");
	const scenarioAgent = { name: "worker", description: "d", systemPrompt: "Work.", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true, source: "builtin", filePath: "/w.md" };
	const scenarioDeps = { piBinary: process.execPath, piArgsPrefix: [fixtureChild], runsBaseDir: scenarioRuns, retryBackoffMs: 0, terminationGraceMs: 200, settleExitGraceMs: 300 };
	const scenarios = [
		{ name: "single", request: { agent: "worker", task: "hello" } },
		{ name: "parallel", request: { tasks: [{ agent: "worker", task: "one" }, { agent: "worker", task: "fail now" }, { agent: "worker", task: "three", model: "m/x", thinking: "low" }], concurrency: 2 } },
		{ name: "resume-hang", request: { agent: "worker", task: "resume-hang", timeoutMs: 1_500 } },
		{ name: "always-hang", request: { agent: "worker", task: "always-hang", timeoutMs: 1_000 } },
		{ name: "quota", request: { agent: "worker", task: "quota-once" } },
		{ name: "quota-always", request: { agent: "worker", task: "quota-always" } },
		{ name: "linger", request: { agent: "worker", task: "linger" } },
		{ name: "missing-binary", request: { agent: "worker", task: "x" }, deps: { piBinary: join(root, "no-such-binary") } },
		{ name: "bad-agent", request: { agent: "ghost", task: "x" } },
		{ name: "bad-request", request: { agent: "worker", task: "x", tasks: [] } },
		{ name: "fork-no-session", request: { agent: "worker", task: "x", context: "fork" }, parent: { parentSessionFile: undefined } },
	];
	const scenarioResults: unknown[] = [];
	for (const scenario of scenarios) {
		registry.clearRuns();
		const parent = { cwd: project, model: "anthropic/claude", modelProvider: "anthropic", thinking: "medium", parentSessionFile: undefined, extensionLaunch: { noExtensions: false, paths: [] }, ...(scenario.parent ?? {}) };
		let run: Record<string, unknown> | undefined;
		let error = "";
		try {
			run = await runner.executeSubagentRun({ request: scenario.request, agents: [scenarioAgent], parent, deps: { ...scenarioDeps, ...(scenario.deps ?? {}) } });
		} catch (e) {
			error = (e as Error).message;
		}
		const id = (run?.id as string) ?? "none";
		const normalize = (value: unknown) => {
			try {
				return JSON.parse(JSON.stringify(value ?? null).split(id).join("@@RUN@@")) as unknown;
			} catch (e) {
				throw new Error(`run id substitution broke the JSON: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		scenarioResults.push({
			name: scenario.name,
			input: { request: scenario.request, parent, deps: scenario.deps ?? null },
			error,
			run: run ? normalize({
				state: run.state, mode: run.mode, context: run.context, error: run.error ?? null,
				children: (run.children as Array<Record<string, unknown>>).map((child) => ({
					index: child.index, agent: child.agent, state: child.state, output: child.output ?? null, error: child.error ?? null,
					model: child.model ?? null, thinking: child.thinking ?? null, attempts: child.attempts ?? null,
					sessionFile: child.sessionFile ?? null, reapedAfterSettle: child.reapedAfterSettle ?? null,
					transcript: ((child.transcript as { entries: Array<Record<string, unknown>> } | undefined)?.entries ?? []).map((entry) => ({ kind: entry.kind, text: entry.text ?? null, tone: entry.tone ?? null })),
				})),
				results: (run.results as Array<Record<string, unknown> | undefined>).map((r) => r ? { index: r.index, state: r.state, output: r.output, error: r.error ?? null, exitCode: r.exitCode, usage: r.usage, attempts: r.attempts, model: r.model ?? null, reapedAfterSettle: r.reapedAfterSettle ?? null } : null),
				text: runner.formatRunResult(run),
			}) : null,
		});
	}
	registry.clearRuns();

	const output = `${JSON.stringify(placeholders({
		now: NOW,
		t0: T0,
		fixtureFiles,
		savedInputs,
		busyEvents,
		transcriptScripts,
		viewRuns: viewRuns().map(runSpec),
		soloRuns: soloRuns().map(runSpec),
		scenarioAgent,
		builtinFiles: Object.fromEntries(["planner", "researcher", "reviewer", "scout", "validator", "worker"].map((name) => [`${name}.md`, readFileSync(join(BUILTIN, `${name}.md`), "utf8")])),
		discovery, invalid, findError, findError2,
		launchCases, enforced,
		durations, summaries, activitySteps, formats,
		transcripts, clips, sanitize,
		historyEntries, historyResult, historyCap,
		savedResults,
		specCases, binaries, baseEnv,
		resultsRuns, runResults, progress, widgets,
		inspectors, transcriptRenders, targets, describes,
		scenarios: scenarioResults,
	}), null, 1)}\n`;
	const goldenPath = join(here, "golden.json");
	if (process.argv.includes("--check")) {
		let current = "";
		try {
			current = readFileSync(goldenPath, "utf8");
		} catch {
			current = "";
		}
		if (current !== output) {
			console.error("subagents golden.json is stale: run npx tsx go/internal/subagents/testdata/gen-golden.ts");
			process.exitCode = 1;
		} else console.log(`subagents golden.json is current (${inspectors.length} inspector scripts, ${scenarioResults.length} runner scenarios)`);
	} else {
		writeFileSync(goldenPath, output);
		console.log(`subagents golden.json: ${inspectors.length} inspector scripts, ${scenarioResults.length} runner scenarios`);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
