/** Keep Playwright's process/pipe failures outside the Pi process. */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { abortError, throwIfAborted } from "./abort.js";
import { CLOAK_MAX_CHARS } from "./cloak-settings.js";
import type { CloakFetchOptions } from "./cloak-runtime.js";
import type { FetchResult } from "./types.js";
import { validateUrlWithDns } from "./url-validation.js";

export type { CloakFetchOptions } from "./cloak-runtime.js";

const RESULT_PREFIX = "AIO_CLOAK_RESULT:";

/** Injection seams for isolated, browser-free regression tests. */
export interface CloakWorkerDependencies {
	spawn?: typeof spawn;
	nodeBinary?: string;
	workerPath?: string;
	timeoutMs?: number;
	killGraceMs?: number;
	maxOutputBytes?: number;
}

export async function cloakFetch(
	opts: CloakFetchOptions,
	deps: CloakWorkerDependencies = {},
): Promise<FetchResult> {
	throwIfAborted(opts.signal);
	if (!opts.unsafe) {
		const check = await validateUrlWithDns(opts.url);
		throwIfAborted(opts.signal);
		if (!check.valid) throw new Error(`URL blocked: ${check.reason}`);
	}

	const nodeBinary = deps.nodeBinary ?? process.env.BROWSER_SEARCH_NODE_BINARY ??
		(process.versions.bun ? "node" : process.execPath);
	const workerPath = deps.workerPath ?? fileURLToPath(
		new URL("./cloak-worker.mjs", import.meta.url),
	);
	const { signal, ...request } = opts;
	const input = JSON.stringify(request);
	const outputLimit = deps.maxOutputBytes ??
		8 * (opts.maxChars ?? CLOAK_MAX_CHARS) + 65_536;
	const ownershipDir = mkdtempSync(join(tmpdir(), "aio-cloak-worker-"));
	const ownershipFile = join(ownershipDir, "children");
	const cleanupOwnership = () => {
		try { rmSync(ownershipDir, { recursive: true, force: true }); } catch { /* best effort */ }
	};

	return new Promise<FetchResult>((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = (deps.spawn ?? spawn)(nodeBinary, [workerPath], {
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
				env: { ...process.env, AIO_CLOAK_OWNERSHIP_FILE: ownershipFile },
			});
		} catch (error) {
			cleanupOwnership();
			reject(new Error(`Could not start CloakBrowser Node worker: ${String(error)}`));
			return;
		}

		let output = "";
		let outputBytes = 0;
		let stderr = "";
		let failure: Error | undefined;
		let finished = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let exitTimer: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;

		const signalTree = (kind: NodeJS.Signals) => {
			if (!child.pid) return;
			if (process.platform !== "win32") {
				try { process.kill(-child.pid, kind); } catch { /* already exited */ }
			}
			// The worker records direct browser PIDs/groups synchronously. These
			// survive reparenting when it exits before a detached Chromium child.
			let records = "";
			try { records = readFileSync(ownershipFile, "utf8"); } catch { /* none yet */ }
			for (const line of records.trim().split("\n")) {
				const [pid, group] = line.split(" ").map(Number);
				if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
				if (process.platform === "win32") {
					execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 1_000 }, () => {});
				} else {
					try { process.kill(group === 1 ? -pid : pid, kind); } catch { /* exited */ }
				}
			}
			child.kill(kind);
		};
		const destroyPipes = () => {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (exitTimer) clearTimeout(exitTimer);
			if (settleTimer) clearTimeout(settleTimer);
			signal?.removeEventListener("abort", onAbort);
			signalTree("SIGKILL");
			cleanupOwnership();
			if (failure) return reject(failure);
			if (code !== 0) {
				return reject(new Error(
					`CloakBrowser Node worker failed (${exitSignal ?? `exit ${code}`}): ${stderr.trim() || "no diagnostic output"}`,
				));
			}
			try {
				const line = output.split("\n").findLast((value) => value.startsWith(RESULT_PREFIX));
				if (!line) throw new Error("missing result");
				const message = JSON.parse(line.slice(RESULT_PREFIX.length));
				if (typeof message.error === "string") return reject(new Error(message.error));
				const result = message.result;
				if (
					!result || result.url !== opts.url || result.tier !== "cloak" ||
					result.format !== (opts.format ?? "text") || typeof result.content !== "string" ||
					typeof result.chars !== "number" || typeof result.truncated !== "boolean"
				) {
					throw new Error("invalid result shape");
				}
				resolve(result);
			} catch (error) {
				reject(new Error(`Invalid CloakBrowser worker response: ${String(error)}`));
			}
		};
		const stop = (error: Error) => {
			if (failure || finished) return;
			failure = error;
			if (child.pid && process.platform === "win32") {
				execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 1_000 }, () => {});
			} else {
				signalTree("SIGTERM");
			}
			killTimer = setTimeout(() => {
				signalTree("SIGKILL");
				destroyPipes();
				// A descendant holding stdio must never keep the tool pending.
				settleTimer = setTimeout(() => finish(null, "SIGKILL"), 25);
			}, deps.killGraceMs ?? 2_000);
		};
		const onAbort = () => stop(abortError(signal));
		const timer = setTimeout(
			() => stop(new Error("CloakBrowser Node worker timed out")),
			deps.timeoutMs ?? 240_000,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		child.on("error", (error) => stop(new Error(`Could not start CloakBrowser Node worker: ${error.message}`)));
		child.stdin?.on("error", (error) => stop(new Error(`CloakBrowser worker input failed: ${error.message}`)));
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("error", (error) => stop(error));
		child.stderr?.on("error", (error) => stop(error));
		child.stdout?.on("data", (chunk: string) => {
			outputBytes += Buffer.byteLength(chunk);
			if (outputBytes > outputLimit) stop(new Error("CloakBrowser worker exceeded its output limit"));
			else output += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-8_192);
		});
		child.on("exit", (code, exitSignal) => {
			// Normal close follows once buffered output drains. Bound that wait
			// too: inherited descendant pipes can otherwise prevent close forever.
			exitTimer = setTimeout(() => {
				signalTree("SIGKILL");
				destroyPipes();
				finish(code, exitSignal);
			}, 100);
		});
		child.on("close", finish);
		child.stdin?.end(input);
	});
}
