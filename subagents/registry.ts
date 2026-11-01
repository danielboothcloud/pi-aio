import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SubagentContext, SubagentRun } from "./types.js";

const runs = new Map<string, SubagentRun>();
let retainedRuns: ReadonlySet<string> = new Set();
const ownedRuns = new WeakSet<SubagentRun>();

/** True only for runs launched by this runtime, not decoded historical rows. */
export function isOwnedRun(run: SubagentRun): boolean {
	return ownedRuns.has(run);
}
const sessionOwners = new Map<string, { runId: string; index: number }>();

function sessionKey(file: string): string {
	try { return realpathSync(file); } catch { return resolve(file); }
}

/** Independent of ancestor rows, which tree reconciliation can evict. */
export function childSessionOwner(file: string): { runId: string; index: number } | undefined {
	const key = sessionKey(file);
	const owner = sessionOwners.get(key);
	if (owner && !runs.has(owner.runId)) {
		sessionOwners.delete(key);
		return undefined;
	}
	return owner;
}

export function claimChildSession(file: string, runId: string, index: number): void {
	for (const [key, owner] of sessionOwners) if (!runs.has(owner.runId)) sessionOwners.delete(key);
	sessionOwners.set(sessionKey(file), { runId, index });
}
const MAX_COMPLETED_RUNS = 50;
/** Finished runs that keep their inspector transcripts (memory bound). */
export const MAX_TRANSCRIPT_RUNS = 10;

function pruneRuns(): void {
	const terminal = [...runs.values()]
		.filter(
			(run) =>
				!run.children.some((child) => child.process) &&
				(run.state === "completed" || run.state === "failed" || run.state === "stopped"),
		)
		.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	const prunable = terminal.filter((run) => !retainedRuns.has(run.id));
	for (const run of prunable.slice(MAX_COMPLETED_RUNS)) runs.delete(run.id);
	for (const run of terminal.slice(MAX_TRANSCRIPT_RUNS)) {
		for (const child of run.children) child.transcript = undefined;
	}
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
	ownedRuns.add(run);
	pruneRuns();
	return run;
}

/** Add a decoded historical run; never replace an active process handle. */
export function restoreRun(run: SubagentRun): void {
	const previous = runs.get(run.id);
	if (previous && ownedRuns.has(previous)) return;
	runs.set(run.id, run);
	pruneRuns();
}

/** Reconcile a tree selection without terminating or replacing live children. */
export function reconcileRuns(history: SubagentRun[], retain?: ReadonlySet<string>): void {
	retainedRuns = retain ?? new Set();
	const selected = new Set(history.map((run) => run.id));
	for (const [id, run] of runs) {
		const active = run.state === "running" || run.state === "queued" || run.children.some((child) => child.process);
		if (!selected.has(id) && !active && !retain?.has(id)) runs.delete(id);
	}
	for (const run of history) restoreRun(run);
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
	sessionOwners.clear();
	retainedRuns = new Set();
}
