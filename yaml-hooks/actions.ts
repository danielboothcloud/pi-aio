// Action execution: bash, tool (follow-up prompt), notify, confirm,
// setStatus. `command:` entries are rejected at load time and never reach
// the runtime. Only confirm (and blocking bash on tool.before.*) can surface
// blocked results; other handlers swallow errors so one misconfigured action
// cannot wedge the dispatch loop. Ported from pi-yaml-hooks (MIT).

import type { BashHookResult } from "./bash-types.js";
import type {
	ExecuteBashHook,
	HookExecutionResult,
	RuntimeActionContext,
} from "./runtime-types.js";
import type { HookAction, HookEvent, HookRunIn, HostAdapter, HostDeliveryResult } from "./types.js";
import type { SessionStateStore } from "./session-state.js";
import { sanitizeToolArgsForSerialization } from "./session-state.js";
import { withActionRecursionGuard, type ActionRecursionGuards } from "./recursion-guard.js";

export interface ActionContext {
	readonly action: HookAction;
	readonly runIn: HookRunIn;
	readonly host: HostAdapter;
	readonly projectDir: string;
	readonly state: SessionStateStore;
	readonly runBashHook: ExecuteBashHook;
	readonly event: HookEvent;
	readonly sessionID: string;
	readonly context: RuntimeActionContext;
	readonly sourceFilePath: string;
	readonly hookId: string;
	readonly actionRecursionGuards: ActionRecursionGuards;
}

export async function executeAction(input: ActionContext): Promise<HookExecutionResult> {
	const { action } = input;

	if ("bash" in action) {
		return executeBashAction(input);
	}
	if ("tool" in action) {
		return executeToolAction(input);
	}
	if ("notify" in action) {
		return executeNotifyAction(input);
	}
	if ("confirm" in action) {
		return executeConfirmAction(input);
	}
	if ("setStatus" in action) {
		return executeSetStatusAction(input);
	}
	return { blocked: false };
}

function resolveRemainingBudget(context: RuntimeActionContext): number | undefined {
	const budget = context.synchronousBashBudget;
	if (!budget) {
		return undefined;
	}
	return Math.max(0, budget.deadline - budget.now());
}

async function executeBashAction(input: ActionContext): Promise<HookExecutionResult> {
	const { action, runBashHook, event, sessionID, context } = input;
	if (!("bash" in action)) {
		return { blocked: false };
	}

	const config = typeof action.bash === "string" ? { command: action.bash } : action.bash;
	const requestedTimeout = config.timeout ?? 60_000;
	const remainingBudget = context.synchronousBashBudget
		? Math.max(1, context.synchronousBashBudget.deadline - context.synchronousBashBudget.now())
		: undefined;
	const timeout = remainingBudget === undefined ? requestedTimeout : Math.min(requestedTimeout, remainingBudget);

	const result: BashHookResult = await runBashHook({
		command: config.command,
		timeout,
		projectDir: input.projectDir,
		context: {
			session_id: sessionID,
			event,
			cwd: input.projectDir,
			...(context.prompt === undefined ? {} : { prompt: context.prompt }),
			files: context.files,
			changes: context.changes,
			tool_name: context.toolName,
			tool_args: sanitizeToolArgsForSerialization(context.toolArgs),
		},
	});

	logBashActionOutcome(result, input, timeout);

	if (event === "user.prompt.submit") {
		const additionalContext = result.stdout.trim();
		const outputUsable = !result.outputTruncated && !result.stdinTruncated;
		if (result.status === "success" && outputUsable && additionalContext.length > 0) {
			return { blocked: false, additionalContext: [additionalContext] };
		}
		if (result.outputTruncated || result.stdinTruncated) {
			logDiscardedPromptOutput(input, result);
		}
		return { blocked: false };
	}

	if (result.blocking) {
		return {
			blocked: true,
			blockReason: redactSensitiveContent(result.stderr.trim()) || "Blocked by hook",
		};
	}
	return { blocked: false };
}

