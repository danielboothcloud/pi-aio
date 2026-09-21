// ---------------------------------------------------------------------------
// Core hook types shared by the loader, runtime, and Pi adapter.
// Ported from pi-yaml-hooks (MIT) — see yaml-hooks/UPSTREAM.md. The YAML
// contract is unchanged; OMP-only surfaces were dropped.
// ---------------------------------------------------------------------------

export const SESSION_HOOK_EVENTS = [
	"session.idle",
	"session.created",
	"session.deleted",
	"file.changed",
] as const;
export const PROMPT_HOOK_EVENTS = ["user.prompt.submit"] as const;

/** Opaque string forwarded with session.deleted envelopes (e.g. "quit", "new", "resume"). */
export type SessionDeletedReason = string;

export const LEGACY_HOOK_CONDITIONS = ["matchesCodeFiles"] as const;
export const PATH_HOOK_CONDITION_KEYS = ["matchesAnyPath", "matchesAllPaths"] as const;
export const HOOK_SCOPES = ["all", "main", "child"] as const;
export const HOOK_RUN_IN = ["current", "main"] as const;
export const HOOK_BEHAVIORS = ["stop"] as const;

export type SessionHookEvent = (typeof SESSION_HOOK_EVENTS)[number];
export type PromptHookEvent = (typeof PROMPT_HOOK_EVENTS)[number];
export type ToolHookPhase = "before" | "after";
export type ToolHookEvent = `tool.${ToolHookPhase}.*` | `tool.${ToolHookPhase}.${string}`;
export type HookEvent = SessionHookEvent | PromptHookEvent | ToolHookEvent;
export type HookLegacyCondition = (typeof LEGACY_HOOK_CONDITIONS)[number];
export type HookPathConditionKey = (typeof PATH_HOOK_CONDITION_KEYS)[number];

export type HookPathCondition =
	| { readonly matchesAnyPath: readonly string[] }
	| { readonly matchesAllPaths: readonly string[] };
export type HookCondition = HookLegacyCondition | HookPathCondition;

export type HookScope = (typeof HOOK_SCOPES)[number];
export type HookRunIn = (typeof HOOK_RUN_IN)[number];
export type HookBehavior = (typeof HOOK_BEHAVIORS)[number];

export interface HookAsyncConfig {
	readonly group?: string;
	readonly concurrency?: number;
}

export interface CreateFileChange {
	readonly operation: "create";
	readonly path: string;
}
export interface ModifyFileChange {
	readonly operation: "modify";
	readonly path: string;
}
export interface DeleteFileChange {
	readonly operation: "delete";
	readonly path: string;
}
export interface RenameFileChange {
	readonly operation: "rename";
	readonly fromPath: string;
	readonly toPath: string;
}
export type FileChange =
	| CreateFileChange
	| ModifyFileChange
	| DeleteFileChange
	| RenameFileChange;

export interface HookCommandActionConfig {
	readonly name: string;
	readonly args?: string;
}
export interface HookToolActionConfig {
	readonly name: string;
	readonly args?: Record<string, unknown>;
}
export interface HookBashActionConfig {
	readonly command: string;
	readonly timeout?: number;
}
export type HookNotifyLevel = "info" | "success" | "warning" | "error";
export interface HookNotifyActionConfig {
	readonly text: string;
	readonly level?: HookNotifyLevel;
}
export interface HookConfirmActionConfig {
	readonly title?: string;
	readonly message: string;
}
export interface HookSetStatusActionConfig {
	readonly text: string;
}

// Action variants are discriminated by the single key each entry carries.
// `command:` entries are parsed only so validation can reject them with a
// clear "unsupported" error; the runtime never executes them.
export interface HookCommandAction {
	readonly command: string | HookCommandActionConfig;
}
export interface HookToolAction {
	readonly tool: HookToolActionConfig;
}
export interface HookBashAction {
	readonly bash: string | HookBashActionConfig;
}
export interface HookNotifyAction {
	readonly notify: string | HookNotifyActionConfig;
}
export interface HookConfirmAction {
	readonly confirm: HookConfirmActionConfig;
}
export interface HookSetStatusAction {
	readonly setStatus: string | HookSetStatusActionConfig;
}
export type HookAction =
	| HookCommandAction
	| HookToolAction
	| HookBashAction
	| HookNotifyAction
	| HookConfirmAction
	| HookSetStatusAction;

/** Closed union of skip reasons emitted when a hook is evaluated. */
export type HookSkipReason =
	| "matched"
	| "scope_mismatch"
	| "matchesCodeFiles_failed"
	| "matchesAnyPath_no_paths"
	| "matchesAnyPath_failed"
	| "matchesAllPaths_no_paths"
	| "matchesAllPaths_failed";

