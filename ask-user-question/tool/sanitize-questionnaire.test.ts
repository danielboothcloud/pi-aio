import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeQuestionnaire, sanitizeText } from "./sanitize-questionnaire.ts";
import type { QuestionParams } from "./types.ts";
import { validateQuestionnaire } from "./validate-questionnaire.ts";

test("strips stray carriage returns a model left inside words", () => {
	// Captured from a GLM-5.3-Flash tool call that rendered as a warped dialog.
	assert.equal(sanitizeText("Add\r\r it\r\r to\r\r the\r\r backlog\r\r;"), "Add it to the backlog;");
	assert.equal(sanitizeText("plain\r-text\r field"), "plain-text field");
});

test("keeps newlines and tabs, normalizes CRLF, drops other control chars", () => {
	assert.equal(sanitizeText("a\r\nb\n\tc"), "a\nb\n\tc");
	assert.equal(sanitizeText("x\x1b[2Jy\x00z\x7f"), "x[2Jyz");
});

test("sanitizes every rendered field and preserves the rest", () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Which\r plan?",
				header: "ARC\r\r plan",
				multiSelect: false,
				options: [
					{ label: "Backlog\r it", description: "Revisit\r later" },
					{ label: "Now", description: "Do it", preview: "line1\r\nline2\r" },
				],
			},
		],
	};
	const clean = sanitizeQuestionnaire(params);
	assert.deepEqual(clean, {
		questions: [
			{
				question: "Which plan?",
				header: "ARC plan",
				multiSelect: false,
				options: [
					{ label: "Backlog it", description: "Revisit later" },
					{ label: "Now", description: "Do it", preview: "line1\nline2" },
				],
			},
		],
	});
	assert.equal(params.questions[0]!.header, "ARC\r\r plan", "input is not mutated");
	assert.equal("preview" in clean.questions[0]!.options[0]!, false);
});

test("duplicate detection runs on the cleaned labels", () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Pick?",
				header: "Pick",
				options: [
					{ label: "Same", description: "a" },
					{ label: "Sa\rme", description: "b" },
				],
			},
		],
	};
	const result = validateQuestionnaire(sanitizeQuestionnaire(params));
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.error, "duplicate_option_label");
});
