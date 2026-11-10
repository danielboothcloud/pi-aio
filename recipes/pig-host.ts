// ---------------------------------------------------------------------------
// PiG host detection.
//
// PiG (github.com/MichaelKinsy/PiG) is a Go reimplementation of Pi that runs
// each Node extension in its own helper process (a "runtime cell"). In that
// process `process.execPath`/`process.argv` describe the helper, not the
// `pig` binary, and stdio is a pipe to the Go host, never the terminal. Code
// that re-spawns "the current agent" (the recipe relaunch bridge, subagents)
// must know which host it is in.
//
// PiG sets both markers below in the cell's environment. Real Pi sets
// `process.env.AI_AGENT = "pi"` at startup (cli/setup.js, rpc-entry.js), so a
// real `pi` started from a PiG shell — which inherits PIG_HARNESS_BINARY —
// is still detected as Pi.
// ---------------------------------------------------------------------------

/** Set by PiG in an extension cell: the `pig` binary that started it. */
export const PIG_HARNESS_BINARY_ENV = "PIG_HARNESS_BINARY";

/** Set by the aio-pig launcher (bin/aio-pig.mjs) on every pig it starts. */
export const PIG_LAUNCHER_ENV = "AIO_PIG_LAUNCHER";

/** Set by the launcher when it already asked the `.pi-recipe` trust question. */
export const PIG_TRUST_ASKED_ENV = "AIO_PIG_TRUST_ASKED";

/** True when this pig was started through the aio-pig launcher. */
export function startedByPigLauncher(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env[PIG_LAUNCHER_ENV] === "1";
}

/** The `pig` binary when this extension runs inside a PiG cell, else undefined. */
export function pigHarnessBinary(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (env.AI_AGENT !== "pig") return undefined;
	const binary = env[PIG_HARNESS_BINARY_ENV]?.trim();
	return binary ? binary : undefined;
}

/** True when this extension runs inside a PiG extension cell. */
export function isPigHost(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return pigHarnessBinary(env) !== undefined;
}
