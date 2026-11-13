import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChildExtensionLaunch } from "./extensions.js";
import type { ChildTranscript } from "./transcript.js";

export type SubagentContext = "fresh" | "fork";
/**
 * `none`: the child works in the parent's checkout. `worktree`: the child
 * works in its own git worktree seeded with the parent's current working
 * tree; its changes return as a patch that is applied after the run.
 */
export type SubagentIsolation = "none" | "worktree";
/** A JSON Schema object that a child's typed result must match. */
export type ResultSchema = Record<string, unknown>;
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
	/** Per-task typed result schema; overrides the run-wide outputSchema. */
	outputSchema?: ResultSchema;
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
	isolation?: SubagentIsolation;
	/** Run-wide typed result schema (JSON Schema object). */
	outputSchema?: ResultSchema;
	/**
	 * Worktree isolation only: apply each completed child's patch to the
	 * parent checkout after the run (default true). False keeps the patches.
	 */
	applyChanges?: boolean;
}

/** One changed path in a child's worktree patch (null counts: binary). */
export interface WorkspaceFileChange {
	path: string;
	added: number | null;
	deleted: number | null;
}

/**
 * `active`: the child is still working in its worktree. `pending`: patch captured, merge not done yet. `applied`: patch applied to
 * the parent checkout. `kept`: patch saved but deliberately not applied.
 * `conflict`: the patch no longer applies to the parent checkout. `empty`:
 * no changes. `error`: the workspace could not be prepared or captured.
 */
export type WorkspaceState =
	| "active"
	| "pending"
	| "applied"
	| "kept"
	| "conflict"
	| "empty"
	| "error";

/** JSON-safe summary of a worktree child's changes. */
export interface ChildWorkspaceResult {
	isolation: "worktree";
	state: WorkspaceState;
	files: WorkspaceFileChange[];
	/** Saved unified diff (git apply format), relative to the repository root. */
	patchFile?: string;
	/** Repository root the patch applies to. */
	repoRoot?: string;
	/**
	 * Where the (now removed) worktree was. The child session stores this as
	 * its cwd, so a manual resume recreates the worktree at the same path.
	 */
	worktreePath?: string;
	message?: string;
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
	/** Validated typed result (only when an outputSchema applied). */
	result?: unknown;
	workspace?: ChildWorkspaceResult;
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
	/** Validated typed result (only when an outputSchema applied). */
	result?: unknown;
	workspace?: ChildWorkspaceResult;
	process?: ChildProcessWithoutNullStreams;
}

export interface SubagentRun {
	id: string;
	state: SubagentRunState;
	mode: "single" | "parallel";
	context: SubagentContext;
	isolation?: SubagentIsolation;
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
	 * The parent's project trust decision. A worktree child runs in another
	 * directory, so the runner passes this decision on explicitly.
	 */
	projectTrusted?: boolean;
	/** yaml-hooks project trust for the parent cwd (keyed by worktree root). */
	projectHooksTrusted?: boolean;
	/**
	 * The parent's resolved extension set (see resolveChildExtensionLaunch).
	 * There is no opt-out: the runner always normalizes this so a child can
	 * never start with fewer extensions than its parent.
	 */
	extensionLaunch?: ChildExtensionLaunch;
	modelProvider?: string;
}

/** Durable private launch data, stored outside model context for recovery. */
export interface ChildLaunchSnapshot {
	task: SubagentTask;
	request: Pick<
		SubagentRunRequest,
		"context" | "timeoutMs" | "isolation" | "applyChanges"
	>;
	agent: AgentConfig;
	parent: ParentLaunchContext;
	resumed: boolean;
	/** Runner-owned directory, used to find a fork interrupted before exit. */
	sessionDir?: string;
	/** Conservatively refuse competing resumes while this process is alive. */
	pid?: number;
}

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionDir: string;
	requestedSessionFile?: string;
}
