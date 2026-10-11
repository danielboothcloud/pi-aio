// aio yaml hooks — Pi extension entry point.
//
// Registers the YAML-driven hooks adapter: hooks.yaml discovery + trust,
// bash/tool/notify/confirm/setStatus actions, /hooks-* commands, prompt
// context injection, and opt-in human-bash interception. Ported from
// pi-yaml-hooks (MIT) — see UPSTREAM.md.

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { registerPiHookPolicy } from "./unsupported.js";
import { registerCommands } from "./commands.js";
import { registerHookDiagnostics } from "./diagnostics.js";
import { registerPromptSupport } from "./prompt-support.js";
import { registerUserBashInterception } from "./user-bash.js";
import { createRuntimeRegistry, type RuntimeRegistry } from "./registry.js";
import { createHostAdapter, safeGetSessionId } from "./host-adapter.js";
import { registerSessionLifecycleHandlers } from "./session-lifecycle.js";
import type { CreateHooksRuntimeOptions } from "./runtime.js";

export type { HooksRuntime } from "./runtime.js";
export type {
	HookAction,
	HookBashAction,
	HookConfirmAction,
	HookConfig,
	HookCondition,
	HookEvent,
	HookNotifyAction,
	HookScope,
	HookSetStatusAction,
	HookToolAction,
	HookValidationError,
	HookValidationErrorCode,
	FileChange,
} from "./types.js";
export type { BashHookContext, BashHookResult, BashExecutionRequest } from "./bash-types.js";

export interface RegisterYamlHooksOptions {
	/** Per-turn budget for synchronous bash hooks (prompt context), ms. */
	readonly synchronousBashBudgetMs?: number;
	/** Extra runtime options (injected seams for tests). */
	readonly runtimeOptions?: Partial<CreateHooksRuntimeOptions>;
}

/**
 * Register the yaml hooks feature on a Pi extension API. Follows the aio
 * registrar convention: takes `pi`, wires its event handlers, returns void.
 */
export default function registerYamlHooks(
	pi: ExtensionAPI,
	options: RegisterYamlHooksOptions = {},
): void {
	registerPiHookPolicy();

	const runtimeRegistry = createRuntimeRegistry(pi, {
		pi,
		runtimeOptions: {
			synchronousBashBudgetMs: options.synchronousBashBudgetMs,
			...options.runtimeOptions,
		},
	});

	registerHookDiagnostics(pi);
	registerCommands(pi);
	registerPromptSupport(pi, runtimeRegistry);

	// The adapter owns host-adapter creation and the SDK event wiring.
	registerAdapter(pi, runtimeRegistry);

	// Opt-in human-bash interception (PI_YAML_HOOKS_ENABLE_USER_BASH=1).
	registerUserBashInterception(pi, { runtimeRegistry });
}

/**
 * SDK event wiring: session lifecycle, tool_call/tool_result dispatch,
 * project_trust passthrough, and adapter registration into the registry.
 */
function registerAdapter(pi: ExtensionAPI, runtimeRegistry: RuntimeRegistry): void {
	// The freshest context per cwd is captured by every handler below and
	// consumed lazily by the host adapter for UI capability checks.
	let lastContext: ExtensionContext | undefined;
	let lastSessionManager: ExtensionContext["sessionManager"] | undefined;

	const remember = (ctx: ExtensionContext): void => {
		lastContext = ctx;
		lastSessionManager = ctx.sessionManager;
		runtimeRegistry.rememberContext(ctx.cwd, ctx);
	};

	const adapter = createHostAdapter(pi, {
		getContext: () => lastContext,
		getSessionManager: () => lastSessionManager,
		projectDir: process.cwd(),
	});
	runtimeRegistry.setHostAdapter(adapter);

	registerSessionLifecycleHandlers(pi, { runtimeRegistry, remember });

	// ---- tool_call: dispatch tool.before hooks; block via first blocking result ----

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		remember(ctx);
		const sessionId = safeGetSessionId(ctx.sessionManager);
		if (!sessionId) {
			return undefined;
		}
		const runtime = runtimeRegistry.getRuntimeFor(ctx.cwd);
		try {
			await runtime["tool.execute.before"](
				{
					tool: event.toolName,
					sessionID: sessionId,
					callID: event.toolCallId,
				},
				{
					args: (event.input ?? {}) as Record<string, unknown>,
				},
			);
			return undefined;
		} catch (error) {
			return {
				block: true,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	});

	// ---- tool_result: dispatch tool.after + file.changed hooks ----

	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		remember(ctx);
		const sessionId = safeGetSessionId(ctx.sessionManager);
		if (!sessionId) {
			return undefined;
		}
		const runtime = runtimeRegistry.getRuntimeFor(ctx.cwd);
		try {
			await runtime["tool.execute.after"]({
				tool: event.toolName,
				sessionID: sessionId,
				callID: event.toolCallId,
				args: (event.input ?? {}) as Record<string, unknown>,
			});
		} catch {
			// Post-tool hook failures are fail-open; the tool already ran.
		}
		return undefined;
	});
}

export { getHookLogFilePath } from "./commands.js";