function executeToolAction(input: ActionContext): Promise<HookExecutionResult> {
	const { action, runIn, host, state, event, sessionID, hookId, actionRecursionGuards } = input;
	if (!("tool" in action)) {
		return Promise.resolve({ blocked: false });
	}

	return (async (): Promise<HookExecutionResult> => {
		try {
			const targetSessionID = await resolveActionSessionID(state, host, sessionID, runIn);
			if (!targetSessionID) {
				return { blocked: false };
			}

			const prompt = `Use the ${action.tool.name} tool with these arguments: ${JSON.stringify(action.tool.args ?? {})}`;
			const actionKey = `${event}:${targetSessionID}:tool:${input.sourceFilePath}:${JSON.stringify(action.tool)}`;
			let delivery: HostDeliveryResult = { status: "accepted" };
			await withActionRecursionGuard(actionRecursionGuards, actionKey, async () => {
				delivery = normalizeHostDeliveryResult(await host.sendPrompt(targetSessionID, prompt));
			});

			if (delivery.status === "degraded") {
				getActionLogger().warn("action_result", "Tool action degraded before the follow-up prompt was accepted.", {
					projectDir: input.projectDir,
					event,
					sessionID,
					hookId,
					details: { delivery },
				});
			} else {
				getActionLogger().info("action_result", "Tool action queued a follow-up prompt.", {
					projectDir: input.projectDir,
					event,
					sessionID,
					hookId,
					details: { toolName: action.tool.name, delivery },
				});
			}
		} catch (error) {
			getActionLogger().error("action_result", "Tool action failed.", {
				projectDir: input.projectDir,
				event,
				sessionID,
				hookId,
				details: { error: error instanceof Error ? error.message : String(error) },
			});
		}
		return { blocked: false };
	})();
}

function executeNotifyAction(input: ActionContext): Promise<HookExecutionResult> {
	const { action, host, event, sessionID, hookId } = input;
	if (!("notify" in action)) {
		return Promise.resolve({ blocked: false });
	}

	return (async (): Promise<HookExecutionResult> => {
		try {
			const config = typeof action.notify === "string" ? { text: action.notify } : action.notify;
			const level = config.level ?? "info";
			if (typeof host.notify === "function") {
				const delivery = normalizeHostDeliveryResult(await host.notify(config.text, level));
				if (delivery.status === "degraded") {
					getActionLogger().warn("action_result", "Notification action degraded before the host accepted it.", {
						projectDir: input.projectDir,
						event,
						sessionID,
						hookId,
						details: { text: config.text, level, delivery },
					});
				} else {
					getActionLogger().info("action_result", "Notification action delivered.", {
						projectDir: input.projectDir,
						event,
						sessionID,
						hookId,
						details: { text: config.text, level },
					});
				}
			} else {
				getActionLogger().warn("action_result", "Notification action skipped because host.notify is unavailable.", {
					projectDir: input.projectDir,
					event,
					sessionID,
					hookId,
					details: { text: config.text, level },
				});
			}
		} catch (error) {
			getActionLogger().error("action_result", "Notification action failed.", {
				projectDir: input.projectDir,
				event,
				sessionID,
				hookId,
				details: { error: error instanceof Error ? error.message : String(error) },
			});
		}
		return { blocked: false };
	})();
}

