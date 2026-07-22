/* pi-pretty: GNU grep detection for the bash guard. */

/** Prefix commands that may wrap the real executable (best-effort). */
const GUARD_PREFIXES = new Set([
	"sudo",
	"env",
	"command",
	"builtin",
	"nice",
	"time",
	"xargs",
]);

/** GNU grep executable names (egrep/fgrep are GNU grep aliases; ggrep is Homebrew GNU grep). */
const GNU_GREP_NAMES = new Set(["grep", "egrep", "fgrep", "ggrep"]);

const SEGMENT_SPLIT = /\|\||&&|[|;\n]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Returns the GNU grep executable token when a shell command invokes grep as a
 * segment's command (start of command, after `|`, `;`, `&&`, `||`, or a
 * newline), optionally behind prefixes like `sudo`/`env`. Conservative by
 * design: `rg`, `pgrep`, `git grep`, and quoted text are never flagged, and
 * complex nesting (`$(grep ...)`, `if grep ...`) is intentionally missed
 * rather than risking false positives.
 */
/** Resolves the executable token of one shell segment, skipping env assignments and prefix commands. */
function executableToken(tokens: string[]): string | undefined {
	const start = tokens.findIndex((t) => !ENV_ASSIGNMENT.test(t));
	if (start === -1) return undefined;
	let prev: string | undefined;
	for (const t of tokens.slice(start)) {
		if (GUARD_PREFIXES.has(t)) {
			prev = t;
			continue;
		}
		// Skip prefix flags: sudo -n grep ...
		if (t.startsWith("-") && prev !== undefined && GUARD_PREFIXES.has(prev)) {
			prev = t;
			continue;
		}
		return t;
	}
	return undefined;
}

export function findGnuGrepInvocation(command: string): string | undefined {
	for (const segment of command.split(SEGMENT_SPLIT)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		const exe = executableToken(tokens);
		if (!exe) continue;
		const base = exe.slice(exe.lastIndexOf("/") + 1);
		if (GNU_GREP_NAMES.has(base)) return exe;
	}
	return undefined;
}
