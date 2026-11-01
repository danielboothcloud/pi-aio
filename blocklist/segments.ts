// ---------------------------------------------------------------------------
// Shell command segmenter for `"match": "command"` blocklist rules.
//
// A pure, dependency-free approximation of how a POSIX-ish shell splits a
// command line into the simple commands it would actually run. It exists so
// a rule like `^vault\b` blocks `vault login` and `echo $(vault read x)` but
// not `rg -n 'vault' src` or a heredoc body that merely mentions the word.
//
// Fail closed: whenever the segmentation cannot be trusted (unbalanced
// quotes, unterminated heredocs or `$(`, scripts read from a pipe/redirect,
// `source`/`.` of a file, …) `segmentCommand` returns `{ ok: false }` and
// `commandSegments` returns `null`. The blocklist then blocks the command
// outright for any active command-mode rule — an unreadable command is never
// let through.
//
// Deliberately NOT a full shell: no expansion is evaluated, aliases/functions
// are not resolved, and interpreters other than the shells below (python -c,
// node -e, find -exec, …) are opaque arguments.
// ---------------------------------------------------------------------------

/** One simple command the shell would run. */
export interface Segment {
	/** Dequoted words from the segment start, including `VAR=value` assignments and `export VAR=`. */
	full: string;
	/** Dequoted words from the actual program name on, after assignments and wrappers. */
	program: string;
}

export type SegmentResult =
	| { ok: true; segments: Segment[] }
	| { ok: false; reason: string };

/** Programs whose stdin/`-c` script is itself shell code to segment. */
export const SHELL_PROGRAMS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"zsh",
	"dash",
	"fish",
	"ksh",
]);

/** Builtins that run a file's contents in the current shell — always opaque. */
export const SOURCE_PROGRAMS: ReadonlySet<string> = new Set(["source", "."]);

/** Unquoted reserved words stripped from the front of a segment. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
	"!",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"esac",
	"{",
	"}",
]);

export interface WrapperSpec {
	/** Options that consume the following word (`-u root`). Attached forms (`-n5`, `--user=x`) are handled too. */
	readonly valueFlags?: readonly string[];
	/** Options after which the wrapped command is unknowable — segmentation fails closed. */
	readonly dynamicFlags?: readonly string[];
	/** Options that make the wrapper inspect rather than run its operand (`command -v`). */
	readonly inertFlags?: readonly string[];
	/** Accept `VAR=value` words between the options and the wrapped command. */
	readonly assignments?: boolean;
	/** Positional operands consumed before the wrapped command (`timeout DURATION`). */
	readonly positionals?: number;
	/**
	 * Special forms: `npx` stays in `program` and only `-y`/`--yes` are
	 * dropped; `perl-exec` unwraps `perl -e '…exec @ARGV…' <cmd>` only.
	 */
	readonly kind?: "npx" | "perl-exec";
}

/**
 * Wrappers stripped from the front of `program`, matched by basename so
 * `/usr/bin/env` counts. Unwrapping repeats, so `sudo env X=1 nice -n 5 cmd`
 * resolves to `cmd`.
 */
export const COMMAND_WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
	env: {
		valueFlags: ["-u", "--unset", "-C", "--chdir"],
		dynamicFlags: ["-S", "--split-string"],
		assignments: true,
	},
	sudo: {
		valueFlags: [
			"-u",
			"--user",
			"-g",
			"--group",
			"-C",
			"--close-from",
			"-h",
			"--host",
			"-p",
			"--prompt",
			"-r",
			"--role",
			"-t",
			"--type",
			"-U",
			"--other-user",
			"-D",
			"--chdir",
			"-T",
			"--command-timeout",
		],
		assignments: true,
	},
	command: { inertFlags: ["-v", "-V"] },
	exec: { valueFlags: ["-a"] },
	time: { valueFlags: ["-f", "--format", "-o", "--output"] },
	nice: { valueFlags: ["-n", "--adjustment"] },
	nohup: {},
	timeout: {
		valueFlags: ["-s", "--signal", "-k", "--kill-after"],
		positionals: 1,
	},
	xargs: {
		valueFlags: [
			"-I",
			"-L",
			"-n",
			"-P",
			"-s",
			"-d",
			"-E",
			"-a",
			"--max-args",
			"--max-procs",
			"--max-lines",
			"--max-chars",
			"--delimiter",
			"--arg-file",
			"--eof",
			"--process-slot-var",
		],
	},
	npx: { kind: "npx" },
	perl: { kind: "perl-exec" },
};

