// Hook dispatch: bucket lookup, single-flight queueing per
// (event, sessionID), per-hook match decisions (scope + path conditions),
// async hook enqueueing, and the action invocation chain. Ported from
// pi-yaml-hooks (MIT).

import type { AsyncLocalStorage } from "node:async_hooks";
import { enqueueAsyncHook, resolveAsyncExecutionConfig, type AsyncQueueState } from "./async-queue.js";
import { executeAction, resolveParentSessionID } from "./actions.js";
import { withActionRecursionGuard } from "./recursion-guard.js";
import type { ActionRecursionGuards } from "./runtime-types.js";
import { buildPathMatchContext, evaluatePathConditions } from "./path-filter.js";
import type { SessionStateStore } from "./session-state.js";
import { getMutationToolHookNames } from "./tool-paths.js";
import type {
	ExecuteBashHook,
	HookExecutionResult,
	HookMatchDecision,
	RuntimeActionContext,
} from "./runtime-types.js";
import type { FileChange, HookConfig, HookEvent, HookMap, HostAdapter } from "./types.js";

export interface DispatchState {
	active: boolean;
	pending: DispatchRequest[];
}

export interface DispatchRequest {
	readonly context: RuntimeActionContext;
	readonly options: { canBlock?: boolean };
	readonly resolve?: (result: HookExecutionResult) => void;
	readonly reject?: (error: unknown) => void;
	// Snapshot the recursion-guard store at park time so the queued execution
	// re-enters the enqueueing dispatch's guard frame on drain.
	readonly recursionGuardStore?: Set<string>;
}

export interface DispatchDependencies {
	readonly state: SessionStateStore;
	readonly host: HostAdapter;
	readonly projectDir: string;
	readonly runBashHook: ExecuteBashHook;
	readonly dispatchStates: Map<string, DispatchState>;
	readonly actionRecursionGuards: ActionRecursionGuards;
	readonly asyncQueues: Map<string, AsyncQueueState>;
	readonly warnedAsyncStopSources: Set<string>;
}

export function summarizeChanges(changes: readonly FileChange[]): Record<string, unknown> {
	const byOperation = new Map<string, number>();
	for (const change of changes) {
		byOperation.set(change.operation, (byOperation.get(change.operation) ?? 0) + 1);
	}
	return Object.fromEntries(byOperation);
}

export async function dispatchToolHooks(
	hooks: HookMap,
	deps: DispatchDependencies,
	phase: "before" | "after",
	toolName: string,
	sessionID: string,
	context: RuntimeActionContext,
): Promise<HookExecutionResult> {
	const wildcardResult = await dispatchHooks(
		hooks,
		deps,
		`tool.${phase}.*`,
		sessionID,
		context,
		{ canBlock: phase === "before" },
	);
	if (wildcardResult.blocked) {
		return wildcardResult;
	}

	// Tool alias dedup: `patch`/`apply_patch` describe the same logical
	// mutation, so dispatch the union of their hook buckets exactly once
	// under the canonical alias name.
	const mutationNames = getMutationToolHookNames(toolName);
	const resolvedNames = mutationNames.length > 0 ? mutationNames : [toolName];
	if (resolvedNames.length > 1) {
		const unionedHooks = collectUniqueHooksAcrossAliases(hooks, phase, resolvedNames);
		if (unionedHooks.length === 0) {
			return { blocked: false };
		}
		const canonicalEvent = `tool.${phase}.${resolvedNames[resolvedNames.length - 1]}` as HookEvent;
		const aliasMap: HookMap = new Map();
		aliasMap.set(canonicalEvent, unionedHooks);
		return await dispatchHooks(
			aliasMap,
			deps,
			canonicalEvent,
			sessionID,
			context,
			{ canBlock: phase === "before" },
		);
	}

	for (const resolvedToolName of resolvedNames) {
		const result = await dispatchHooks(
			hooks,
			deps,
			`tool.${phase}.${resolvedToolName}`,
			sessionID,
			context,
			{ canBlock: phase === "before" },
		);
		if (result.blocked) {
			return result;
		}
	}

	return { blocked: false };
}

