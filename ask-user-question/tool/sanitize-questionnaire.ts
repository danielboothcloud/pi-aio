import type { OptionData, QuestionData, QuestionParams } from "./types.js";

// C0 controls and DEL, except tab and newline. A bare `\r` returns the cursor to
// column 0, so each word overwrites the last and the dialog renders warped; ESC
// would let tool arguments inject terminal sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/g;

/** Normalize CRLF/CR line endings to `\n`, then drop remaining control characters. */
export function sanitizeText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(CONTROL_CHARS, "");
}

/**
 * Clean the named string fields, leaving anything else (missing fields, wrong
 * types) untouched so validation still sees and reports the original shape.
 */
function sanitizeFields<T extends object>(item: T, fields: readonly (keyof T)[]): T {
	const clean = { ...item };
	for (const field of fields) {
		const value = clean[field];
		if (typeof value === "string") clean[field] = sanitizeText(value) as T[keyof T];
	}
	return clean;
}

function sanitizeOption(option: OptionData): OptionData {
	return sanitizeFields(option, ["label", "description", "preview"]);
}

function sanitizeQuestion(question: QuestionData): QuestionData {
	const clean = sanitizeFields(question, ["question", "header"]);
	if (Array.isArray(question.options)) clean.options = question.options.map(sanitizeOption);
	return clean;
}

/**
 * Some models emit stray carriage returns inside tool-call strings (e.g.
 * `"Add\r\r it\r\r to"`). Strip them before validation so duplicate checks and
 * returned answers use the same text the user saw.
 */
export function sanitizeQuestionnaire(params: QuestionParams): QuestionParams {
	if (!Array.isArray(params?.questions)) return params;
	return { ...params, questions: params.questions.map(sanitizeQuestion) };
}
