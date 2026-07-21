export interface BashInputState {
	active: boolean;
	hidden: boolean;
	command: string;
}

export function parseBashInput(text: string): BashInputState {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("!")) {
		return { active: false, hidden: false, command: "" };
	}

	const hidden = trimmed.startsWith("!!");
	const command = trimmed.slice(hidden ? 2 : 1).trimStart();
	return { active: true, hidden, command };
}

/** Insert a space after ! / !! when command text follows without one. */
export function ensureBashSpacing(text: string): string | null {
	const leadingWhitespace = text.match(/^\s*/)?.[0] ?? "";
	const trimmed = text.slice(leadingWhitespace.length);
	if (!trimmed.startsWith("!")) return null;

	const hidden = trimmed.startsWith("!!");
	const prefix = hidden ? "!!" : "!";
	const afterPrefix = trimmed.slice(prefix.length);
	if (afterPrefix.length === 0 || afterPrefix.startsWith(" ")) return null;

	return `${leadingWhitespace}${prefix} ${afterPrefix}`;
}
