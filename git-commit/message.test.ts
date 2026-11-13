import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChangedFile } from "./git.js";
import {
	buildMessagePrompt,
	cleanMessage,
	isConventional,
	MESSAGE_INSTRUCTIONS,
	MESSAGE_SYSTEM_PROMPT,
	parseMessage,
} from "./message.js";

const FILES: ChangedFile[] = [
	{ path: "a.ts", status: "M", added: 2, deleted: 1 },
	{ path: "new.ts", oldPath: "old.ts", status: "R", added: 0, deleted: 0 },
];

describe("isConventional", () => {
	it("requires type(scope): description", () => {
		assert.equal(isConventional("feat(git): add command"), true);
		assert.equal(isConventional("fix(ui)!: break things\n\nbody"), true);
		assert.equal(isConventional("feat: no scope"), false);
		assert.equal(isConventional("wip(git): unknown type"), false);
		assert.equal(isConventional("feat(git):missing space"), false);
		assert.equal(isConventional(""), false);
	});
});

describe("parseMessage", () => {
	it("keeps a plain message with its body", () => {
		assert.equal(parseMessage("feat(a): add a\n\nWhy it matters."), "feat(a): add a\n\nWhy it matters.");
	});

	it("removes fences, quotes, labels, and JSON wrappers", () => {
		assert.equal(parseMessage("```\nfix(b): repair b\n```"), "fix(b): repair b");
		assert.equal(parseMessage("```text\nfix(b): repair b\n\nbody\n```"), "fix(b): repair b\n\nbody");
		assert.equal(parseMessage("\"docs(c): explain c\""), "docs(c): explain c");
		assert.equal(parseMessage("Commit message: chore(d): tidy d"), "chore(d): tidy d");
		assert.equal(parseMessage("{\"message\": \"feat(e): add e\"}"), "feat(e): add e");
		assert.equal(parseMessage("```json\n{\"commits\":[{\"message\":\"feat(f): add f\",\"files\":[]}]}\n```"), "feat(f): add f");
	});

	it("returns undefined for empty replies", () => {
		assert.equal(parseMessage(""), undefined);
		assert.equal(parseMessage("```\n```"), undefined);
	});
});

describe("prompt and cleanup", () => {
	it("puts the instructions in the user message, not only the system prompt", () => {
		const prompt = buildMessagePrompt({ branch: "main", files: FILES, diff: "DIFF", recentSubjects: ["feat(x): y"] });
		assert.ok(prompt.startsWith(MESSAGE_INSTRUCTIONS), "providers that drop the developer role still see the rules");
		assert.ok(!MESSAGE_SYSTEM_PROMPT.includes("type(scope)"));
		assert.match(prompt, /M a\.ts \(\+2 -1\)/);
		assert.match(prompt, /R old\.ts -> new\.ts/);
		assert.match(prompt, /- feat\(x\): y/);
		assert.match(prompt, /DIFF$/);
	});

	it("strips terminal sequences and control characters", () => {
		assert.equal(cleanMessage("\u001b[31mfeat(a): red\u001b[0m\r\n\r\nbody\u0007  "), "feat(a): red\n\nbody");
	});
});