function executeConfirmAction(input: ActionContext): Promise<HookExecutionResult> {
	const { action, host, event, sessionID, hookId, context } = input;
	if (!("confirm" in action)) {
		return Promise.resolve({ blocked: false });
	}

	return (async (): Promise<HookExecutionResult> => {
		const remainingBudget = resolveRemainingBudget(context);
		try {
			if (typeof host.confirm === "function") {
				const approved = remainingBudget === 0
					? false
					: await host.confirm({
							...(action.confirm.title !== undefined ? { title: action.confirm.title } : {}),
							message: action.confirm.message,
							...(remainingBudget === undefined ? {} : { timeout: remainingBudget }),
						});
				if (!approved) {
					return { blocked: true, blockReason: "Blocked by user via confirm action" };
				}
				return { blocked: false };
			}
			getActionLogger().warn("action_result", "Confirmation action skipped because host.confirm is unavailable.", {
				projectDir: input.projectDir,
				event,
				sessionID,
				hookId,
				details: { title: action.confirm.title, message: action.confirm.message },
			});
		} catch (error) {
			getActionLogger().error("action_result", "Confirmation action failed.", {
				projectDir: input.projectDir,
				event,
				sessionID,
				hookId,
				details: { error: error instanceof Error ? error.message : String(error) },
			});
		}
		return { blocked: false };
	})();
}

function executeSetStatusAction(input: ActionContext): Promise<HookExecutionResult> {
	const { action, host, event, sessionID, hookId } = input;
	if (!("setStatus" in action)) {
		return Promise.resolve({ blocked: false });
	}

	return (async (): Promise<HookExecutionResult> => {
		try {
			const config = typeof action.setStatus === "string" ? { text: action.setStatus } : action.setStatus;
			if (typeof host.setStatus === "function") {
				// Status slots are keyed by the stable hook id only, so a hooks
				// file move keeps its slot; hooks without ids are drop-and-recreate.
				const statusHookId = `aio-yaml-hooks:${hookId}`;
				const delivery = normalizeHostDeliveryResult(await host.setStatus(statusHookId, config.text));
				if (delivery.status === "degraded") {
					getActionLogger().warn("action_result", "Status action degraded before the host accepted it.", {
						projectDir: input.projectDir,
						event,
						sessionID,
						hookId,
						details: { statusHookId, text: config.text, delivery },
					});
				} else {
					getActionLogger().info("action_result", "Status action updated the status surface.", {
						projectDir: input.projectDir,
						event,
						sessionID,
						hookId,
						details: { statusHookId, text: config.text },
					});
				}
			} else {
				getActionLogger().warn("action_result", "Status action skipped because host.setStatus is unavailable.", {
					projectDir: input.projectDir,
					event,
					sessionID,
					hookId,
					details: { text: config.text },
				});
			}
		} catch (error) {
			getActionLogger().error("action_result", "Status action failed.", {
				projectDir: input.projectDir,
				event,
				sessionID,
				hookId,
				details: { error: error instanceof Error ? error.message : String(error) },
			});
		}
		return { blocked: false };
	})();
}

export async function resolveActionSessionID(
	state: SessionStateStore,
	host: HostAdapter,
	sessionID: string,
	runIn: HookRunIn,
): Promise<string | undefined> {
	const targetSessionID =
		runIn === "main"
			? await state.getRootSessionID(sessionID, (currentSessionID) => resolveParentSessionID(host, currentSessionID))
			: sessionID;
	return state.isDeleted(targetSessionID) ? undefined : targetSessionID;
}

export async function resolveParentSessionID(host: HostAdapter, sessionID: string): Promise<string | null> {
	// The host only exposes a root-session lookup, so callers that need a
	// parent fall back to "is this already the root?" as best effort.
	try {
		const rootID = await host.getRootSessionId(sessionID);
		return rootID && rootID !== sessionID ? rootID : null;
	} catch {
		return null;
	}
}

function normalizeHostDeliveryResult(delivery: HostDeliveryResult): HostDeliveryResult {
	if (delivery.status === "accepted" || delivery.status === "degraded") {
		return delivery;
	}
	return { status: "accepted" };
}

function logBashActionOutcome(result: BashHookResult, input: ActionContext, timeout: number): void {
	if (result.status !== "failed" && result.status !== "timed_out") {
		return;
	}
	getActionLogger().error("action_result", "Bash action failed.", {
		projectDir: input.projectDir,
		event: input.event,
		sessionID: input.sessionID,
		hookId: input.hookId,
		details: {
			command: input.action.bash,
			timeout,
			status: result.status,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			stderr: redactSensitiveContent(result.stderr.trim()).slice(0, 400),
			stdout: redactSensitiveContent(result.stdout.trim()).slice(0, 400),
		},
	});
}