const MAX_NESTING = 8;
const MAX_UNWRAP = 16;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PERL_EXEC_ARGV = /\bexec\s*\(?\s*@ARGV\b/;

interface Word {
	/** Dequoted text; substitutions keep their raw `$(…)` source. */
	value: string;
	/** Any part of the word was quoted or escaped. */
	quoted: boolean;
	/** The first character was a quote/escape (`"FOO=1"` is not an assignment). */
	leadingQuote: boolean;
}

interface Builder {
	words: Word[];
	hereStrings: string[];
	heredocs: number;
	/** Set at finalize: this command is a shell reading its script from stdin. */
	shellStdin: boolean;
}

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	owner: Builder;
}

class SegmentError extends Error {}

function fail(reason: string): never {
	throw new SegmentError(reason);
}

function basename(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(slash + 1) : value;
}

function newBuilder(): Builder {
	return { words: [], hereStrings: [], heredocs: 0, shellStdin: false };
}

function isMeta(c: string): boolean {
	return (
		c === " " ||
		c === "\t" ||
		c === "\n" ||
		c === ";" ||
		c === "&" ||
		c === "|" ||
		c === "(" ||
		c === ")" ||
		c === "<" ||
		c === ">"
	);
}

function isAssignment(word: Word): boolean {
	return !word.leadingQuote && ASSIGNMENT.test(word.value);
}

function joinWords(words: readonly Word[]): string {
	return words.map((word) => word.value).join(" ");
}

type OptionScan = { next: number } | { inert: true };

/** Skip a wrapper's options starting at `i`; fails closed on dynamic flags. */
function skipOptions(words: readonly Word[], i: number, spec: WrapperSpec): OptionScan {
	const valueFlags = new Set(spec.valueFlags ?? []);
	const dynamicFlags = new Set(spec.dynamicFlags ?? []);
	const inertFlags = new Set(spec.inertFlags ?? []);
	while (i < words.length) {
		const value = words[i].value;
		if (value === "--") return { next: i + 1 };
		if (!value.startsWith("-")) break;
		if (value.startsWith("--")) {
			const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
			if (dynamicFlags.has(name)) fail(`\`${value}\` builds the wrapped command dynamically`);
			if (inertFlags.has(name)) return { inert: true };
			i += !value.includes("=") && valueFlags.has(name) ? 2 : 1;
			continue;
		}
		// Short option cluster (`-iu`, `-n5`, `-E`); a lone `-` is env's `-i`.
		let consumesNext = false;
		for (let k = 1; k < value.length; k++) {
			const flag = `-${value[k]}`;
			if (dynamicFlags.has(flag)) fail(`\`${value}\` builds the wrapped command dynamically`);
			if (inertFlags.has(flag)) return { inert: true };
			if (valueFlags.has(flag)) {
				consumesNext = k === value.length - 1;
				break;
			}
		}
		i += consumesNext ? 2 : 1;
	}
	return { next: i };
}

/** `perl [-flags] -e '…exec @ARGV…' [--] cmd…` → index of `cmd`, else undefined. */
function unwrapPerlExec(words: readonly Word[], i: number): number | undefined {
	const code: string[] = [];
	let j = i + 1;
	while (j < words.length) {
		const value = words[j].value;
		if (value === "--") {
			j++;
			break;
		}
		if (!value.startsWith("-") || value === "-") break;
		// `-e CODE`, or a cluster ending in e/E (`-we CODE`, `-lE CODE`).
		if (/^-[A-Za-z]*[eE]$/.test(value)) {
			const next = words[j + 1];
			if (!next) return undefined;
			code.push(next.value);
			j += 2;
			continue;
		}
		if (/^-[eE]./.test(value)) code.push(value.slice(2));
		j++;
	}
	if (j >= words.length) return undefined;
	return code.some((snippet) => PERL_EXEC_ARGV.test(snippet)) ? j : undefined;
}

/** Index of the real program after stripping COMMAND_WRAPPERS from `i`. */
function unwrap(words: readonly Word[], i: number): number {
	for (let round = 0; round < MAX_UNWRAP && i < words.length; round++) {
		const spec = COMMAND_WRAPPERS[basename(words[i].value)];
		if (!spec || spec.kind === "npx") return i;
		if (spec.kind === "perl-exec") {
			const next = unwrapPerlExec(words, i);
			if (next === undefined) return i;
			i = next;
			continue;
		}
		const scan = skipOptions(words, i + 1, spec);
		if ("inert" in scan) return i;
		let j = scan.next;
		if (spec.assignments) {
			while (j < words.length && isAssignment(words[j])) j++;
		}
		j += spec.positionals ?? 0;
		// A bare wrapper (`env`, `time`) is itself the program.
		if (j >= words.length) return i;
		i = j;
	}
	return i;
}

