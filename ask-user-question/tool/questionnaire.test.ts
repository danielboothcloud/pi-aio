import assert from "node:assert/strict";
import test from "node:test";
import {
	buildQuestionnaireResponse,
	DECLINE_MESSAGE,
} from "./response-envelope.ts";
import type { QuestionParams } from "./types.ts";
import { validateQuestionnaire } from "./validate-questionnaire.ts";

const params: QuestionParams = {
	questions: [
		{
			question: "Which approach?",
			header: "Approach",
			options: [
				{ label: "Simple", description: "Prefer the smallest implementation" },
				{
					label: "Flexible",
					description: "Allow future customization",
					preview: "interface Config {}",
				},
			],
		},
	],
};

test("accepts a valid questionnaire", () => {
	assert.deepEqual(validateQuestionnaire(params), { ok: true });
});

test("rejects duplicate questions, duplicate labels, and runtime sentinel labels", () => {
	assert.equal(
		validateQuestionnaire({
			questions: [params.questions[0], params.questions[0]],
		}).ok,
		false,
	);

	const duplicateLabels: QuestionParams = {
		questions: [
			{
				...params.questions[0],
				options: [
					{ label: "Same", description: "First" },
					{ label: "Same", description: "Second" },
				],
			},
		],
	};
	assert.deepEqual(validateQuestionnaire(duplicateLabels), {
		ok: false,
		error: "duplicate_option_label",
		message: "Error: Option labels must be unique within a question",
	});

	const reservedLabel: QuestionParams = {
		questions: [
			{
				...params.questions[0],
				options: [
					{ label: "Other", description: "Reserved" },
					{ label: "Valid", description: "Allowed" },
				],
			},
		],
	};
	const result = validateQuestionnaire(reservedLabel);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "reserved_label");
});

test("formats selected previews and user notes in the model-facing response", () => {
	const result = buildQuestionnaireResponse(
		{
			cancelled: false,
			answers: [
				{
					questionIndex: 0,
					question: "Which approach?",
					kind: "option",
					answer: "Flexible",
					preview: "interface Config {}",
					notes: "Keep the public API small",
				},
			],
		},
		params,
	);

	assert.match(result.content[0].text, /"Which approach\?"="Flexible"/);
	assert.match(
		result.content[0].text,
		/selected preview: interface Config \{\}/,
	);
	assert.match(result.content[0].text, /user notes: Keep the public API small/);
	assert.equal(result.details.cancelled, false);
});

test("uses one canonical decline response for cancellation", () => {
	const result = buildQuestionnaireResponse(
		{ answers: [], cancelled: true },
		params,
	);
	assert.equal(result.content[0].text, DECLINE_MESSAGE);
	assert.equal(result.details.cancelled, true);
});