export interface HookConfigSource {
	readonly filePath: string;
	readonly index: number;
}

export interface HookConfig {
	readonly id?: string;
	readonly event: HookEvent;
	readonly action?: HookBehavior;
	readonly actions: HookAction[];
	readonly scope: HookScope;
	readonly runIn: HookRunIn;
	readonly async?: true | HookAsyncConfig;
	readonly conditions?: HookCondition[];
	readonly source: HookConfigSource;
}

export interface HookOverrideEntry {
	readonly targetId: string;
	readonly disable: boolean;
	readonly replacement?: HookConfig;
	readonly source: HookConfigSource;
}

export type HookMap = Map<HookEvent, HookConfig[]>;

export type HookValidationErrorCode =
	| "invalid_frontmatter"
	| "invalid_imports"
	| "missing_hooks"
	| "invalid_hooks"
	| "invalid_hook"
	| "invalid_event"
	| "invalid_scope"
	| "invalid_run_in"
	| "invalid_hook_action"
	| "invalid_conditions"
	| "invalid_actions"
	| "invalid_action"
	| "duplicate_hook_id"
	| "override_target_not_found"
	| "invalid_override"
	| "invalid_async"
	| "unsupported_on_pi";

export interface HookValidationError {
	readonly code: HookValidationErrorCode;
	readonly filePath: string;
	readonly message: string;
	readonly path?: string;
}

export interface ParsedHooksFile {
	readonly hooks: HookMap;
	readonly overrides: HookOverrideEntry[];
	readonly errors: HookValidationError[];
	readonly advisories?: string[];
}

/**
 * Host-supplied policy that flags hooks the host runtime cannot execute.
 * Pi lacks a slash-command API for hooks, so `command:` actions are rejected
 * on Pi; the policy is registered by yaml-hooks/unsupported.ts.
 */
export interface HookPolicyDiagnostics {
	readonly errors: string[];
	readonly advisories: string[];
	readonly invalidHooks: ReadonlySet<HookConfig>;
}

export interface HookPolicy {
	readonly diagnose: (hookMap: HookMap) => HookPolicyDiagnostics;
}

export function isHookEvent(value: unknown): value is HookEvent {
	return (
		typeof value === "string" &&
		((SESSION_HOOK_EVENTS as readonly string[]).includes(value) ||
			(PROMPT_HOOK_EVENTS as readonly string[]).includes(value) ||
			/^tool\.(before|after)\.(\*|.+)$/.test(value))
	);
}

export function isHookLegacyCondition(value: unknown): value is HookLegacyCondition {
	return (
		typeof value === "string" &&
		(LEGACY_HOOK_CONDITIONS as readonly string[]).includes(value)
	);
}

export function isHookPathConditionKey(value: unknown): value is HookPathConditionKey {
	return (
		typeof value === "string" &&
		(PATH_HOOK_CONDITION_KEYS as readonly string[]).includes(value)
	);
}

export function isHookScope(value: unknown): value is HookScope {
	return typeof value === "string" && (HOOK_SCOPES as readonly string[]).includes(value);
}

export function isHookRunIn(value: unknown): value is HookRunIn {
	return typeof value === "string" && (HOOK_RUN_IN as readonly string[]).includes(value);
}

export function isHookBehavior(value: unknown): value is HookBehavior {
	return typeof value === "string" && (HOOK_BEHAVIORS as readonly string[]).includes(value);
}

export function isHookNotifyLevel(value: unknown): value is HookNotifyLevel {
	return (
		typeof value === "string" &&
		["info", "success", "warning", "error"].includes(value)
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Host adapter implemented by the Pi integration layer (see adapter.ts). */
export interface HostDeliveryResult {
	readonly status: "accepted" | "degraded";
	readonly reason?: string;
	readonly details?: Record<string, unknown>;
}

export interface HostAdapter {
	runBash(request: {
		command: string;
		timeout?: number;
		projectDir: string;
		context: {
			session_id: string;
			event: string;
			cwd: string;
			prompt?: string;
			files?: readonly string[];
			changes?: readonly FileChange[];
			tool_name?: string;
			tool_args?: Record<string, unknown>;
		};
	}): Promise<import("./bash-types.js").BashHookResult>;
	sendPrompt(sessionId: string, text: string): HostDeliveryResult;
	notify(text: string, level?: HookNotifyLevel): HostDeliveryResult;
	confirm(request: { title?: string; message: string; timeout?: number }): Promise<boolean>;
	setStatus(hookId: string, text: string): HostDeliveryResult;
	abort(sessionId: string): void | Promise<void>;
	getRootSessionId(sessionId: string): string | Promise<string | undefined> | undefined;
}
