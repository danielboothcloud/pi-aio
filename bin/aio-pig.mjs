#!/usr/bin/env node
// aio-pig — start PiG with AIO recipes applied, like `pi --recipe`.
//
// PiG runs AIO in a helper process that cannot restart pig, so recipes with
// an extension set or model scope (`--recipe`, a `.pi-recipe` default,
// `--continue` into a recipe session) must be resolved before pig starts.
// This launcher does that with AIO's own recipe code (loaded through jiti;
// Pi's package is replaced by recipes/pig-launch/pi-shim.ts) and then runs
// pig once, with inherited stdio, and exits with pig's exit status.
//
// Use it in place of `pig`, e.g. in fish:
//   function pig; node <aio>/bin/aio-pig.mjs $argv; end
// Environment: AIO_PIG_BINARY selects the pig executable (default `pig`);
// AIO_PIG_DRY_RUN=1 prints the planned command as JSON instead of running it.
// Any planning failure starts pig unchanged: the launcher never blocks pig.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pigBinary = process.env.AIO_PIG_BINARY?.trim() || "pig";
const args = process.argv.slice(2);

async function plan() {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": join(root, "recipes", "pig-launch", "pi-shim.ts"),
		},
	});
	const { planPigLaunch } = await jiti.import(join(root, "recipes", "pig-launch", "plan.ts"));
	const { promptRecipeTrust } = await jiti.import(join(root, "recipes", "trust.ts"));
	return planPigLaunch({
		args,
		env: { ...process.env },
		cwd: process.cwd(),
		pigBinary,
		stdinIsTTY: process.stdin.isTTY === true,
		stdoutIsTTY: process.stdout.isTTY === true,
		promptTrust: promptRecipeTrust,
		stderr: (line) => process.stderr.write(`${line}\n`),
	});
}

let launch = { command: pigBinary, args, env: process.env };
try {
	launch = await plan();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`aio-pig: recipe launch skipped (${message}); starting pig unchanged\n`);
}

if (process.env.AIO_PIG_DRY_RUN === "1") {
	const env = Object.fromEntries(
		Object.entries(launch.env).filter(([key]) => key.startsWith("AIO_")),
	);
	process.stdout.write(`${JSON.stringify({ command: launch.command, args: launch.args, env }, null, 2)}\n`);
	process.exit(0);
}

// pig shares this terminal's foreground process group, so it receives
// Ctrl+C itself; the launcher only waits and must outlive it.
for (const signal of ["SIGINT", "SIGQUIT"]) process.on(signal, () => {});

const child = spawn(launch.command, launch.args, { stdio: "inherit", env: launch.env });
for (const signal of ["SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		child.kill(signal);
	});
}
child.on("error", (error) => {
	process.stderr.write(`aio-pig: could not start ${launch.command}: ${error.message}\n`);
	process.exit(127);
});
child.on("close", (code, signal) => {
	if (signal) {
		// Re-raise so the shell sees the same signal death as with plain pig.
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