/** `npx -y vitest` → `npx vitest`: npx stays, only the auto-install flags go. */
function stripNpxYes(words: Word[]): Word[] {
	if (words.length === 0 || basename(words[0].value) !== "npx") return words;
	let j = 1;
	while (j < words.length && (words[j].value === "-y" || words[j].value === "--yes")) j++;
	return [words[0], ...words.slice(j)];
}

type ShellInvocation =
	| { kind: "script"; script: string }
	| { kind: "file" }
	| { kind: "stdin" };

/** Classify a shell's arguments: `-c` script, script file, or stdin. */
function shellInvocation(args: readonly Word[]): ShellInvocation {
	let readsCommand = false;
	let readsStdin = false;
	let j = 0;
	while (j < args.length) {
		const value = args[j].value;
		if (value === "--" || value === "-") {
			j++;
			break;
		}
		if (value.startsWith("--command=")) {
			return { kind: "script", script: value.slice("--command=".length) };
		}
		if (value === "--command") {
			const script = args[j + 1];
			if (!script) fail("`--command` has no script");
			return { kind: "script", script: script.value };
		}
		if (value.startsWith("--")) {
			j += value === "--rcfile" || value === "--init-file" ? 2 : 1;
			continue;
		}
		if (/^[-+][A-Za-z]+$/.test(value)) {
			if (value.startsWith("-") && value.includes("c")) readsCommand = true;
			if (value.includes("s")) readsStdin = true;
			// `-o opt` / `-O shopt` take an argument.
			j += /[oO]/.test(value) ? 2 : 1;
			continue;
		}
		break;
	}
	if (readsCommand) {
		const script = args[j];
		if (!script) fail("shell `-c` has no script");
		return { kind: "script", script: script.value };
	}
	if (readsStdin || j >= args.length) return { kind: "stdin" };
	return { kind: "file" };
}

class Parser {
	pos = 0;
	readonly segments: Segment[] = [];
	private pending: PendingHeredoc[] = [];

	constructor(
		private readonly src: string,
		private readonly depth: number,
	) {}

	run(): Segment[] {
		this.parseList(null);
		return this.segments;
	}

	private recurse(script: string): void {
		if (this.depth >= MAX_NESTING) fail("shell code is nested too deeply");
		const child = new Parser(script, this.depth + 1);
		this.segments.push(...child.run());
	}

	private skipBlanks(): void {
		const src = this.src;
		while (this.pos < src.length) {
			const c = src[this.pos];
			if (c === " " || c === "\t" || c === "\r") this.pos++;
			else if (c === "\\" && src[this.pos + 1] === "\n") this.pos += 2;
			else break;
		}
	}

	/** Parse commands until EOF or the given closing token. */
	private parseList(term: ")" | "`" | null): void {
		const src = this.src;
		let builder = newBuilder();
		let parenDepth = 0;
		const finish = () => {
			this.finalize(builder);
			builder = newBuilder();
		};
		for (;;) {
			this.skipBlanks();
			if (this.pos >= src.length) {
				finish();
				if (term === ")") fail("unterminated `$(` or `(`");
				if (term === "`") fail("unterminated backtick");
				if (this.pending.length > 0) {
					fail(`heredoc \`${this.pending[0].delimiter}\` is never terminated`);
				}
				return;
			}
			const c = src[this.pos];
			const next = src[this.pos + 1];
			if (c === "#") {
				const nl = src.indexOf("\n", this.pos);
				this.pos = nl < 0 ? src.length : nl;
				continue;
			}
			if (c === "\n") {
				this.pos++;
				finish();
				this.readHeredocBodies();
				continue;
			}
			if (c === ";") {
				this.pos++;
				while (src[this.pos] === ";" || src[this.pos] === "&") this.pos++;
				finish();
				continue;
			}
			if (c === "&" && next !== ">") {
				this.pos += next === "&" ? 2 : 1;
				finish();
				continue;
			}
			if (c === "|") {
				this.pos += next === "|" || next === "&" ? 2 : 1;
				finish();
				continue;
			}
			if (c === "(") {
				this.pos++;
				parenDepth++;
				finish();
				continue;
			}
			if (c === ")") {
				this.pos++;
				finish();
				if (parenDepth > 0) {
					parenDepth--;
					continue;
				}
				if (term === ")") return;
				continue; // stray `)` (e.g. a `case` pattern) — just a separator
			}
			if (c === "`" && term === "`") {
				this.pos++;
				finish();
				return;
			}
			if (c === "<" || c === ">" || c === "&") {
				this.readRedirect(builder);
				continue;
			}
			const fd = /^\d+(?=[<>])/.exec(src.slice(this.pos, this.pos + 12));
			if (fd) {
				this.pos += fd[0].length;
				continue;
			}
			builder.words.push(this.readWord(term));
		}
	}

