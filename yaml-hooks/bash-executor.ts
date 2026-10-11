// Bash hook execution: spawn with injected context env, capped captures,
// JSON-stdin payload with byte caps, timeout semantics. Ported from
// pi-yaml-hooks (MIT).

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import {
	DEFAULT_BASH_TIMEOUT,
	TIMEOUT_EXIT_CODE,
	type BashExecutionRequest,
	type BashHookContext,
	type BashHookResult,
	type BashProcessResult,
} from "./bash-types.js";
import { ENV } from "./env.js";

const BLOCKING_EXIT_CODE = 2;
// Exit code when the child fails to spawn (e.g. ENOENT); mirrors the POSIX
// shell convention for "command not found".
const SPAWN_ERROR_EXIT_CODE = 127;
const KILL_GRACE_PERIOD_MS = 250;
const TRUNCATION_MARKER = "\n…[aio yaml hooks: output truncated]";

const REQUIRED_CONTEXT_ENV_KEYS = new Set([
	"PI_PROJECT_DIR",
	"OPENCODE_PROJECT_DIR",
	"PI_WORKTREE_DIR",
	"OPENCODE_WORKTREE_DIR",
	"PI_SESSION_ID",
	"OPENCODE_SESSION_ID",
	"PI_GIT_COMMON_DIR",
	"OPENCODE_GIT_COMMON_DIR",
]);

// Execution-context cache TTL. Without invalidation, a worktree replaced
// in-place under the same path would keep returning a stale gitCommonDir.
const EXECUTION_CONTEXT_CACHE_TTL_MS = 5 * 60_000;

interface ExecutionContext {
	worktreeDir: string;
	gitCommonDir?: string;
}

interface ExecutionContextCacheEntry {
	context: ExecutionContext;
	expiresAt: number;
}

const executionContextCache = new Map<string, ExecutionContextCacheEntry>();

interface SerializeContextResult {
	payload: string;
	truncated: boolean;
}

export function serializeContextForStdinDetailed(context: BashHookContext): SerializeContextResult {
	const maxStdinBytes = ENV.maxStdinBytes();
	const json = JSON.stringify(context);
	if (Buffer.byteLength(json, "utf8") <= maxStdinBytes) {
		return { payload: json, truncated: false };
	}
	// The payload exceeds the cap. Truncating JSON mid-stream would hand the
	// hook invalid JSON, so emit a synthetic but still-valid object with
	// large nested fields replaced by placeholders.
	const truncated = {
		...context,
		_aio_hooks_truncated: true,
		_aio_hooks_original_byte_length: Buffer.byteLength(json, "utf8"),
		_aio_hooks_max_byte_length: maxStdinBytes,
	};
	for (const key of Object.keys(truncated) as Array<keyof typeof truncated>) {
		if (key === "_aio_hooks_truncated" || key === "_aio_hooks_original_byte_length" || key === "_aio_hooks_max_byte_length") {
			continue;
		}
		const value = (truncated as Record<string, unknown>)[key as string];
		if (typeof value === "string" && value.length > 1024) {
			(truncated as Record<string, unknown>)[key as string] = `[aio yaml hooks: truncated string of ${value.length} chars]`;
		} else if (value && typeof value === "object") {
			const nestedSize = Buffer.byteLength(JSON.stringify(value), "utf8");
			if (nestedSize > 4096) {
				(truncated as Record<string, unknown>)[key as string] = `[aio yaml hooks: truncated nested value of ${nestedSize} bytes]`;
			}
		}
	}
	const reduced = JSON.stringify(truncated);
	if (Buffer.byteLength(reduced, "utf8") <= maxStdinBytes) {
		return { payload: reduced, truncated: true };
	}
	// Last resort: keep only the bare identity fields.
	return {
		payload: JSON.stringify({
			session_id: context.session_id,
			event: context.event,
			cwd: context.cwd,
			_aio_hooks_truncated: true,
			_aio_hooks_original_byte_length: Buffer.byteLength(json, "utf8"),
			_aio_hooks_max_byte_length: maxStdinBytes,
		}),
		truncated: true,
	};
}

export function serializeContextForStdin(context: BashHookContext): string {
	return serializeContextForStdinDetailed(context).payload;
}

