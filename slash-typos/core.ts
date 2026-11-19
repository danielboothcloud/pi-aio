/**
 * slash-typos/core — pure helpers: find a near-miss slash command such as
 * `/handof` and suggest the registered command. No Pi runtime imports.
 */

/** Pi's built-in interactive commands; `pi.getCommands()` does not list them. */
export const BUILTIN_COMMANDS = [
	"settings",
	"model",
	"thinking",
	"scoped-models",
	"login",
	"logout",
	"llama",
	"new",
	"resume",
	"name",
	"session",
	"tree",
	"fork",
	"clone",
	"compact",
	"import",
	"copy",
	"export",
	"share",
	"bug",
	"trust",
	"mcp",
	"reload",
	"hotkeys",
	"changelog",
	"quit",
] as const;

export interface SlashInput {
	name: string;
	/** Everything after the name, including its leading whitespace. */
	rest: string;
}

// A second slash (`/Users/…`, `/tmp/x`) means a path, not a command.
const SLASH_COMMAND = /^\/([A-Za-z0-9][\w:.-]*)(\s[\s\S]*)?$/;

export function parseSlashInput(text: string): SlashInput | undefined {
	const match = SLASH_COMMAND.exec(text);
	if (!match?.[1]) return undefined;
	return { name: match[1], rest: match[2] ?? "" };
}

/** Optimal string alignment distance: an adjacent swap costs 1 (`/hnadoff`). */
export function editDistance(a: string, b: string): number {
	let twoBack: number[] = [];
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, (twoBack[j - 2] ?? 0) + 1);
			}
			current.push(best);
		}
		twoBack = previous;
		previous = current;
	}
	return previous[b.length] ?? 0;
}

// Short names need a tight limit, or `/new` would match many words.
function maxDistance(name: string): number {
	return name.length <= 4 ? 1 : 2;
}

const MIN_PREFIX = 3;
const MAX_SUGGESTIONS = 3;

/**
 * Known commands close to `name`, best first; empty when `name` is itself
 * known or nothing is close enough. A unique prefix (`/hand`) also matches.
 */
export function suggestCommands(name: string, known: Iterable<string>): string[] {
	const names = [...new Set(known)];
	if (names.includes(name)) return [];
	const lower = name.toLowerCase();
	const caseMatch = names.filter((candidate) => candidate.toLowerCase() === lower);
	if (caseMatch.length > 0) return caseMatch.slice(0, MAX_SUGGESTIONS);

	const limit = maxDistance(lower);
	const scored = names
		.map((candidate) => ({ candidate, distance: editDistance(lower, candidate.toLowerCase()) }))
		.filter((entry) => entry.distance <= limit)
		.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
	if (scored.length > 0) return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.candidate);

	if (lower.length < MIN_PREFIX) return [];
	const prefixed = names.filter((candidate) => candidate.toLowerCase().startsWith(lower));
	return prefixed.length === 1 ? prefixed : [];
}

export function typoMessage(name: string, suggestions: readonly string[]): string {
	const options = suggestions.map((suggestion) => `/${suggestion}`).join(", ");
	const ask = suggestions.length === 1 ? `Did you mean ${options}?` : `Did you mean one of ${options}?`;
	return `Unknown command /${name}. ${ask} The text was not sent. Start with a space to send it as a message.`;
}
