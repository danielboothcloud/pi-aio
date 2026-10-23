import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChildExtensionLaunch } from "./extensions.js";
import type { ChildTranscript } from "./transcript.js";

export type SubagentContext = "fresh" | "fork";
export type SubagentThinking =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	tools?: string[];
	model?: string;
	thinking?: SubagentThinking;
	timeoutMs?: number;
	source: "builtin" | "user" | "project";
	filePath: string;
}

export interface SubagentTask {
	agent: string;
	task: string;
	model?: string;
	thinking?: SubagentThinking;
}

export interface SubagentRunRequest {
	agent?: string;
	task?: string;
	tasks?: SubagentTask[];
	context?: SubagentContext;
	async?: boolean;
	concurrency?: number;
	model?: string;
	thinking?: SubagentThinking;
	timeoutMs?: number;
}

type SubagentRunState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "stopped";

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** A tool the child is executing right now (from tool_execution_* events). */
export interface RunningTool {
	id: string;
	name: string;
	summary: string;
	startedAt: number;
}

export type ChildActivityPhase =
	| "starting"
	| "waiting"
	| "thinking"
	| "writing"
	| "tool"
	| "retrying"
	| "compacting"
	| "finishing";

/** Live progress derived from the child's JSON event stream. JSON-safe. */
export interface ChildActivity {
	phase: ChildActivityPhase;
	/** Wall-clock time of the last event of any kind from the child. */
	lastEventAt: number;
	turns: number;
	toolCount: number;
	runningTools: RunningTool[];
	retry?: { attempt: number; maxAttempts: number; error?: string };
	/** Set when the child reported agent_settled (it will not continue). */
	settledAt?: number;
}

export interface ChildRunResult {
	index: number;
	agent: string;
	task: string;
	state: Exclude<SubagentRunState, "queued">;
	output: string;
	error?: string;
	exitCode: number;
	model?: string;
	thinking?: SubagentThinking;
	sessionFile?: string;
	startedAt: number;
	endedAt: number;
	usage: ChildUsage;
	attempts: number;
	/**
	 * The child finished (agent_settled) but its process did not exit on its
	 * own, so the runner terminated it. Usually an extension left a live
	 * handle in the headless child.
	 */
	reapedAfterSettle?: boolean;
}

export interface ChildRunStatus {
	index: number;
	agent: string;
	task: string;
	state: SubagentRunState;
	model?: string;
	/** Resolved launch effort, independent of the parent's current setting. */
	thinking?: SubagentThinking;
	startedAt?: number;
	endedAt?: number;
	output?: string;
	error?: string;
	sessionFile?: string;
	attempts?: number;
	activity?: ChildActivity;
	/**
	 * Bounded live transcript for the inspector overlay. In-memory only: never
	 * published in tool details or model context; discarded for older runs.
	 */
	transcript?: ChildTranscript;
	reapedAfterSettle?: boolean;
	process?: ChildProcessWithoutNullStreams;
}

export interface SubagentRun {
	id: string;
	state: SubagentRunState;
	mode: "single" | "parallel";
	context: SubagentContext;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	children: ChildRunStatus[];
	results: ChildRunResult[];
	error?: string;
	stopRequested: boolean;
	/** Manual continuation; the original run/result stays unchanged. */
	resumedFrom?: { runId: string; index: number };
}

export interface ParentLaunchContext {
	cwd: string;
	model?: string;
	thinking?: SubagentThinking;
	parentSessionFile?: string;
	/**
	 * The parent's resolved extension set (see resolveChildExtensionLaunch).
	 * There is no opt-out: the runner always normalizes this so a child can
	 * never start with fewer extensions than its parent.
	 */
	extensionLaunch?: ChildExtensionLaunch;
	modelProvider?: string;
}

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionDir: string;
	requestedSessionFile?: string;
}