/** Cap output bytes on a UTF-8 codepoint boundary (never split a sequence). */
export function trimToUtf8Boundary(chunk: Buffer, maxBytes: number): number {
	if (maxBytes <= 0) return 0;
	const limit = Math.min(maxBytes, chunk.length);
	if (limit === 0) return 0;

	// Walk backwards from the limit looking for the start of the last
	// codepoint: a byte whose top two bits are not `10`.
	let i = limit;
	while (i > 0) {
		const b = chunk[i - 1];
		if (b === undefined) {
			return 0;
		}
		if ((b & 0b1100_0000) !== 0b1000_0000) {
			const expectedLen =
				(b & 0b1000_0000) === 0 ? 1 :
				(b & 0b1110_0000) === 0b1100_0000 ? 2 :
				(b & 0b1111_0000) === 0b1110_0000 ? 3 :
				(b & 0b1111_1000) === 0b1111_0000 ? 4 :
				0;
			const start = i - 1;
			if (expectedLen > 0 && start + expectedLen <= limit) {
				return start + expectedLen;
			}
			return start;
		}
		i -= 1;
	}
	// The whole prefix was continuation bytes (corrupt stream). Drop them.
	return 0;
}

/** Accumulates child-process output bytes against the configured cap. */
class CappedOutputBuffer {
	private chunks: Buffer[] = [];
	private byteLength = 0;
	private truncatedFlag = false;

	get truncated(): boolean {
		return this.truncatedFlag;
	}

	append(chunk: Buffer): void {
		if (this.truncatedFlag) {
			return;
		}
		const maxOutputBytes = ENV.maxOutputBytes();
		if (this.byteLength + chunk.length <= maxOutputBytes) {
			this.chunks.push(chunk);
			this.byteLength += chunk.length;
			return;
		}

		const remaining = maxOutputBytes - this.byteLength;
		if (remaining > 0) {
			const safeEnd = trimToUtf8Boundary(chunk, remaining);
			if (safeEnd > 0) {
				this.chunks.push(chunk.subarray(0, safeEnd));
				this.byteLength += safeEnd;
			}
		}
		this.truncatedFlag = true;
	}

	toString(): string {
		const joined = Buffer.concat(this.chunks, this.byteLength).toString("utf8");
		return this.truncatedFlag ? joined + TRUNCATION_MARKER : joined;
	}
}

export async function executeBashHook(request: BashExecutionRequest): Promise<BashHookResult> {
	const processResult = await executeBashProcess(request);
	return mapBashProcessResultToHookResult(processResult, request.context);
}

export function mapBashProcessResultToHookResult(
	result: BashProcessResult,
	context: BashHookContext,
): BashHookResult {
	if (result.timedOut) {
		return { ...result, status: "timed_out", blocking: false };
	}

	if (result.exitCode === 0) {
		return { ...result, status: "success", blocking: false };
	}

	if (result.exitCode === BLOCKING_EXIT_CODE && isBlockingToolBeforeEvent(context.event)) {
		return { ...result, status: "blocked", blocking: true };
	}

	return { ...result, status: "failed", blocking: false };
}

export function isBlockingToolBeforeEvent(event: string): boolean {
	return event.startsWith("tool.before.");
}

async function executeBashProcess(request: BashExecutionRequest): Promise<BashProcessResult> {
	const timeout = request.timeout ?? DEFAULT_BASH_TIMEOUT;
	const startTime = Date.now();
	const executionContext = resolveExecutionContext(request.projectDir);

	return new Promise((resolve) => {
		const contextEnv: Record<string, string> = {
			PI_PROJECT_DIR: request.projectDir,
			OPENCODE_PROJECT_DIR: request.projectDir,
			PI_WORKTREE_DIR: executionContext.worktreeDir,
			OPENCODE_WORKTREE_DIR: executionContext.worktreeDir,
			PI_SESSION_ID: request.context.session_id,
			OPENCODE_SESSION_ID: request.context.session_id,
			...(executionContext.gitCommonDir
				? {
						PI_GIT_COMMON_DIR: executionContext.gitCommonDir,
						OPENCODE_GIT_COMMON_DIR: executionContext.gitCommonDir,
					}
				: {}),
		};
		const env = buildBashEnvironment(process.env, contextEnv);

		const child = spawn(ENV.bashExecutable(), ["-c", request.command], {
			cwd: request.context.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			// Detached so timed-out hooks can be killed by process group.
			detached: true,
		});

		const stdout = new CappedOutputBuffer();
		const stderr = new CappedOutputBuffer();
		let timedOut = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timeoutCleanupNotes: string[] = [];

		const finalize = (result: Omit<BashProcessResult, "durationMs">): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutTimer);
			if (killTimer) {
				clearTimeout(killTimer);
			}
			resolve({
				...result,
				durationMs: Date.now() - startTime,
			});
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			timeoutCleanupNotes.push(...signalTimedOutProcess(child, "SIGTERM", timeout));
			killTimer = setTimeout(() => {
				timeoutCleanupNotes.push(...signalTimedOutProcess(child, "SIGKILL", timeout));
			}, KILL_GRACE_PERIOD_MS);
		}, timeout);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout.append(chunk);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr.append(chunk);
		});

		const stdinSerialization = serializeContextForStdinDetailed(request.context);
		const stdinTruncated = stdinSerialization.truncated;

		child.stdin.on("error", () => {});
		child.stdin.end(stdinSerialization.payload);

		child.on("error", (error) => {
			stderr.append(Buffer.from(`\n${error.message}`, "utf8"));
			finalize({
				command: request.command,
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				exitCode: SPAWN_ERROR_EXIT_CODE,
				signal: null,
				timedOut: false,
				outputTruncated: stdout.truncated || stderr.truncated,
				stdinTruncated,
			});
		});

		child.on("close", (code, signal) => {
			const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? SPAWN_ERROR_EXIT_CODE);
			const timeoutMessages = timedOut
				? [
						`Command timed out after ${timeout}ms`,
						...timeoutCleanupNotes,
						`Timeout cleanup: final result exitCode=${code ?? "none"} signal=${signal ?? "none"}`,
					]
				: [];
			for (const message of timeoutMessages) {
				appendStderrLine(stderr, message);
			}

			finalize({
				command: request.command,
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				exitCode,
				signal,
				timedOut,
				outputTruncated: stdout.truncated || stderr.truncated,
				stdinTruncated,
			});
		});
	});
}

