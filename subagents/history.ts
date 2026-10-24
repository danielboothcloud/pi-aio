import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ChildLaunchSnapshot, ChildRunStatus, SubagentRun } from "./types.js";

/** Durable, non-context checkpoint. Tool details remain the legacy fallback. */
export const SUBAGENT_STATE_ENTRY = "aio-subagent-state";
const State = Type.Union((["queued", "running", "completed", "failed", "stopped"] as const).map((state) => Type.Literal(state)));
const Thinking = Type.Union((["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => Type.Literal(level)));
const OptionalText = Type.Optional(Type.String());
const OptionalNumber = Type.Optional(Type.Number());
const ChildSchema = Type.Object({
	index: Type.Integer({ minimum: 0, maximum: 11 }),
	agent: Type.String(), task: Type.String(), state: State,
	model: OptionalText, thinking: Type.Optional(Thinking),
	startedAt: OptionalNumber, endedAt: OptionalNumber,
	output: OptionalText, error: OptionalText, sessionFile: OptionalText,
	attempts: Type.Optional(Type.Integer({ minimum: 0 })),
	reapedAfterSettle: Type.Optional(Type.Boolean()),
});
const RunSchema = Type.Object({
	id: Type.String({ minLength: 1 }), state: State,
	mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")]),
	context: Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
	cwd: Type.String(), startedAt: Type.Number(), endedAt: OptionalNumber,
	error: OptionalText, children: Type.Array(ChildSchema, { minItems: 1, maxItems: 12 }),
	resumedFrom: Type.Optional(Type.Object({ runId: Type.String(), index: Type.Integer({ minimum: 0, maximum: 11 }) })),
});
const LaunchSchema = Type.Object({
	task: Type.Object({ agent: Type.String(), task: Type.String(), model: OptionalText, thinking: Type.Optional(Thinking) }),
	request: Type.Object({ context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])), timeoutMs: OptionalNumber }),
	agent: Type.Object({
		name: Type.String(), description: Type.String(), systemPrompt: Type.String(),
		systemPromptMode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		inheritProjectContext: Type.Boolean(), inheritSkills: Type.Boolean(),
		tools: Type.Optional(Type.Array(Type.String())), model: OptionalText,
		thinking: Type.Optional(Thinking), timeoutMs: OptionalNumber,
		source: Type.Union([Type.Literal("builtin"), Type.Literal("user"), Type.Literal("project")]), filePath: Type.String(),
	}),
	parent: Type.Object({
		cwd: Type.String(), model: OptionalText, modelProvider: OptionalText,
		thinking: Type.Optional(Thinking), parentSessionFile: OptionalText,
		extensionLaunch: Type.Object({ noExtensions: Type.Boolean(), paths: Type.Array(Type.String()) }),
	}),
	resumed: Type.Boolean(),
	sessionDir: OptionalText,
	pid: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** Explicit public projection: never serialize process handles or private prompts. */
export function publicRun(run: SubagentRun): Record<string, unknown> {
	return {
		id: run.id, state: run.state, mode: run.mode, context: run.context,
		cwd: run.cwd, startedAt: run.startedAt, endedAt: run.endedAt,
		error: run.error,
		resumedFrom: run.resumedFrom ? { runId: run.resumedFrom.runId, index: run.resumedFrom.index } : undefined,
		children: run.children.map((child) => ({
			index: child.index, agent: child.agent, task: child.task, state: child.state,
			model: child.model, thinking: child.thinking,
			startedAt: child.startedAt, endedAt: child.endedAt,
			output: child.output, error: child.error, sessionFile: child.sessionFile,
			attempts: child.attempts ?? 1,
			activity: child.activity ? { ...child.activity, runningTools: child.activity.runningTools.map((tool) => ({ ...tool })) } : undefined,
			reapedAfterSettle: child.reapedAfterSettle,
		})),
	};
}

export interface RestoredRun {
	run: SubagentRun;
	launches?: Array<ChildLaunchSnapshot | undefined>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

/** Decode only known fields; old running/queued records are NOT live processes. */
export function decodeHistoricalRun(value: unknown, recordedAt?: number): SubagentRun | undefined {
	if (!Value.Check(RunSchema, value)) return undefined;
	if (new Set(value.children.map((child) => child.index)).size !== value.children.length) return undefined;
	const children: ChildRunStatus[] = value.children.map((child) => ({
		index: child.index, agent: child.agent, task: child.task,
		state: child.state === "running" || child.state === "queued" ? "stopped" : child.state,
		model: child.model, thinking: child.thinking,
		startedAt: child.startedAt,
		endedAt: child.endedAt ?? value.endedAt ?? recordedAt ?? value.startedAt,
		output: child.output, sessionFile: child.sessionFile, attempts: child.attempts,
		error: child.error ?? (child.state === "running" || child.state === "queued" ? "Interrupted when the parent session ended." : undefined),
		reapedAfterSettle: child.reapedAfterSettle,
	}));
	const state = value.state === "running" || value.state === "queued" ? "stopped" : value.state;
	return {
		id: value.id, state, mode: value.mode, context: value.context,
		cwd: value.cwd, startedAt: value.startedAt, endedAt: value.endedAt ?? recordedAt ?? value.startedAt,
		error: value.error,
		resumedFrom: value.resumedFrom ? { runId: value.resumedFrom.runId, index: value.resumedFrom.index } : undefined,
		stopRequested: state === "stopped", children,
		results: children.map((child) => ({
			index: child.index, agent: child.agent, task: child.task,
			state: child.state as "completed" | "failed" | "stopped",
			output: child.output ?? "", error: child.error, exitCode: child.state === "completed" ? 0 : 1,
			model: child.model, thinking: child.thinking, sessionFile: child.sessionFile,
			startedAt: child.startedAt ?? value.startedAt, endedAt: child.endedAt ?? value.endedAt ?? value.startedAt,
			attempts: child.attempts ?? 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			reapedAfterSettle: child.reapedAfterSettle,
		})),
	};
}

/** Scan the selected branch only, including pre-checkpoint AIO tool results. */
export function runsFromBranch(entries: readonly unknown[]): RestoredRun[] {
	const restored = new Map<string, RestoredRun>();
	const add = (data: unknown, launches?: unknown, recordedAt?: number) => {
		const run = decodeHistoricalRun(data, recordedAt);
		if (!run) return;
		const previous = restored.get(run.id);
		const parsedLaunches = Array.isArray(launches) ? run.children.map((child, position) => {
			const launch = launches[position];
			if (!Value.Check(LaunchSchema, launch)) return undefined;
			if (launch.task.agent !== child.agent || launch.task.task !== child.task || launch.agent.name !== child.agent || launch.parent.cwd !== run.cwd) return undefined;
			return structuredClone(launch) as ChildLaunchSnapshot;
		}) : previous?.launches;
		restored.set(run.id, { run, launches: parsedLaunches });
	};
	for (const raw of entries) {
		const entry = record(raw);
		if (!entry) continue;
		const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		const recordedAt = Number.isFinite(time) ? time : undefined;
		if (entry.type === "custom" && entry.customType === SUBAGENT_STATE_ENTRY) {
			const data = record(entry.data);
			if (data?.version === 1) add(data.run, data.launches, recordedAt);
		} else if (entry.type === "custom_message" && entry.customType === "aio-subagent-complete") {
			add(entry.details, undefined, recordedAt);
		} else if (entry.type === "message") {
			const message = record(entry.message);
			const details = record(message?.details);
			if (message?.role === "toolResult" && message.toolName === "subagent") {
				if (Array.isArray(details?.runs)) for (const run of details.runs) add(run, undefined, recordedAt);
				add(details?.run, undefined, recordedAt);
			} else if (message?.role === "custom" && message.customType === "aio-subagent-complete") {
				add(message.details, undefined, recordedAt);
			}
		}
	}
	// A continuation claims its ancestor even if a crash prevented its final
	// checkpoint. Never offer two writers to one preserved child session.
	for (const { run } of restored.values()) {
		if (!run.resumedFrom) continue;
		const from = run.resumedFrom;
		const source = restored.get(from.runId);
		const position = source?.run.children.findIndex((child) => child.index === from.index) ?? -1;
		const launch = source?.launches?.[position];
		if (launch) launch.resumed = true;
	}
	return [...restored.values()].sort((a, b) => b.run.startedAt - a.run.startedAt).slice(0, 50);
}
