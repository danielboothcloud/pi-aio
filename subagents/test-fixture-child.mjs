#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
};
const task = args.at(-1) ?? "";
const model = valueAfter("--model") ?? "default-model";
const sessionFile = valueAfter("--session");
const sessionDir = valueAfter("--session-dir");
const resumed =
	!!sessionFile &&
	existsSync(sessionFile) &&
	readFileSync(sessionFile, "utf8").includes('"role":"user"');

// On a resumed retry the prompt is a continuation nudge; recover the original
// task from the session stub written by the first attempt.
const originalTask = () => {
	if (!sessionFile) return task;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes('"role":"user"')) continue;
			const entry = JSON.parse(line);
			const content = entry?.message?.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content.find((b) => typeof b?.text === "string")?.text;
				if (text) return text;
			}
		}
	} catch {
		// fall through
	}
	return task;
};
const effectiveTask = resumed ? originalTask() : task;

const writeSessionStub = (file) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session" })}\n${JSON.stringify({
			message: { role: "user", content: task },
		})}\n`,
	);
};

const emitCompletion = (text, errorMessage) => {
	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				model,
				stopReason: errorMessage ? "error" : "stop",
				errorMessage,
				usage: {
					input: 10,
					output: 2,
					cacheRead: 1,
					cacheWrite: 0,
					cost: { total: 0.01 },
				},
			},
		})}\n`,
	);
};

let hanging = false;
const hang = () => {
	hanging = true;
	setInterval(() => {}, 1_000);
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

// "linger" reproduces a child whose run finished (agent_settled) but whose
// process never exits because something keeps its event loop alive.
// "linger-stubborn" additionally ignores SIGTERM so only SIGKILL ends it.
const lingering = task.includes("linger");
if (lingering) {
	if (task.includes("linger-stubborn")) process.on("SIGTERM", () => {});
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "bash",
		args: { command: "npm test" },
	});
	emit({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "bash",
		isError: false,
	});
	emitCompletion(`completed:${task}`);
	emit({ type: "agent_settled", aborted: false });
	setInterval(() => {}, 1_000);
}

if (task.includes("ignore-term")) process.on("SIGTERM", () => {});
let delay = 5;
if (task.includes("ignore-term")) delay = 5_000;
else if (task.includes("slow")) delay = 80;

// "always-hang" stalls on every attempt; the runner should retry, then fail
// while preserving the session file.
if (effectiveTask.includes("always-hang")) {
	if (sessionFile && !existsSync(sessionFile)) writeSessionStub(sessionFile);
	hang();
} else if (effectiveTask.includes("fork-hang") && !resumed) {
	// First fork attempt: leave a forked child session behind, then stall.
	if (sessionDir) writeSessionStub(join(sessionDir, "forked-child.jsonl"));
	hang();
} else if (effectiveTask.includes("resume-hang") && !resumed) {
	// First fresh attempt: create the session file, then stall until killed.
	if (sessionFile) writeSessionStub(sessionFile);
	hang();
}

// Worktree isolation: "edit-<name>" writes <name>.txt in the child's cwd;
// "clash-<value>" writes shared.txt (siblings conflict on it). A resumed
// child does not edit again: its earlier edits must come from the replay.
for (const match of effectiveTask.matchAll(/edit-(\w+)/g))
	if (!resumed) writeFileSync(join(process.cwd(), `${match[1]}.txt`), `edited by ${match[1]}\n`);
const clash = effectiveTask.match(/clash-(\w+)/);
if (clash && !resumed) writeFileSync(join(process.cwd(), "shared.txt"), `${clash[1]}\n`);

// Typed results: "typed-ok" calls submit_result; "typed-text" answers with
// JSON text; "typed-late" submits only when asked again for the result;
// "typed-wrong" always submits a value that does not match the schema.
const typed = effectiveTask.includes("typed-");
if (typed) {
	const askedForResult = task.includes("valid typed result");
	const value = { status: "ok", files: ["a.txt"] };
	const submit = (result) =>
		emit({
			type: "tool_execution_end",
			toolCallId: "submit-1",
			toolName: "submit_result",
			isError: false,
			result: { content: [{ type: "text", text: "Result submitted." }], details: { result } },
		});
	if (sessionFile && !existsSync(sessionFile)) writeSessionStub(sessionFile);
	setTimeout(() => {
		if (effectiveTask.includes("quota-once") && !resumed) {
			emitCompletion("partial work saved", "429 quota exhausted");
			emit({ type: "agent_settled", aborted: false });
			return;
		}
		if (effectiveTask.includes("typed-ok") || (effectiveTask.includes("typed-late") && askedForResult))
			submit(value);
		if (effectiveTask.includes("typed-wrong")) submit({ status: 42 });
		emitCompletion(effectiveTask.includes("typed-text") ? JSON.stringify(value) : `done:${effectiveTask}`);
		emit({ type: "agent_settled", aborted: false });
	}, 5);
}

if (!lingering && !typed)
	setTimeout(() => {
		if (sessionDir && task.includes("fork-parent-only")) {
			// Startup failed after copying parent history but before persisting the
			// child assignment: a user turn is NOT proof the task was saved.
			const file = join(sessionDir, "forked-child.jsonl");
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(file, `${JSON.stringify({ message: { role: "user", content: "Unrelated parent assignment" } })}\n`);
			emitCompletion("", "429 quota exhausted during startup");
			emit({ type: "agent_settled", aborted: false });
			return;
		}
		if (effectiveTask.includes("quota-") && (!resumed || effectiveTask.includes("quota-always"))) {
			const file = sessionFile ?? (sessionDir && join(sessionDir, "forked-child.jsonl"));
			if (file && !existsSync(file)) writeSessionStub(file);
			emitCompletion("partial work saved", "429 quota exhausted");
			emit({ type: "agent_settled", aborted: false });
			return;
		}
		if (task.includes("fail")) {
			process.stderr.write("fixture failure\n");
			process.exit(2);
		}
		emitCompletion(`completed:${task}`);
		// A stalled child never settles; a healthy one settles, then exits.
		if (!hanging) emit({ type: "agent_settled", aborted: false });
	}, delay);