function collectUniqueHooksAcrossAliases(
	hooks: HookMap,
	phase: "before" | "after",
	aliasNames: readonly string[],
): HookConfig[] {
	const seen = new Set<HookConfig>();
	const out: HookConfig[] = [];
	for (const aliasName of aliasNames) {
		const eventKey = `tool.${phase}.${aliasName}` as HookEvent;
		const bucket = hooks.get(eventKey);
		if (!bucket) continue;
		for (const hook of bucket) {
			if (seen.has(hook)) continue;
			seen.add(hook);
			out.push(hook);
		}
	}
	return out;
}

export async function dispatchHooks(
	hooks: HookMap,
	deps: DispatchDependencies,
	event: HookEvent,
	sessionID: string,
	context: RuntimeActionContext = {},
	options: { canBlock?: boolean } = {},
): Promise<HookExecutionResult> {
	const hooksForEvent = hooks.get(event);
	if (!hooksForEvent || hooksForEvent.length === 0) {
		return { blocked: false };
	}

	const dispatchKey = `${event}:${sessionID}`;
	const dispatchState = deps.dispatchStates.get(dispatchKey);
	if (dispatchState?.active) {
		const recursionGuardStore = deps.actionRecursionGuards.getStore();
		if (!options.canBlock) {
			dispatchState.pending.push({ context, options, ...(recursionGuardStore ? { recursionGuardStore } : {}) });
			return { blocked: false };
		}
		return await new Promise<HookExecutionResult>((resolve, reject) => {
			dispatchState.pending.push({
				context,
				options,
				resolve,
				reject,
				...(recursionGuardStore ? { recursionGuardStore } : {}),
			});
		});
	}

	const currentState = dispatchState ?? { active: false, pending: [] };
	currentState.active = true;
	deps.dispatchStates.set(dispatchKey, currentState);

	let currentResult: HookExecutionResult = { blocked: false };
	let currentError: unknown;

	try {
		currentResult = await executeDispatchRequest({ context, options });
	} catch (error) {
		currentError = error;
	}

	if (currentState.pending.length > 0) {
		// Always drain inline so dispatch-state lifetime is well-defined.
		await drainPendingRequests();
	} else {
		currentState.active = false;
		currentState.pending = [];
		deps.dispatchStates.delete(dispatchKey);
	}

	if (currentError !== undefined) {
		throw currentError;
	}
	return currentResult;

	async function executeDispatchRequest(request: DispatchRequest): Promise<HookExecutionResult> {
		const additionalContext: string[] = [];
		for (const hook of hooksForEvent) {
			const result = await executeHook(hook, deps, event, sessionID, prepareRuntimeActionContext(deps.projectDir, request.context), request.options);
			additionalContext.push(...(result.additionalContext ?? []));
			if (result.blocked) {
				return { ...result, ...(additionalContext.length > 0 ? { additionalContext } : {}) };
			}
		}
		return { blocked: false, ...(additionalContext.length > 0 ? { additionalContext } : {}) };
	}

	async function drainPendingRequests(): Promise<void> {
		try {
			while (currentState.pending.length > 0) {
				const request = currentState.pending.shift()!;
				try {
					const result = request.recursionGuardStore
						? await deps.actionRecursionGuards.run(request.recursionGuardStore, () => executeDispatchRequest(request))
						: await executeDispatchRequest(request);
					request.resolve?.(result);
				} catch (error) {
					request.reject?.(error);
				}
			}
		} finally {
			currentState.active = false;
			currentState.pending = [];
			deps.dispatchStates.delete(dispatchKey);
		}
	}
}

