import assert from "node:assert/strict";
import test from "node:test";
import { extractCopyableBlocks, extractFencedCodeBlocks } from "./parse.ts";

test("extracts multiple backtick and tilde fences in source order", () => {
	const blocks = extractFencedCodeBlocks(`Before

\`\`\`ts
const answer = 42;
\`\`\`

~~~sh
echo ok
~~~
`);

	assert.deepEqual(blocks, [
		{
			kind: "code",
			text: "const answer = 42;",
			info: "ts",
			language: "ts",
			lineCount: 1,
			ordinal: 1,
		},
		{
			kind: "code",
			text: "echo ok",
			info: "sh",
			language: "sh",
			lineCount: 1,
			ordinal: 2,
		},
	]);
});

test("keeps the first info-string word as the preview language", () => {
	const [block] = extractFencedCodeBlocks("```typescript title=example.ts\nlet value = 1;\n```");
	assert.equal(block?.info, "typescript title=example.ts");
	assert.equal(block?.language, "typescript");
});

test("handles longer fences and embedded backticks", () => {
	const [block] = extractFencedCodeBlocks("````md\nUse ``` inside this block.\n````");
	assert.equal(block?.text, "Use ``` inside this block.");
	assert.equal(block?.language, "md");
});

test("extracts an unclosed fence", () => {
	const [block] = extractFencedCodeBlocks("```json\n{\"ready\": true}");
	assert.equal(block?.text, '{"ready": true}');
	assert.equal(block?.language, "json");
});

test("ignores inline and indented code", () => {
	const blocks = extractFencedCodeBlocks("Use `inline()` here.\n\n    const indented = true;");
	assert.deepEqual(blocks, []);
});

test("extracts nested fenced blocks", () => {
	const blocks = extractFencedCodeBlocks("> ```js\n> console.log('quoted');\n> ```\n\n- item\n\n  ~~~py\n  print('listed')\n  ~~~");
	assert.deepEqual(
		blocks.map(({ text, language }) => ({ text, language })),
		[
			{ text: "console.log('quoted');", language: "js" },
			{ text: "print('listed')", language: "py" },
		],
	);
});

test("reports empty fenced blocks without inventing a line", () => {
	const [block] = extractFencedCodeBlocks("```text\n```");
	assert.equal(block?.text, "");
	assert.equal(block?.lineCount, 0);
});

const JACK =
	"Hi Jack, I checked the switch for Equativ. The only roles on that account are Admin, Trafficker, Business Owner and Account Manager, same as the other buy-side accounts. None of those have export, and neither do the publisher or SSP roles, so there isn't a role you can switch into that can export.";

test("extracts a block quote as plain text without its markers", () => {
	const blocks = extractCopyableBlocks(`Here's a draft reply:\n\n> ${JACK}\n\nWant me to adjust it?`);
	assert.deepEqual(blocks, [{ kind: "quote", text: JACK, lineCount: 1, ordinal: 1 }]);
});

test("joins soft-wrapped quote lines and keeps paragraphs and hard breaks", () => {
	const [block] = extractCopyableBlocks(
		"> Hi Jack, I checked\n> the switch for Equativ.\n>\n> Thanks,  \n> Daniel\\\n> (Novatiq)",
	);
	assert.equal(block?.text, "Hi Jack, I checked the switch for Equativ.\n\nThanks,\nDaniel\n(Novatiq)");
	assert.equal(block?.lineCount, 5);
});

test("keeps lists and nested quotes (verbatim) inside a quote", () => {
	const [block, ...rest] = extractCopyableBlocks(
		"> Options:\n>\n> - export as yourself\n> - ask an admin\n>\n> > earlier message\nlazy continuation",
	);
	assert.equal(rest.length, 0, "a nested quote belongs to its parent");
	assert.equal(
		block?.text,
		"Options:\n\n- export as yourself\n- ask an admin\n\n> earlier message\nlazy continuation",
	);
});

test("lists code and quotes together in source order with shared ordinals", () => {
	const blocks = extractCopyableBlocks(
		"```sh\nls\n```\n\n> first quote\n\n- item\n\n  > quote in a list\n\n> ```js\n> quoted();\n> ```",
	);
	assert.deepEqual(
		blocks.map(({ kind, text, ordinal }) => ({ kind, text, ordinal })),
		[
			{ kind: "code", text: "ls", ordinal: 1 },
			{ kind: "quote", text: "first quote", ordinal: 2 },
			{ kind: "quote", text: "quote in a list", ordinal: 3 },
			{ kind: "quote", text: "```js\nquoted();\n```", ordinal: 4 },
			{ kind: "code", text: "quoted();", ordinal: 5 },
		],
	);
});

test("skips empty quotes and leaves code-only extraction unchanged", () => {
	assert.deepEqual(extractCopyableBlocks(">\n>\n"), []);
	assert.deepEqual(
		extractFencedCodeBlocks("> quoted\n\n```ts\nx\n```").map(({ kind, ordinal }) => ({ kind, ordinal })),
		[{ kind: "code", ordinal: 1 }],
	);
});
