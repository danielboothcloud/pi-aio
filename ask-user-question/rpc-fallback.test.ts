import assert from "node:assert/strict";
import test from "node:test";
import {
	hasDialogUI,
	runRpcQuestionnaire,
	type DialogUI,
} from "./rpc-fallback.ts";
import type { QuestionParams } from "./tool/types.ts";

const single: QuestionParams = {
	questions: [
		{
			question: "Which option?",
			header: "Choice",
			options: [
				{ label: "A", description: "First", preview: "Preview A" },
				{ label: "B", description: "Second" },
			],
		},
	],
};

const multi: QuestionParams = {
	questions: [
		{
			question: "Which colors?",
			header: "Colors",
			multiSelect: true,
			options: [
				{ label: "Red", description: "Warm" },
				{ label: "Green", description: "Natural" },
				{ label: "Blue", description: "Cool" },
			],
		},
	],
};

test("detects RPC dialog capabilities", () => {
	assert.equal(
		hasDialogUI({
			select: async () => undefined,
			input: async () => undefined,
		}),
		true,
	);
	assert.equal(hasDialogUI({ select: async () => undefined }), false);
	assert.equal(hasDialogUI(undefined), false);
});

test("RPC single-select returns the selected option and preview", async () => {
	let title = "";
	let offered: string[] = [];
	const ui: DialogUI = {
		select: async (nextTitle, options) => {
			title = nextTitle;
			offered = options;
			return options[0];
		},
		input: async () => undefined,
	};

	const result = await runRpcQuestionnaire(ui, single);
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which option?",
		kind: "option",
		answer: "A",
		preview: "Preview A",
	});
	assert.match(title, /Preview A/);
	assert.equal(offered.at(-1), "3. Type something.");
});

test("RPC custom-answer fallback preserves typed text", async () => {
	const ui: DialogUI = {
		select: async (_title, options) => options.at(-1),
		input: async () => "A different answer",
	};

	const result = await runRpcQuestionnaire(ui, single);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which option?",
		kind: "custom",
		answer: "A different answer",
	});
});

test("RPC multi-select parses indexes and de-duplicates labels", async () => {
	const ui: DialogUI = {
		select: async () => undefined,
		input: async () => "1,3,1",
	};

	const result = await runRpcQuestionnaire(ui, multi);
	assert.deepEqual(result.answers[0], {
		questionIndex: 0,
		question: "Which colors?",
		kind: "multi",
		answer: null,
		selected: ["Red", "Blue"],
	});
});

test("dismissing an RPC dialog cancels the questionnaire", async () => {
	const ui: DialogUI = {
		select: async () => undefined,
		input: async () => undefined,
	};

	assert.deepEqual(await runRpcQuestionnaire(ui, single), {
		answers: [],
		cancelled: true,
	});
});
