/** Worker-only: retain Chromium ownership even if this process crashes first. */
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export function trackChildProcesses() {
	const file = process.env.AIO_CLOAK_OWNERSHIP_FILE;
	if (!file) return;
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = function(command, args, options) {
		const child = originalSpawn.apply(this, arguments);
		if (child.pid) {
			const opts = Array.isArray(args) ? options : args;
			const group = Boolean(opts?.detached) && process.platform !== "win32";
			try {
				// Synchronous publication cannot be lost when an uncaught exception
				// or process.exit interrupts buffered stdout.
				appendFileSync(file, `${child.pid} ${group ? 1 : 0}\n`, { mode: 0o600 });
			} catch (error) {
				try { process.kill(group ? -child.pid : child.pid, "SIGKILL"); } catch { /* exited */ }
				throw error;
			}
		}
		return child;
	};
	// Also update live ESM spawn bindings used by browser libraries.
	syncBuiltinESMExports();
}