	private readRedirect(builder: Builder): void {
		const src = this.src;
		const at = (token: string) => src.startsWith(token, this.pos);
		if (at("<<<")) {
			this.pos += 3;
			builder.hereStrings.push(this.readTarget().value);
			return;
		}
		if (at("<<")) {
			this.pos += 2;
			const stripTabs = src[this.pos] === "-";
			if (stripTabs) this.pos++;
			const delimiter = this.readTarget().value;
			builder.heredocs++;
			this.pending.push({ delimiter, stripTabs, owner: builder });
			return;
		}
		if (at("<(") || at(">(")) {
			const start = this.pos;
			this.pos += 2;
			this.parseList(")");
			builder.words.push({
				value: src.slice(start, this.pos),
				quoted: false,
				leadingQuote: false,
			});
			return;
		}
		if (at("&>>")) this.pos += 3;
		else if (at("&>") || at(">>") || at(">&") || at(">|") || at("<&") || at("<>")) this.pos += 2;
		else this.pos += 1;
		this.readTarget();
	}

	/** The word after a redirection operator — never part of the command. */
	private readTarget(): Word {
		this.skipBlanks();
		const c = this.src[this.pos];
		if (c === undefined || isMeta(c)) fail("redirection has no target");
		return this.readWord(null);
	}

	private readWord(term: ")" | "`" | null): Word {
		const src = this.src;
		const word: Word = { value: "", quoted: false, leadingQuote: false };
		const start = this.pos;
		const markQuoted = () => {
			if (this.pos === start) word.leadingQuote = true;
			word.quoted = true;
		};
		while (this.pos < src.length) {
			const c = src[this.pos];
			if (isMeta(c)) break;
			if (c === "`" && term === "`") break;
			if (c === "\\") {
				markQuoted();
				const next = src[this.pos + 1];
				if (next === undefined) {
					word.value += "\\";
					this.pos++;
				} else {
					if (next !== "\n") word.value += next;
					this.pos += 2;
				}
				continue;
			}
			if (c === "'") {
				markQuoted();
				const close = src.indexOf("'", this.pos + 1);
				if (close < 0) fail("unbalanced single quote");
				word.value += src.slice(this.pos + 1, close);
				this.pos = close + 1;
				continue;
			}
			if (c === '"') {
				markQuoted();
				word.value += this.readDoubleQuoted();
				continue;
			}
			if (c === "$") {
				const next = src[this.pos + 1];
				if (next === "'") {
					markQuoted();
					this.pos += 2;
					word.value += this.readAnsiC();
					continue;
				}
				if (next === '"') {
					markQuoted();
					this.pos++;
					word.value += this.readDoubleQuoted();
					continue;
				}
				if (next === "(" || next === "{") {
					word.value += this.readDollar();
					continue;
				}
				word.value += c;
				this.pos++;
				continue;
			}
			if (c === "`") {
				word.value += this.readBacktick();
				continue;
			}
			word.value += c;
			this.pos++;
		}
		return word;
	}

	/** `"…"` starting at the opening quote; recurses into `$(…)`/backticks. */
	private readDoubleQuoted(): string {
		const src = this.src;
		let value = "";
		this.pos++;
		for (;;) {
			if (this.pos >= src.length) fail("unbalanced double quote");
			const c = src[this.pos];
			if (c === '"') {
				this.pos++;
				return value;
			}
			if (c === "\\") {
				const next = src[this.pos + 1];
				if (next === "\n") {
					this.pos += 2;
				} else if (next === "$" || next === "`" || next === '"' || next === "\\") {
					value += next;
					this.pos += 2;
				} else {
					value += c;
					this.pos++;
				}
				continue;
			}
			if (c === "$" && (src[this.pos + 1] === "(" || src[this.pos + 1] === "{")) {
				value += this.readDollar();
				continue;
			}
			if (c === "`") {
				value += this.readBacktick();
				continue;
			}
			value += c;
			this.pos++;
		}
	}

