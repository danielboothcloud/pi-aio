/**
 * Pure utility functions for permission-modes.
 */

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Deliberately narrow: programs with write/exec options (env, find, awk,
// sed, curl, package managers, pagers, etc.) require approval, even when a
// particular invocation might only read. Git diff/log/show can invoke implicit
// external-diff/textconv helpers, so they also require approval. Match complete command names, not
// prefixes such as `cat-editor` or `git status-extra`.
export const SAFE_PATTERNS: RegExp[] = [
	/^\s*(cat|head|tail|grep|ls|pwd|echo|printf|wc|diff|stat|du|df|which|whereis|type|printenv|uname|whoami|id|cal|uptime|ps|free|rg|eza)(?=\s|$)/,
	/^\s*git\s+(status|ls-files|ls-tree)(?=\s|$)/,
	/^\s*git\s+branch(?:\s+(?:--show-current|--list|-a|-r|-v|--all|--remotes))*\s*$/,
	/^\s*git\s+remote(?:\s+(?:-v|--verbose))?\s*$/,
	/^\s*(node|python(?:\d+(?:\.\d+)?)?)\s+--version\s*$/,
];

/** AIO shell execution surfaces must share the same permission/blocklist gates. */
export function isShellTool(toolName: string): boolean {
	return toolName === "bash" || toolName === "hypa_shell";
}

export function isSafeCommand(command: string): boolean {
	// This is an approval allowlist, not a shell parser. Never infer safety
	// from the first executable in a script. Quoted metacharacters also take
	// the conservative path: default asks; ask/plan block; auto permits.
	if (/[;&|`$<>()\\\r\n{}*?\[\]\x00-\x1f\x7f]/.test(command)) return false;
	// Strip quotes for option checks so --p''re and --out"put" cannot hide
	// execution/output flags. Expansions and escapes were rejected above.
	const unquoted = command.replace(/["']/g, "");
	if (/--(?:output|pre|hostname-bin|ext-diff|textconv)(?:[=\s]|$)/.test(unquoted)) return false;
	if (/\s-[^-\s]*o/.test(unquoted)) return false;
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(
		message.indexOf(headerMatch[0]) + headerMatch[0].length,
	);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (
			text.length > 5 &&
			!text.startsWith("`") &&
			!text.startsWith("/") &&
			!text.startsWith("-")
		) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const abs = Math.abs(n);
	if (abs < 1000) return `${n}`;
	if (abs < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (abs < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}
