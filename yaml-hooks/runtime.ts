// Hooks runtime: the dispatch entry points the host adapter calls. Owns
// session state, dispatch/async-queue lifetime, and prompt-context budgets.
// Ported from pi-yaml-hooks (MIT).

import { AsyncLocalStorage } from "node:async_hooks";
import type { AsyncLocalStorage as AsyncLocalStorageType } from "node:async_hooks";
import { executeBashHook } from "./bash-executor.js";
import type { AsyncQueueState } from "./async-queue.js";
import {
	dispatchHooks,
	dispatchToolHooks,
	type DispatchState,
	type DispatchDependencies,
} from "./dispatch.js";
import { SessionStateStore } from "./session-state.js";
import { getChangedPaths, getToolFileChanges } from "./tool-paths.js";
import { loadDiscoveredHooks, type HookLoadOptions } from "./discovery.js";
import type {
	ActionRecursionGuards,
	ExecuteBashHook,
	HooksRuntimeSpec,
	RuntimeActionContext,
	RuntimeEventEnvelope,
	ToolExecuteAfterInput,
	ToolExecuteBeforeInput,
	ToolExecuteBeforeOutput,
	UserPromptSubmitInput,
	UserPromptSubmitOutput,
} from "./runtime-types.js";

const MAX_PROMPT_CONTEXT_BYTES = 64 * 1024;

export interface CreateHooksRuntimeOptions extends HookLoadOptions {
	/** Host adapter wired by the Pi integration layer. */
	readonly host: import("./types.js").HostAdapter;
	/** Per-turn budget for synchronous bash hooks (prompt context). */
	readonly synchronousBashBudgetMs?: number;
	readonly now?: () => number;
	readonly executeBash?: ExecuteBashHook;
}

export type HooksRuntime = HooksRuntimeSpec;