function logDiscardedPromptOutput(input: ActionContext, result: BashHookResult): void {
	getActionLogger().warn("action_result", "Discarded prompt hook output from a truncated execution.", {
		projectDir: input.projectDir,
		event: input.event,
		sessionID: input.sessionID,
		hookId: input.hookId,
		details: {
			status: result.status,
			outputTruncated: result.outputTruncated ?? false,
			stdinTruncated: result.stdinTruncated ?? false,
		},
	});
}

// Minimal structured logger (see logger.ts); actions never let logging
// failures reach the dispatch loop.
function getActionLogger(): StructuredActionLogger {
	return defaultActionLogger;
}

export interface StructuredActionLogger {
	info(kind: string, message: string, fields?: LogFields): void;
	warn(kind: string, message: string, fields?: LogFields): void;
	error(kind: string, message: string, fields?: LogFields): void;
}

export interface LogFields {
	projectDir?: string;
	event?: string;
	sessionID?: string;
	hookId?: string;
	details?: Record<string, unknown>;
}

function emitStructured(level: "info" | "warn" | "error", kind: string, message: string, fields?: LogFields): void {
	if (!isLoggingEnabled()) {
		return;
	}
	const payload = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		kind,
		message,
		...(fields?.projectDir ? { cwd: fields.projectDir } : {}),
		...(fields?.event ? { event: fields.event } : {}),
		...(fields?.sessionID ? { sessionId: fields.sessionID } : {}),
		...(fields?.hookId ? { hookId: fields.hookId } : {}),
		...(fields?.details ? { details: redactSensitiveContent(JSON.stringify(fields.details)) } : {}),
	});
	// eslint-disable-next-line no-console
	console.info(`[aio-yaml-hooks:${level}] ${payload}`);
}

const defaultActionLogger: StructuredActionLogger = {
	info: (kind, message, fields) => emitStructured("info", kind, message, fields),
	warn: (kind, message, fields) => emitStructured("warn", kind, message, fields),
	error: (kind, message, fields) => emitStructured("error", kind, message, fields),
};

function isLoggingEnabled(): boolean {
	return (
		process.env.PI_YAML_HOOKS_DEBUG === "1" ||
		process.env.PI_YAML_HOOKS_LOG_LEVEL !== undefined ||
		process.env.PI_YAML_HOOKS_LOG_STDERR === "1"
	);
}

/** Redact obvious secrets from free-text log/detail fields. */
const REDACTED = "[REDACTED]";

export function redactSensitiveContent(value: string): string {
	return value
		.replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, REDACTED)
		.replace(/\bgh[opusr]_[A-Za-z0-9]{20,255}\b/g, REDACTED)
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, REDACTED)
		.replace(/\bglpat-[A-Za-z0-9_-]{20,255}\b/g, REDACTED)
		.replace(/\bxox[bpars]-[A-Za-z0-9-]{10,255}\b/g, REDACTED)
		.replace(
			/\b((?:https?|ftp|ssh|git|mongodb|postgres(?:ql)?|mysql|redis|amqp):\/\/)([^\s:/@]+):([^\s/@]+)@/gi,
			`$1$2:${REDACTED}@`,
		)
		.replace(/\b(authorization\s*:\s*bearer\s+)([^\s]+)/gi, `$1${REDACTED}`)
		.replace(
			/(\b(?:api[-_ ]?key|token|secret|password|passwd|pwd)\b[^\S\r\n]*[:=][^\S\r\n]*)([^\s,"'}\]`]+)/gi,
			`$1${REDACTED}`,
		)
		.replace(
			/\b([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD))(\s*[:=]\s*)("?)([^\s,"'}\]`]+)\3/g,
			(_match, name: string, sep: string, quote: string) => `${name}${sep}${quote}${REDACTED}${quote}`,
		)
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);
}
