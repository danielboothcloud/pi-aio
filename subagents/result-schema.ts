import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ResultSchema } from "./types.js";

/**
 * Typed subagent results.
 *
 * When a run sets `outputSchema`, the runner writes the schema to the child's
 * private run directory and passes the path in RESULT_SCHEMA_ENV. AIO in the
 * child then registers SUBMIT_RESULT_TOOL with `{ result: <schema> }` as its
 * parameters, so Pi validates the arguments before the call succeeds. The
 * parent reads the value from the child's `tool_execution_end` event and
 * validates it again. A JSON final message is accepted as a fallback.
 */
export const SUBMIT_RESULT_TOOL = "submit_result";
export const RESULT_SCHEMA_ENV = "AIO_SUBAGENT_RESULT_SCHEMA_FILE";
const MAX_ERROR_LINES = 8;

type Validator = ReturnType<typeof Compile>;
const validators = new WeakMap<object, Validator>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compiled(schema: ResultSchema): Validator {
	let validator = validators.get(schema);
	if (!validator) {
		validator = Compile(schema as TSchema);
		validators.set(schema, validator);
	}
	return validator;
}

/** Throw a clear error when the schema cannot be used. */
export function assertResultSchema(schema: unknown, label = "outputSchema"): asserts schema is ResultSchema {
	if (!isPlainObject(schema))
		throw new Error(`${label} must be a JSON Schema object.`);
	try {
		const validator = compiled(schema);
		// Exercise the validator once: some invalid schemas only fail on use.
		validator.Check(null);
	} catch (error) {
		throw new Error(
			`${label} is not a usable JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export type ResultCheck = { ok: true } | { ok: false; errors: string };

export function checkResult(schema: ResultSchema, value: unknown): ResultCheck {
	const validator = compiled(schema);
	if (validator.Check(value)) return { ok: true };
	const errors = [...validator.Errors(value)]
		.slice(0, MAX_ERROR_LINES)
		.map((error) => `${error.instancePath || "(root)"} ${error.message}`);
	return { ok: false, errors: errors.join("; ") || "value does not match the schema" };
}

/** Parse a JSON final message: the whole text, else its last fenced block. */
export function resultFromText(text: string): { found: true; value: unknown } | { found: false } {
	const trimmed = text.trim();
	if (!trimmed) return { found: false };
	try {
		return { found: true, value: JSON.parse(trimmed) };
	} catch {
		// try a fenced block
	}
	const fences = [...trimmed.matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)\n?```/g)];
	for (const fence of fences.toReversed()) {
		try {
			return { found: true, value: JSON.parse(fence[1]) };
		} catch {
			// keep looking
		}
	}
	return { found: false };
}

/** The tool parameters: object-wrapped so any schema type works as tool input. */
export function submitResultParameters(schema: ResultSchema): Record<string, unknown> {
	return {
		type: "object",
		properties: { result: schema },
		required: ["result"],
		additionalProperties: false,
	};
}

/** Instructions appended to the child's system prompt. */
export function resultInstructions(schema: ResultSchema): string {
	return [
		"[TYPED RESULT REQUIRED]",
		`When the task is complete, call the \`${SUBMIT_RESULT_TOOL}\` tool exactly once. Put your final result in its \`result\` argument. The value must match this JSON Schema:`,
		"```json",
		JSON.stringify(schema, null, 2),
		"```",
		`If \`${SUBMIT_RESULT_TOOL}\` rejects the value, fix it and call the tool again. After the call, end with a short plain-text summary.`,
	].join("\n");
}

/** Prompt for a resumed child that finished without a valid result. */
export function missingResultPrompt(errors: string): string {
	return `Your previous run ended without a valid typed result (${errors}). Do not redo completed work. Call the \`${SUBMIT_RESULT_TOOL}\` tool now with a \`result\` value that matches the required JSON Schema from your instructions.`;
}

/**
 * In a subagent child with a result schema, register the submit tool. The
 * parent reads the submitted value from the JSON event stream.
 */
export function registerChildResultTool(
	pi: ExtensionAPI,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const file = env[RESULT_SCHEMA_ENV];
	if (env.AIO_SUBAGENT_CHILD !== "1" || !file) return false;
	let schema: unknown;
	try {
		schema = JSON.parse(readFileSync(file, "utf8"));
		assertResultSchema(schema);
	} catch (error) {
		console.error(
			`[aio subagents] Could not load the typed result schema: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	pi.registerTool({
		name: SUBMIT_RESULT_TOOL,
		label: "Submit result",
		description:
			"Submit your final typed result to the parent agent. Call it once, when the task is complete. The `result` argument must match the JSON Schema from your instructions.",
		// SAFETY: TypeBox 1.x schemas are plain JSON Schema objects; Pi only
		// serializes parameters and validates them with typebox Compile, which
		// accepts raw JSON Schema (covered by result-schema.test.ts).
		parameters: submitResultParameters(schema) as unknown as TSchema,
		async execute(_toolCallId, params: { result: unknown }) {
			const check = checkResult(schema, params.result);
			if (!check.ok)
				throw new Error(`The result does not match the schema: ${check.errors}`);
			return {
				content: [{ type: "text" as const, text: "Result submitted to the parent agent." }],
				details: { result: params.result },
			};
		},
	});
	return true;
}

/** Read a submitted result from a child's `tool_execution_end` event. */
export function submittedResult(event: Record<string, unknown>): { found: true; value: unknown } | { found: false } {
	if (event.type !== "tool_execution_end" || event.toolName !== SUBMIT_RESULT_TOOL || event.isError === true)
		return { found: false };
	const result = event.result;
	if (!isPlainObject(result) || !isPlainObject(result.details) || !("result" in result.details))
		return { found: false };
	return { found: true, value: result.details.result };
}