export function createHooksRuntime(options: CreateHooksRuntimeOptions): HooksRuntime {
	if (!options.projectDir) {
		throw new Error("createHooksRuntime requires a project directory");
	}

	const now = options.now ?? Date.now;
	const createSynchronousBashBudget = (): RuntimeActionContext["synchronousBashBudget"] | undefined =>
		options.synchronousBashBudgetMs === undefined
			? undefined
			: { deadline: now() + options.synchronousBashBudgetMs, now };

	const state = new SessionStateStore();
	const runBashHook: ExecuteBashHook = options.executeBash ?? ((request) => executeBashHook(request));
	const dispatchStates = new Map<string, DispatchState>();
	const asyncQueues = new Map<string, AsyncQueueState>();
	const actionRecursionGuards = new AsyncLocalStorage<Set<string>>() as AsyncLocalStorageType<Set<string>> & ActionRecursionGuards;
	const warnedAsyncStopSources = new Set<string>();

	const deps: DispatchDependencies = {
		state,
		host: options.host,
		projectDir: options.projectDir,
		runBashHook,
		dispatchStates,
		actionRecursionGuards,
		asyncQueues,
		warnedAsyncStopSources,
	};

	return {
		"user.prompt.submit": async (input: UserPromptSubmitInput): Promise<UserPromptSubmitOutput> => {
			const synchronousBashBudget = createSynchronousBashBudget();
			const discovery = loadDiscoveredHooks(options);
			const result = await dispatchHooks(
				discovery.hooks,
				deps,
				"user.prompt.submit",
				input.sessionID,
				{ prompt: input.prompt, synchronousBashBudget },
				{ canBlock: false },
			);
			return {
				additionalContext: enforcePromptContextBudget(result.additionalContext ?? []),
			};
		},

		"tool.execute.before": async (
			eventInput: ToolExecuteBeforeInput,
			eventOutput: ToolExecuteBeforeOutput,
		): Promise<void> => {
			const sessionID = eventInput.sessionID;
			if (!sessionID) {
				return;
			}
			const synchronousBashBudget = createSynchronousBashBudget();
			const discovery = loadDiscoveredHooks(options);
			const toolArgs = eventOutput.args ?? {};
			state.setPendingToolCall(eventInput.callID, sessionID, toolArgs);

			const result = await dispatchToolHooks(discovery.hooks, deps, "before", eventInput.tool, sessionID, {
				toolName: eventInput.tool,
				toolArgs,
				synchronousBashBudget,
			});

			if (result.blocked) {
				state.consumePendingToolCall(eventInput.callID);
				if (result.stopSession) {
					await hostAbort(options.host, sessionID);
				}
				throw new Error(result.blockReason ?? "Blocked by hook");
			}
		},

		"tool.execute.after": async (eventInput: ToolExecuteAfterInput): Promise<void> => {
			const sessionID = eventInput.sessionID;
			if (!sessionID) {
				return;
			}
			const synchronousBashBudget = createSynchronousBashBudget();
			const discovery = loadDiscoveredHooks(options);
			const pending = state.consumePendingToolCall(eventInput.callID);
			const toolArgs = resolveToolArgs(eventInput.args, pending?.toolArgs);
			const changes = getToolFileChanges(eventInput.tool, toolArgs);
			const files = changes.length > 0 ? getChangedPaths(changes) : undefined;

			// Collect mutations for the next session.idle dispatch, then run
			// file.changed and post-tool hooks.
			state.addFileChanges(sessionID, changes);

			if (changes.length > 0) {
				await dispatchHooks(discovery.hooks, deps, "file.changed", sessionID, {
					files,
					changes,
					toolName: eventInput.tool,
					toolArgs,
					synchronousBashBudget,
				});
			}

			await dispatchToolHooks(discovery.hooks, deps, "after", eventInput.tool, sessionID, {
				files,
				changes,
				toolName: eventInput.tool,
				toolArgs,
				synchronousBashBudget,
			});
		},

		"user.bash.before": async (
			eventInput: ToolExecuteBeforeInput,
			eventOutput: ToolExecuteBeforeOutput,
		): Promise<void> => {
			const sessionID = eventInput.sessionID;
			if (!sessionID) {
				return;
			}
			const synchronousBashBudget = createSynchronousBashBudget();
			const discovery = loadDiscoveredHooks(options);
			const result = await dispatchToolHooks(discovery.hooks, deps, "before", eventInput.tool, sessionID, {
				toolName: eventInput.tool,
				toolArgs: eventOutput.args ?? {},
				synchronousBashBudget,
			});

			if (result.blocked) {
				if (result.stopSession) {
					await hostAbort(options.host, sessionID);
				}
				throw new Error(result.blockReason ?? "Blocked by hook");
			}
		},

		event: async (envelope: RuntimeEventEnvelope): Promise<void> => {
			const synchronousBashBudget = createSynchronousBashBudget();
			const discovery = loadDiscoveredHooks(options);
			const properties = envelope.event.properties ?? {};

			if (envelope.event.type === "session.created") {
				const sessionID = pickString(asRecord(properties.info)?.id);
				if (!sessionID) {
					return;
				}
				state.rememberSession(sessionID);
				await dispatchHooks(discovery.hooks, deps, "session.created", sessionID, { synchronousBashBudget });
				return;
			}

			if (envelope.event.type === "session.deleted") {
				const sessionID = pickString(asRecord(properties.info)?.id);
				if (!sessionID) {
					return;
				}
				state.rememberSession(sessionID);
				state.deleteSession(sessionID);
				await dispatchHooks(discovery.hooks, deps, "session.deleted", sessionID, { synchronousBashBudget });
				return;
			}

			if (envelope.event.type === "session.idle") {
				const sessionID = pickString(properties.sessionID);
				if (!sessionID) {
					return;
				}

				const changes = state.getFileChanges(sessionID);
				const files = state.getModifiedPaths(sessionID);
				state.beginIdleDispatch(sessionID, changes);

				try {
					await dispatchHooks(discovery.hooks, deps, "session.idle", sessionID, {
						files,
						changes,
						synchronousBashBudget,
					});
					state.consumeFileChanges(sessionID, changes);
				} catch (error) {
					// Ordinary hook failures consume pending changes so a
					// persistent bad hook cannot loop forever; the error still
					// propagates so the adapter can report it.
					state.consumeFileChanges(sessionID, changes);
					throw error;
				}
			}
		},
	};

	function pickString(value: unknown): string | undefined {
		return typeof value === "string" && value.trim().length > 0 ? value : undefined;
	}

	function asRecord(value: unknown): Record<string, unknown> | undefined {
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	}

	function resolveToolArgs(
		eventArgs: Record<string, unknown> | undefined,
		pendingArgs: Record<string, unknown> | undefined,
	): Record<string, unknown> {
		if (eventArgs && Object.keys(eventArgs).length > 0) {
			return eventArgs;
		}
		return pendingArgs ?? eventArgs ?? {};
	}

	function enforcePromptContextBudget(contributions: readonly string[]): string[] {
		const accepted: string[] = [];
		let usedBytes = 0;
		for (const contribution of contributions) {
			const contributionBytes = Buffer.byteLength(contribution, "utf8");
			if (usedBytes + contributionBytes > MAX_PROMPT_CONTEXT_BYTES) {
				continue;
			}
			accepted.push(contribution);
			usedBytes += contributionBytes;
		}
		return accepted;
	}
}

async function hostAbort(host: import("./types.js").HostAdapter, sessionID: string): Promise<void> {
	await host.abort(sessionID);
}
