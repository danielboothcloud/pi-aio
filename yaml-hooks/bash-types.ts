// Bash hook execution types. Ported from pi-yaml-hooks (MIT).

import type { FileChange } from "./types.js";

export const DEFAULT_BASH_TIMEOUT = 60_000;

export interface BashHookContext {
	readonly session_id: string;
	readonly event: string;
	readonly cwd: string;
	readonly prompt?: string;
	readonly files?: readonly string[];
	readonly changes?: readonly FileChange[];
	readonly tool_name?: string;
	readonly tool_args?: Record<string, unknown>;
}

export interface BashExecutionRequest {
	readonly command: string;
	readonly context: BashHookContext;
	readonly projectDir: string;
	readonly timeout?: number;
}

export interface BashProcessResult {
	readonly command: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly exitCode: number;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	/** True when stdout/stderr exceeded the byte cap and was truncated. */
	readonly outputTruncated?: boolean;
	/** True when the serialized context exceeded the stdin cap. */
	readonly stdinTruncated?: boolean;
}

/** Exit code for a timed-out hook (GNU coreutils `timeout` convention). */
export const TIMEOUT_EXIT_CODE = 124;

export type BashHookResultStatus = "success" | "failed" | "blocked" | "timed_out";

export interface BashHookResult extends BashProcessResult {
	readonly status: BashHookResultStatus;
	readonly blocking: boolean;
}