/**
 * Restrict inherited environment variables in allowlist mode; required hook
 * context variables are always added afterwards.
 */
export function buildBashEnvironment(
	inheritedEnv: NodeJS.ProcessEnv,
	contextEnv: Record<string, string>,
): NodeJS.ProcessEnv {
	const rawAllowlist = inheritedEnv.PI_YAML_HOOKS_ENV_ALLOWLIST;
	if (!rawAllowlist) {
		return { ...inheritedEnv, ...contextEnv };
	}

	const allowlist = new Set(
		rawAllowlist
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)),
	);
	const env: NodeJS.ProcessEnv = {};
	for (const key of allowlist) {
		if (REQUIRED_CONTEXT_ENV_KEYS.has(key)) continue;
		const value = inheritedEnv[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return { ...env, ...contextEnv };
}

function appendStderrLine(buffer: CappedOutputBuffer, message: string): void {
	if (!message) return;
	// Own line per cleanup message so log parsing stays readable.
	buffer.append(Buffer.from(`\n${message}`, "utf8"));
}

function signalTimedOutProcess(
	child: ReturnType<typeof spawn>,
	signal: NodeJS.Signals,
	timeout: number,
): string[] {
	const pid = child.pid ?? undefined;
	const notes: string[] = [];
	if (typeof pid === "number" && pid > 0) {
		let groupError: string | undefined;
		try {
			process.kill(-pid, signal);
		} catch (error) {
			groupError = error instanceof Error ? error.message : String(error);
		}

		// Defence in depth: signal the direct child PID too, so the bash
		// process itself can never linger as a zombie holding resources.
		let directError: string | undefined;
		try {
			child.kill(signal);
		} catch (error) {
			directError = error instanceof Error ? error.message : String(error);
		}

		notes.push(
			`Timeout cleanup: ${signal === "SIGKILL" ? "escalated" : "sent"} ${signal} to process group${groupError ? ` (failed: ${groupError})` : ""} and pid ${pid} after ${timeout}ms timeout`,
		);
		if (groupError && directError) {
			notes.push(`Timeout cleanup: group kill failed (${groupError}); direct kill failed (${directError})`);
		}
		return notes;
	}

	try {
		child.kill(signal);
		notes.push(`Timeout cleanup: sent ${signal} to process${pid ? ` pid ${pid}` : ""} after ${timeout}ms timeout`);
	} catch (error) {
		notes.push(`Timeout cleanup: failed to signal process: ${error instanceof Error ? error.message : String(error)}`);
	}
	return notes;
}

function resolveExecutionContext(projectDir: string): ExecutionContext {
	const now = Date.now();
	const cached = executionContextCache.get(projectDir);
	if (cached && cached.expiresAt > now) {
		return cached.context;
	}

	// Git is the source of truth for the worktree dir and the git common dir;
	// non-git projects keep worktreeDir = projectDir and no common dir.
	const context: ExecutionContext = { worktreeDir: projectDir };
	try {
		const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: projectDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (topLevel && path.isAbsolute(topLevel)) {
			context.worktreeDir = topLevel;
		}
		const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: projectDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (commonDir && path.isAbsolute(commonDir)) {
			context.gitCommonDir = commonDir;
		} else if (commonDir) {
			context.gitCommonDir = path.resolve(projectDir, commonDir);
		}
	} catch {
		// Ignore — best-effort git context.
	}

	executionContextCache.set(projectDir, { context, expiresAt: now + EXECUTION_CONTEXT_CACHE_TTL_MS });
	return context;
}
