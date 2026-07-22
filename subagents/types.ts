import type { ChildProcessWithoutNullStreams } from "node:child_process";

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

export interface ChildRunResult {
	index: number;
	agent: string;
	task: string;
	state: Exclude<SubagentRunState, "queued">;
	output: string;
	error?: string;
	exitCode: number;
	model?: string;
	sessionFile?: string;
	startedAt: number;
	endedAt: number;
	usage: ChildUsage;
}

export interface ChildRunStatus {
	index: number;
	agent: string;
	task: string;
	state: SubagentRunState;
	model?: string;
	startedAt?: number;
	endedAt?: number;
	output?: string;
	error?: string;
	sessionFile?: string;
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
}

export interface ParentLaunchContext {
	cwd: string;
	model?: string;
	thinking?: SubagentThinking;
	permissionMode: "default" | "ask" | "plan" | "auto";
	parentSessionFile?: string;
	extensionPath?: string;
}

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionDir: string;
	requestedSessionFile?: string;
}
