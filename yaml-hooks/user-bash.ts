// Opt-in human-bash interception: with PI_YAML_HOOKS_ENABLE_USER_BASH=1,
// every human ! / !! command is routed through tool.before.bash hooks before
// execution. Off by default; emits a one-time trust warning on startup and a
// UI warning on the first intercepted command. Ported from pi-yaml-hooks (MIT).

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, UserBashEvent, UserBashEventResult } from "@earendil-works/pi-coding-agent";
import type { HooksRuntime } from "./runtime.js";
import type { RuntimeRegistry } from "./registry.js";
import { safeGetSessionId } from "./host-adapter.js";
import { trustedProjectsFilePath } from "./paths.js";
import { isEnvEnabled } from "./env.js";

const ENABLE_USER_BASH_ENV = "PI_YAML_HOOKS_ENABLE_USER_BASH";

// One-time warning tracking: per process on startup, per cwd in the UI.
let userBashWarningEmitted = false;
const userBashUiWarningCwds = new Set<string>();

function emitUserBashWarningOnce(): void {
	if (userBashWarningEmitted) return;
	userBashWarningEmitted = true;

	const trustedProjects = readTrustedProjectsList();
	const projectList =
		trustedProjects.length > 0
			? trustedProjects.map((p) => `  - ${p}`).join("\n")
			: "  (no projects currently in trusted-projects.json)";

	process.stderr.write(
		`[aio yaml hooks] WARNING: PI_YAML_HOOKS_ENABLE_USER_BASH=1 is set.\n` +
			`  Every human "!" / "!!" shell command typed in Pi will be routed through\n` +
			`  tool.before.bash hooks before execution. Hooks in trusted projects can:\n` +
			`    - observe the full command text\n` +
			`    - block the command (exit code 2)\n` +
			`    - read tool_args from stdin JSON to exfiltrate command content via bash actions\n` +
			`  Trusted projects whose hooks will see your typed commands:\n` +
			`${projectList}\n` +
			`  Only enable this feature if you trust all hooks in the listed projects.\n`,
	);
}

export function readTrustedProjectsList(): string[] {
	try {
		const trustFile = trustedProjectsFilePath();
		if (!existsSync(trustFile)) return [];
		const parsed: unknown = JSON.parse(readFileSync(trustFile, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

/** Test-only reset for warning state. */
export function resetUserBashWarningForTests(): void {
	userBashWarningEmitted = false;
	userBashUiWarningCwds.clear();
}

function cancelledInternalErrorResult(message: string): UserBashEventResult {
	return {
		result: {
			output: `[aio yaml hooks] internal error during user_bash interception: ${message}`,
			exitCode: undefined,
			cancelled: true,
			truncated: false,
		},
	};
}

function emitUserBashUiWarningOnce(ctx: ExtensionContext): void {
	if (!ctx.hasUI || userBashUiWarningCwds.has(ctx.cwd)) return;
	userBashUiWarningCwds.add(ctx.cwd);
	ctx.ui.notify(
		"PI_YAML_HOOKS_ENABLE_USER_BASH=1 is routing typed shell commands through trusted project hooks for this session.",
		"warning",
	);
}

export function registerUserBashInterception(
	pi: ExtensionAPI,
	options: {
		runtimeRegistry: RuntimeRegistry;
	},
): void {
	if (isEnvEnabled(ENABLE_USER_BASH_ENV)) {
		emitUserBashWarningOnce();
	}

	pi.on("user_bash", async (event: UserBashEvent, ctx: ExtensionContext): Promise<UserBashEventResult | void> => {
		if (!isEnvEnabled(ENABLE_USER_BASH_ENV)) {
			return;
		}

		// Fail closed on any internal error: a missing interception must never
		// silently let the typed command run unchecked.
		try {
			emitUserBashUiWarningOnce(ctx);
			options.runtimeRegistry.rememberContext(ctx.cwd, ctx);

			const sessionId = safeGetSessionId(ctx.sessionManager);
			if (!sessionId) {
				return cancelledInternalErrorResult("missing_session_id");
			}

			const runtime: HooksRuntime = options.runtimeRegistry.getRuntimeFor(ctx.cwd);
			try {
				await runtime["user.bash.before"](
					{
						tool: "bash",
						sessionID: sessionId,
						callID: `user-bash:${sessionId}:${generateCallId()}`,
					},
					{
						args: { command: event.command },
					},
				);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					result: {
						output: `[aio yaml hooks] user_bash blocked: ${message}`,
						exitCode: undefined,
						cancelled: true,
						truncated: false,
					},
				};
			}
		} catch (error) {
			return cancelledInternalErrorResult(error instanceof Error ? error.message : String(error));
		}
	});
}

// Monotonic fallback counter when crypto.randomUUID is unavailable.
let monotonicCounter = 0;

function generateCallId(): string {
	try {
		return globalThis.crypto.randomUUID();
	} catch {
		return `fallback-${Date.now()}-${(monotonicCounter += 1)}`;
	}
}
