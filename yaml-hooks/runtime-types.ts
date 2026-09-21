// Shared runtime types. Kept separate so dispatch.ts and actions.ts can
// import them without a circular runtime.ts dependency.

import type { AsyncLocalStorage } from "node:async_hooks";
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js";
import type { FileChange } from "./types.js";
import type { PathMatchContext } from "./path-filter.js";

export interface SynchronousBashBudget {
	readonly deadline: number;
	readonly now: () => number;
}

export interface RuntimeActionContext {
	readonly prompt?: string;
	readonly files?: readonly string[];
	readonly changes?: readonly FileChange[];
	readonly toolName?: string;
	readonly toolArgs?: Record<string, unknown>;
	readonly sourceSessionID?: string;
	readonly targetSessionID?: string;
	readonly pathMatchContext?: PathMatchContext;
	readonly synchronousBashBudget?: SynchronousBashBudget;
}

export interface HookExecutionResult {
	readonly blocked: boolean;
	readonly blockReason?: string;
	readonly stopSession?: boolean;
	readonly additionalContext?: readonly string[];
}

export interface HookMatchDecision {
	readonly matched: boolean;
	readonly reason: string;
	readonly changedPaths: readonly string[];
	readonly details?: Record<string, unknown>;
}

export type ExecuteBashHook = (request: BashExecutionRequest) => Promise<BashHookResult>;

export type ActionRecursionGuards = AsyncLocalStorage<Set<string>>;

export const MAX_PROMPT_CONTEXT_BYTES = 64 * 1024;

export interface UserPromptSubmitInput {
	readonly sessionID: string;
	readonly prompt: string;
}

export interface UserPromptSubmitOutput {
	readonly additionalContext: readonly string[];
}

export interface ToolExecuteBeforeInput {
	readonly tool: string;
	readonly sessionID?: string;
	readonly callID: string;
}

export interface ToolExecuteBeforeOutput {
	readonly args?: Record<string, unknown>;
}

export interface ToolExecuteAfterInput {
	readonly tool: string;
	readonly sessionID?: string;
	readonly callID: string;
	readonly args?: Record<string, unknown>;
}

export interface RuntimeEventEnvelope {
	readonly event: {
		readonly type: string;
		readonly properties?: Record<string, unknown>;
	};
}

/**
 * Host-facing runtime surface. Each entry point is called by the Pi adapter
 * from the corresponding SDK event handler.
 */
export interface HooksRuntimeSpec {
	readonly "user.prompt.submit": (input: UserPromptSubmitInput) => Promise<UserPromptSubmitOutput>;
	readonly "tool.execute.before": (
		input: ToolExecuteBeforeInput,
		output: ToolExecuteBeforeOutput,
	) => Promise<void>;
	readonly "tool.execute.after": (input: ToolExecuteAfterInput) => Promise<void>;
	readonly "user.bash.before": (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>;
	readonly event: (envelope: RuntimeEventEnvelope) => Promise<void>;
}
