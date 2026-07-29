/**
 * rtk rewrite core — routes shell commands through `rtk rewrite` to reduce LLM
 * token usage. Mirrors the behavior of {@link https://github.com/sherif-fanous/pi-rtk}
 * integrated natively into aio.
 *
 * Two execution paths consume this module:
 *
 * 1. Agent `bash` tool calls — {@link rewriteAgentBashCommand} asynchronously
 *    asks `rtk rewrite` for the command that Pi should execute.
 * 2. User `!<cmd>` shell commands — {@link buildRtkUserBashResult} returns custom
 *    bash operations that execute the rewritten command.
 *
 * Both paths fall back silently only when rtk is unavailable or cannot rewrite
 * a command. Routing is enforced for the process: there is no session toggle or
 * RTK_DISABLED escape hatch in aio.
 */

import { spawnSync } from "node:child_process";
import type {
	BashOperations,
	ExtensionAPI,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 2_000;

// Kept as compatibility exports for consumers of earlier aio releases. RTK is
// now mandatory, so attempts to disable it are intentionally ignored.
export function isRtkEnabled(): boolean {
	return true;
}

export function setRtkEnabled(_enabled: boolean): void {}

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
	// `rtk rewrite` returns 0 for a normal rewrite, 1 when no equivalent exists,
	// and 3 for an advisory rewrite. Permission decisions remain owned by aio's
	// permission modes.
	try {
		delete process.env.RTK_DISABLED;
		const result = spawnSync("rtk", ["rewrite", command], {
			encoding: "utf-8",
			timeout: REWRITE_TIMEOUT_MS,
		});

		if (result.error) {
			const reason = classifySpawnError(result.error);
			if (reason !== "other") alertRtkUnavailable(reason);
			return undefined;
		}
		if (result.status !== 0 && result.status !== 3) return undefined;

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

function shouldSkipRewrite(command: string): boolean {
	const trimmed = command.trimStart();
	return trimmed === "rtk" || trimmed.startsWith("rtk ");
}

function removeRtkDisabledPrefix(command: string): string {
	return command.replace(
		/(^|(?:&&|\|\||;|\|)\s*)((?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+)/g,
		(_match, boundary: string, assignments: string) => {
			let cleaned = assignments.replace(/\bRTK_DISABLED=1\s+/g, "");
			if (/^\s*env\s*$/.test(cleaned)) cleaned = "";
			return `${boundary}${cleaned}`;
		},
	);
}

/**
 * Rewrite a user-shell command synchronously. User-bash interception must return
 * custom operations before Pi starts the command, so it retains the lightweight
 * synchronous path used by the original integration.
 */
export function rtkRewriteCommand(command: string): string | undefined {
	delete process.env.RTK_DISABLED;
	const enforcedCommand = removeRtkDisabledPrefix(command);
	if (shouldSkipRewrite(enforcedCommand)) return undefined;
	const rewritten = rewriteFn(enforcedCommand);
	return rewritten && rewritten !== enforcedCommand ? rewritten : undefined;
}

/**
 * Rewrite an agent `bash` command asynchronously through Pi's process API. This
 * is independent of whichever extension owns the final `bash` tool definition,
 * so disabling pretty bash or loading another renderer cannot disable RTK.
 */
export async function rewriteAgentBashCommand(
	pi: ExtensionAPI,
	command: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	delete process.env.RTK_DISABLED;
	const enforcedCommand = removeRtkDisabledPrefix(command);
	if (shouldSkipRewrite(enforcedCommand)) return undefined;

	// Keep the existing injection seam deterministic for unit tests.
	if (rewriteFn !== defaultRtkRewrite)
		return rtkRewriteCommand(enforcedCommand);

	try {
		const result = await pi.exec("rtk", ["rewrite", enforcedCommand], {
			timeout: REWRITE_TIMEOUT_MS,
			signal,
		});
		if (result.killed || (result.code !== 0 && result.code !== 3)) {
			return undefined;
		}
		const rewritten = result.stdout.trimEnd();
		return rewritten && rewritten !== enforcedCommand ? rewritten : undefined;
	} catch {
		// RTK is an optimization. Never prevent the original command from running.
		return undefined;
	}
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
 * Build a {@link UserBashEventResult} that executes the rewritten command via
 * the supplied bash operations. Returns `undefined` only when rtk cannot rewrite
 * the command, so the caller falls through to Pi's normal user shell handling.
 */
export function buildRtkUserBashResult(
	command: string,
	operations: BashOperations,
): UserBashEventResult | undefined {
	const rewritten = rtkRewriteCommand(command);
	if (rewritten === undefined) return undefined;

	return {
		operations: {
			exec: (_command, cwd, options) =>
				operations.exec(rewritten, cwd, options),
		},
	};
}
