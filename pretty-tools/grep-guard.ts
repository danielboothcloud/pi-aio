/* pi-pretty: GNU grep and ripgrep-flag detection for the bash guard. */

import { commandArgvs } from "../blocklist/segments.js";

/** GNU grep executable names (egrep/fgrep are GNU grep aliases; ggrep is Homebrew GNU grep). */
const GNU_GREP_NAMES = new Set(["grep", "egrep", "fgrep", "ggrep"]);

/** ripgrep short options that take a value (`rg --help`, ripgrep 15). */
const RG_SHORT_VALUE_FLAGS = new Set([
	"A",
	"B",
	"C",
	"d",
	"E",
	"e",
	"f",
	"g",
	"j",
	"m",
	"M",
	"r",
	"t",
	"T",
]);

/** ripgrep long options that take a value; the value may be the next word. */
const RG_LONG_VALUE_FLAGS = new Set([
	"--after-context",
	"--before-context",
	"--color",
	"--colors",
	"--context",
	"--context-separator",
	"--dfa-size-limit",
	"--encoding",
	"--engine",
	"--field-context-separator",
	"--field-match-separator",
	"--file",
	"--generate",
	"--glob",
	"--hostname-bin",
	"--hyperlink-format",
	"--iglob",
	"--ignore-file",
	"--max-columns",
	"--max-count",
	"--max-depth",
	"--max-filesize",
	"--path-separator",
	"--pre",
	"--pre-glob",
	"--regex-size-limit",
	"--regexp",
	"--replace",
	"--sort",
	"--sortr",
	"--threads",
	"--type",
	"--type-add",
	"--type-clear",
	"--type-not",
]);

function basename(value: string): string {
	return value.slice(value.lastIndexOf("/") + 1);
}

/**
 * The argv of every simple command the shell would run, from the shared
 * blocklist segmenter: quotes, heredoc bodies, and `$(…)`/`bash -c` scripts
 * are handled, and wrappers (`sudo`, `env`, `xargs`, `nice`, …) are stripped.
 * A command that cannot be segmented (unbalanced quotes, `source file`, a
 * script piped into a shell) yields nothing: this guard is a nudge, not a
 * security gate, so it fails open.
 */
function argvs(command: string): string[][] {
	return commandArgvs(command) ?? [];
}

/**
 * Returns the GNU grep executable token when a shell command runs GNU grep
 * as a command. Text that only mentions grep (quoted regexes, heredoc bodies,
 * `git grep`, `pgrep`, file names) is never flagged.
 */
export function findGnuGrepInvocation(command: string): string | undefined {
	for (const argv of argvs(command)) {
		const exe = argv[0];
		if (exe && GNU_GREP_NAMES.has(basename(exe))) return exe;
	}
	return undefined;
}

/** A ripgrep short-option cluster where `-r` swallowed letters meant as flags. */
export interface RgReplaceMisuse {
	/** The offending option cluster, e.g. `-rn`. */
	flag: string;
	/** The text ripgrep will use as the replacement, e.g. `n`. */
	replacement: string;
}

/** The ripgrep arguments of a command (`rg …` or `rtk rg …`), if it runs rg. */
function rgArgs(argv: string[]): string[] | undefined {
	if (argv.length === 0) return undefined;
	const first = basename(argv[0]);
	if (first === "rg") return argv.slice(1);
	if (first === "rtk" && argv[1] === "rg") return argv.slice(2);
	return undefined;
}

/** Scan one rg argument list for a `-r<letters>` cluster. */
function findMisuseInArgs(args: string[]): RgReplaceMisuse | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return undefined;
		if (arg.startsWith("--")) {
			if (!arg.includes("=") && RG_LONG_VALUE_FLAGS.has(arg)) i++;
			continue;
		}
		if (!arg.startsWith("-") || arg === "-") continue;
		for (let c = 1; c < arg.length; c++) {
			const flag = arg[c];
			if (!RG_SHORT_VALUE_FLAGS.has(flag)) continue;
			const attached = arg.slice(c + 1);
			if (flag === "r" && /^[A-Za-z]+$/.test(attached)) {
				return { flag: arg, replacement: attached };
			}
			// The rest of the cluster, or the next word, is this option's value.
			if (attached === "") i++;
			break;
		}
	}
	return undefined;
}

/**
 * Detects the GNU grep habit `rg -rn …`. In ripgrep `-r` is `--replace` (rg
 * already searches recursively), so `-rn` replaces every match with `n` and
 * silently rewrites the output. Only clusters where `-r` is followed by
 * letters are flagged; `rg -r '$1' …`, `rg pat -r X`, and `--replace=…` stay
 * allowed.
 */
export function findRgReplaceMisuse(
	command: string,
): RgReplaceMisuse | undefined {
	for (const argv of argvs(command)) {
		const args = rgArgs(argv);
		if (!args) continue;
		const misuse = findMisuseInArgs(args);
		if (misuse) return misuse;
	}
	return undefined;
}
