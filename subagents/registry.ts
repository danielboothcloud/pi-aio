import { randomUUID } from "node:crypto";
import type { SubagentContext, SubagentRun } from "./types.js";

const runs = new Map<string, SubagentRun>();
const MAX_COMPLETED_RUNS = 50;

function pruneRuns(): void {
	const terminal = [...runs.values()]
		.filter(
			(run) =>
				run.state === "completed" ||
				run.state === "failed" ||
				run.state === "stopped",
		)
		.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	for (const run of terminal.slice(MAX_COMPLETED_RUNS)) runs.delete(run.id);
}

export function createRun(input: {
	mode: SubagentRun["mode"];
	context: SubagentContext;
	cwd: string;
	children: SubagentRun["children"];
}): SubagentRun {
	const run: SubagentRun = {
		id: randomUUID(),
		state: "queued",
		mode: input.mode,
		context: input.context,
		cwd: input.cwd,
		startedAt: Date.now(),
		children: input.children,
		results: [],
		stopRequested: false,
	};
	runs.set(run.id, run);
	pruneRuns();
	return run;
}

export function getRun(id: string): SubagentRun | undefined {
	if (runs.has(id)) return runs.get(id);
	const matches = [...runs.values()].filter((run) => run.id.startsWith(id));
	return matches.length === 1 ? matches[0] : undefined;
}

export function listRuns(): SubagentRun[] {
	return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function stopRun(id: string): SubagentRun {
	const run = getRun(id);
	if (!run) throw new Error(`Unknown or ambiguous subagent run '${id}'.`);
	if (
		run.state === "completed" ||
		run.state === "failed" ||
		run.state === "stopped"
	)
		return run;
	run.stopRequested = true;
	run.state = "stopped";
	run.endedAt = Date.now();
	for (const child of run.children) {
		if (child.state === "queued") child.state = "stopped";
		if (child.state === "running") {
			child.state = "stopped";
			child.endedAt = Date.now();
			child.process?.kill("SIGTERM");
			const process = child.process;
			const timer = setTimeout(() => {
				if (process && process.exitCode === null && process.signalCode === null)
					process.kill("SIGKILL");
			}, 3000);
			timer.unref?.();
		}
	}
	return run;
}

export function clearRuns(): void {
	for (const run of runs.values()) {
		for (const child of run.children) child.process?.kill("SIGKILL");
	}
	runs.clear();
}
