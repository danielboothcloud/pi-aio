import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
	assertResultSchema,
	checkResult,
	registerChildResultTool,
	RESULT_SCHEMA_ENV,
	resultFromText,
	resultInstructions,
	submitResultParameters,
	submittedResult,
	SUBMIT_RESULT_TOOL,
} from "./result-schema.ts";

const schema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["ok", "blocked"] },
		files: { type: "array", items: { type: "string" } },
	},
	required: ["status", "files"],
	additionalProperties: false,
};

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const base = join(process.cwd(), ".pi-subagents");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "result-schema-test-"));
	directories.push(dir);
	return dir;
}

test("schemas must be JSON Schema objects", () => {
	assert.throws(() => assertResultSchema("nope"), /must be a JSON Schema object/);
	assert.throws(() => assertResultSchema([]), /must be a JSON Schema object/);
	assert.throws(() => assertResultSchema(null, "tasks[1].outputSchema"), /tasks\[1\]\.outputSchema/);
	assert.doesNotThrow(() => assertResultSchema({ type: "string" }));
});

test("valid values pass and invalid values report paths", () => {
	assertResultSchema(schema);
	assert.deepEqual(checkResult(schema, { status: "ok", files: [] }), { ok: true });
	const bad = checkResult(schema, { status: "done", files: [1] });
	assert.equal(bad.ok, false);
	assert.match(bad.ok ? "" : bad.errors, /\/status/);
	assert.match(bad.ok ? "" : bad.errors, /\/files\/0/);
});

test("JSON text results: whole message or the last fenced block", () => {
	assert.deepEqual(resultFromText('{"a":1}'), { found: true, value: { a: 1 } });
	assert.deepEqual(
		resultFromText('Done.\n```json\n{"a":1}\n```\nAnd finally:\n```json\n{"a":2}\n```'),
		{ found: true, value: { a: 2 } },
	);
	assert.deepEqual(resultFromText("no json here"), { found: false });
	assert.deepEqual(resultFromText(""), { found: false });
});

test("Pi validates submit_result arguments against the wrapped raw JSON Schema", () => {
	const tool = { name: SUBMIT_RESULT_TOOL, description: "", parameters: submitResultParameters(schema) };
	const ok = { type: "toolCall", id: "1", name: SUBMIT_RESULT_TOOL, arguments: { result: { status: "ok", files: ["x"] } } };
	assert.deepEqual(validateToolArguments(tool as never, ok as never), ok.arguments);
	const bad = { ...ok, arguments: { result: { status: "nope", files: [] } } };
	assert.throws(() => validateToolArguments(tool as never, bad as never));
	// Non-object schemas work too: the tool always wraps them in { result }.
	const list = { ...tool, parameters: submitResultParameters({ type: "array", items: { type: "integer" } }) };
	const listCall = { ...ok, arguments: { result: [1, 2] } };
	assert.deepEqual(validateToolArguments(list as never, listCall as never), listCall.arguments);
});

test("instructions name the tool and embed the schema", () => {
	const text = resultInstructions(schema);
	assert.match(text, /submit_result/);
	assert.match(text, /"enum": \[/);
});

test("the child tool registers only in a subagent child with a schema file", async () => {
	const dir = scratch();
	const file = join(dir, "schema.json");
	writeFileSync(file, JSON.stringify(schema));
	const tools: Array<Record<string, unknown>> = [];
	const pi = { registerTool: (tool: Record<string, unknown>) => tools.push(tool) } as never;
	assert.equal(registerChildResultTool(pi, { [RESULT_SCHEMA_ENV]: file }), false);
	assert.equal(registerChildResultTool(pi, { AIO_SUBAGENT_CHILD: "1" }), false);
	assert.equal(registerChildResultTool(pi, { AIO_SUBAGENT_CHILD: "1", [RESULT_SCHEMA_ENV]: file }), true);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, SUBMIT_RESULT_TOOL);
	const execute = tools[0].execute as (id: string, params: unknown) => Promise<{ details: unknown }>;
	const value = { status: "ok", files: [] };
	const result = await execute("call", { result: value });
	assert.deepEqual(result.details, { result: value });
	await assert.rejects(execute("call", { result: { status: 1 } }), /does not match/);
	// The parent reads that tool result back from the JSON event stream.
	assert.deepEqual(
		submittedResult({ type: "tool_execution_end", toolName: SUBMIT_RESULT_TOOL, isError: false, result }),
		{ found: true, value },
	);
	assert.deepEqual(
		submittedResult({ type: "tool_execution_end", toolName: SUBMIT_RESULT_TOOL, isError: true, result }),
		{ found: false },
	);
});

test("an unreadable or invalid schema file does not register the tool", () => {
	const dir = scratch();
	const file = join(dir, "schema.json");
	writeFileSync(file, '"just a string"');
	const tools: unknown[] = [];
	const pi = { registerTool: (tool: unknown) => tools.push(tool) } as never;
	const original = console.error;
	console.error = () => {};
	try {
		assert.equal(registerChildResultTool(pi, { AIO_SUBAGENT_CHILD: "1", [RESULT_SCHEMA_ENV]: file }), false);
		assert.equal(registerChildResultTool(pi, { AIO_SUBAGENT_CHILD: "1", [RESULT_SCHEMA_ENV]: join(dir, "missing.json") }), false);
	} finally {
		console.error = original;
	}
	assert.equal(tools.length, 0);
});
