import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedAstGrepInput } from "./schema.js";

const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface ProcessResult {
	command: string;
	args: string[];
	cwd: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export interface RunProcessOptions {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	maxCaptureBytes?: number;
}

function executableNames(baseName: string): string[] {
	if (process.platform === "win32") {
		return [`${baseName}.cmd`, `${baseName}.exe`, baseName];
	}
	return [baseName];
}

async function isUsableFile(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.R_OK | fsConstants.X_OK);
		return true;
	} catch {
		try {
			await access(path, fsConstants.R_OK);
			return process.platform === "win32";
		} catch {
			return false;
		}
	}
}

function parentDirectories(startDir: string): string[] {
	const dirs: string[] = [];
	let current = startDir;
	while (true) {
		dirs.push(current);
		const parent = dirname(current);
		if (parent === current || current === parsePath(current).root) break;
		current = parent;
	}
	return dirs;
}

export async function resolveAstGrepBinary(
	startDir = moduleDir,
): Promise<string> {
	const candidates: string[] = [];
	for (const dir of parentDirectories(startDir)) {
		for (const name of executableNames("ast-grep")) {
			candidates.push(join(dir, "node_modules", ".bin", name));
			candidates.push(join(dir, "node_modules", "@ast-grep", "cli", name));
		}
	}

	for (const candidate of candidates) {
		if (await isUsableFile(candidate)) return candidate;
	}

	// Fallback to PATH. Use the long command name because `sg` is a Linux setgroups tool on many systems.
	return process.platform === "win32" ? "ast-grep.cmd" : "ast-grep";
}

export function buildAstGrepArgs(input: NormalizedAstGrepInput): string[] {
	const args: string[] = [];
	if (input.config) args.push("--config", input.config);
	args.push(input.command);
	args.push(`--json=${input.json}`);

	for (const glob of input.globs) {
		args.push("--globs", glob);
	}

	if (input.command === "run") {
		if (input.pattern) args.push("--pattern", input.pattern);
		if (input.kind) args.push("--kind", input.kind);
		if (input.language) args.push("--lang", input.language);
		if (input.selector) args.push("--selector", input.selector);
		if (input.strictness) args.push("--strictness", input.strictness);
		if (input.context !== undefined)
			args.push("--context", String(input.context));
		if (input.before !== undefined) args.push("--before", String(input.before));
		if (input.after !== undefined) args.push("--after", String(input.after));
	} else {
		if (input.rule) args.push("--rule", input.rule);
		if (input.inlineRules) args.push("--inline-rules", input.inlineRules);
	}

	args.push(...input.paths);
	return args;
}

export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(shellQuote).join(" ");
}

export async function runProcess(
	command: string,
	args: string[],
	options: RunProcessOptions,
): Promise<ProcessResult> {
	const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;

	return await new Promise<ProcessResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let overflowed = false;
		let exited = false;
		let sigkillTimer: NodeJS.Timeout | undefined;

		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const cleanup = () => {
			clearTimeout(timeout);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const terminate = () => {
			if (exited) return;
			try {
				child.kill("SIGTERM");
			} catch {
				// Ignore kill races; close/error handlers will settle the promise.
			}
			sigkillTimer = setTimeout(() => {
				if (exited) return;
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignore kill races; close/error handlers will settle the promise.
				}
			}, 1000);
			sigkillTimer.unref();
		};

		const onAbort = () => {
			aborted = true;
			terminate();
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, options.timeoutMs);
		timeout.unref();

		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdoutBytes += Buffer.byteLength(chunk, "utf8");
			if (stdoutBytes + stderrBytes > maxCaptureBytes) {
				overflowed = true;
				terminate();
				return;
			}
			stdout += chunk;
		});

		child.stderr.on("data", (chunk: string) => {
			stderrBytes += Buffer.byteLength(chunk, "utf8");
			if (stdoutBytes + stderrBytes > maxCaptureBytes) {
				overflowed = true;
				terminate();
				return;
			}
			stderr += chunk;
		});

		child.on("error", (error) => {
			fail(
				new Error(
					`Failed to start ast-grep. Install this package's dependencies or put ast-grep on PATH. Cause: ${error.message}`,
				),
			);
		});

		child.on("close", (code, signal) => {
			exited = true;
			if (settled) return;
			settled = true;
			cleanup();
			if (overflowed) {
				reject(
					new Error(
						`ast-grep output exceeded ${maxCaptureBytes} bytes; narrow the paths/globs or lower maxResults.`,
					),
				);
				return;
			}
			resolve({
				command,
				args,
				cwd: options.cwd,
				code,
				signal,
				stdout,
				stderr,
				timedOut,
				aborted,
			});
		});
	});
}
