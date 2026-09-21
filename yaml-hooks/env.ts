// ---------------------------------------------------------------------------
// Environment-variable surface for aio yaml hooks.
//
// The PI_YAML_HOOKS_* names are retained from upstream pi-yaml-hooks so
// existing hooks.yaml docs, examples, and shell profiles keep working
// unchanged (see yaml-hooks/UPSTREAM.md). OPENCODE_* aliases are honoured
// where upstream honoured them.
// ---------------------------------------------------------------------------

/** True only for the literal "1" (upstream convention). */
export function isEnvEnabled(name: string): boolean {
	return process.env[name] === "1";
}

/** Truthy spellings accepted for off-switches: 0/false/off/no. */
export function isEnvDisabled(name: string): boolean {
	const raw = process.env[name];
	if (raw === undefined) return false;
	return ["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/** Parse a positive integer env value; undefined when unset or invalid. */
export function positiveIntEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export const ENV = {
	bashExecutable: () =>
		process.env.PI_YAML_HOOKS_BASH_EXECUTABLE ||
		process.env.OPENCODE_HOOKS_BASH_EXECUTABLE ||
		"bash",
	maxOutputBytes: () => positiveIntEnv("PI_YAML_HOOKS_MAX_OUTPUT_BYTES") ?? 1_048_576,
	maxStdinBytes: () => positiveIntEnv("PI_YAML_HOOKS_MAX_STDIN_BYTES") ?? 262_144,
	maxAsyncPending: () => positiveIntEnv("PI_YAML_HOOKS_ASYNC_MAX_PENDING") ?? 1_000,
	asyncWatchdogMs: () => positiveIntEnv("PI_YAML_HOOKS_ASYNC_WATCHDOG_MS"),
	confirmAutoApprove: () => isEnvEnabled("PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE"),
	trustProject: () => isEnvEnabled("PI_YAML_HOOKS_TRUST_PROJECT"),
	enableUserBash: () => isEnvEnabled("PI_YAML_HOOKS_ENABLE_USER_BASH"),
	allowGlobalImports: () => isEnvEnabled("PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS"),
	allowPackageImports: () => isEnvEnabled("PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS"),
	allowProjectImportsOutsideAnchor: () =>
		isEnvEnabled("PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR"),
	logMaxBytes: () => positiveIntEnv("PI_YAML_HOOKS_LOG_MAX_BYTES") ?? 10 * 1024 * 1024,
} as const;
