import assert from "node:assert/strict";
import test from "node:test";
import { extractFencedCodeBlocks } from "./parse.ts";

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
			code: "const answer = 42;",
			info: "ts",
			language: "ts",
			lineCount: 1,
			ordinal: 1,
		},
		{
			code: "echo ok",
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
	assert.equal(block?.code, "Use ``` inside this block.");
	assert.equal(block?.language, "md");
});

test("extracts an unclosed fence", () => {
	const [block] = extractFencedCodeBlocks("```json\n{\"ready\": true}");
	assert.equal(block?.code, '{"ready": true}');
	assert.equal(block?.language, "json");
});

test("ignores inline and indented code", () => {
	const blocks = extractFencedCodeBlocks("Use `inline()` here.\n\n    const indented = true;");
	assert.deepEqual(blocks, []);
});

test("extracts nested fenced blocks", () => {
	const blocks = extractFencedCodeBlocks("> ```js\n> console.log('quoted');\n> ```\n\n- item\n\n  ~~~py\n  print('listed')\n  ~~~");
	assert.deepEqual(
		blocks.map(({ code, language }) => ({ code, language })),
		[
			{ code: "console.log('quoted');", language: "js" },
			{ code: "print('listed')", language: "py" },
		],
	);
});

test("reports empty fenced blocks without inventing a line", () => {
	const [block] = extractFencedCodeBlocks("```text\n```");
	assert.equal(block?.code, "");
	assert.equal(block?.lineCount, 0);
});
