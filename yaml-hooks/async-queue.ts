// Async hook queues: hooks declared `async` run on a per-(event|group)+session
// lane respecting a concurrency limit, with pending caps and an optional
// slow-run watchdog. Ported from pi-yaml-hooks (MIT).

import type { HookConfig } from "./types.js";
import { ENV } from "./env.js";

export interface AsyncQueueState {
	activeCount: number;
	pending: Array<() => Promise<void>>;
}

export interface AsyncQueueWarning {
	readonly reason: "pending_limit" | "watchdog_timeout";
	readonly queueKey: string;
	readonly pendingCount: number;
	readonly activeCount: number;
	readonly limit?: number;
	readonly timeoutMs?: number;
}

export interface AsyncQueueOptions {
	readonly onWarning?: (warning: AsyncQueueWarning) => void;
}

export function resolveAsyncExecutionConfig(
	hook: HookConfig,
	sessionID: string,
): { queueKey: string; concurrency: number } {
	if (hook.async === true || hook.async === undefined) {
		return { queueKey: `${hook.event}:${sessionID}`, concurrency: 1 };
	}

	const group = hook.async.group?.trim();
	return {
		queueKey: group ? `${sessionID}:${group}` : `${hook.event}:${sessionID}`,
		concurrency: hook.async.concurrency ?? 1,
	};
}

export function enqueueAsyncHook(
	asyncQueues: Map<string, AsyncQueueState>,
	config: { queueKey: string; concurrency: number },
	run: () => Promise<void>,
	onError: (error: unknown) => void,
	options: AsyncQueueOptions = {},
): void {
	const state = asyncQueues.get(config.queueKey) ?? { activeCount: 0, pending: [] };
	asyncQueues.set(config.queueKey, state);
	const maxPending = ENV.maxAsyncPending();
	const watchdogMs = ENV.asyncWatchdogMs();

	if (state.pending.length >= maxPending) {
		options.onWarning?.({
			reason: "pending_limit",
			queueKey: config.queueKey,
			pendingCount: state.pending.length,
			activeCount: state.activeCount,
			limit: maxPending,
		});
		return;
	}

	const startNext = (): void => {
		while (state.activeCount < config.concurrency && state.pending.length > 0) {
			const next = state.pending.shift();
			if (!next) {
				continue;
			}

			state.activeCount += 1;
			// `Promise.resolve().then(next)` converts a synchronous throw from
			// `next()` into a rejected promise so .catch/.finally always run
			// and the queue cannot wedge on a sync throw.
			let watchdog: NodeJS.Timeout | undefined;
			if (watchdogMs) {
				watchdog = setTimeout(() => {
					options.onWarning?.({
						reason: "watchdog_timeout",
						queueKey: config.queueKey,
						pendingCount: state.pending.length,
						activeCount: state.activeCount,
						timeoutMs: watchdogMs,
					});
				}, watchdogMs);
			}

			void Promise.resolve()
				.then(next)
				.catch(onError)
				.finally(() => {
					if (watchdog) clearTimeout(watchdog);
					state.activeCount -= 1;
					if (state.activeCount === 0 && state.pending.length === 0) {
						asyncQueues.delete(config.queueKey);
						return;
					}
					startNext();
				});
		}
	};

	state.pending.push(run);
	startNext();
}
