/**
 * rtk rewrite core — routes shell commands through `rtk rewrite` to reduce LLM
 * token usage. Mirrors the behavior of {@link https://github.com/sherif-fanous/pi-rtk}
 * integrated natively into aio.
 *
 * Two execution paths consume this module:
 *
 * 1. Agent `bash` tool calls — {@link rtkSpawnHook} rewrites the command before
 *    the SDK spawns it, preserving the original command in tool output.
 * 2. User `!<cmd>` shell commands — {@link buildRtkUserBashResult} returns custom
 *    bash operations that execute the rewritten command.
 *
 * Both paths fall back silently when rtk is unavailable, disabled, or cannot
 * rewrite a command. `!!<cmd>` is intentionally not intercepted here — callers
 * skip it so the user's choice to exclude shell output from model context is
 * preserved.
 *
 * The session toggle is in-memory only: it resets to enabled on every Pi process
 * start and is never persisted to disk.
 */

import { spawnSync } from "node:child_process";
import type {
	BashOperations,
	BashSpawnContext,
	BashSpawnHook,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Session toggle (in-memory only)
// ---------------------------------------------------------------------------

let sessionEnabled = true;

export function isRtkEnabled(): boolean {
	return sessionEnabled;
}

export function setRtkEnabled(enabled: boolean): void {
	sessionEnabled = enabled;
}

// ---------------------------------------------------------------------------
// Spawn seam — overridable for tests so unit tests never invoke the real rtk
// binary. The default implementation shells out to `rtk rewrite`.
// ---------------------------------------------------------------------------

type RewriteFn = (command: string) => string | undefined;

let rewriteFn: RewriteFn = defaultRtkRewrite;

/** Replace the rewrite implementation. Intended for tests. */
export function setRtkRewriteFn(fn: RewriteFn): void {
	rewriteFn = fn;
}

/** Restore the default `rtk rewrite` implementation. Intended for tests. */
export function resetRtkRewriteFn(): void {
	rewriteFn = defaultRtkRewrite;
}

// ---------------------------------------------------------------------------
// Availability notifications — warn-once per outage. A successful rewrite spawn
// resets the gate so the next ENOENT/EACCES may warn again. Pi only exposes the
// TUI notify surface through lifecycle context, so the callable is captured from
// the first relevant event rather than at module load.
// ---------------------------------------------------------------------------

type Notify = (message: string, level: "info" | "warning" | "error") => void;
type RtkUnavailableReason = "missing" | "unexecutable";
type SpawnErrorClassification = RtkUnavailableReason | "other";

let rtkUnavailableNotified = false;
let cachedNotify: Notify | null = null;

export function cacheNotify(notify: Notify): void {
	if (cachedNotify === null) cachedNotify = notify;
}

/** Reset all module state to defaults. Intended for tests. */
export function resetRtkState(): void {
	sessionEnabled = true;
	rtkUnavailableNotified = false;
	cachedNotify = null;
	rewriteFn = defaultRtkRewrite;
}

function alertRtkUnavailable(reason: RtkUnavailableReason): void {
	if (rtkUnavailableNotified || cachedNotify === null) return;

	const messages: Record<RtkUnavailableReason, string> = {
		missing:
			"[aio-rtk] rtk binary not found on PATH. Shell command rewrites are disabled. Install rtk: https://github.com/rtk-ai/rtk#installation",
		unexecutable:
			"[aio-rtk] rtk binary found on PATH but is not executable. Shell command rewrites are disabled. Run: chmod +x $(command -v rtk)",
	};

	rtkUnavailableNotified = true;
	cachedNotify(messages[reason], "warning");
}

function classifySpawnError(
	err: NodeJS.ErrnoException,
): SpawnErrorClassification {
	if (err.code === "ENOENT") return "missing";
	if (err.code === "EACCES") return "unexecutable";
	return "other";
}

function defaultRtkRewrite(command: string): string | undefined {
	// rtk's exit codes are permission verdicts (0/1/2/3 = allow/no-equiv/deny/
	// ask). We trust stdout and ignore the exit code — this shim rewrites, it
	// does not gate. Spawn availability errors are surfaced via the notify gate.
	try {
		const result = spawnSync("rtk", ["rewrite", command], {
			encoding: "utf-8",
			timeout: REWRITE_TIMEOUT_MS,
		});

		if (result.error) {
			const reason = classifySpawnError(result.error);
			if (reason !== "other") alertRtkUnavailable(reason);
			return undefined;
		}

		rtkUnavailableNotified = false;

		const out = (result.stdout ?? "").trimEnd();
		return out.length > 0 ? out : undefined; // empty stdout = no equivalent
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Public rewrite API
// ---------------------------------------------------------------------------

/**
 * Rewrite a command via rtk. Returns the rewritten command, or `undefined` when
 * rtk is unavailable, times out, or has no equivalent for the command.
 */
export function rtkRewriteCommand(command: string): string | undefined {
	return rewriteFn(command);
}

/**
 * Probe rtk availability at session start so a missing/unexecutable binary is
 * reported once via the notify gate.
 */
export function probeRtkAvailability(): void {
	const result = spawnSync("rtk", ["--version"], {
		timeout: REWRITE_TIMEOUT_MS,
	});
	if (!result.error) return;
	const reason = classifySpawnError(result.error as NodeJS.ErrnoException);
	if (reason !== "other") alertRtkUnavailable(reason);
}

/**
 * Spawn hook for the agent `bash` tool. Rewrites the command when the session
 * toggle is enabled and rtk can rewrite it; otherwise returns the context
 * unchanged so Pi's normal shell behavior continues.
 */
export const rtkSpawnHook: BashSpawnHook = ({
	command,
	cwd,
	env,
}: BashSpawnContext): BashSpawnContext => {
	if (!sessionEnabled) return { command, cwd, env };
	return { command: rtkRewriteCommand(command) ?? command, cwd, env };
};

/**
 * Build a {@link UserBashEventResult} that executes the rewritten command via
 * the supplied bash operations. Returns `undefined` when rewriting is disabled or
 * rtk cannot rewrite the command, so the caller falls through to Pi's normal
 * user shell handling.
 */
export function buildRtkUserBashResult(
	command: string,
	operations: BashOperations,
): UserBashEventResult | undefined {
	if (!sessionEnabled) return undefined;

	const rewritten = rtkRewriteCommand(command);
	if (rewritten === undefined) return undefined;

	return {
		operations: {
			exec: (_command, cwd, options) =>
				operations.exec(rewritten, cwd, options),
		},
	};
}
