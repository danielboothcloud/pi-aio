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

const emitCompletion = (text) => {
	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				model,
				stopReason: "stop",
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

const hang = () => {
	setInterval(() => {}, 1_000);
};

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

setTimeout(() => {
	if (task.includes("fail")) {
		process.stderr.write("fixture failure\n");
		process.exit(2);
	}
	emitCompletion(`completed:${task}`);
}, delay);
