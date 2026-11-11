#!/usr/bin/env node
// aio-pig — start PiG with AIO recipes applied, like `pi --recipe`.
//
// PiG runs AIO in a helper process that cannot restart pig, so recipes with
// an extension set or model scope (`--recipe`, a `.pi-recipe` default,
// `--continue` into a recipe session) must be resolved before pig starts.
// This launcher does that with AIO's own recipe code (loaded through jiti;
// Pi's package is replaced by recipes/pig-launch/pi-shim.ts).
//
// Two modes:
//   - exec plan (preferred): `aio-pig.mjs --aio-print-exec=tty|pipe <args>`
//     prints NUL-separated arguments for `env` and exits. The shell runs
//     `env <them>`, and env replaces itself with pig, so no Node launcher
//     stays alive. `tty`/`pipe` is the shell's real stdout state (the
//     shell captures this process's stdout). See bin/pig.fish.
//   - spawn: `aio-pig.mjs <args>` runs pig as a child with inherited stdio
//     and exits with pig's exit status. The launcher stays alive meanwhile.
//
// Environment: AIO_PIG_BINARY selects the pig executable (default `pig`);
// AIO_PIG_EXTENSION selects the AIO extension that a recipe relaunch loads
// (default this package's index.ts; set <repo>/go/aio for the Go port);
// AIO_PIG_DRY_RUN=1 prints the planned command as JSON instead of running it.
// Any planning failure starts pig unchanged: the launcher never blocks pig.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pigBinary = process.env.AIO_PIG_BINARY?.trim() || "pig";
const EXEC_FLAG = "--aio-print-exec=";

let args = process.argv.slice(2);
let execMode;
if (args[0]?.startsWith(EXEC_FLAG)) {
	execMode = args[0].slice(EXEC_FLAG.length);
	args = args.slice(1);
}
const stdoutIsTTY = execMode === undefined ? process.stdout.isTTY === true : execMode === "tty";

async function load() {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": join(root, "recipes", "pig-launch", "pi-shim.ts"),
		},
	});
	const plan = await jiti.import(join(root, "recipes", "pig-launch", "plan.ts"));
	const { promptRecipeTrust } = await jiti.import(join(root, "recipes", "trust.ts"));
	return { ...plan, promptRecipeTrust };
}

let launch = { command: pigBinary, args, env: { ...process.env } };
let execEnvArgs;
try {
	const mod = await load();
	execEnvArgs = mod.execEnvArgs;
	launch = await mod.planPigLaunch({
		args,
		env: { ...process.env },
		cwd: process.cwd(),
		pigBinary,
		stdinIsTTY: process.stdin.isTTY === true,
		stdoutIsTTY,
		promptTrust: mod.promptRecipeTrust,
		aioExtensionPath: process.env.AIO_PIG_EXTENSION?.trim() || undefined,
		stderr: (line) => process.stderr.write(`${line}\n`),
	});
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

if (execMode !== undefined) {
	// A planning failure still prints a plan: plain pig with the same args.
	const words = execEnvArgs ? execEnvArgs(process.env, launch) : [launch.command, ...launch.args];
	process.stdout.write(words.map((word) => `${word}\0`).join(""));
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