async function executeHook(
	hook: HookConfig,
	deps: DispatchDependencies,
	event: HookEvent,
	sessionID: string,
	context: RuntimeActionContext,
	options: { canBlock?: boolean },
): Promise<HookExecutionResult> {
	const hookId = getHookIdentifier(hook);

	let decision: HookMatchDecision;
	try {
		decision = await shouldRunHook(hook, deps, sessionID, context);
	} catch {
		// Match-evaluation failures are fail-open: the hook is skipped and the
		// turn continues (upstream logs via its structured logger; ours is
		// env-gated in actions.ts).
		return { blocked: false };
	}

	if (!decision.matched) {
		return { blocked: false };
	}

	if (hook.async) {
		// Async hooks cannot enforce action: stop (parse-time should reject
		// the combination; warn once per hook source as defence in depth).
		if (hook.action === "stop") {
			warnAsyncStopOnce(hook, deps);
		}
		const asyncConfig = resolveAsyncExecutionConfig(hook, sessionID);
		const { synchronousBashBudget: _synchronousBashBudget, ...asyncContext } = context;
		void _synchronousBashBudget;
		enqueueAsyncHook(
			deps.asyncQueues,
			asyncConfig,
			async () => {
				for (const action of hook.actions) {
					await executeAction({
						action,
						runIn: hook.runIn,
						host: deps.host,
						projectDir: deps.projectDir,
						state: deps.state,
						runBashHook: deps.runBashHook,
						event,
						sessionID,
						context: asyncContext,
						sourceFilePath: hook.source.filePath,
						hookId,
						actionRecursionGuards: deps.actionRecursionGuards,
					});
				}
			},
			() => {},
			{
				onWarning: () => {
					// Bounded queue warnings are surfaced through the action
					// logger's env-gated output; hook authors debug via
					// /hooks-tail-log.
				},
			},
		);
		return { blocked: false };
	}

	const additionalContext: string[] = [];
	for (const action of hook.actions) {
		const result = await executeAction({
			action,
			runIn: hook.runIn,
			host: deps.host,
			projectDir: deps.projectDir,
			state: deps.state,
			runBashHook: deps.runBashHook,
			event,
			sessionID,
			context,
			sourceFilePath: hook.source.filePath,
			hookId,
			actionRecursionGuards: deps.actionRecursionGuards,
		});
		additionalContext.push(...(result.additionalContext ?? []));
		if (result.blocked && options.canBlock) {
			return {
				...result,
				...(hook.action === "stop" ? { stopSession: true } : {}),
				...(additionalContext.length > 0 ? { additionalContext } : {}),
			};
		}
	}

	return { blocked: false, ...(additionalContext.length > 0 ? { additionalContext } : {}) };
}

async function shouldRunHook(
	hook: HookConfig,
	deps: DispatchDependencies,
	sessionID: string,
	context: RuntimeActionContext,
): Promise<HookMatchDecision> {
	const pathMatchContext =
		context.pathMatchContext ??
		buildPathMatchContext(deps.projectDir, context.files, context.changes);
	const changedPaths = pathMatchContext.changedPaths;

	if (!(await deps.state.evaluateScope(sessionID, hook.scope, (currentSessionID) => resolveParentSessionID(deps.host, currentSessionID)))) {
		return {
			matched: false,
			reason: "scope_mismatch",
			changedPaths,
			details: { scope: hook.scope },
		};
	}

	const conditionFailure = evaluatePathConditions(hook.conditions, pathMatchContext);
	if (conditionFailure) {
		return {
			matched: false,
			reason: conditionFailure.reason,
			changedPaths,
			...(conditionFailure.patterns ? { details: { patterns: [...conditionFailure.patterns] } } : {}),
		};
	}

	return { matched: true, reason: "matched", changedPaths };
}

function prepareRuntimeActionContext(projectDir: string, context: RuntimeActionContext): RuntimeActionContext {
	if (context.pathMatchContext) {
		return context;
	}
	return {
		...context,
		pathMatchContext: buildPathMatchContext(projectDir, context.files, context.changes),
	};
}

export function getHookIdentifier(hook: HookConfig): string {
	return hook.id ?? `${hook.source.filePath}#hooks[${hook.source.index}]`;
}

export function formatHookSource(hook: HookConfig): string {
	return `${hook.source.filePath}#hooks[${hook.source.index}]`;
}

function warnAsyncStopOnce(hook: HookConfig, deps: DispatchDependencies): void {
	const sourceKey = formatHookSource(hook);
	if (deps.warnedAsyncStopSources.has(sourceKey)) {
		return;
	}
	deps.warnedAsyncStopSources.add(sourceKey);
	// eslint-disable-next-line no-console
	console.warn(
		`[aio yaml hooks] hook ${sourceKey} declares both async and action: stop; the stop directive is ignored because async hooks cannot block dispatch.`,
	);
}
