// YAML envelope parsing for hooks files. Ported from pi-yaml-hooks (MIT).

import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { HookValidationError } from "./types.js";
import { isNonEmptyString, isRecord } from "./types.js";

/** Hard cap on YAML payload size before parsing (1 MiB). */
export const MAX_HOOKS_YAML_BYTES = 1024 * 1024;

export interface ParsedHooksFileEnvelope {
	readonly imports: string[];
	readonly body?: Record<string, unknown>;
	readonly errors: HookValidationError[];
}

export function parseHooksFileEnvelope(
	filePath: string,
	content: string,
): ParsedHooksFileEnvelope {
	const byteLength = Buffer.byteLength(content, "utf8");
	if (byteLength > MAX_HOOKS_YAML_BYTES) {
		return {
			imports: [],
			errors: [
				{
					code: "invalid_frontmatter",
					filePath,
					message: `[aio yaml hooks] hooks.yaml exceeds the ${MAX_HOOKS_YAML_BYTES}-byte size cap (got ${byteLength} bytes); refusing to parse.`,
				},
			],
		};
	}

	const document = YAML.parseDocument(content);
	if (document.errors.length > 0) {
		return {
			imports: [],
			errors: [
				{
					code: "invalid_frontmatter",
					filePath,
					message: document.errors[0]?.message ?? "Failed to parse hooks.yaml.",
				},
			],
		};
	}

	const parsed: unknown = document.toJS();
	if (!isRecord(parsed)) {
		return {
			imports: [],
			errors: [
				{
					code: "invalid_frontmatter",
					filePath,
					message: "hooks.yaml must parse to an object.",
				},
			],
		};
	}

	const importsResult = parseImportsField(filePath, parsed.imports);
	if (importsResult.error) {
		return { imports: [], errors: [importsResult.error] };
	}

	return { imports: importsResult.imports, body: parsed, errors: [] };
}

export function parseImportsField(
	filePath: string,
	imports: unknown,
): { imports: string[]; error?: undefined } | { imports?: undefined; error: HookValidationError } {
	if (imports === undefined) {
		return { imports: [] };
	}

	if (!Array.isArray(imports)) {
		return {
			error: envelopeError(filePath, "invalid_imports", "imports must be an array of non-empty strings.", "imports"),
		};
	}

	const invalidIndex = imports.findIndex((entry) => !isNonEmptyString(entry));
	if (invalidIndex >= 0) {
		return {
			error: envelopeError(
				filePath,
				"invalid_imports",
				`imports[${invalidIndex}] must be a non-empty string.`,
				`imports[${invalidIndex}]`,
			),
		};
	}

	return { imports: [...imports] };
}

export function defaultReadFile(filePath: string): string {
	return readFileSync(filePath, "utf8");
}

export function formatHookReadError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Failed to read hooks.yaml: ${message}`;
}

function envelopeError(
	filePath: string,
	code: HookValidationError["code"],
	message: string,
	errorPath?: string,
): HookValidationError {
	return {
		code,
		filePath,
		message,
		...(errorPath ? { path: errorPath } : {}),
	};
}