	/** `$'…'` body after the opening `$'`. */
	private readAnsiC(): string {
		const src = this.src;
		let value = "";
		for (;;) {
			if (this.pos >= src.length) fail("unbalanced `$'` quote");
			const c = src[this.pos];
			if (c === "'") {
				this.pos++;
				return value;
			}
			if (c === "\\" && this.pos + 1 < src.length) {
				value += src[this.pos + 1];
				this.pos += 2;
				continue;
			}
			value += c;
			this.pos++;
		}
	}

	/** `$(…)` (segmented recursively) or `${…}` (scanned for nested substitutions). */
	private readDollar(): string {
		const src = this.src;
		const start = this.pos;
		if (src[this.pos + 1] === "(") {
			this.pos += 2;
			this.parseList(")");
			return src.slice(start, this.pos);
		}
		this.pos += 2;
		let depth = 1;
		while (depth > 0) {
			if (this.pos >= src.length) fail("unterminated `${`");
			const c = src[this.pos];
			if (c === "\\") {
				this.pos += 2;
			} else if (c === "'") {
				const close = src.indexOf("'", this.pos + 1);
				if (close < 0) fail("unbalanced single quote");
				this.pos = close + 1;
			} else if (c === '"') {
				this.readDoubleQuoted();
			} else if (c === "$" && (src[this.pos + 1] === "(" || src[this.pos + 1] === "{")) {
				this.readDollar();
			} else if (c === "`") {
				this.readBacktick();
			} else {
				if (c === "{") depth++;
				else if (c === "}") depth--;
				this.pos++;
			}
		}
		return src.slice(start, this.pos);
	}

	private readBacktick(): string {
		const start = this.pos;
		this.pos++;
		this.parseList("`");
		return this.src.slice(start, this.pos);
	}

	private readHeredocBodies(): void {
		const src = this.src;
		const pending = this.pending;
		this.pending = [];
		for (const heredoc of pending) {
			const lines: string[] = [];
			let terminated = false;
			while (this.pos < src.length) {
				const nl = src.indexOf("\n", this.pos);
				const raw = nl < 0 ? src.slice(this.pos) : src.slice(this.pos, nl);
				this.pos = nl < 0 ? src.length : nl + 1;
				const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
				if (line === heredoc.delimiter) {
					terminated = true;
					break;
				}
				lines.push(line);
			}
			if (!terminated) fail(`heredoc \`${heredoc.delimiter}\` is never terminated`);
			if (heredoc.owner.shellStdin) this.recurse(lines.join("\n"));
		}
	}

	private finalize(builder: Builder): void {
		const words = builder.words;
		let start = 0;
		while (start < words.length && !words[start].quoted && RESERVED_WORDS.has(words[start].value)) {
			start++;
		}
		if (start >= words.length) return;
		let p = start;
		while (p < words.length && isAssignment(words[p])) p++;
		const programWords = stripNpxYes(words.slice(unwrap(words, p)));
		this.segments.push({
			full: joinWords(words.slice(start)),
			program: joinWords(programWords),
		});
		if (programWords.length === 0) return;

		const first = programWords[0];
		const args = programWords.slice(1);
		if (!first.quoted && SOURCE_PROGRAMS.has(first.value)) {
			fail(`\`${first.value}\` runs a file whose commands cannot be checked`);
		}
		const name = basename(first.value);
		if (name === "eval") {
			this.recurse(joinWords(args));
			return;
		}
		if (!SHELL_PROGRAMS.has(name)) return;
		const invocation = shellInvocation(args);
		if (invocation.kind === "script") {
			this.recurse(invocation.script);
			return;
		}
		if (invocation.kind === "file") return;
		if (builder.heredocs === 0 && builder.hereStrings.length === 0) {
			fail(`\`${name}\` reads its script from a pipe or redirect`);
		}
		builder.shellStdin = true;
		for (const script of builder.hereStrings) this.recurse(script);
	}
}

/** Segment a command, or explain why it cannot be segmented safely. */
export function segmentCommand(command: string): SegmentResult {
	try {
		return { ok: true, segments: new Parser(command, 0).run() };
	} catch (error) {
		if (error instanceof SegmentError) return { ok: false, reason: error.message };
		return { ok: false, reason: "segmentation failed unexpectedly" };
	}
}

/** The commands the shell would run, or null when that cannot be trusted. */
export function commandSegments(command: string): Segment[] | null {
	const result = segmentCommand(command);
	return result.ok ? result.segments : null;
}
