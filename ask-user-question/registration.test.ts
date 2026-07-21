import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	loadQuestionnaireSession,
	registerAskUserQuestionTool,
} from "./ask-user-question.ts";
import { reconcileAskUserQuestionTool } from "./reconcile.ts";

test("registers ask_user_question as a sequential tool with prompt metadata and its strict schema", () => {
	let registered:
		| {
				name?: string;
				promptSnippet?: string;
				promptGuidelines?: string[];
				parameters?: unknown;
				executionMode?: string;
		  }
		| undefined;
	const pi = {
		registerTool(tool: typeof registered) {
			registered = tool;
		},
	} as unknown as ExtensionAPI;

	registerAskUserQuestionTool(pi);

	assert.equal(registered?.name, ASK_USER_QUESTION_TOOL_NAME);
	assert.equal(registered?.executionMode, "sequential");
	assert.match(registered?.promptSnippet ?? "", /structured questions/);
	assert.ok((registered?.promptGuidelines?.length ?? 0) >= 4);
	assert.ok(registered?.parameters);
});

test("the lazily loaded TUI questionnaire graph is available", async () => {
	const loaded = await loadQuestionnaireSession();
	assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.message);
	if (loaded.ok)
		assert.equal(typeof loaded.module.QuestionnaireSession, "function");
});

test("reconciler removes the tool without UI and restores it with UI", () => {
	let active = ["read", ASK_USER_QUESTION_TOOL_NAME];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as unknown as ExtensionAPI;

	reconcileAskUserQuestionTool(pi, { hasUI: false } as ExtensionContext);
	assert.deepEqual(active, ["read"]);

	reconcileAskUserQuestionTool(pi, { hasUI: true } as ExtensionContext);
	assert.deepEqual(active, ["read", ASK_USER_QUESTION_TOOL_NAME]);
});
