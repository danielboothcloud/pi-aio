// Text helpers shared by the rewind and resume pickers: one readable line per
// prompt or session, and short relative ages.

const SKILL_BLOCK = /^\s*<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;

/**
 * Turn a raw user prompt into one readable line. Skill invocations are stored
 * as an XML block followed by the user's own text; show "skill: name — text"
 * instead of the markup.
 */
export function cleanPromptTitle(raw: string): string {
	let text = raw ?? "";
	let prefix = "";
	const skill = SKILL_BLOCK.exec(text);
	if (skill) {
		prefix = `skill: ${skill[1]}`;
		text = text.slice(skill[0].length);
	}
	const body = text.replace(/\s+/g, " ").trim();
	if (prefix) return body ? `${prefix} — ${body}` : prefix;
	return body;
}

/** "now", "4m", "3h", "2d", then a short date for anything older than a week. */
export function relativeAge(timestamp: number, now: number): string {
	if (!Number.isFinite(timestamp)) return "";
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	const date = new Date(timestamp);
	const month = date.toLocaleString("en", { month: "short" });
	return `${month} ${date.getDate()}`;
}

/** Long form for headers: "22m ago", "just now". */
export function relativeAgeLong(timestamp: number, now: number): string {
	const short = relativeAge(timestamp, now);
	if (short === "now") return "just now";
	return /^\d/.test(short) ? `${short} ago` : short;
}

export function toMillis(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? Number.NaN : parsed;
	}
	return Number.NaN;
}

/** Case-insensitive AND match of every whitespace-separated term. */
export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = fields.filter(Boolean).join("\n").toLowerCase();
	return terms.every((term) => haystack.includes(term));
}
