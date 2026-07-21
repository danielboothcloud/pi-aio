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
